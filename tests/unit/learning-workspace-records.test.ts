import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { mountLearningWorkspaceRecords } from "../../src/learning-workspace-records.ts";
import { csrf } from "../../src/session.ts";
import {
  emptyLearningSnapshot,
  splitLearningSnapshot,
  joinLearningSnapshot,
} from "../../src/learning-workspace-values.ts";
import type {
  LearningFailure,
  LearningRead,
  LearningWorkspaceStore,
} from "../../src/learning-workspace-store.ts";
import {
  bundleFixture,
  identityFixture,
} from "./learning-workspace-fixtures.ts";

const bearer = "a".repeat(64),
  secret = "synthetic-record-secret",
  origin = "http://localhost";
const id = "10000000-0000-4000-8000-000000000001",
  operationId = "20000000-0000-4000-8000-000000000001";
const store = Object.fromEntries(
  [
    "source",
    "create",
    "list",
    "read",
    "find",
    "save",
    "append",
    "history",
    "remove",
    "operation",
  ].map((key) => [key, vi.fn()]),
) as unknown as LearningWorkspaceStore;
const app = express();
app.use((_req, res, next) => {
  res.locals.token = bearer;
  next();
});
mountLearningWorkspaceRecords(app, store, { origin, secret });
const base = "/learn/notebooks",
  path = `${base}/${id}`;
const date = new Date("2026-10-29T12:00:00Z");
const saved = {
  kind: "saved" as const,
  notebookId: id,
  revision: 5,
  decisionSequence: 2,
  savedAt: date,
};
const form = {
  csrf: csrf(bearer, secret),
  operationId,
  expectedRevision: "4",
  confirm: "yes",
};
const statusPath = `${path}/status?operationId=${operationId}&expectedRevision=4`;
function record(): LearningRead {
  const state = emptyLearningSnapshot(bundleFixture, "everyday");
  return {
    ...identityFixture,
    id,
    revision: 4,
    decisionSequence: 2,
    draftRevision: 2,
    draftBasedOnDecisionSequence: 0,
    savedAt: date,
    createdAt: date,
    deletedAt: null,
    availability: "available",
    currentArtifact: { id: 3, text: "Accepted new text" },
    state,
  };
}
beforeEach(() => {
  for (const fn of Object.values(store))
    vi.mocked(fn).mockReset().mockResolvedValue({ kind: "denied" });
  vi.mocked(store.read).mockResolvedValue({ kind: "ok", value: record() });
  vi.mocked(store.history).mockResolvedValue({
    kind: "ok",
    value: { items: [], nextSequence: null },
  });
});

it("LWORK-05 lists owner notebooks in bounded pages without serving teaching sources", async () => {
  vi.mocked(store.list).mockResolvedValue({
    kind: "ok",
    value: { items: [record()], nextCursor: id },
  });
  const first = await request(app).get(base).timeout(1000);
  expect(first.status).toBe(200);
  expect(first.text).toContain('href="/member/export"');
  expect(first.text).toContain(`${base}?after=${id}`);
  expect(first.text).toContain("everyday notebook");
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(store.list).toHaveBeenLastCalledWith(bearer, undefined);
  vi.mocked(store.list).mockResolvedValue({
    kind: "ok",
    value: { items: [], nextCursor: null },
  });
  const second = await request(app)
    .get(`${base}?after=${id}`)
    .set("if-none-match", first.headers.etag!)
    .set("if-modified-since", date.toUTCString())
    .timeout(1000);
  expect(second.status).toBe(200);
  expect(second.text).toContain("No saved notebooks on this page");
  expect(store.list).toHaveBeenLastCalledWith(bearer, id);
  for (const query of ["after=no", "after=a&after=b", "owner=other"])
    expect((await request(app).get(`${base}?${query}`)).status).toBe(400);
  expect((await request(app).get(`${base}/bad`)).status).toBe(400);
  expect(store.source).not.toHaveBeenCalled();
  expect(store.create).not.toHaveBeenCalled();
});

it("LWORK-05 recovers all27 exact saved strings with safe visible control notation and separate draft/head labels", async () => {
  const value = record(),
    parts = splitLearningSnapshot(value.state);
  const text = "<script>\"&'\u0000\r\u007f\u009f\ud800x\udfff\t\n😀";
  value.state = joinLearningSnapshot(
    parts.metadata,
    parts.fields.map(([key], i) => [key, `${i}:${text}`]),
  );
  value.state.feedback.draft.decision = "decline";
  value.availability = "source-unavailable";
  value.currentArtifact = null;
  vi.mocked(store.read).mockResolvedValue({ kind: "ok", value });
  const response = await request(app).get(path);
  expect(response.status).toBe(200);
  expect(response.text).toContain("teaching source is unavailable");
  expect(response.text).toContain(
    "Saved draft revision 2, based on feedback decision 0",
  );
  expect(response.text).toContain("Current feedback head: decision 2");
  expect(response.text).toContain("No accepted artifact");
  expect(response.text).not.toContain("<script>");
  expect(response.text).not.toContain("\u0000");
  for (let i = 0; i < 27; i++)
    expect(response.text).toContain(`${i}:&lt;script&gt;`);
  expect(response.text).toContain(
    "\\u0000\\u000d\\u007f\\u009f\\ud800x\\udfff\t\n😀",
  );
  const download = await request(app).get(`${path}/download`);
  expect(download.headers["content-disposition"]).toContain(`after-0.json`);
  expect(download.body.notebook.state).toEqual(value.state);
  expect(download.body.historyPage).toMatchObject({
    afterSequence: 0,
    items: [],
    nextSequence: null,
    nextDownload: null,
  });
  expect(store.read).toHaveBeenLastCalledWith(bearer, id);
  expect(store.source).not.toHaveBeenCalled();
  const ordinary = record();
  vi.mocked(store.read).mockResolvedValue({ kind: "ok", value: ordinary });
  const normal = await request(app).get(path);
  expect(normal.text).toContain("Continue learning");
  expect(normal.text).toContain("Accepted new text");
  expect(normal.text).toContain("Nothing saved in this field");
  expect(normal.text).toContain('name="expectedRevision" value="4"');
  expect(normal.text).toMatch(/name="operationId" value="[a-f0-9-]{36}"/);
});

it("LWORK-05 pages complete historical decisions and downloads with explicit continuation links", async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    commentVersion: 1,
    fromVersion: i + 1,
    toVersion: i + 2,
    decision: "revise" as const,
    text: `accepted${i}\u0000`,
    proposedText: `proposal${i}<img>`,
    reason: `reason${i}`,
    question: `question${i}`,
    acceptedAt: date,
  }));
  vi.mocked(store.history).mockResolvedValue({
    kind: "ok",
    value: { items, nextSequence: 20 },
  });
  const history = await request(app).get(`${path}/history`);
  expect(history.text).toContain("after decision 0 (up to 20 decisions)");
  expect(history.text).toContain(`${path}/history?after=20`);
  for (const item of items) {
    expect(history.text).toContain(`Decision ${item.id}: revise`);
    expect(history.text).toContain(item.reason);
    expect(history.text).toContain(item.question);
  }
  expect(history.text).toContain("proposal0&lt;img&gt;");
  const downloaded = await request(app).get(`${path}/download?after=20`);
  expect(downloaded.body.historyPage.nextDownload).toBe(
    `${path}/download?after=20`,
  );
  expect(downloaded.body.historyPage.items).toEqual(
    JSON.parse(JSON.stringify(items)),
  );
  expect(store.history).toHaveBeenLastCalledWith(bearer, id, 20);
  vi.mocked(store.history).mockResolvedValue({
    kind: "ok",
    value: { items: [], nextSequence: null },
  });
  const end = await request(app).get(`${path}/history?after=20`);
  expect(end.text).toContain("No further saved feedback decisions");
  expect(end.text).toContain("End of saved history");
  for (const query of [
    "after=-1",
    "after=01",
    "after=1.5",
    "after=9007199254740992",
    "after=1&after=2",
    "owner=other",
  ])
    expect((await request(app).get(`${path}/history?${query}`)).status).toBe(
      400,
    );
});

it("LWORK-06 reauthorizes reads, histories, downloads and receipt inspection instead of cached success", async () => {
  const failures: Array<[LearningFailure["kind"], number]> = [
    ["denied", 401],
    ["unavailable", 503],
    ["invalid", 400],
    ["conflict", 409],
    ["deleted", 410],
    ["source-unavailable", 409],
    ["not-found", 404],
  ];
  for (const [kind, expected] of failures) {
    vi.mocked(store.list).mockResolvedValue({ kind });
    vi.mocked(store.read).mockResolvedValue({ kind });
    expect((await request(app).get(base)).status).toBe(expected);
    for (const suffix of ["", "/history", "/download"])
      expect((await request(app).get(path + suffix)).status).toBe(expected);
  }
  vi.mocked(store.read).mockResolvedValue({ kind: "ok", value: record() });
  vi.mocked(store.history).mockResolvedValue({ kind: "denied" });
  expect((await request(app).get(`${path}/history`)).status).toBe(401);
  expect((await request(app).get(`${path}/download`)).status).toBe(401);
  expect(store.history).toHaveBeenLastCalledWith(bearer, id, 0);
  expect((await request(app).get(statusPath)).status).toBe(401);
  expect(store.operation).toHaveBeenLastCalledWith(bearer, operationId);
});

it("LWORK-06 rejects unconfirmed, cross-origin, forged and malformed deletion requests without storage writes", async () => {
  for (const [overrides, requestOrigin, expected] of [
    [{ csrf: "bad" }, origin, 403],
    [{}, "https://other.invalid", 403],
    [{}, "", 403],
    [{ confirm: "no" }, origin, 400],
    [{ operationId: "bad" }, origin, 400],
    [{ expectedRevision: "0" }, origin, 400],
    [{ expectedRevision: "01" }, origin, 400],
    [{ expectedRevision: "9007199254740992" }, origin, 400],
    [{ unexpected: "owner" }, origin, 400],
  ] as Array<[Record<string, string>, string, number]>)
    expect(
      (
        await request(app)
          .post(`${path}/delete`)
          .set("origin", requestOrigin)
          .type("form")
          .send({ ...form, ...overrides })
      ).status,
    ).toBe(expected);
  expect(
    (await request(app).post(`${path}/delete`).set("origin", origin).send(form))
      .status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .type("form")
        .send({ ...form, operationId: [operationId, operationId] })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .type("form")
        .send({ ...form, expectedRevision: ["4", "4"] })
    ).status,
  ).toBe(400);
  expect(store.remove).not.toHaveBeenCalled();
});

it("LWORK-06 uses one explicit revision and UUID, then checks an uncertain outcome without automatically mutating", async () => {
  for (const kind of ["saved", "replayed", "unavailable"] as const) {
    vi.mocked(store.remove).mockResolvedValue(
      kind === "unavailable" ? { kind } : { ...saved, kind },
    );
    const response = await request(app)
      .post(`${path}/delete`)
      .set("origin", origin)
      .type("form")
      .send(form);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(statusPath);
    expect(store.remove).toHaveBeenLastCalledWith(bearer, id, {
      operationId,
      expectedRevision: 4,
    });
  }
  vi.mocked(store.remove).mockRejectedValueOnce(Error("response uncertain"));
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .type("form")
        .send(form)
    ).headers.location,
  ).toBe(statusPath);
  vi.mocked(store.remove).mockClear();
  vi.mocked(store.operation).mockResolvedValue({ kind: "not-found" });
  const status = await request(app).get(statusPath);
  expect(status.status).toBe(200);
  expect(status.text).toContain("Retry this same deletion");
  expect(status.text).toContain(`name="operationId" value="${operationId}"`);
  expect(status.text).toContain('name="expectedRevision" value="4"');
  expect(store.remove).not.toHaveBeenCalled();
  vi.mocked(store.remove).mockResolvedValue({ kind: "conflict" });
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .type("form")
        .send(form)
    ).status,
  ).toBe(409);
  vi.mocked(store.read).mockResolvedValue({
    kind: "ok",
    value: { ...record(), revision: 5 },
  });
  expect((await request(app).get(statusPath)).status).toBe(409);
});

it("LWORK-06 never mistakes a save/create receipt for proof of deletion and requires a matching notebook tombstone", async () => {
  vi.mocked(store.operation).mockResolvedValue(saved);
  expect((await request(app).get(statusPath)).status).toBe(409);
  vi.mocked(store.read).mockResolvedValue({ kind: "deleted" });
  const removed = await request(app).get(statusPath);
  expect(removed.status).toBe(200);
  expect(removed.text).toContain("receipt and saved record confirm");
  vi.mocked(store.operation).mockResolvedValue({ ...saved, kind: "replayed" });
  expect((await request(app).get(statusPath)).status).toBe(200);
  vi.mocked(store.operation).mockResolvedValue({
    ...saved,
    notebookId: operationId,
  });
  expect((await request(app).get(statusPath)).status).toBe(410);
  vi.mocked(store.operation).mockResolvedValue({ kind: "not-found" });
  expect((await request(app).get(statusPath)).status).toBe(410);
  vi.mocked(store.read).mockResolvedValue({ kind: "denied" });
  expect((await request(app).get(statusPath)).status).toBe(401);
  for (const query of [
    "",
    "operationId=bad&expectedRevision=4",
    `operationId=${operationId}&expectedRevision=0`,
    `operationId=${operationId}&expectedRevision=9007199254740992`,
    `operationId=${operationId}&expectedRevision=4&expectedRevision=4`,
    `operationId=${operationId}&expectedRevision=4&owner=other`,
  ])
    expect((await request(app).get(`${path}/status?${query}`)).status).toBe(
      400,
    );
});

it("LWORK-06 safely handles unavailable reads and bounded form decoding failures", async () => {
  vi.mocked(store.read).mockRejectedValueOnce(
    Error("Synthetic database error"),
  );
  expect((await request(app).get(path)).status).toBe(503);
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .type("form")
        .send(`x=${"x".repeat(9000)}`)
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .set("content-encoding", "gzip")
        .type("form")
        .send("x=y")
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(`${path}/delete`)
        .set("origin", origin)
        .set("content-type", "application/x-www-form-urlencoded; charset=bogus")
        .send("x=y")
    ).status,
  ).toBe(400);
  vi.mocked(store.read).mockRejectedValueOnce("Synthetic transport failure");
  expect((await request(app).get(path)).status).toBe(503);
});
