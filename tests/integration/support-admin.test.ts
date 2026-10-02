import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  symlink,
  lstat,
  rm,
  chmod,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { testPool } from "../support/database.ts";
const pool = testPool();
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function run(root: string, args: string[] = ["bootstrap"]) {
  const child = spawn(
    process.execPath,
    ["src/support-admin-main.ts", ...args],
    {
      env: {
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PRIVATE_STORAGE_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (data) => {
    out += data;
  });
  child.stderr.on("data", (data) => {
    err += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, out, err };
}
it("rejects a support-admin directory symlink before creating credentials or principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "dne-support-admin-private-")),
    publicTarget = await mkdtemp(join(tmpdir(), "dne-support-admin-public-"));
  try {
    await symlink(publicTarget, join(root, "support-admin"));
    expect(await run(root)).toEqual({
      code: 1,
      out: "",
      err: JSON.stringify({ status: "failed" }) + "\n",
    });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0].n,
    ).toBe(0);
    await expect(lstat(join(publicTarget, "admin.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      lstat(join(publicTarget, "operator.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(publicTarget, { recursive: true, force: true });
  }
});
it("rejects an insufficiently private directory without provisioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "dne-support-admin-mode-"));
  try {
    await mkdir(join(root, "support-admin"), { mode: 0o755 });
    await chmod(join(root, "support-admin"), 0o755);
    expect((await run(root)).code).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0].n,
    ).toBe(0);
    for (const name of ["admin.json", "operator.json"])
      await expect(
        lstat(join(root, "support-admin", name)),
      ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("bootstraps into private regular files without printing tokens and preserves existing identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "dne-support-admin-good-"));
  try {
    const result = await run(root);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      status: "complete",
      action: "bootstrap",
    });
    for (const file of ["admin.json", "operator.json"]) {
      const path = join(root, "support-admin", file),
        info = await lstat(path),
        credential = JSON.parse(await readFile(path, "utf8"));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
      expect(credential.token).toMatch(/^[a-f0-9]{64}$/);
      expect(result.out + result.err).not.toContain(credential.token);
    }
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0].n,
    ).toBe(2);
    expect((await run(root)).code).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0].n,
    ).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("grants and revokes an exact real request using current private administrator credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "dne-support-admin-grant-"));
  try {
    expect((await run(root)).code).toBe(0);
    const directory = join(root, "support-admin"),
      memberToken = randomBytes(32).toString("hex"),
      support = supportRequestStore(pool);
    await store(pool).create(memberToken, {
      background: "professional",
      goal: "work",
    });
    const created = await support.create(memberToken, {
      idempotencyKey: randomUUID(),
      subject: "Invented command test",
      body: "Private sample",
    });
    if (!("receipt" in created)) throw Error("Missing synthetic request");
    const instruction = {
      requestId: created.receipt.requestId,
      idempotencyKey: randomUUID(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    };
    await writeFile(
      join(directory, "grant.json"),
      JSON.stringify(instruction),
      { flag: "wx", mode: 0o600 },
    );
    const granted = await run(root, ["grant", "grant.json"]);
    expect(granted.code).toBe(0);
    const grant = JSON.parse(granted.out);
    expect(grant).toMatchObject({
      status: "complete",
      action: "grant",
      grantId: expect.any(String),
    });
    expect(JSON.parse((await run(root, ["grant", "grant.json"])).out)).toEqual(
      grant,
    );
    const operator = JSON.parse(
      await readFile(join(directory, "operator.json"), "utf8"),
    );
    expect(
      await support.operatorDetail(operator.token, {
        requestId: instruction.requestId,
        grantId: grant.grantId,
      }),
    ).toMatchObject({ kind: "ready", value: { body: "Private sample" } });
    expect(granted.out + granted.err).not.toContain(operator.token);
    await writeFile(
      join(directory, "revoke.json"),
      JSON.stringify({ grantId: grant.grantId }),
      { flag: "wx", mode: 0o600 },
    );
    expect((await run(root, ["revoke", "revoke.json"])).code).toBe(0);
    expect((await run(root, ["revoke", "revoke.json"])).code).toBe(0);
    expect(
      await support.operatorDetail(operator.token, {
        requestId: instruction.requestId,
        grantId: grant.grantId,
      }),
    ).toEqual({ kind: "denied" });
    await writeFile(
      join(directory, "admin.json"),
      JSON.stringify({ token: memberToken }),
      { mode: 0o600 },
    );
    expect((await run(root, ["grant", "grant.json"])).code).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
        .rows[0].n,
    ).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
