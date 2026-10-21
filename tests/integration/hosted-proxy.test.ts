import { request as httpRequest } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const canonical = "engine.deepnative.io";
const legacy =
  "ca-deepnative-dev.ambitiouscoast-ac447ad9.canadacentral.azurecontainerapps.io";
const name = `dne-proxy-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), "dne-hosted-proxy-"));
let address: string;
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function proxyRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return new Promise<{ status: number; text: () => Promise<string> }>(
    (resolve, reject) => {
      const request = httpRequest(url, options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(5_000, () =>
        request.destroy(Error("Owned proxy request timed out.")),
      );
      request.end(options.body);
    },
  );
}
beforeAll(async () => {
  writeFileSync(
    join(directory, "upstream.conf"),
    'server { listen 3000; location / { default_type text/plain; return 200 "$http_host|$http_origin|$http_cookie|$http_x_forwarded_host|$http_x_forwarded_proto"; } }',
  );
  chmodSync(join(directory, "upstream.conf"), 0o644);
  docker("build", "--tag", name, "infra/proxy");
  docker(
    "create",
    "--name",
    name,
    "-p",
    "127.0.0.1::8080",
    "-e",
    `PUBLIC_HOST=${canonical}`,
    "-e",
    `LEGACY_HOST=${legacy}`,
    name,
  );
  docker(
    "cp",
    join(directory, "upstream.conf"),
    `${name}:/etc/nginx/conf.d/upstream.conf`,
  );
  docker("start", name);
  const inspected = JSON.parse(docker("inspect", name))[0];
  const ports = inspected.NetworkSettings.Ports["8080/tcp"];
  if (!ports?.length) {
    const log = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    throw Error(
      `Owned proxy startup: ${JSON.stringify(inspected.State)} ${log.stdout} ${log.stderr}`,
    );
  }
  const port = ports[0].HostPort;
  address = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      if (
        (await proxyRequest(address, { headers: { Host: canonical } }))
          .status === 200
      )
        break;
    } catch {
      /* Wait only for this owned nginx process to start. */
    }
    if (Date.now() >= deadline) {
      const log = spawnSync("docker", ["logs", name], { encoding: "utf8" });
      throw Error(
        `Owned proxy fixture did not become ready: ${log.stdout} ${log.stderr}`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}, 120_000);
afterAll(() => {
  try {
    docker("rm", "--force", name);
    docker("image", "rm", name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([canonical, legacy])(
  "HOSTED-09/10 preserves the same owned browser session at %s without weakening the application origin",
  async (host) => {
    const response = await proxyRequest(address, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: "dne_session=invented-owned-session",
        "X-Forwarded-Host": "attacker.example",
        "X-Forwarded-Proto": "http",
      },
      body: "invented-form",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `${canonical}|https://${canonical}|dne_session=invented-owned-session||`,
    );
  },
);
it.each([
  ["attacker.example", "https://attacker.example"],
  [canonical, `https://${legacy}`],
  [legacy, `https://${canonical}`],
  [canonical, "https://attacker.example"],
  [legacy, "null"],
  [canonical, ""],
  ["127.0.0.1:3000", `https://${canonical}`],
  [`${canonical}:8080`, `https://${canonical}`],
])(
  "HOSTED-10 rejects unowned or crossed Host/Origin %s %s",
  async (host, origin) => {
    const response = await proxyRequest(address, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        "X-Forwarded-Host": canonical,
        "X-Forwarded-Proto": "https",
      },
      body: "invented-form",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("invented-form");
  },
);
it("HOSTED-10 allows owned read navigation without Origin but rejects a foreign read Origin", async () => {
  for (const host of [canonical, legacy])
    expect(
      (await proxyRequest(address, { headers: { Host: host } })).status,
    ).toBe(200);
  expect(
    (
      await proxyRequest(address, {
        headers: { Host: canonical, Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
});

it("HOSTED-13 enters and leaves verified maintenance in place without restarting or losing the original browser credential", async () => {
  const original = join(directory, "original.conf");
  const maintenance = join(directory, "maintenance.conf");
  docker("cp", `${name}:/etc/nginx/conf.d/default.conf`, original);
  writeFileSync(
    maintenance,
    'server { listen 8080; default_type text/plain; location / { return 503 "Deployment maintenance. Existing work is preserved.\\n"; } }',
  );
  chmodSync(maintenance, 0o644);
  const before = JSON.parse(docker("inspect", name))[0];
  const waitFor = async (status: number) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const response = await proxyRequest(address, {
        headers: { Host: canonical },
      });
      if (response.status === status) return response;
      if (Date.now() >= deadline)
        throw Error("Owned proxy reload did not reach its expected state.");
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  try {
    docker("cp", maintenance, `${name}:/etc/nginx/conf.d/default.conf`);
    docker("exec", name, "nginx", "-t");
    docker("exec", name, "nginx", "-s", "reload");
    expect(await (await waitFor(503)).text()).toBe(
      "Deployment maintenance. Existing work is preserved.\n",
    );
    expect(
      (
        await proxyRequest(address, {
          method: "POST",
          headers: { Host: legacy, Origin: `https://${legacy}` },
          body: "must-not-reach-application",
        })
      ).status,
    ).toBe(503);
  } finally {
    docker("cp", original, `${name}:/etc/nginx/conf.d/default.conf`);
    docker("exec", name, "nginx", "-t");
    docker("exec", name, "nginx", "-s", "reload");
    await waitFor(200);
  }
  const after = JSON.parse(docker("inspect", name))[0];
  expect(after.Id).toBe(before.Id);
  expect(after.State.StartedAt).toBe(before.State.StartedAt);
  expect(after.RestartCount).toBe(before.RestartCount);
  const receipt = await proxyRequest(address, {
    method: "POST",
    headers: {
      Host: legacy,
      Origin: `https://${legacy}`,
      Cookie: "dne_session=same-original-invented-credential",
    },
  });
  expect(await receipt.text()).toContain(
    "dne_session=same-original-invented-credential",
  );
});
