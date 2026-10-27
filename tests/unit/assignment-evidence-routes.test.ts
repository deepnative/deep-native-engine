import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { mountAssignmentEvidenceRoutes } from "../../src/assignment-evidence-routes.ts";
import { ASSIGNMENT_INSPECT_PATH } from "../../src/assignment-evidence-views.ts";
import type {
  AssignmentEvidenceStore,
  AssignmentEvidenceReceipt,
} from "../../src/assignment-evidence.ts";
import { ASSIGNMENT_ORIGIN_LABEL } from "../../src/assignment-evidence-values.ts";
import { config } from "../../src/config.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) await closeLoopback(server);
  servers.clear();
});
const attemptId = randomUUID(),
  base = `/assignments/attempts/${attemptId}/handoff`;
const source = {
  attemptId,
  sequence: 1,
  contentId: "ASSIGN-545",
  contentVersion: 2,
  title: "My <assignment>",
  rubric: "Explain <why>",
  rubricVersion: 3,
  response: "My own <response>\r\nwith details.",
  submittedAt: new Date("2026-10-27T12:00:00Z"),
  sourceSha256: "a".repeat(64),
};
const receipt: AssignmentEvidenceReceipt = {
  receiptId: randomUUID(),
  evidenceId: randomUUID(),
  createdAt: new Date(),
  state: "available",
  assignmentOrigin: {
    kind: "member-assignment-submission",
    attemptId,
    sequence: 1,
    contentId: source.contentId,
    contentVersion: 2,
    rubricVersion: 3,
    submittedAt: source.submittedAt,
    sourceSha256: source.sourceSha256,
    acknowledgedAt: new Date(),
    label: ASSIGNMENT_ORIGIN_LABEL,
  },
};
const input = () => ({
  csrf: "nonce",
  operationId: randomUUID(),
  sequence: "1",
  contentId: source.contentId,
  contentVersion: "2",
  rubricVersion: "3",
  sourceSha256: source.sourceSha256,
  privateReview: "yes",
});
async function fixture(enabled = true, present = true) {
  const store = {
    open: vi.fn<AssignmentEvidenceStore["open"]>().mockResolvedValue({
      kind: "ready",
      source,
      deadline: performance.now() + 60000,
    }),
    create: vi.fn<AssignmentEvidenceStore["create"]>().mockResolvedValue({
      kind: "created",
      receipt,
      deadline: performance.now() + 60000,
    }),
    inspect: vi.fn<AssignmentEvidenceStore["inspect"]>().mockResolvedValue({
      kind: "ready",
      receipt,
      deadline: performance.now() + 60000,
    }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = "b".repeat(64);
    res.locals.csrf = "nonce";
    next();
  });
  mountAssignmentEvidenceRoutes(app, present ? store : undefined, enabled);
  const server = await listenLoopback(app);
  servers.add(server);
  return { server, store };
}
it("AHO-01/02 previews only the selected response, escapes text and leaves consent unchecked", async () => {
  const f = await fixture(),
    r = await request(f.server)
      .get(base + "?sequence=1")
      .expect(200);
  expect(r.text).toContain("My own &lt;response&gt;&#13;\nwith details.");
  expect(r.text).toContain("rubric · version 3");
  expect(r.text).toContain('name="privateReview"');
  expect(r.text).not.toContain(" checked");
  expect(r.text).not.toContain("invented");
  expect(f.store.open).toHaveBeenCalledWith("b".repeat(64), attemptId, 1);
  expect(f.store.create).not.toHaveBeenCalled();
});
it("AHO-10 disables new copies but retains current-owner inspection", async () => {
  for (const f of [await fixture(false), await fixture(true, false)]) {
    await request(f.server)
      .get(base + "?sequence=1")
      .expect(404);
    await request(f.server).post(base).type("form").send(input()).expect(404);
    expect(f.store.create).not.toHaveBeenCalled();
  }
  const f = await fixture(false);
  await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  const absent = await fixture(true, false);
  await request(absent.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(404);
});
it("AHO-02/04 rejects extra or missing fields and missing permission without a write", async () => {
  const f = await fixture();
  for (const query of ["", "?sequence=1&extra=x", "?sequence=1&sequence=2"])
    await request(f.server)
      .get(base + query)
      .expect(422);
  for (const body of [
    {},
    { ...input(), extra: "x" },
    { ...input(), privateReview: "no" },
    { ...input(), sequence: "01" },
    { ...input(), contentVersion: "0" },
    { ...input(), rubricVersion: "NaN" },
  ])
    await request(f.server).post(base).type("form").send(body).expect(422);
  await request(f.server)
    .post(base + "?extra=x")
    .type("form")
    .send(input())
    .expect(422);
  await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH + "?extra=x")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(422);
  await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce" })
    .expect(422);
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.store.inspect).not.toHaveBeenCalled();
});
it("AHO-03/10 provides fresh read-only inspection forms while creation is disabled and never accepts a key in the URL", async () => {
  const f = await fixture(false);
  const form = await request(f.server).get(ASSIGNMENT_INSPECT_PATH).expect(200);
  expect(form.text).toContain('name="csrf" value="nonce"');
  expect(form.text).toContain("Original copy request reference");
  expect(form.text).toContain('method="post"');
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.store.inspect).not.toHaveBeenCalled();
  const operationId = randomUUID();
  const rejected = await request(f.server)
    .get(`${ASSIGNMENT_INSPECT_PATH}?operationId=${operationId}`)
    .expect(422);
  expect(rejected.text).not.toContain(operationId);
  const absent = await fixture(false, false);
  await request(absent.server).get(ASSIGNMENT_INSPECT_PATH).expect(404);
});
it("AHO-02/03 shows canonical created and replayed outcomes without requesting review", async () => {
  const f = await fixture(),
    b = input();
  const first = await request(f.server)
    .post(base)
    .type("form")
    .send(b)
    .expect(200);
  expect(first.text).toContain("Your private assignment copy was saved.");
  expect(first.text).toContain(
    `data-assignment-evidence="${receipt.evidenceId}"`,
  );
  expect(f.store.create).toHaveBeenCalledWith("b".repeat(64), {
    operationId: b.operationId,
    attemptId,
    sequence: 1,
    contentId: source.contentId,
    contentVersion: 2,
    rubricVersion: 3,
    sourceSha256: source.sourceSha256,
    privateReview: true,
  });
  f.store.create.mockResolvedValueOnce({
    kind: "replayed",
    receipt: {
      ...receipt,
      evidenceId: null,
      state: "removed",
      assignmentOrigin: null,
    },
    deadline: performance.now() + 60000,
  });
  const repeated = await request(f.server)
    .post(base)
    .type("form")
    .send(b)
    .expect(200);
  expect(repeated.text).toContain("No new copy or permission");
  expect(repeated.text).toContain("cannot recreate it");
  expect(repeated.text).not.toContain("data-assignment-evidence");
});
it("AHO-03 preserves the exact original request after an uncertain write or late handback", async () => {
  const f = await fixture(),
    b = input();
  for (const result of [
    { kind: "unavailable" } as const,
    { kind: "created", receipt, deadline: performance.now() - 1 } as const,
  ]) {
    f.store.create.mockResolvedValueOnce(result);
    const r = await request(f.server)
      .post(base)
      .type("form")
      .send(b)
      .expect(503);
    expect(r.text).toContain('action="' + ASSIGNMENT_INSPECT_PATH + '"');
    expect(r.text).toContain(b.operationId);
    expect(r.text).toContain("Repeat this original copy request");
    expect(r.text).not.toContain(" checked");
  }
  f.store.create.mockRejectedValueOnce(Error("lost response"));
  await request(f.server).post(base).type("form").send(b).expect(503);
  expect(f.store.create).toHaveBeenCalledTimes(3);
});
it("AHO-04 propagates denial, malformed input, conflict and unavailable state without source text", async () => {
  const f = await fixture();
  for (const [kind, status] of [
    ["invalid", 422],
    ["denied", 403],
    ["conflict", 409],
    ["disabled", 404],
    ["unavailable", 503],
  ] as const) {
    f.store.open.mockResolvedValueOnce({ kind });
    const r = await request(f.server)
      .get(base + "?sequence=1")
      .expect(status);
    expect(r.text).not.toContain("My own &lt;response&gt;");
    f.store.create.mockResolvedValueOnce({ kind });
    await request(f.server)
      .post(base)
      .type("form")
      .send(input())
      .expect(status);
    f.store.inspect.mockResolvedValueOnce({ kind });
    await request(f.server)
      .post(ASSIGNMENT_INSPECT_PATH)
      .type("form")
      .send({ csrf: "nonce", operationId: randomUUID() })
      .expect(status);
  }
});
it("AHO-04 never sends private source text after read expiry or failed acquisition", async () => {
  const f = await fixture();
  for (const deadline of [NaN, performance.now() - 1]) {
    f.store.open.mockResolvedValueOnce({ kind: "ready", source, deadline });
    await request(f.server)
      .get(base + "?sequence=1")
      .expect(403);
  }
  f.store.open.mockRejectedValueOnce(Error("connection"));
  await request(f.server)
    .get(base + "?sequence=1")
    .expect(503);
  f.store.inspect.mockRejectedValueOnce(Error("connection"));
  await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(503);
  f.store.inspect.mockResolvedValueOnce({
    kind: "ready",
    receipt,
    deadline: performance.now() - 1,
  });
  await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(403);
});
it("AHO-03 reports an absent receipt without assuming no commit", async () => {
  const f = await fixture();
  f.store.inspect.mockResolvedValueOnce({
    kind: "absent",
    deadline: performance.now() + 60000,
  });
  const r = await request(f.server)
    .post(ASSIGNMENT_INSPECT_PATH)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  expect(r.text).toContain("does not establish that the request failed");
  expect(r.text).not.toContain('action="' + base + '"');
});
it("AHO-10 accepts explicit local or hosted creation and rejects ambiguous configuration", () => {
  const local = { DNE_DATABASE_URL: "postgresql://localhost/dne_demo" };
  expect(config(local).assignmentHandoff).toBe(false);
  expect(
    config({ ...local, DNE_ASSIGNMENT_HANDOFF: "enabled" }).assignmentHandoff,
  ).toBe(true);
  expect(() => config({ ...local, DNE_ASSIGNMENT_HANDOFF: "true" })).toThrow(
    "DNE_ASSIGNMENT_HANDOFF",
  );
  const hosted = {
    DNE_DATABASE_URL:
      "postgresql://app:unit-only@database.postgres.database.azure.com/deepnative?sslmode=verify-full",
    DNE_PUBLIC_ORIGIN: "https://engine.deepnative.io",
    DNE_AZURE_BLOB_ACCOUNT_URL: "https://enginefiles.blob.core.windows.net",
    DNE_AZURE_BLOB_CONTAINER: "private-evidence",
    DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID: randomUUID(),
    DNE_ASSIGNMENT_HANDOFF: "enabled",
  };
  expect(config(hosted).assignmentHandoff).toBe(true);
});
