// QA-004 M04 (#42): joining a circle and taking part in it is not a grant.
// Each case counts every authority and contact table the database has, found
// by name at run time, so a table added later is counted too.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const circles = circleStore(pool);
const circle = "everyday-ai";
const path = `/circles/${circle}/discussion`;
let running: Awaited<ReturnType<typeof start>>;
let storage: string;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  storage = await mkdtemp(join(tmpdir(), "dne42-m04-"));
  running = await start({
    ...process.env,
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_CIRCLE_DISCUSSION: "enabled",
  });
});
afterEach(async () => {
  try {
    if (running) await running.close();
  } finally {
    if (storage) await rm(storage, { recursive: true, force: true });
  }
});
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Invented circle member unavailable");
  return { token, id: session.learner.id };
}
const get = (token: string, url: string) =>
  request(running.server)
    .get(url)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
async function post(
  token: string,
  url: string,
  fields: Record<string, string>,
) {
  const page = await get(token, "/circles").expect(200);
  const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(page.text)?.[1];
  if (!csrf) throw Error("Missing real circle CSRF field");
  return request(running.server)
    .post(url)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ csrf, ...fields });
}
async function share(token: string) {
  const page = await get(token, `${path}/choice`).expect(200);
  const generation = /name="generation" value="([0-9]+)"/.exec(page.text)?.[1];
  if (!generation) throw Error("No current membership generation");
  const result = await post(token, `${path}/choice`, {
    generation,
    policyVersion: "circle-discussion-test-v1",
    idempotencyKey: randomUUID(),
    confirm: "yes",
  });
  expect(result.status).toBe(303);
}

/** Row counts of every table that could carry a role, a grant or a way to contact someone. */
async function authority() {
  const tables = await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
        AND table_name ~ '(role|grant|email|contact|outreach|invit|notice)'
      ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables.rows)
    counts[name] = (
      await pool.query<{ n: number }>(
        `SELECT count(*)::integer n FROM "${name}"`,
      )
    ).rows[0]!.n;
  return counts;
}
const STAFF_PAGES = [
  "/staff",
  `/moderate/circles/${circle}/reports`,
  "/operator/sample-holds",
];

it("M04-01 joining, sharing, posting, reporting and leaving create no role, grant or contact record", async () => {
  const owner = await member(),
    peer = await member();
  const before = await authority();
  // The check is only meaningful if it watches the real tables.
  for (const expected of [
    "account_roles",
    "preview_circle_moderator_grants",
    "member_login_emails",
    "support_access_grants",
  ])
    expect(Object.keys(before)).toContain(expected);

  for (const actor of [owner, peer]) {
    expect(await circles.join(actor.token, circle)).toBe("joined");
    expect(await authority()).toEqual(before);
    await share(actor.token);
  }
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Invented question about checking a draft",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  const list = await get(peer.token, path).expect(200);
  const root = /\/threads\/([a-f0-9-]{36})/.exec(list.text)?.[1];
  if (!root) throw Error("Peer question link missing");
  expect(
    (
      await post(peer.token, `${path}/posts/${root}/reports`, {
        idempotencyKey: randomUUID(),
        category: "conduct",
      })
    ).status,
  ).toBe(200);
  expect(await authority()).toEqual(before);

  // Taking part opens no staff page, for the author or the reporter.
  for (const actor of [owner, peer])
    for (const page of STAFF_PAGES)
      // 404 where this configuration serves no such page; never a page or a redirect into one.
      expect([403, 404], page).toContain((await get(actor.token, page)).status);
  expect(
    (await get(peer.token, `/moderate/circles/${circle}/reports`)).status,
    "The reporter gets no moderator worklist",
  ).toBe(403);

  expect(await circles.leave(owner.token, circle)).toBe(true);
  expect(await authority()).toEqual(before);
  expect((await get(owner.token, path)).status).toBe(403);
});

it("M04-02 a circle peer is shown the shared text and nothing that identifies or reaches its author", async () => {
  const owner = await member(),
    peer = await member();
  const privateDraft = "Invented private draft kept out of the circle";
  expect(
    await members.save(owner.token, {
      revision: 0,
      instruction: privateDraft,
      verification: "Private invented check",
      complete: false,
      goal: "everyday",
    }),
  ).toBe("saved");
  for (const actor of [owner, peer]) {
    expect(await circles.join(actor.token, circle)).toBe("joined");
    await share(actor.token);
  }
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Invented shared question",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  const list = await get(peer.token, path).expect(200);
  const root = /\/threads\/([a-f0-9-]{36})/.exec(list.text)?.[1];
  if (!root) throw Error("Peer question link missing");
  const thread = await get(peer.token, `${path}/threads/${root}`).expect(200);
  for (const page of [list.text, thread.text]) {
    expect(page).toContain("Invented shared question");
    expect(page).not.toContain(privateDraft);
    expect(page).not.toContain(owner.id);
    expect(page).not.toContain(owner.token);
    expect(page).not.toMatch(/name="(to|recipient|message|email)"/i);
  }
});
