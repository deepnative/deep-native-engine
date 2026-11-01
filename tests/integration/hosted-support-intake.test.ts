import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { supportAssignmentStore } from "../../src/support-assignment.ts";
import { testPool } from "../support/database.ts";
import { COOKIE } from "../../src/session.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
const fresh = () => randomBytes(32).toString("hex");
const csrfFrom = (html: string) =>
  html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
const get = (path: string, cookie = "") =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie);
const post = (path: string, cookie: string, fields: Record<string, unknown>) =>
  request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .type("form")
    .send(fields);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne195-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
    DNE_PRIVATE_SUPPORT_INTAKE: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
  });
});
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function member() {
  const token = fresh();
  await members.create(token, { background: "explorer", goal: "everyday" });
  return { token, cookie: `${COOKIE}=${token}` };
}
async function signIn(role: "platform_admin" | "operator" = "platform_admin") {
  const credential = fresh();
  const id = await auth.provisionStaff(
    credential,
    role,
    new Date(Date.now() + 3600000),
  );
  const form = await get("/staff/sign-in").expect(200);
  const nonce = (form.headers["set-cookie"] as unknown as string[])
    .find((v) => v.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const signed = await post("/staff/sign-in", nonce, {
    csrf: csrfFrom(form.text),
    credential,
  }).expect(303);
  const cookie = (signed.headers["set-cookie"] as unknown as string[])
    .find((v) => v.startsWith("dne_staff="))!
    .split(";")[0]!;
  return { cookie, id, credential };
}
it("SI-01 a member deliberately sends a private request without falsely attesting that their information is invented", async () => {
  const owner = await member();
  const form = await get("/support/new", owner.cookie).expect(200);
  const fields = {
    csrf: csrfFrom(form.text),
    idempotencyKey: randomUUID(),
    subject: "Invented private learning question",
    body: "How can I check a source in my learning project?",
    confirm: "yes",
  };
  const sent = await post("/support", owner.cookie, fields).expect(303);
  const receipt = await get(sent.headers.location!, owner.cookie).expect(200);
  expect(receipt.text).toContain(fields.body);
  expect(receipt.text).toContain("No separate acknowledgement recorded");
  expect(receipt.text).toContain("Open; no resolution recorded");
  expect(form.text).not.toContain('name="synthetic"');
  await post("/support", owner.cookie, fields)
    .expect(303)
    .expect("Location", sent.headers.location!);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_requests")).rows[0]
      .n,
  ).toBe(1);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
      .rows[0].n,
  ).toBe(0);
});
it("SI-01 administrators discover only receipt and lifecycle metadata before deliberate exact assignment", async () => {
  const owner = await member(),
    support = supportRequestStore(pool);
  const created = await support.create(owner.token, {
    idempotencyKey: randomUUID(),
    subject: "NEVER-ADMIN-SUBJECT",
    body: "NEVER-ADMIN-BODY",
  });
  if (!("receipt" in created)) throw Error("Invented request missing");
  const actor = await signIn();
  const inbox = await get(
    "/operator/support-assignment/inbox",
    actor.cookie,
  ).expect(200);
  expect(inbox.text).toContain(created.receipt.requestId);
  expect(inbox.text).toContain(created.receipt.receivedAt.toISOString());
  expect(inbox.text).toContain("No separate acknowledgement recorded");
  for (const value of [
    "NEVER-ADMIN-SUBJECT",
    "NEVER-ADMIN-BODY",
    owner.token,
    actor.credential,
  ])
    expect(inbox.text).not.toContain(value);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
      .rows[0].n,
  ).toBe(0);
});
it("SI-03 metadata pages are bounded, actor-bound, content-free and reflect withdrawal and account deletion", async () => {
  const owner = await member(),
    support = supportRequestStore(pool),
    inbox = supportAssignmentStore(pool, "invented-inbox-secret");
  const actor = await signIn(),
    other = await signIn(),
    operator = await signIn("operator");
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    const saved = await support.create(owner.token, {
      idempotencyKey: randomUUID(),
      subject: `NEVER-ADMIN-SUBJECT-${i}`,
      body: "NEVER-ADMIN-BODY",
    });
    if (!("receipt" in saved)) throw Error("Missing invented receipt");
    ids.push(saved.receipt.requestId);
  }
  const first = await inbox.inbox(actor.credential);
  if (first.kind !== "ready") throw Error("Missing inbox");
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).toBeTruthy();
  const second = await inbox.inbox(actor.credential, first.value.nextCursor!);
  if (second.kind !== "ready") throw Error("Missing second page");
  expect(second.value.items).toHaveLength(3);
  expect(second.value.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.value.items, ...second.value.items].map((r) => r.requestId),
    ),
  ).toEqual(new Set(ids));
  for (const item of [...first.value.items, ...second.value.items])
    expect(Object.keys(item).sort()).toEqual([
      "acknowledgedAt",
      "receivedAt",
      "requestId",
      "resolvedAt",
      "withdrawnAt",
    ]);
  expect(await inbox.inbox(other.credential, first.value.nextCursor!)).toEqual({
    kind: "denied",
  });
  expect(
    await inbox.inbox(actor.credential, first.value.nextCursor! + "x"),
  ).toEqual({ kind: "denied" });
  await get("/operator/support-assignment/inbox", operator.cookie).expect(403);
  await get("/operator/support-assignment/inbox", owner.cookie).expect(403);
  expect(await support.withdraw(owner.token, ids.at(-1)!)).toMatchObject({
    kind: "withdrawn",
  });
  const withdrawn = await inbox.inbox(actor.credential);
  if (withdrawn.kind !== "ready") throw Error("Missing retained lifecycle");
  expect(
    withdrawn.value.items.find((r) => r.requestId === ids.at(-1))!.withdrawnAt,
  ).toBeInstanceOf(Date);
  const state = await members.session(owner.token);
  if (state.kind !== "active") throw Error("Missing member");
  await members.remove(state.learner.id);
  const deleted = await inbox.inbox(actor.credential);
  expect(deleted.kind === "ready" && deleted.value.items).toEqual([]);
});
it("SI-03 an inbox read actually waiting on the administrator row refuses metadata after revocation commits", async () => {
  const owner = await member(),
    actor = await signIn();
  await supportRequestStore(pool).create(owner.token, {
    idempotencyKey: randomUUID(),
    subject: "Private race subject",
    body: "Private race body",
  });
  const blocker = await pool.connect();
  let open = false;
  try {
    await blocker.query("BEGIN");
    open = true;
    await blocker.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      actor.id,
    ]);
    const reading = supportAssignmentStore(pool).inbox(actor.credential);
    const deadline = performance.now() + 2000;
    let waiting = false;
    while (performance.now() < deadline) {
      waiting = (
        await pool.query(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM principals WHERE id=ANY%') AS waiting`,
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await blocker.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [actor.id],
    );
    await blocker.query("COMMIT");
    open = false;
    expect(await reading).toEqual({ kind: "denied" });
    await get("/operator/support-assignment/inbox", actor.cookie).expect(403);
  } finally {
    if (open) await blocker.query("ROLLBACK");
    blocker.release();
  }
});
it("SI-03 turning private intake off preserves owned receipts and legacy sample intake but rejects the real-intake form", async () => {
  const owner = await member();
  const saved = await supportRequestStore(pool).create(owner.token, {
    idempotencyKey: randomUUID(),
    subject: "Retained private subject",
    body: "Retained private body",
  });
  if (!("receipt" in saved)) throw Error("Missing retained receipt");
  const options = {
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
  };
  await running.close();
  running = await start(options);
  try {
    const form = await get("/support/new", owner.cookie).expect(200);
    expect(form.text).toContain('name="synthetic"');
    const fields = {
      csrf: csrfFrom(form.text),
      idempotencyKey: randomUUID(),
      subject: "Invented sample",
      body: "Only invented data",
    };
    await post("/support", owner.cookie, { ...fields, confirm: "yes" }).expect(
      422,
    );
    await post("/support", owner.cookie, {
      ...fields,
      synthetic: "yes",
    }).expect(303);
    const retained = await get(
      `/support/${saved.receipt.requestId}`,
      owner.cookie,
    ).expect(200);
    expect(retained.text).toContain("Retained private body");
    expect(retained.text).not.toContain("Private sample support receipt");
  } finally {
    await running.close();
    running = await start({
      ...options,
      DNE_PRIVATE_SUPPORT_INTAKE: "enabled",
    });
  }
});
