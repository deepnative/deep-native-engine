import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

// XMEM (#42, QA-004 M02): member B presents member A's review-minute and
// support-time receipt IDs to the member HTTP routes. B must get exactly the
// answer an unused ID gets, and A's held units must not move.

const pool = testPool(),
  members = store(pool),
  ledger = syntheticLedger(pool),
  support = supportRequestStore(pool),
  minutes = reviewTimeStore(pool, { enabled: true, mode: "test" });
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-cross-member-receipts";
let server: Server, root: string;

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-cross-member-"));
  const objects = fileObjectStorage(root);
  server = await listenLoopback(
    app(members, {
      origin,
      secret,
      supportRequests: support,
      reviewTime: minutes,
      reviewTimeWrites: true,
      sampleFeedback: sampleFeedbackStore(pool, objects, {
        reviewTimeWrites: true,
        mode: "test",
      }),
    }),
  );
});
afterEach(async () => {
  await closeLoopback(server);
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => pool.end());

const window = () => ({
  startsAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

async function member(background: "explorer" | "technical") {
  const token = randomBytes(32).toString("hex");
  await members.create(token, {
    background,
    goal: background === "explorer" ? "everyday" : "build",
  });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id };
}

const get = (path: string, token: string) =>
  request(server)
    .get(path)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${token}`);
const post = (path: string, token: string, form: Record<string, string>) =>
  request(server)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ csrf: csrf(token, secret), ...form });

const balance = async (grant: string) =>
  (
    await pool.query(
      "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
      [grant],
    )
  ).rows[0];

async function reviewAllocation(owner: { token: string; id: string }) {
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(root),
    "invented-test-secret",
  );
  const upload = await evidence.upload(owner.token, {
    name: "Invented review sample",
    mediaType: "text/plain",
    data: Buffer.from("An invented team checks its claims."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (upload.kind !== "created") throw Error("Invented upload missing");
  await evidence.transitionQuarantine(upload.id, "clean");
  await evidence.submitForReview(owner.token, upload.id);
  const grant = await ledger.grant(
    owner.id,
    "review_minutes",
    10,
    randomUUID(),
    window(),
  );
  const held = await minutes.allocate(owner.token, upload.id, randomUUID(), 4);
  if (held.kind !== "applied") throw Error("Invented allocation missing");
  return { grant, allocationId: held.receipt.allocationId };
}

async function supportAllocation(owner: { token: string; id: string }) {
  const grant = await ledger.grant(
    owner.id,
    "support_minutes",
    10,
    randomUUID(),
    window(),
  );
  const intake = await support.create(owner.token, {
    idempotencyKey: randomUUID(),
    subject: "Invented support request",
    body: "Invented private detail for member A only.",
  });
  if (!("receipt" in intake)) throw Error("Invented request missing");
  const requestId = intake.receipt.requestId;
  const held = await support.time!.allocate(
    owner.token,
    requestId,
    randomUUID(),
    3,
  );
  if (!("receipt" in held)) throw Error("Invented support hold missing");
  const allocationId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM support_time_allocations WHERE request_id=$1",
      [requestId],
    )
  ).rows[0]!.id;
  return { grant, requestId, allocationId };
}

it("XMEM-01: another member opening a review-minute receipt gets the unused-ID answer and no receipt details", async () => {
  const a = await member("explorer"),
    b = await member("technical");
  const { allocationId } = await reviewAllocation(a);
  const unused = await get(`/review-minutes/${randomUUID()}`, b.token);
  const foreign = await get(`/review-minutes/${allocationId}`, b.token);
  expect(unused.status).toBe(404);
  expect(foreign.status).toBe(unused.status);
  expect(foreign.text).toBe(unused.text);
  expect(foreign.text).not.toContain(allocationId);
  expect((await get(`/review-minutes`, b.token)).text).not.toContain(
    allocationId,
  );
  const own = await get(`/review-minutes/${allocationId}`, a.token);
  expect(own.status).toBe(200);
  expect(own.text).toContain(allocationId);
});

it("XMEM-02: another member cancelling a review-minute allocation gets the unused-ID answer and A's held minutes stay held", async () => {
  const a = await member("explorer"),
    b = await member("technical");
  const { grant, allocationId } = await reviewAllocation(a);
  const before = await balance(grant);
  expect(before).toEqual({ available: 6, reserved: 4, consumed: 0 });
  const unused = await post(
    `/review-minutes/${randomUUID()}/cancel`,
    b.token,
    {},
  );
  const foreign = await post(
    `/review-minutes/${allocationId}/cancel`,
    b.token,
    {},
  );
  expect(unused.status).toBe(404);
  expect(foreign.status).toBe(unused.status);
  expect(foreign.text).toBe(unused.text);
  expect(await balance(grant)).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT state FROM review_time_allocations WHERE id=$1",
        [allocationId],
      )
    ).rows,
  ).toEqual([{ state: "allocated" }]);
  const own = await post(`/review-minutes/${allocationId}/cancel`, a.token, {});
  expect(own.status).toBe(303);
  expect(await balance(grant)).toEqual({
    available: 10,
    reserved: 0,
    consumed: 0,
  });
});

it("XMEM-03: another member cancelling a support-time allocation, by A's request or their own, gets the unused-ID answer and A's minutes stay held", async () => {
  const a = await member("explorer"),
    b = await member("technical");
  const { grant, requestId, allocationId } = await supportAllocation(a);
  const own = await support.create(b.token, {
    idempotencyKey: randomUUID(),
    subject: "Invented request of member B",
    body: "Invented private detail for member B only.",
  });
  if (!("receipt" in own)) throw Error("Invented request missing");
  const before = await balance(grant);
  expect(before).toEqual({ available: 7, reserved: 3, consumed: 0 });
  const cancel = (req: string, allocation: string, token = b.token) =>
    post(`/support/${req}/time/${allocation}/cancel`, token, {
      confirm: "yes",
    });
  const unknownRequest = randomUUID(),
    unused = await cancel(unknownRequest, randomUUID());
  expect(unused.status).toBe(403);
  for (const [req, response] of [
    [requestId, await cancel(requestId, allocationId)],
    [own.receipt.requestId, await cancel(own.receipt.requestId, allocationId)],
  ] as const) {
    expect(response.status).toBe(unused.status);
    expect(response.text.replaceAll(req, unknownRequest)).toBe(unused.text);
    expect(response.text).not.toContain(allocationId);
    expect(response.text).not.toContain("member A only");
  }
  expect(await balance(grant)).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT state FROM support_time_allocations WHERE id=$1",
        [allocationId],
      )
    ).rows,
  ).toEqual([{ state: "allocated" }]);
  expect((await cancel(requestId, allocationId, a.token)).status).toBe(303);
  expect(await balance(grant)).toEqual({
    available: 10,
    reserved: 0,
    consumed: 0,
  });
});

it("XMEM-04: another member opening a support request with an allocation gets the unused-ID answer and none of A's time or text", async () => {
  const a = await member("explorer"),
    b = await member("technical");
  const { requestId, allocationId } = await supportAllocation(a);
  const unknown = randomUUID();
  const unused = await get(`/support/${unknown}`, b.token);
  const foreign = await get(`/support/${requestId}`, b.token);
  expect(foreign.status).toBe(unused.status);
  expect(foreign.text.replaceAll(requestId, unknown)).toBe(unused.text);
  expect(foreign.text).not.toContain("member A only");
  expect(foreign.text).not.toContain("support test minutes held");
  expect(foreign.text).not.toContain(allocationId);
});
