import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import {
  workflowBundle,
  workflowRegistry,
} from "../../src/workflow-registry.ts";
import type { Store } from "../../src/store.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
const fixture = vi.hoisted(() => ({
  replacement: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) =>
      fixture.replacement !== undefined &&
      args[0] instanceof URL &&
      args[0].pathname.endsWith("/workflows/WF-003-meeting-actions.md")
        ? Promise.resolve(fixture.replacement)
        : fs.readFile(...args),
  };
});
let server: Server | undefined;
it("WFR114-01 exposes ordinary reviewed workflow version2 with factual editorial and maintenance metadata", async () => {
  const item = await workflowBundle("WF-003");
  expect(item).toMatchObject({
    version: 2,
    reviewer:
      "Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root",
  });
  expect(item?.lastVerification).toContain(
    "2026-10-27 manual input/output comparison",
  );
  expect(item?.license).toContain("No new license granted");
});
it("WFR114-01/03 withholds invalid or retired reviewed files instead of reverting to a version1 draft", async () => {
  const original = (await workflowBundle("WF-003"))!;
  for (const change of [
    original.download.replace("id: WF-003", "id: WF-999"),
    original.download.replace("version: 2", "version: 1"),
    original.download.replace("version: 2\n", ""),
    original.download.replace("version: 2", "version: 02"),
    original.download.replace("version: 2", "version: 9007199254740992"),
    original.download.replace(
      "version: 2",
      "version: 2\npublication_state: retired",
    ),
    original.download.split("\n---\n")[0] + "\n---\n",
    original.download.split("\n---\n")[0] + "\n---\n \n",
  ]) {
    fixture.replacement = change;
    expect(await workflowBundle("WF-003")).toBeNull();
    expect((await workflowRegistry()).map((item) => item.id)).toEqual([
      "WF-001",
      "WF-002",
    ]);
  }
  for (const key of [
    "owner",
    "rights",
    "sources",
    "reviewer",
    "reviewed_on",
    "setup",
    "supported_environment",
    "permissions",
    "license",
    "last_verification",
    "next_review",
  ]) {
    fixture.replacement = original.download.replace(
      new RegExp(`^${key}:.*$`, "m"),
      `${key}: `,
    );
    expect(await workflowBundle("WF-003")).toBeNull();
  }
  fixture.replacement = original.download.replace(
    "version: 2",
    "version: 2\npublication_state: reviewed",
  );
  expect((await workflowBundle("WF-003"))?.version).toBe(2);
});
it("WFR114-03 a cached version1 link cannot read or download version2, and retirement preserves safe recovery", async () => {
  const get = await workflowHttp();
  for (const suffix of ["", "/download"]) {
    const stale = await get(`/workflows/WF-003${suffix}?version=1`).expect(409);
    expect(stale.headers["content-disposition"]).toBeUndefined();
    expect(stale.text).not.toContain("## Synthetic input");
    expect(stale.text).toContain("Browse current workflows");
  }
  const original = (await workflowBundle("WF-003"))!;
  fixture.replacement = original.download.replace(
    "version: 2",
    "version: 2\npublication_state: retired",
  );
  const retired = await get("/workflows/WF-003/download?version=2").expect(404);
  expect(retired.headers["content-disposition"]).toBeUndefined();
  expect(retired.text).not.toContain("## Synthetic input");
  expect(retired.text).toContain("not currently available");
  expect(retired.text).toContain("Browse current workflows");
});
afterEach(async () => {
  if (server) await closeLoopback(server);
  server = undefined;
  fixture.replacement = undefined;
});

it("[WFDL-02] refuses an unavailable pinned version before sending an attachment", async () => {
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  server = await listenLoopback(
    app(store, { origin: "http://127.0.0.1:3000", secret: "secret" }),
  );
  const response = await request(server)
    .get("/workflows/WF-003/download?version=3")
    .set("Host", "127.0.0.1:3000");
  expect.soft(response.status).toBe(409);
  expect.soft(response.headers["content-disposition"]).toBeUndefined();
  expect(response.text).not.toContain("## Synthetic input");
});

it("[WFDL-01 WFDL-02] refuses a retained displayed-version link after a draft replacement", async () => {
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  server = await listenLoopback(
    app(store, { origin: "http://127.0.0.1:3000", secret: "secret" }),
  );
  const get = (path: string) =>
    request(server!).get(path).set("Host", "127.0.0.1:3000");
  const original = (await workflowBundle("WF-003"))!;
  const detail = await get("/workflows/WF-003?version=2").expect(200);
  const link = detail.text.match(
    /href="([^"]+)"[^>]*>Download Markdown text<\/a>/,
  )![1]!;
  expect.soft(link).toBe("/workflows/WF-003/download?version=2");
  fixture.replacement = original.download
    .replace("version: 2\n", "version: 3\n")
    .replace(
      "## Synthetic input",
      "## Synthetic input\nReplacement-only invented text",
    );
  const response = await get(link);
  expect.soft(response.status).toBe(409);
  expect.soft(response.headers["content-disposition"]).toBeUndefined();
  expect(response.text).not.toContain("Replacement-only invented text");
  expect(response.text).toContain('href="/workflows">Browse current workflows');
  const staleDetail = await get("/workflows/WF-003?version=2").expect(409);
  expect(staleDetail.text).not.toContain("Replacement-only invented text");
  expect(staleDetail.headers["content-disposition"]).toBeUndefined();
  const currentList = await get("/workflows").expect(200);
  expect(currentList.text).toContain('href="/workflows/WF-003?version=3"');
  expect(currentList.text).toContain('href="/workflows/WF-001?version=2"');
  const currentDetail = await get("/workflows/WF-003?version=3").expect(200);
  expect(currentDetail.text).toContain(
    'href="/workflows/WF-003/download?version=3"',
  );
  const current = await get("/workflows/WF-003/download?version=3").expect(200);
  expect(current.text).toBe(fixture.replacement);
  expect(current.headers["content-disposition"]).toBe(
    'attachment; filename="WF-003-v3.md"',
  );
});

it("loads only the three fixed reviewed Markdown bundles and filters their metadata", async () => {
  const all = await workflowRegistry();
  expect(all.map((item) => item.id)).toEqual(["WF-001", "WF-002", "WF-003"]);
  for (const item of all) {
    expect(item.version).toBe(2);
    expect(item.body).toContain("## Synthetic input");
    expect(item.body).toContain("## Hand-authored example");
    expect(item.setup).toBeTruthy();
    expect(item.license).toContain("No new license granted");
    expect(item.lastVerification).toContain("manual input/output comparison");
    expect(item.download).toContain(`id: ${item.id}`);
  }
  expect(
    (await workflowRegistry("  MEETING  ")).map((item) => item.id),
  ).toEqual(["WF-003"]);
  expect(await workflowRegistry("no matching goal")).toEqual([]);
  expect(await workflowBundle("../../package.json")).toBeNull();
});

it("[WFDL-01 WFDL-04] serves read-only demonstration pages and inert Markdown attachments", async () => {
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  server = await listenLoopback(
    app(store, {
      origin: "http://127.0.0.1:3000",
      secret: "secret",
    }),
  );
  const agent = request.agent(server);
  const get = (path: string) => agent.get(path).set("Host", "127.0.0.1:3000");
  const list = await get("/workflows").expect(200);
  for (const id of ["WF-001", "WF-002", "WF-003"]) {
    expect(list.text).toContain(`href="/workflows/${id}?version=2"`);
  }
  expect(list.text).toContain("ORDINARY REVIEWED WORKFLOWS");
  expect((await get("/workflows?q=meeting").expect(200)).text).toContain(
    "Extract actions from synthetic meeting notes",
  );
  expect((await get("/workflows?q=no-match").expect(200)).text).toContain(
    "No demonstration matches",
  );
  const escaped = await get("/workflows?q=%3Cscript%3E").expect(200);
  expect(escaped.text).toContain("&lt;script&gt;");
  expect(escaped.text).not.toContain("<script>");
  expect((await get("/workflows?q[]=array").expect(200)).text).toContain(
    "Workflow demonstrations",
  );
  const detail = await get("/workflows/WF-003").expect(200);
  expect(detail.text).toContain("Select and copy the synthetic workflow text");
  expect(detail.text).toContain(
    "no AI provider, calendar or messaging integration verified",
  );
  const download = await get("/workflows/WF-003/download?version=2").expect(
    200,
  );
  expect(download.headers["content-disposition"]).toContain(
    'attachment; filename="WF-003-v2.md"',
  );
  expect(download.headers["x-content-type-options"]).toBe("nosniff");
  expect(download.headers["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(Buffer.from(download.text)).toEqual(
    Buffer.from((await workflowBundle("WF-003"))!.download),
  );
  expect(download.text).toContain(
    "# Workflow demonstration: extract meeting actions",
  );
  await get("/workflows/unknown").expect(404);
  await get("/workflows/unknown/download").expect(404);
});

async function workflowHttp() {
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  server = await listenLoopback(
    app(store, { origin: "http://127.0.0.1:3000", secret: "secret" }),
  );
  return (path: string) =>
    request(server!).get(path).set("Host", "127.0.0.1:3000");
}

it.each([
  "version",
  "version=",
  "version=0",
  "version=-1",
  "version=01",
  "version=1.0",
  "version=1e0",
  "version=%2B1",
  "version=%201",
  "version=1%20",
  "version=1%0A",
  "version=NaN",
  "version=Infinity",
  "version=9007199254740992",
  "version=999999999999999999999999999999999999999999",
  "version=1&version=1",
  "version=1&version=2",
  "version[]=1",
  "version[x]=1",
  "version.x=1",
  "version=1&version[]=1",
  "version=1&version[x]=1",
  "version=1&version.x=1",
])(
  "[WFDL-03] rejects malformed version query %s on both reader and download",
  async (query) => {
    const get = await workflowHttp();
    for (const suffix of ["", "/download"]) {
      const response = await get(`/workflows/WF-003${suffix}?${query}`).expect(
        400,
      );
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.text).not.toContain("## Synthetic input");
      expect(response.text).toContain("Workflow version required");
      expect(response.text).toContain(
        'href="/workflows">Browse current workflows',
      );
    }
  },
);

it("[WFDL-03] keeps legacy detail entry but refuses missing download pins with recovery", async () => {
  const get = await workflowHttp();
  for (const suffix of ["", "?q=unrelated"]) {
    const detail = await get(`/workflows/WF-003${suffix}`).expect(200);
    expect(detail.text).toContain(
      'href="/workflows/WF-003/download?version=2"',
    );
    const denied = await get(`/workflows/WF-003/download${suffix}`).expect(400);
    expect(denied.headers["content-disposition"]).toBeUndefined();
    expect(denied.text).not.toContain("## Synthetic input");
    expect(denied.text).toContain('href="/workflows">Browse current workflows');
  }
});

it("[WFDL-02 WFDL-03] distinguishes safe positive mismatches from malformed versions", async () => {
  const get = await workflowHttp();
  for (const version of ["1", "3", "9007199254740991"]) {
    for (const suffix of ["", "/download"]) {
      const response = await get(
        `/workflows/WF-003${suffix}?version=${version}`,
      ).expect(409);
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.text).toContain("Workflow version unavailable");
      expect(response.text).not.toContain("## Synthetic input");
      expect(response.text).toContain(
        'href="/workflows">Browse current workflows',
      );
    }
  }
});

it("[WFDL-01 WFDL-03] accepts the largest safe declared draft version exactly", async () => {
  const get = await workflowHttp();
  const original = (await workflowBundle("WF-003"))!;
  fixture.replacement = original.download.replace(
    "version: 2\n",
    "version: 9007199254740991\n",
  );
  const detail = await get("/workflows/WF-003?version=9007199254740991").expect(
    200,
  );
  expect(detail.text).toContain(
    'href="/workflows/WF-003/download?version=9007199254740991"',
  );
  const downloaded = await get(
    "/workflows/WF-003/download?version=9007199254740991",
  ).expect(200);
  expect(downloaded.text).toBe(fixture.replacement);
  expect(downloaded.headers["content-disposition"]).toBe(
    'attachment; filename="WF-003-v9007199254740991.md"',
  );
});

it("[WFDL-03] gives unknown fixed IDs precedence over version errors", async () => {
  const get = await workflowHttp();
  for (const query of [
    "",
    "?version=0",
    "?version=2",
    "?version[]=1",
    "?version=1&version=1",
  ]) {
    for (const suffix of ["", "/download"]) {
      const response = await get(`/workflows/unknown${suffix}${query}`).expect(
        404,
      );
      expect(response.text).toContain("Workflow unavailable");
      expect(response.text).toContain(
        'href="/workflows">Browse current workflows',
      );
      expect(response.text).not.toContain("## Synthetic input");
      expect(response.headers["content-disposition"]).toBeUndefined();
    }
  }
});

it("[WFDL-01 WFDL-04] keeps concurrent repeated reads exact and isolated across fixed drafts", async () => {
  const get = await workflowHttp();
  const items = await workflowRegistry();
  for (const item of items) {
    const responses = await Promise.all([
      get(`/workflows/${item.id}/download?version=2`).expect(200),
      get(`/workflows/${item.id}/download?version=3`).expect(409),
      get(`/workflows/${item.id}/download?version=2`).expect(200),
    ]);
    for (const response of [responses[0], responses[2]]) {
      expect(Buffer.from(response.text)).toEqual(Buffer.from(item.download));
      expect(response.headers["content-disposition"]).toBe(
        `attachment; filename="${item.id}-v2.md"`,
      );
      expect(response.headers["content-type"]).toBe(
        "text/markdown; charset=utf-8",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(responses[1].text).not.toContain("## Synthetic input");
    expect(responses[1].headers["content-disposition"]).toBeUndefined();
  }
});
