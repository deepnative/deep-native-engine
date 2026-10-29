import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { mountLearningWorkspacePages } from "../../src/learning-workspace-pages.ts";
import {
  learningWorkspacePack,
  LEARNING_WORKSPACE_CONTENT,
} from "../../src/learning-workspace-pack.ts";
import type { LearningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import type { LearningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";

const token = "original-member-bearer";
const pack = await learningWorkspacePack();
const store = { source: vi.fn() } as unknown as LearningWorkspaceStore;
const publication = {
  preview: vi.fn(),
} as unknown as LearningWorkspacePublicationStore;
const app = express();
app.use((req, res, next) => {
  res.locals.token = token;
  res.locals.csrf = '"<csrf>';
  res.locals.learner = { goal: req.get("x-test-goal") ?? "explore" };
  next();
});
mountLearningWorkspacePages(app, store, publication);
app.get("/learn", (_req, res) => res.send("Earlier lessons and assignments"));
beforeEach(() => {
  vi.mocked(store.source)
    .mockReset()
    .mockResolvedValue({ kind: "ok", value: pack });
  vi.mocked(publication.preview)
    .mockReset()
    .mockResolvedValue({ kind: "ready", pack, state: "not-imported" });
});

it("LWORK-01 opens the published workspace for each goal with the original bearer and no write", async () => {
  for (const [goal, route] of [
    ["explore", "everyday"],
    ["work", "work"],
    ["build", "technical"],
  ]) {
    const response = await request(app).get("/learn").set("x-test-goal", goal!);
    expect(response.status).toBe(200);
    expect(response.text).toContain(`data-workspace-route="${route}"`);
    expect(response.text).toContain('href="/learn/notebooks"');
    expect(response.text).toContain('data-workspace-csrf="&quot;&lt;csrf&gt;"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(store.source).toHaveBeenLastCalledWith(token, {
      contentId: LEARNING_WORKSPACE_CONTENT.id,
      contentVersion: 1,
      contentHash: pack.contentHash,
      variant: route,
    });
  }
});

it("LWORK-07 keeps earlier lessons reachable explicitly and before publication or after retirement", async () => {
  const redirect = await request(app).get("/learn/records");
  expect(redirect.status).toBe(303);
  expect(redirect.headers.location).toBe("/learn?view=records");
  expect((await request(app).get(redirect.headers.location!)).text).toBe(
    "Earlier lessons and assignments",
  );
  expect(store.source).not.toHaveBeenCalled();
  vi.mocked(store.source).mockResolvedValue({ kind: "source-unavailable" });
  expect((await request(app).get("/learn")).text).toBe(
    "Earlier lessons and assignments",
  );
});

it("LWORK-05/06 reauthorizes reloads and keeps failure recovery free of private errors", async () => {
  const first = await request(app).get("/learn");
  vi.mocked(store.source).mockResolvedValue({ kind: "denied" });
  const denied = await request(app)
    .get("/learn")
    .set("if-none-match", first.headers.etag!);
  expect(denied.status).toBe(303);
  expect(denied.headers.location).toBe("/");
  for (const kind of [
    "unavailable",
    "invalid",
    "conflict",
    "deleted",
    "not-found",
  ] as const) {
    vi.mocked(store.source).mockResolvedValue({ kind });
    const response = await request(app).get("/learn");
    expect(response.status).toBe(503);
    expect(response.text).toContain('href="/learn/notebooks"');
    expect(response.text).not.toContain("data-workspace-module-base");
  }
  vi.mocked(store.source).mockRejectedValue(
    new Error("private database detail"),
  );
  expect((await request(app).get("/learn")).text).not.toContain(
    "private database detail",
  );
});

it("LWORK-05 offers explicit draft import and complete source inspection without automatic publication", async () => {
  const response = await request(app).get("/editor/library/learning-workspace");
  expect(response.status).toBe(200);
  expect(response.text).toContain(
    'action="/editor/library/learning-workspace/import"',
  );
  expect(response.text).toContain(
    'href="/editor/library/learning-workspace/bundle"',
  );
  expect(response.text).toContain('value="&quot;&lt;csrf&gt;"');
  expect(publication.preview).toHaveBeenCalledWith(token);
  for (const state of [
    "draft",
    "in-review",
    "approved",
    "published",
    "retired",
  ] as const) {
    vi.mocked(publication.preview).mockResolvedValue({
      kind: "ready",
      pack,
      state,
    } as never);
    const existing = await request(app).get(
      "/editor/library/learning-workspace",
    );
    expect(existing.text).toContain('href="/editor/library/LRN-001/1"');
    expect(existing.text).not.toContain("<form");
  }
});

it("LWORK-05 denies unauthorized bundle inspection and explains mismatched/unavailable versions", async () => {
  for (const [kind, status] of [
    ["denied", 403],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const) {
    vi.mocked(publication.preview).mockResolvedValue({ kind });
    const response = await request(app).get(
      "/editor/library/learning-workspace",
    );
    expect(response.status).toBe(status);
    expect(response.text).not.toContain("<form");
  }
  vi.mocked(publication.preview).mockRejectedValue(
    new Error("private bundle detail"),
  );
  const response = await request(app).get("/editor/library/learning-workspace");
  expect(response.status).toBe(503);
  expect(response.text).not.toContain("private bundle detail");
});
