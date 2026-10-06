import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { testPool } from "../support/database.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
const fresh = () => randomBytes(32).toString("hex");
const csrfFrom = (html: string) =>
  html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
const cookiesFrom = (res: request.Response) =>
  res.headers["set-cookie"] as unknown as string[];
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
  root = await mkdtemp(join(tmpdir(), "dne-support-assignment-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: root,
  });
});
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const owner = fresh(),
    operator = fresh(),
    admin = fresh();
  await members.create(owner, { background: "professional", goal: "work" });
  const member = await members.session(owner);
  if (member.kind !== "active") throw Error("Missing invented member fixture");
  const expires = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires);
  const staffId = await auth.provisionStaff(operator, "operator", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "Private invented assignment subject",
    body: "PRIVATE-SUPPORT-CONTENT-MARKER",
  });
  if (!("receipt" in created)) throw Error("Missing invented support fixture");
  return {
    owner,
    memberId: member.learner.id,
    operator,
    staffId,
    admin,
    adminId,
    expires,
    requestId: created.receipt.requestId,
  };
}
async function signIn(credential: string, existing = "") {
  const form = await get("/staff/sign-in", existing).expect(200);
  const nonce = cookiesFrom(form)
    .find((v) => v.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const signed = await post("/staff/sign-in", `${existing}; ${nonce}`, {
    csrf: csrfFrom(form.text),
    credential,
  })
    .expect(303)
    .expect("Location", "/staff");
  return `${existing}; ${
    cookiesFrom(signed)
      .find((v) => v.startsWith("dne_staff="))!
      .split(";")[0]!
  }`;
}
it("SUPADM-01-REFERENCES existing ordinary member receipt already exposes the exact request reference", async () => {
  const f = await fixture();
  const receipt = await get(
    `/support/${f.requestId}`,
    `${COOKIE}=${f.owner}`,
  ).expect(200);
  expect(receipt.text).toContain(f.requestId);
  expect(receipt.text).toContain("Request receipt");
  expect(receipt.text).not.toContain(f.staffId);
  expect(receipt.text.includes(f.admin)).toBe(false);
});
it("SUPADM-01-REFERENCES a current signed-in operator obtains only their own noncredential assignment reference", async () => {
  const f = await fixture(),
    cookie = await signIn(f.operator, `${COOKIE}=${f.owner}`);
  await get("/staff", cookie).expect(200);
  const page = await get("/operator/assignment-id", cookie).expect(200);
  expect(page.text).toContain("My local assignment ID");
  expect(page.text).toContain(f.staffId);
  expect(page.text).toContain(f.expires.toISOString());
  for (const forbidden of [
    f.operator,
    f.owner,
    f.admin,
    f.memberId,
    "PRIVATE-SUPPORT-CONTENT-MARKER",
  ])
    expect(page.text.includes(forbidden)).toBe(false);
  expect(page.headers["cache-control"]).toBe("no-store");
});
it("SUPADM-01-REFERENCES the actual administrator form checks exact references without exposing member content", async () => {
  const f = await fixture(),
    cookie = await signIn(f.admin, `${COOKIE}=${f.owner}`);
  await get("/staff", cookie).expect(200);
  const form = await get("/operator/support-assignment", cookie).expect(200);
  expect(form.text).toContain('name="requestId"');
  expect(form.text).toContain('name="staffId"');
  const checked = await post("/operator/support-assignment/check", cookie, {
    csrf: csrfFrom(form.text),
    requestId: f.requestId,
    staffId: f.staffId,
  }).expect(200);
  expect(checked.text).toContain(f.requestId);
  expect(checked.text).toContain(f.staffId);
  expect(checked.text).toContain('name="idempotencyKey"');
  for (const forbidden of [
    f.operator,
    f.owner,
    f.admin,
    f.memberId,
    "Private invented assignment subject",
    "PRIVATE-SUPPORT-CONTENT-MARKER",
  ])
    expect(checked.text.includes(forbidden)).toBe(false);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
      .rows[0].n,
  ).toBe(0);
});
async function assignment(
  f: Awaited<ReturnType<typeof fixture>>,
  cookie: string,
) {
  const form = await get("/operator/support-assignment", cookie).expect(200);
  const checked = await post("/operator/support-assignment/check", cookie, {
    csrf: csrfFrom(form.text),
    requestId: f.requestId,
    staffId: f.staffId,
  }).expect(200);
  return {
    csrf: csrfFrom(checked.text),
    requestId: f.requestId,
    staffId: f.staffId,
    idempotencyKey: checked.text.match(
      /name="idempotencyKey" value="([a-f0-9-]+)"/,
    )![1]!,
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(+f.expires - 1000).toISOString(),
    confirm: "yes",
  };
}
it("SUPADM-02-ASSIGN real selected-admin form creates and replays exactly one grant, while finite overlong expiry is rejected intact", async () => {
  const f = await fixture(),
    cookie = await signIn(f.admin, `${COOKIE}=${f.owner}`),
    fields = await assignment(f, cookie);
  const overlong = {
    ...fields,
    expiresAt: new Date(+f.expires + 1).toISOString(),
  };
  await post("/operator/support-assignment/assign", cookie, overlong).expect(
    422,
  );
  const saved = await post(
    "/operator/support-assignment/assign",
    cookie,
    fields,
  ).expect(200);
  expect(saved.text).toContain("Support assignment recorded");
  await post("/operator/support-assignment/assign", cookie, fields).expect(200);
  const row = (
    await pool.query(
      "SELECT id,expires_at FROM support_request_grants WHERE idempotency_key=$1",
      [fields.idempotencyKey],
    )
  ).rows[0];
  expect(row.expires_at.toISOString()).toBe(fields.expiresAt);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM support_request_events WHERE action='grant-created'",
      )
    ).rows[0].n,
  ).toBe(1);
  const history = await get(
    `/operator/support-assignment/history?requestId=${f.requestId}&key=${fields.idempotencyKey}`,
    cookie,
  ).expect(200);
  expect(history.text).toContain(row.id);
  const revoked = await post("/operator/support-assignment/revoke", cookie, {
    csrf: csrfFrom(history.text),
    requestId: f.requestId,
    grantId: row.id,
    confirm: "yes",
  }).expect(200);
  expect(revoked.text).toContain("Support assignment revoked");
  await post("/operator/support-assignment/assign", cookie, fields).expect(409);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM support_request_events WHERE action='grant-revoked'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("SUPADM-05-BOUNDARIES actual legacy-only member/wrong-role/ambiguous/signed-out staff states reveal no privileged metadata", async () => {
  const f = await fixture();
  for (const cookie of [
    `${COOKIE}=${f.admin}`,
    `${COOKIE}=${f.owner}`,
    `${COOKIE}=${f.owner}; dne_staff=signed-out`,
    `${COOKIE}=${f.owner}; dne_staff=${f.admin}; dne_staff=${f.admin}`,
  ]) {
    const r = await get("/operator/support-assignment", cookie).expect(403);
    expect(r.text.includes(f.requestId)).toBe(false);
  }
  const operator = await signIn(f.operator, `${COOKIE}=${f.owner}`);
  await get("/operator/support-assignment", operator).expect(403);
  const admin = await signIn(f.admin, `${COOKIE}=${f.owner}`);
  await get("/operator/assignment-id", admin).expect(403);
  await pool.query(
    "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
    [f.adminId],
  );
  await get("/operator/support-assignment", admin).expect(403);
  await pool.query(
    "UPDATE staff_profiles SET role='platform_admin' WHERE principal_id=$1",
    [f.adminId],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.adminId],
  );
  await get("/operator/support-assignment", admin).expect(403);
  await get("/learn", admin).expect(200);
  expect((await members.session(f.owner)).kind).toBe("active");
});
it("SUPADM-05-BOUNDARIES real parser and selected CSRF reject foreign origins hosts duplicate oversized and authority fields without grant writes", async () => {
  const f = await fixture(),
    cookie = await signIn(f.admin, `${COOKIE}=${f.owner}`),
    fields = await assignment(f, cookie),
    member = await get("/learn", cookie).expect(200);
  const learnerCsrf = csrfFrom(member.text);
  await post("/operator/support-assignment/assign", cookie, {
    ...fields,
    csrf: learnerCsrf,
  }).expect(403);
  await post("/operator/support-assignment/assign", cookie, fields)
    .set("Origin", "https://foreign.invalid")
    .expect(403);
  await post("/operator/support-assignment/assign", cookie, fields)
    .set("Host", "foreign.invalid")
    .expect(403);
  for (const patch of [
    { role: "platform_admin" },
    { purpose: "other" },
    { actor: f.adminId },
    { workspace: f.memberId },
    { confirm: "no" },
    { confirm: ["yes", "yes"] },
    { staffId: [f.staffId, f.staffId] },
    { requestId: randomUUID() },
    { staffId: f.memberId },
    { startsAt: "2026-02-30T12:00:00.000Z" },
    { expiresAt: "2100-01-01T00:00:00+00:00" },
  ]) {
    const r = await post("/operator/support-assignment/assign", cookie, {
      ...fields,
      ...patch,
    }).expect(403);
    expect(r.text.includes("PRIVATE-SUPPORT-CONTENT-MARKER")).toBe(false);
  }
  const oversize = await post("/operator/support-assignment/assign", cookie, {
    ...fields,
    staffId: "PRIVATE-OVERSIZE".repeat(2000),
  }).expect(413);
  expect(oversize.text.includes("PRIVATE-OVERSIZE")).toBe(false);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
      .rows[0].n,
  ).toBe(0);
  await post("/OPERATOR/SUPPORT-ASSIGNMENT/assign/", cookie, fields).expect(
    200,
  );
});
