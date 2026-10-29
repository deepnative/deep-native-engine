import express from "express";
import request from "supertest";
import { type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { csrf } from "../../src/session.ts";
import { mountLearningWorkspaceRoutes } from "../../src/learning-workspace-routes.ts";
import type { LearningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import { LEARNING_WORKSPACE_CONTENT } from "../../src/learning-workspace-pack.ts";

const bearer = "a".repeat(64);
const secret = "synthetic-test-secret";
const origin = "http://localhost";
const store = Object.fromEntries(
  [
    "find",
    "source",
    "create",
    "list",
    "read",
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
mountLearningWorkspaceRoutes(app, store, { origin, secret });
let server: Server;
beforeAll(async () => {
  server = await listenLoopback(app);
});
afterAll(async () => {
  await closeLoopback(server);
});
const path = "/api/learning-workspace";
const identity = {
  contentId: LEARNING_WORKSPACE_CONTENT.id,
  contentVersion: LEARNING_WORKSPACE_CONTENT.version,
  contentHash: LEARNING_WORKSPACE_CONTENT.contentHash,
  variant: "work",
};
const operation = {
  operationId: "10000000-0000-4000-8000-000000000001",
  expectedRevision: 1,
};
const headers = { origin, "x-csrf-token": csrf(bearer, secret) };
beforeEach(() => {
  for (const fn of Object.values(store))
    vi.mocked(fn).mockReset().mockResolvedValue({ kind: "denied" });
});

it("opens only the requested registered variant without implicitly creating work", async () => {
  vi.mocked(store.find).mockResolvedValue({ kind: "not-found" });
  const response = await request(server).get(`${path}/current?variant=work`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ kind: "empty" });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(store.find).toHaveBeenCalledWith(bearer, identity);
  expect(store.create).not.toHaveBeenCalled();
  for (const query of [
    "",
    "variant=unknown",
    "variant=work&variant=everyday",
    "variant=work&owner=other",
  ])
    expect((await request(server).get(`${path}/current?${query}`)).status).toBe(
      400,
    );
});

it("preserves original bearer and operation identity across each explicit write", async () => {
  const saved = {
    kind: "saved" as const,
    notebookId: "own",
    revision: 2,
    decisionSequence: 1,
    savedAt: new Date("2026-10-29T12:00:00Z"),
  };
  vi.mocked(store.create).mockResolvedValue(saved);
  vi.mocked(store.save).mockResolvedValue(saved);
  vi.mocked(store.append).mockResolvedValue(saved);
  vi.mocked(store.remove).mockResolvedValue({ ...saved, kind: "replayed" });
  const create = { ...identity, operationId: operation.operationId };
  expect(
    (await request(server).post(`${path}/notebooks`).set(headers).send(create))
      .body.kind,
  ).toBe("saved");
  expect(store.create).toHaveBeenCalledWith(bearer, create);
  const draft = {
    ...operation,
    state: { exact: "NUL\u0000lone\ud800" },
    basedOnDecisionSequence: 1,
  };
  expect(
    (
      await request(server)
        .put(`${path}/notebooks/own/draft`)
        .set(headers)
        .send(draft)
    ).status,
  ).toBe(200);
  expect(store.save).toHaveBeenCalledWith(bearer, "own", draft);
  const append = {
    ...operation,
    decision: { text: "a bounded private revision" },
  };
  expect(
    (
      await request(server)
        .post(`${path}/notebooks/own/feedback-decisions`)
        .set(headers)
        .send(append)
    ).status,
  ).toBe(200);
  expect(store.append).toHaveBeenCalledWith(bearer, "own", append);
  expect(
    (
      await request(server)
        .delete(`${path}/notebooks/own`)
        .set(headers)
        .send(operation)
    ).body.kind,
  ).toBe("replayed");
  expect(store.remove).toHaveBeenCalledWith(bearer, "own", operation);
});

it("rejects cross-origin, missing CSRF, wrong media and unexpected write fields before storage", async () => {
  for (const override of [
    { origin: "https://elsewhere.example" },
    { "x-csrf-token": "bad" },
    { origin: "" },
  ])
    expect(
      (
        await request(server)
          .post(`${path}/notebooks`)
          .set({ ...headers, ...override })
          .send({})
      ).status,
    ).toBe(403);
  expect(
    (
      await request(server)
        .post(`${path}/notebooks`)
        .set(headers)
        .type("form")
        .send("variant=work")
    ).status,
  ).toBe(415);
  for (const route of ["/notebooks", "/notebooks/own/feedback-decisions"])
    expect(
      (
        await request(server)
          .post(path + route)
          .set(headers)
          .send({})
      ).status,
    ).toBe(400);
  expect(
    (
      await request(server)
        .put(`${path}/notebooks/own/draft`)
        .set(headers)
        .send({
          ...operation,
          state: {},
          basedOnDecisionSequence: 0,
          memberId: "other",
        })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(server)
        .delete(`${path}/notebooks/own`)
        .set(headers)
        .send({})
    ).status,
  ).toBe(400);
  for (const method of [store.create, store.save, store.append, store.remove])
    expect(method).not.toHaveBeenCalled();
});

it("returns owner reads, paged history and receipt inspection without conditional-cache shortcuts", async () => {
  const read = { kind: "ok" as const, value: { exact: "own\u0000draft" } };
  vi.mocked(store.read).mockResolvedValue(read as never);
  const first = await request(server).get(`${path}/notebooks/own`);
  const cached = await request(server)
    .get(`${path}/notebooks/own`)
    .set("if-none-match", first.headers.etag!);
  expect(cached.status).toBe(200);
  expect(cached.body).toEqual(read);
  expect(store.read).toHaveBeenCalledWith(bearer, "own");
  vi.mocked(store.list).mockResolvedValue({
    kind: "ok",
    value: { items: [], nextCursor: null },
  });
  expect(
    (await request(server).get(`${path}/notebooks?after=known`)).status,
  ).toBe(200);
  expect(store.list).toHaveBeenLastCalledWith(bearer, "known");
  await request(server).get(`${path}/notebooks`);
  expect(store.list).toHaveBeenLastCalledWith(bearer, undefined);
  for (const query of ["after=a&after=b", "owner=other"])
    expect(
      (await request(server).get(`${path}/notebooks?${query}`)).status,
    ).toBe(400);
  vi.mocked(store.history).mockResolvedValue({
    kind: "ok",
    value: { items: [], nextSequence: null },
  });
  await request(server).get(`${path}/notebooks/own/history?after=20`);
  expect(store.history).toHaveBeenLastCalledWith(bearer, "own", 20);
  await request(server).get(`${path}/notebooks/own/history`);
  expect(store.history).toHaveBeenLastCalledWith(bearer, "own", undefined);
  for (const query of [
    "after=-1",
    "after=01",
    "after=1.5",
    "after=9007199254740992",
    "after=1&after=2",
    "owner=other",
  ])
    expect(
      (await request(server).get(`${path}/notebooks/own/history?${query}`))
        .status,
    ).toBe(400);
  vi.mocked(store.operation).mockResolvedValue({ kind: "not-found" });
  expect(
    (await request(server).get(`${path}/operations/${operation.operationId}`))
      .status,
  ).toBe(404);
  expect(store.operation).toHaveBeenCalledWith(bearer, operation.operationId);
});

it("preserves store failure distinctions and hides unexpected exceptions", async () => {
  for (const [kind, code] of Object.entries({
    denied: 401,
    unavailable: 503,
    invalid: 400,
    conflict: 409,
    deleted: 410,
    "source-unavailable": 409,
  })) {
    vi.mocked(store.find).mockResolvedValue({ kind } as never);
    const response = await request(server).get(
      `${path}/current?variant=everyday`,
    );
    expect(response.status).toBe(code);
    expect(response.body).toEqual({ kind });
  }
  for (const error of [
    new Error("private database detail"),
    "private detail",
  ]) {
    vi.mocked(store.read).mockRejectedValueOnce(error);
    const response = await request(server).get(`${path}/notebooks/own`);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ kind: "unavailable" });
  }
});

it("accepts the largest fixed writing payload and rejects oversized/malformed/encoded requests safely", async () => {
  vi.mocked(store.save).mockResolvedValue({ kind: "invalid" });
  const fields = Array.from({ length: 27 }, () => "\u0000".repeat(30000));
  const body = JSON.stringify({
    ...operation,
    state: fields,
    basedOnDecisionSequence: 0,
  });
  expect(Buffer.byteLength(body)).toBeGreaterThan(4_800_000);
  const full = await request(server)
    .put(`${path}/notebooks/own/draft`)
    .set(headers)
    .type("json")
    .send(body);
  expect(full.status).toBe(400); // Domain validation, not a body-limit rejection.
  expect(store.save).toHaveBeenCalledWith(
    bearer,
    "own",
    expect.objectContaining({ state: fields }),
  );
  const large = await request(server)
    .put(`${path}/notebooks/own/draft`)
    .set(headers)
    .type("json")
    .send(JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) }));
  expect(large.status).toBe(413);
  const malformed = await request(server)
    .post(`${path}/notebooks`)
    .set(headers)
    .type("json")
    .send('{"private":');
  expect(malformed.status).toBe(400);
  expect(malformed.body).toEqual({ kind: "invalid" });
  expect(
    (
      await request(server)
        .post(`${path}/notebooks`)
        .set(headers)
        .set("Content-Encoding", "gzip")
        .type("json")
        .send("{}")
    ).status,
  ).toBe(415);
  expect(
    (
      await request(server)
        .post(`${path}/notebooks`)
        .set(headers)
        .set("Content-Type", "application/json; charset=iso-8859-1")
        .send("{}")
    ).status,
  ).toBe(415);
});
