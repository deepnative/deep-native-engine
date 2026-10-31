import { readFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { csrf } from "../../src/session.ts";
import {
  mountLearningWorkspaceAssets,
  LEARNING_WORKSPACE_ASSET_BASE as base,
} from "../../src/learning-workspace-assets.ts";
import { learningWorkspacePack } from "../../src/learning-workspace-pack.ts";
import type { LearningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import type { LearningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(
    (await original<typeof import("node:fs/promises")>()).readFile,
  ),
}));
const original =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const pack = await learningWorkspacePack();
const bearer = "b".repeat(64);
const secret = "synthetic-secret";
const origin = "http://localhost";
const teaching = "/editor/library/learning-workspace";
const store = { source: vi.fn() } as unknown as LearningWorkspaceStore;
const publication = {
  preview: vi.fn(),
  import: vi.fn(),
} as unknown as LearningWorkspacePublicationStore;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => {
  res.locals.token = bearer;
  next();
});
mountLearningWorkspaceAssets(app, store, publication, { origin, secret });
let server: Server;
beforeAll(async () => {
  server = await listenLoopback(app);
});
afterAll(async () => {
  await closeLoopback(server);
});
beforeEach(() => {
  vi.mocked(readFile).mockClear().mockImplementation(original.readFile);
  vi.mocked(store.source).mockReset().mockResolvedValue({ kind: "denied" });
  vi.mocked(publication.preview)
    .mockReset()
    .mockResolvedValue({ kind: "denied" });
  vi.mocked(publication.import)
    .mockReset()
    .mockResolvedValue({ kind: "denied" });
});

it("serves the full exact course only from a freshly authorized source, never a public file fallback", async () => {
  vi.mocked(store.source).mockResolvedValue({ kind: "ok", value: pack });
  const first = await request(server).get(`${base}/course.mjs`);
  expect(first.status).toBe(200);
  expect(first.text).toBe(pack.module);
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.headers["content-type"]).toContain("javascript");
  expect(store.source).toHaveBeenCalledWith(
    bearer,
    expect.objectContaining({
      contentId: "LRN-001",
      contentVersion: 1,
      contentHash: pack.contentHash,
    }),
  );
  vi.mocked(store.source).mockResolvedValue({ kind: "source-unavailable" });
  expect(
    (
      await request(server)
        .get(`${base}/course.mjs`)
        .set("if-none-match", first.headers.etag!)
    ).status,
  ).toBe(409);
  expect(readFile).not.toHaveBeenCalled();
  for (const filename of [
    "course.json",
    "local-entry.mjs",
    "build.py",
    "checks.mjs",
    "index.html",
  ]) {
    expect((await request(server).get(`${base}/${filename}`)).status).toBe(404);
  }
  expect(readFile).not.toHaveBeenCalled();
});

it("provides only the five allowlisted generic rendering assets at the exact version prefix", async () => {
  for (const filename of [
    "reader.mjs",
    "feedback.mjs",
    "contribution.mjs",
    "browser-notebook.mjs",
    "style.css",
  ]) {
    const result = await request(server).get(`${base}/${filename}`);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain(
      filename.endsWith(".css") ? "text/css" : "javascript",
    );
    expect(result.text).toBe(
      await original.readFile(
        new URL(
          `../../assets/docs/learning-design/reader/${filename}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  expect(store.source).not.toHaveBeenCalled();
  const font = await request(server).get(`${base}/fonts/InterVariable.woff2`);
  expect(font.status).toBe(200);
  expect(font.headers["content-type"]).toBe("font/woff2");
  expect(font.body).toEqual(
    await original.readFile(
      new URL(
        "../../assets/docs/learning-design/reader/fonts/InterVariable.woff2",
        import.meta.url,
      ),
    ),
  );
  expect(
    (
      await request(server).get(
        base.replace("LRN-001", "LRN-999") + "/reader.mjs",
      )
    ).status,
  ).toBe(404);
});

it("fails closed for denied, missing or malformed sources and unavailable assets", async () => {
  expect((await request(server).get(`${base}/course.mjs`)).status).toBe(403);
  vi.mocked(store.source).mockResolvedValue({
    kind: "ok",
    value: { ...pack, module: undefined },
  } as never);
  expect((await request(server).get(`${base}/course.mjs`)).status).toBe(503);
  vi.mocked(store.source).mockResolvedValue({ kind: "ok", value: {} } as never);
  expect((await request(server).get(`${base}/course.mjs`)).status).toBe(503);
  vi.mocked(store.source).mockRejectedValue(
    new Error("private filesystem detail"),
  );
  expect((await request(server).get(`${base}/course.mjs`)).body).toEqual({
    kind: "unavailable",
  });
  vi.mocked(readFile).mockRejectedValue(new Error("private path"));
  expect(
    (await request(server).get(`${base}/fonts/InterVariable.woff2`)).status,
  ).toBe(503);
  expect((await request(server).get(`${base}/reader.mjs`)).body).toEqual({
    kind: "unavailable",
  });
});

it("lets current staff inspect the complete bundle without granting learner publication", async () => {
  vi.mocked(publication.preview).mockResolvedValue({
    kind: "ready",
    pack,
    state: "draft",
  });
  const first = await request(server).get(`${teaching}/bundle`);
  expect(first.status).toBe(200);
  expect(first.body.course).toEqual(pack.course);
  expect(first.body.publication).toEqual(pack.publication);
  expect(first.body.state).toBe("draft");
  expect(publication.preview).toHaveBeenCalledWith(bearer);
  expect(publication.import).not.toHaveBeenCalled();
  expect(store.source).not.toHaveBeenCalled();
  vi.mocked(publication.preview).mockResolvedValue({ kind: "denied" });
  expect(
    (
      await request(server)
        .get(`${teaching}/bundle`)
        .set("if-none-match", first.headers.etag!)
    ).status,
  ).toBe(403);
  vi.mocked(publication.preview).mockRejectedValue(new Error("private detail"));
  expect((await request(server).get(`${teaching}/bundle`)).body).toEqual({
    kind: "unavailable",
  });
});

it("requires explicit same-origin CSRF-protected import and preserves editorial lifecycle results", async () => {
  const form = { csrf: csrf(bearer, secret) };
  expect(
    (await request(server).post(`${teaching}/import`).type("form").send(form))
      .status,
  ).toBe(403);
  expect(
    (
      await request(server)
        .post(`${teaching}/import`)
        .set("origin", origin)
        .type("form")
        .send({ csrf: "bad" })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(server)
        .post(`${teaching}/import`)
        .set("origin", origin)
        .type("form")
        .send({ ...form, publish: "yes" })
    ).status,
  ).toBe(400);
  expect(publication.import).not.toHaveBeenCalled();
  for (const [kind, status] of [
    ["imported", 200],
    ["existing", 200],
    ["denied", 403],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const) {
    vi.mocked(publication.import).mockResolvedValue({ kind });
    const response = await request(server)
      .post(`${teaching}/import`)
      .set("origin", origin)
      .type("form")
      .send(form);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ kind });
    expect(publication.import).toHaveBeenLastCalledWith(bearer);
  }
  vi.mocked(publication.import).mockRejectedValue(
    new Error("private database detail"),
  );
  expect(
    (
      await request(server)
        .post(`${teaching}/import`)
        .set("origin", origin)
        .type("form")
        .send(form)
    ).body,
  ).toEqual({ kind: "unavailable" });
});

it("returns an explicit HTML draft import to the ordinary editorial version", async () => {
  for (const kind of ["imported", "existing"] as const) {
    vi.mocked(publication.import).mockResolvedValue({ kind });
    const response = await request(server)
      .post(`${teaching}/import`)
      .set("origin", origin)
      .set("accept", "text/html")
      .type("form")
      .send({ csrf: csrf(bearer, secret) });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/editor/library/LRN-001/1");
  }
});

it("gives failed HTML imports a read-only inspection path before an explicit retry", async () => {
  const post = (form = { csrf: csrf(bearer, secret) }) =>
    request(server)
      .post(`${teaching}/import`)
      .set("origin", origin)
      .set("accept", "text/html")
      .type("form")
      .send(form);
  expect((await post({ csrf: "wrong" })).status).toBe(403);
  expect(
    (await post({ csrf: csrf(bearer, secret), publish: "yes" } as never))
      .status,
  ).toBe(400);
  for (const [kind, status] of [
    ["denied", 403],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const) {
    vi.mocked(publication.import).mockResolvedValue({ kind });
    const response = await post();
    expect(response.status).toBe(status);
    expect(response.text).toContain(`href="${teaching}"`);
    expect(response.text).not.toContain("<form");
    expect(response.text).not.toContain("refresh");
    if (kind === "unavailable")
      expect(response.text).toContain("The draft may already exist");
  }
  vi.mocked(publication.import).mockRejectedValue(new Error("private result"));
  const response = await post();
  expect(response.status).toBe(503);
  expect(response.text).toContain(
    "inspect its current state before trying again",
  );
  expect(response.text).not.toContain("private result");
});
