import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountPreparedSampleRoutes } from "../../src/prepared-sample-routes.ts";
import type {
  PreparedSampleStore,
  PreparedReceipt,
} from "../../src/prepared-samples.ts";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
} from "../../src/prepared-sample-values.ts";
import type { Server } from "node:http";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
const listeners = new Set<Server>();
afterEach(async () => {
  for (const listener of listeners) await closeLoopback(listener);
  listeners.clear();
});
const template = PREPARED_SAMPLES[0]!,
  base = "/evidence/prepared";
const input = () => ({
  csrf: "nonce",
  operationId: randomUUID(),
  templateId: template.id,
  templateVersion: "1",
  templateDigest: template.digest,
  providedExample: "yes",
  privateReview: "yes",
});
const receipt: PreparedReceipt = {
  receiptId: randomUUID(),
  evidenceId: randomUUID(),
  createdAt: new Date(),
  state: "available",
  origin: {
    kind: "platform-provided-invented",
    templateId: template.id,
    templateVersion: 1,
    templateDigest: template.digest,
    acknowledgedAt: new Date(),
    label: PROVIDED_SAMPLE_LABEL,
  },
};
async function fixture(
  enabled = true,
  present = true,
  mode: "test" | "live" = "test",
) {
  const store = {
    open: vi.fn(async () => ({
      kind: "ready",
      goal: "everyday",
      deadline: performance.now() + 60000,
    })),
    create: vi.fn(async () => ({
      kind: "created",
      receipt,
      deadline: performance.now() + 60000,
    })),
    inspect: vi.fn(async () => ({
      kind: "ready",
      receipt,
      deadline: performance.now() + 60000,
    })),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.csrf = "nonce";
    res.locals.token = "a".repeat(64);
    next();
  });
  mountPreparedSampleRoutes(
    app,
    present ? (store as unknown as PreparedSampleStore) : undefined,
    { preparedReviewSamples: enabled, mode, origin: "http://127.0.0.1" },
  );
  const listener = await listenLoopback(app);
  listeners.add(listener);
  return { app: listener, store };
}
it("PREPARED-01 presents fixed choices with both acknowledgements and a goal suggestion", async () => {
  const f = await fixture();
  const r = await request(f.app).get(base).expect(200);
  expect(r.text).toContain("Suggested for your current direction");
  expect(r.text.match(/name="providedExample"/g)).toHaveLength(3);
  expect(r.text).not.toContain(" checked");
});
it("PREPARED-02 refuses disabled/live/missing-store creation and never calls its backend", async () => {
  for (const f of [
    await fixture(false),
    await fixture(true, false),
    await fixture(true, true, "live"),
  ]) {
    await request(f.app).get(base).expect(404);
    await request(f.app).post(base).type("form").send(input()).expect(404);
    expect(f.store.create).not.toHaveBeenCalled();
  }
  await request((await fixture(true, false)).app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(404);
  await request((await fixture(true, true, "live")).app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(404);
});
it("PREPARED-02 rejects unknown query/body fields, repeated fields and changed permissions", async () => {
  const f = await fixture();
  await request(f.app)
    .get(base + "?extra=yes")
    .expect(422);
  for (const fields of [
    { ...input(), text: "private" },
    { ...input(), templateVersion: "2" },
    { ...input(), providedExample: "no" },
    { ...input(), privateReview: "no" },
  ])
    await request(f.app).post(base).type("form").send(fields).expect(422);
  await request(f.app)
    .post(base + "?extra=yes")
    .type("form")
    .send(input())
    .expect(422);
  await request(f.app)
    .post(base)
    .type("form")
    .send({ ...input(), templateId: [template.id, template.id] })
    .expect(422);
  await request(f.app)
    .post(base + "/inspect?extra=1")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(422);
  await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID(), extra: "x" })
    .expect(422);
  expect(f.store.create).not.toHaveBeenCalled();
});
it("PREPARED-04 shows creation and unchanged original replay without claiming automatic submission", async () => {
  const f = await fixture();
  expect(
    (await request(f.app).post(base).type("form").send(input()).expect(200))
      .text,
  ).toContain("Your exact private provided copy was saved");
  f.store.create.mockResolvedValueOnce({
    kind: "replayed",
    receipt,
    deadline: performance.now() + 60000,
  });
  expect(
    (await request(f.app).post(base).type("form").send(input()).expect(200))
      .text,
  ).toContain("no new copy or permission");
});
it.each(["invalid", "conflict", "disabled", "denied", "unavailable"])(
  "PREPARED-02/04 handles %s safely",
  async (kind) => {
    const f = await fixture();
    f.store.create.mockResolvedValueOnce({ kind } as never);
    const status = {
      invalid: 422,
      conflict: 409,
      disabled: 404,
      denied: 403,
      unavailable: 503,
    }[kind]!;
    const attempt = input();
    const r = await request(f.app)
      .post(base)
      .type("form")
      .send(attempt)
      .expect(status);
    if (kind === "unavailable") {
      expect(r.text).toContain(attempt.operationId);
      expect(r.text).toContain("Repeat this original copy instruction");
    } else expect(r.text).not.toContain(attempt.operationId);
  },
);
it("PREPARED-04 unexpected write failure preserves only exact original recovery controls", async () => {
  const f = await fixture();
  f.store.create.mockRejectedValueOnce(Error("private database diagnostic"));
  const r = await request(f.app)
    .post(base)
    .type("form")
    .send(input())
    .expect(503);
  expect(r.text).toContain("Inspect my original copy instruction");
  expect(r.text).not.toContain("private database diagnostic");
});
it("PREPARED-05 refuses expired/nonfinite handback before private source data reaches HTTP", async () => {
  const f = await fixture();
  f.store.open.mockResolvedValueOnce({
    kind: "ready",
    goal: "everyday",
    deadline: NaN,
  });
  await request(f.app).get(base).expect(403);
  f.store.create.mockResolvedValueOnce({
    kind: "created",
    receipt,
    deadline: performance.now() - 1,
  });
  const r = await request(f.app)
    .post(base)
    .type("form")
    .send(input())
    .expect(503);
  expect(r.text).not.toContain(receipt.evidenceId!);
  f.store.inspect.mockResolvedValueOnce({
    kind: "ready",
    receipt,
    deadline: Infinity,
  });
  await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(403);
});
it("PREPARED-04/08 inspection in creation-off mode is read-only and absence never proves an uncommitted write", async () => {
  const f = await fixture(false);
  await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  f.store.inspect.mockResolvedValueOnce({
    kind: "absent",
    deadline: performance.now() + 60000,
  } as never);
  const r = await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  expect(r.text).toContain("does not establish that the write failed");
  expect(f.store.create).not.toHaveBeenCalled();
});
it("PREPARED-05 discovery and inspection failures withhold diagnostics and private records", async () => {
  const f = await fixture();
  f.store.open.mockResolvedValueOnce({ kind: "denied" } as never);
  await request(f.app).get(base).expect(403);
  f.store.open.mockRejectedValueOnce(Error("private"));
  await request(f.app).get(base).expect(503);
  f.store.inspect.mockResolvedValueOnce({ kind: "invalid" } as never);
  await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(422);
  f.store.inspect.mockRejectedValueOnce(Error("private"));
  const r = await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(503);
  expect(r.text).not.toContain(receipt.evidenceId!);
});

it("PREPARED-05 displays a retained removed receipt without a usable source or invented provenance", async () => {
  const f = await fixture();
  f.store.inspect.mockResolvedValueOnce({
    kind: "ready",
    receipt: { ...receipt, state: "removed", origin: null, evidenceId: null },
    deadline: performance.now() + 60000,
  } as never);
  const r = await request(f.app)
    .post(base + "/inspect")
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  expect(r.text).toContain("cannot recreate it");
  expect(r.text).not.toContain("data-prepared-evidence=");
});
