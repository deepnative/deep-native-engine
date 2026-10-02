import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  auth = authorizationStore(pool),
  origin = "http://127.0.0.1:3000",
  host = "127.0.0.1:3000",
  secret = "synthetic-support-http";
let server: Server;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  server = await listenLoopback(
    app(members, {
      origin,
      secret,
      supportRequests: support,
      memberExport: memberExportStore(pool),
    }),
  );
});
afterEach(async () => closeLoopback(server));
afterAll(async () => pool.end());
const token = () => randomBytes(32).toString("hex");
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
  goal: "everyday" | "work" | "build" = "everyday",
) {
  const value = token();
  await members.create(value, { background, goal });
  return value;
}
function get(value: string, path: string) {
  return request(server)
    .get(path)
    .set("Host", host)
    .set("Cookie", `${COOKIE}=${value}`);
}
function post(value: string, path: string, fields: Record<string, unknown>) {
  return request(server)
    .post(path)
    .set("Host", host)
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${value}`)
    .type("form")
    .send({ csrf: csrf(value, secret), ...fields });
}
async function fixture() {
  const owner = await member(),
    other = await member(),
    admin = token(),
    operator = token();
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const staffId = await auth.provisionStaff(
    operator,
    "operator",
    new Date(Date.now() + 3600000),
  );
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "Invented request",
    body: "OWNER-REQUEST-MARKER",
  });
  if (!("receipt" in created)) throw Error("Synthetic intake missing");
  const requestId = created.receipt.requestId;
  const grant = await support.grant(admin, {
    requestId,
    staffId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 1800000),
  });
  if (!("grantId" in grant)) throw Error("Synthetic grant missing");
  return { owner, other, admin, operator, requestId, grantId: grant.grantId };
}
it("accepts full-size encoded Unicode forms for every audience and reloads exact owner text", async () => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const) {
    const owner = await member(background, goal),
      key = randomUUID(),
      subject = "中".repeat(120),
      body = "样".repeat(2000);
    await get(owner, "/support/new").expect(200);
    const saved = await post(owner, "/support", {
      idempotencyKey: key,
      subject,
      body,
      synthetic: "yes",
    }).expect(303);
    const location = saved.headers.location;
    if (!location) throw Error("Missing persisted receipt location");
    expect(location).toMatch(/^\/support\/[0-9a-f-]+$/);
    const page = await get(owner, location).expect(200);
    expect(page.text).toContain(subject);
    expect(page.text).toContain(body);
    expect(page.text).toContain("coverage unverified");
    await get(owner, "/support/receipts/" + key)
      .expect(303)
      .expect("Location", location);
    await post(owner, "/support", {
      idempotencyKey: key,
      subject,
      body,
      synthetic: "yes",
    })
      .expect(303)
      .expect("Location", location);
    await post(owner, "/support", {
      idempotencyKey: key,
      subject,
      body: "Changed invented request",
      synthetic: "yes",
    }).expect(409);
  }
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_requests")).rows[0]
      .n,
  ).toBe(3);
});
it("rejects forged fields, repeated form fields, malformed acknowledgements and invalid CSRF without writes", async () => {
  const owner = await member(),
    form = {
      idempotencyKey: randomUUID(),
      subject: "Invented",
      body: "Synthetic",
      synthetic: "yes",
    };
  await post(owner, "/support", { ...form, memberId: randomUUID() }).expect(
    422,
  );
  await post(owner, "/support", { ...form, subject: ["A", "B"] }).expect(422);
  await post(owner, "/support", { ...form, synthetic: "no" }).expect(422);
  await post(owner, "/support", { ...form, csrf: "forged" }).expect(403);
  await post(owner, "/support", { ...form, body: "样".repeat(2001) }).expect(
    422,
  );
  await post(owner, "/support", { ...form, body: "中".repeat(12000) }).expect(
    413,
  );
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_requests")).rows[0]
      .n,
  ).toBe(0);
});
it("serves exact-granted operators while member HTML, download and withdrawal never expose internal notes", async () => {
  const f = await fixture(),
    scope = { requestId: f.requestId, grantId: f.grantId },
    path = `/operator/support/${f.requestId}`;
  const forged = await get(f.admin, path + `?grant=${f.grantId}`).expect(403);
  expect(forged.text).not.toContain("OWNER-REQUEST-MARKER");
  const other = await get(f.other, `/support/${f.requestId}`).expect(403);
  expect(other.text).not.toContain("OWNER-REQUEST-MARKER");
  await get(f.operator, path + `?grant=${f.grantId}`).expect(200);
  for (const [action, body] of [
    ["notes", "INTERNAL-NOTE-MARKER"],
    ["replies", "VISIBLE-REPLY-MARKER"],
  ])
    await post(f.operator, path + "/" + action, {
      grantId: f.grantId,
      idempotencyKey: randomUUID(),
      confirm: "yes",
      body,
    }).expect(303);
  const afterReply = await support.memberDetail(f.owner, f.requestId);
  expect(afterReply).toMatchObject({
    kind: "ready",
    value: { acknowledgedAt: null },
  });
  await post(f.operator, path + "/acknowledge", {
    grantId: f.grantId,
    idempotencyKey: randomUUID(),
    confirm: "yes",
  }).expect(303);
  const page = await get(f.owner, `/support/${f.requestId}`).expect(200);
  expect(page.text).toContain("VISIBLE-REPLY-MARKER");
  expect(page.text).not.toContain("INTERNAL-NOTE-MARKER");
  const exported = await get(f.owner, "/api/member/export").expect(200);
  expect(exported.text).toContain("VISIBLE-REPLY-MARKER");
  expect(exported.text).not.toContain("INTERNAL-NOTE-MARKER");
  const key = randomUUID();
  await post(f.operator, path + "/resolve", {
    grantId: f.grantId,
    idempotencyKey: key,
    confirm: "yes",
  }).expect(303);
  await post(f.operator, path + "/resolve", {
    grantId: f.grantId,
    idempotencyKey: key,
    confirm: "yes",
  }).expect(303);
  await post(f.operator, path + "/notes", {
    grantId: f.grantId,
    idempotencyKey: randomUUID(),
    confirm: "yes",
    body: "No terminal append",
  }).expect(409);
  await post(f.owner, `/support/${f.requestId}/withdraw`, {
    confirm: "yes",
  }).expect(303);
  const withdrawn = await get(f.owner, `/support/${f.requestId}`).expect(200);
  for (const text of [
    "OWNER-REQUEST-MARKER",
    "VISIBLE-REPLY-MARKER",
    "INTERNAL-NOTE-MARKER",
  ])
    expect(withdrawn.text).not.toContain(text);
  const finalExport = await get(f.owner, "/api/member/export").expect(200);
  for (const text of [
    "OWNER-REQUEST-MARKER",
    "VISIBLE-REPLY-MARKER",
    "INTERNAL-NOTE-MARKER",
  ])
    expect(finalExport.text).not.toContain(text);
  expect(await support.operatorDetail(f.operator, scope)).toEqual({
    kind: "withdrawn",
  });
});
