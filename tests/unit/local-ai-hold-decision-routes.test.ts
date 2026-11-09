import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import type {
  HoldTestDecision,
  LocalAiHoldDecisionStore,
} from "../../src/local-ai-hold-decisions.ts";
import { localAiHoldDetailPage } from "../../src/local-ai-hold-inspection-views.ts";
const token = "a".repeat(64),
  secret = "invented-hold-decision-route-secret",
  origin = "http://127.0.0.1:3000",
  jobId = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  path = `/operator/local-ai-holds/${jobId}/test-outcome`;
const decision: HoldTestDecision = {
  outcome: "test-not-executed",
  reason: "operator-test-exercise",
  sourceKind: "invented-test-record",
  sourceReference: "test-record-7",
  priorStatus: "expired-claim",
  decidedAt: "2026-11-07T15:00:00.000Z",
  decidedByReader: false,
};
const body = {
  outcome: "test-executed",
  reason: "matching-test-record",
  sourceReference: "test-record-7",
  key,
};
function fixture(mode: ApplicationMode = "test") {
  const session = vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" });
  const read = vi.fn<LocalAiHoldDecisionStore["read"]>().mockResolvedValue({
    kind: "ready",
    jobId,
    open: true,
    metered: false,
    decision: null,
  });
  const record = vi
    .fn<LocalAiHoldDecisionStore["record"]>()
    .mockResolvedValue({ kind: "applied", decision });
  const application = app({ session } as unknown as Store, {
    origin,
    secret,
    mode,
    localHoldDecisions: { read, record },
  });
  const get = (to = path) =>
    withLoopback(application, (server) =>
      request(server)
        .get(to)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const post = (fields: Record<string, unknown> = body, to = path) =>
    withLoopback(application, (server) =>
      request(server)
        .post(to)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .type("form")
        .send({ csrf: csrf(token, secret), ...fields }),
    );
  const bare = () =>
    withLoopback(application, (server) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${token}`)
        .set("x-csrf-token", csrf(token, secret)),
    );
  return { get, post, bare, read, record };
}

it("HOLDDEC-12 offers a labelled test-outcome form for an open held request", async () => {
  const f = fixture();
  const page = await f.get();
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.text).toContain("NOT PROVIDER-CONFIRMED");
  expect(page.text).toContain("No AI provider confirmed it");
  expect(page.text).toContain('name="sourceReference"');
  expect(page.text).toContain("not metered");
  expect(page.text).not.toContain(token);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(token, jobId);
  f.read.mockResolvedValue({
    kind: "ready",
    jobId,
    open: true,
    metered: true,
    decision: null,
  });
  expect((await f.get()).text).toContain("with a reserved test unit");
});

it("shows a recorded decision, or why none can be recorded, with no form", async () => {
  const f = fixture();
  f.read.mockResolvedValue({
    kind: "ready",
    jobId,
    open: false,
    metered: false,
    decision,
  });
  const page = await f.get();
  expect(page.text).toContain("the request did not run");
  expect(page.text).toContain("Its claim expired without a result");
  expect(page.text).toContain("Another assigned operator");
  expect(page.text).not.toContain("<form");
  f.read.mockResolvedValue({
    kind: "ready",
    jobId,
    open: false,
    metered: false,
    decision: null,
  });
  const closed = await f.get();
  expect(closed.text).toContain("cannot take a test outcome now");
  expect(closed.text).not.toContain("<form");
});

it.each([
  ["denied", 403],
  ["invalid", 400],
  ["unavailable", 503],
] as const)("reports a %s read as %i", async (kind, status) => {
  const f = fixture();
  f.read.mockResolvedValue({ kind });
  expect((await f.get()).status).toBe(status);
});

it("contains read errors and refuses extra query parameters", async () => {
  const f = fixture();
  expect((await f.get(`${path}?member=x`)).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockRejectedValue(Error("PRIVATE-DIAGNOSTIC"));
  const failed = await f.get();
  expect(failed.status).toBe(503);
  expect(failed.text).not.toContain("PRIVATE-DIAGNOSTIC");
});

it("records a decision as 201 and a replay as 200", async () => {
  const f = fixture();
  const created = await f.post();
  expect(created.status).toBe(201);
  expect(created.text).toContain("Test outcome recorded.");
  expect(f.record).toHaveBeenCalledExactlyOnceWith(token, jobId, body);
  f.record.mockResolvedValue({
    kind: "replayed",
    decision: {
      ...decision,
      priorStatus: "needs_reconciliation",
      decidedByReader: true,
    },
  });
  const replay = await f.post();
  expect(replay.status).toBe(200);
  expect(replay.text).toContain("already recorded");
  expect(replay.text).toContain("Its outcome was unknown");
  expect(replay.text).toContain("<dd>You</dd>");
});

it.each([
  ["conflict", 409, "already recorded for this request"],
  ["closed", 409, "cannot take a test outcome now"],
  ["denied", 403, "No current exact assignment"],
  ["invalid", 400, "starts with test-"],
  ["unavailable", 503, "could not be confirmed"],
] as const)("reports a %s write as %i", async (kind, status, text) => {
  const f = fixture();
  f.record.mockResolvedValue({ kind });
  const response = await f.post();
  expect(response.status).toBe(status);
  expect(response.text).toContain(text);
  expect(response.text.includes("Read the current test outcome")).toBe(
    kind !== "denied",
  );
});

it("refuses extra or missing fields and contains write errors", async () => {
  const f = fixture();
  expect((await f.post({ ...body, memberId: "x" })).status).toBe(400);
  const missing: Record<string, unknown> = { ...body };
  delete missing.sourceReference;
  expect((await f.post(missing)).status).toBe(400);
  expect((await f.post(body, `${path}?x=1`)).status).toBe(400);
  expect((await f.bare()).status).toBe(400);
  expect(f.record).not.toHaveBeenCalled();
  f.record.mockRejectedValue(Error("PRIVATE-DIAGNOSTIC"));
  const failed = await f.post();
  expect(failed.status).toBe(503);
  expect(failed.text).not.toContain("PRIVATE-DIAGNOSTIC");
});

it("never reads or records in live mode", async () => {
  const f = fixture("live");
  expect((await f.get()).status).toBe(404);
  expect((await f.post()).status).toBe(404);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.record).not.toHaveBeenCalled();
});

it("links the assigned snapshot to its test outcome", () => {
  expect(
    localAiHoldDetailPage({
      jobId,
      state: "needs-reconciliation",
      status: "needs_reconciliation",
      createdAt: "2026-11-07T12:00:00.000Z",
      updatedAt: "2026-11-07T12:00:00.000Z",
      leaseUntil: null,
      unitState: null,
      policy: null,
      promptTemplateVersion: "local-simulation-v1",
      modelContractVersion: "deterministic-local-v1",
    }),
  ).toContain(`href="${path}"`);
});
