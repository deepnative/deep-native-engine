import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const members = store(pool);
const authority = authorizationStore(pool);
let running: Awaited<ReturnType<typeof start>>, storage: string;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "dne-unit-issuance-http-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});
const own = (path: string, token: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
it("TESTISSUE-01 existing baseline: a fresh member can inspect zero local units without a grant", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const result = await own("/member/test-units", token);
  expect(result.status).toBe(200);
  expect(result.text).toContain("Your local test units");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("TESTISSUE-01 missing behavior: the owning member can open a deliberate fixed-three study-unit request without creating units on GET", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  await authority.provisionStaff(
    randomBytes(32).toString("hex"),
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const result = await own("/member/test-unit-request", token);
  expect(result.status).toBe(200);
  expect(result.text).toContain("Request three local study units");
  expect(result.text).toContain('name="administratorId"');
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
      )
    ).rows[0].n,
  ).toBe(0);
});

const fresh = () => randomBytes(32).toString("hex");
const field = (html: string, name: string) => {
  const value = html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
  if (value === undefined) throw new Error(`Expected fixed form field ${name}`);
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
};
const getWith = (path: string, cookie: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie);
const postWith = (
  path: string,
  cookie: string,
  fields: Record<string, string>,
) =>
  request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .type("form")
    .send(fields);
const confirmed = (html: string) => ({
  csrf: field(html, "csrf"),
  kind: field(html, "kind"),
  key: field(html, "key"),
  checked: field(html, "checked"),
  confirm: "yes",
});
async function administratorBrowser(credential: string) {
  const form = await getWith("/staff/sign-in", "").expect(200);
  const nonce = (form.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const signed = await postWith("/staff/sign-in", nonce, {
    csrf: field(form.text, "csrf"),
    credential,
  }).expect(303);
  return (signed.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith("dne_staff="))!
    .split(";")[0]!;
}
it("TESTISSUE-01/02/05 the normal member and selected administrator deliberately issue exactly three units then withdraw only the remaining units", async () => {
  const token = fresh(),
    administrator = fresh();
  await members.create(token, { background: "professional", goal: "work" });
  const selected = await authority.provisionStaff(
    administrator,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const memberCookie = `${COOKIE}=${token}`;
  const home = await getWith("/member/test-unit-request", memberCookie).expect(
    200,
  );
  const check = await postWith(
    "/member/test-unit-request/check",
    memberCookie,
    {
      csrf: field(home.text, "csrf"),
      administratorId: selected,
    },
  ).expect(200);
  expect(check.text).not.toContain('name="confirm" value="yes" checked');
  await postWith(
    "/member/test-unit-request/request",
    memberCookie,
    confirmed(check.text),
  ).expect(200);
  const source = (
    await pool.query("SELECT * FROM browser_study_fixture_requests")
  ).rows[0];
  expect(source.grant_id).toBeNull();
  const staff = await administratorBrowser(administrator);
  const portal = await getWith("/staff", staff).expect(200);
  expect(portal.text).toContain("Issue local study test units");
  const staffHome = await getWith("/operator/study-test-units", staff).expect(
    200,
  );
  const issue = await postWith("/operator/study-test-units/check", staff, {
    csrf: field(staffHome.text, "csrf"),
    requestId: source.id,
  }).expect(200);
  await postWith(
    "/operator/study-test-units/issue",
    staff,
    confirmed(issue.text),
  ).expect(200);
  const grants = (
    await pool.query("SELECT * FROM synthetic_entitlement_grants")
  ).rows;
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    quantity: 3,
    category: "study_requests",
    available: 3,
    reserved: 0,
    consumed: 0,
  });
  // Pause creation on the same populated schema; existing owner actions remain.
  await running.close();
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_TEST_UNIT_ISSUANCE: "disabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
  const pausedStaff = await administratorBrowser(administrator);
  const paused = await getWith(
    "/operator/study-test-units",
    pausedStaff,
  ).expect(200);
  expect(paused.text).toContain("New requests and issuance are paused");
  await postWith("/operator/study-test-units/check", pausedStaff, {
    csrf: field(paused.text, "csrf"),
    requestId: source.id,
  }).expect(403);
  await postWith("/operator/study-test-units/issue", pausedStaff, {
    ...confirmed(issue.text),
    csrf: field(paused.text, "csrf"),
  }).expect(403);
  const inspected: Record<string, string> = {
    ...confirmed(issue.text),
    csrf: field(paused.text, "csrf"),
  };
  delete inspected.confirm;
  const original = await postWith(
    "/operator/study-test-units/inspect",
    pausedStaff,
    inspected,
  ).expect(200);
  expect(original.text).toContain(source.id);
  const balance = await getWith("/member/test-units", memberCookie).expect(200);
  expect(balance.text).toContain("Your local test units");
  const retained = await getWith(
    "/member/test-unit-request",
    memberCookie,
  ).expect(200);
  expect(retained.text).toContain("issued");
  const withdrawal = await postWith(
    "/member/test-unit-request/withdraw/check",
    memberCookie,
    {
      csrf: field(retained.text, "csrf"),
      requestId: source.id,
    },
  ).expect(200);
  const result = await postWith(
    "/member/test-unit-request/withdraw",
    memberCookie,
    confirmed(withdrawal.text),
  ).expect(200);
  expect(result.text).toContain("withdrawn");
  const after = (await pool.query("SELECT * FROM synthetic_entitlement_grants"))
    .rows[0];
  expect(after).toMatchObject({
    quantity: 3,
    available: 0,
    expired: 3,
    reserved: 0,
    consumed: 0,
  });
  expect(+after.expires_at).toBe(+grants[0].expires_at);
  expect(
    (
      await pool.query(
        "SELECT quantity FROM synthetic_entitlement_events WHERE operation='expire'",
      )
    ).rows,
  ).toEqual([{ quantity: 3 }]);
  await running.close();
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
});

it("TESTISSUE-03 unsafe, unconfirmed and arbitrary-scope HTTP instructions cannot create a request or units", async () => {
  const owner = fresh(),
    administrator = fresh();
  await members.create(owner, { background: "technical", goal: "build" });
  const selected = await authority.provisionStaff(
    administrator,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const cookie = `${COOKIE}=${owner}`;
  const page = await getWith("/member/test-unit-request", cookie).expect(200);
  const csrf = field(page.text, "csrf");
  await postWith("/member/test-unit-request/check", cookie, {
    csrf,
    administratorId: selected,
    quantity: "300",
  }).expect(422);
  await postWith("/member/test-unit-request/check", cookie, {
    csrf: "invalid",
    administratorId: selected,
  }).expect(403);
  await request(running.server)
    .post("/member/test-unit-request/check")
    .set("Host", new URL(running.origin).host)
    .set("Origin", "https://invented.invalid")
    .set("Cookie", cookie)
    .type("form")
    .send({ csrf, administratorId: selected })
    .expect(403);
  await request(running.server)
    .post("/member/test-unit-request/check")
    .set("Host", "invented.invalid")
    .set("Origin", running.origin)
    .set("Cookie", cookie)
    .type("form")
    .send({ csrf, administratorId: selected })
    .expect(403);
  const reviewed = await postWith("/member/test-unit-request/check", cookie, {
    csrf,
    administratorId: selected,
  }).expect(200);
  const exact = confirmed(reviewed.text);
  const unchecked: Record<string, string> = { ...exact };
  delete unchecked.confirm;
  await postWith("/member/test-unit-request/request", cookie, unchecked).expect(
    422,
  );
  await postWith("/member/test-unit-request/request", cookie, {
    ...exact,
    checked: "{invalid",
  }).expect(422);
  const oversized = JSON.parse(exact.checked) as Record<string, unknown>;
  oversized.quantity = 300;
  await postWith("/member/test-unit-request/request", cookie, {
    ...exact,
    checked: JSON.stringify(oversized),
  }).expect(422);
  await getWith("/member/test-unit-request?member=someone", cookie).expect(422);
  await getWith("/operator/study-test-units", cookie).expect(403);
  const wrongRole = fresh();
  await authority.provisionStaff(
    wrongRole,
    "coach",
    new Date(Date.now() + 3600000),
  );
  const wrongCookie = await administratorBrowser(wrongRole);
  await getWith("/operator/study-test-units", wrongCookie).expect(403);
  expect(
    (await pool.query("SELECT * FROM browser_study_fixture_requests")).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT * FROM browser_study_fixture_operations")).rows,
  ).toEqual([]);
});
