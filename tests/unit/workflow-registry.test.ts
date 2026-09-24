import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import {
  workflowBundle,
  workflowRegistry,
} from "../../src/workflow-registry.ts";
import type { Store } from "../../src/store.ts";

it("loads only the three fixed synthetic Markdown bundles and filters their metadata", async () => {
  const all = await workflowRegistry();
  expect(all.map((item) => item.id)).toEqual(["WF-001", "WF-002", "WF-003"]);
  for (const item of all) {
    expect(item.version).toBe(1);
    expect(item.body).toContain("## Synthetic input");
    expect(item.body).toContain("## Hand-authored example");
    expect(item.setup).toBeTruthy();
    expect(item.license).toContain("pending owner decision");
    expect(item.lastVerification).toContain("no live");
    expect(item.download).toContain(`id: ${item.id}`);
  }
  expect(
    (await workflowRegistry("  MEETING  ")).map((item) => item.id),
  ).toEqual(["WF-003"]);
  expect(await workflowRegistry("no matching goal")).toEqual([]);
  expect(await workflowBundle("../../package.json")).toBeNull();
});

it("serves read-only demonstration pages and inert Markdown attachments", async () => {
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  const server = app(store, {
    origin: "http://127.0.0.1:3000",
    secret: "secret",
  });
  const get = (path: string) =>
    request(server).get(path).set("Host", "127.0.0.1:3000");
  const list = await get("/workflows").expect(200);
  expect(list.text).toContain("WF-003");
  expect(list.text).toContain("NOT REVIEWED FOR PUBLICATION");
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
  const download = await get("/workflows/WF-003/download").expect(200);
  expect(download.headers["content-disposition"]).toContain(
    'attachment; filename="WF-003-v1.md"',
  );
  expect(download.headers["x-content-type-options"]).toBe("nosniff");
  expect(download.text).toContain(
    "# Workflow demonstration: extract meeting actions",
  );
  await get("/workflows/unknown").expect(404);
  await get("/workflows/unknown/download").expect(404);
});
