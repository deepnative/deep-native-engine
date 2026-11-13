import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import {
  coachingTermsStore,
  type CoachingTermsValues,
  type TermsResult,
} from "../../src/coaching-terms.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { memberTestUnitsStore } from "../../src/member-test-units.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #27 with the owner's 9 Nov 2026 decision: the student's own coaching price
// covers the allowances an administrator sets (#316/#800). Saving terms turns
// expert review minutes and AI requests into ledger units for the coaching
// period. Invented people and numbers only.
const pool = testPool(),
  members = store(pool),
  terms = coachingTermsStore(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool);
const origin = "http://127.0.0.1:3000";
const application = app(members, {
  origin,
  secret: "coaching-allowances-test",
  mode: "test",
  simpleInvoices: simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  coachingTerms: terms,
});
const ready = <T>(result: TermsResult<T>): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
  return result.value;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error();
  return { token, id: s.learner.id };
}
// Calendar dates relative to today, far from any midnight boundary.
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const torontoMidnight = async (date: string) =>
  (
    await pool.query<{ at: Date }>(
      "SELECT ($1::date::timestamp AT TIME ZONE 'America/Toronto') AS at",
      [date],
    )
  ).rows[0]!.at;
const current: CoachingTermsValues = {
  priceCents: 150000,
  startsOn: day(-10),
  endsOn: day(80),
  renewsOn: day(81),
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
};
const version = new Map<string, number>();
async function save(
  ownerId: string,
  values: Partial<CoachingTermsValues> = {},
  operationId = randomUUID(),
) {
  const expectedVersion = version.get(ownerId) ?? 0;
  const saved = ready(
    await terms.save(admin, {
      ...current,
      ...values,
      ownerId,
      expectedVersion,
      operationId,
    }),
  );
  version.set(ownerId, saved.version);
  return saved;
}
interface GrantRow {
  id: string;
  category: string;
  quantity: number;
  available: number;
  reserved: number;
  consumed: number;
  adjusted: number;
  startsAt: Date;
  expiresAt: Date;
}
const grants = async (memberId: string, category?: string) =>
  (
    await pool.query<GrantRow>(
      `SELECT id,category,quantity,available,reserved,consumed,adjusted,
       starts_at AS "startsAt",expires_at AS "expiresAt"
       FROM synthetic_entitlement_grants WHERE member_id=$1 AND ($2::text IS NULL OR category=$2)
       ORDER BY created_at,id`,
      [memberId, category ?? null],
    )
  ).rows;
const total = (rows: GrantRow[], field: keyof GrantRow) =>
  rows.reduce((sum, row) => sum + Number(row[field]), 0);
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
let admin: string;
beforeAll(async () => {
  await migrate(pool);
  admin = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
});
afterAll(() => pool.end());

it("ALLOW27-01 saving terms turns expert review minutes and AI requests into units for the coaching period", async () => {
  const m = await member();
  await save(m.id);
  const review = await grants(m.id, "review_minutes");
  const ai = await grants(m.id, "study_requests");
  expect(review).toHaveLength(1);
  expect(ai).toHaveLength(1);
  expect(review[0]).toMatchObject({ quantity: 120, available: 120 });
  expect(ai[0]).toMatchObject({ quantity: 200, available: 200 });
  for (const row of [review[0]!, ai[0]!]) {
    expect(row.startsAt).toEqual(await torontoMidnight(current.startsOn));
    expect(row.expiresAt).toEqual(await torontoMidnight(day(81)));
  }
  // Coaching sessions stay an agreed number; nothing else is minted.
  expect(await grants(m.id)).toHaveLength(2);
  const units = await memberTestUnitsStore(pool).snapshot(m.token);
  if (units.kind !== "ready") throw Error("Expected test units");
  const usable = Object.fromEntries(
    units.value.categories.map((c) => [c.category, c.usable]),
  );
  expect(usable).toMatchObject({ review_minutes: 120, study_requests: 200 });
});

it("ALLOW27-02 replaying the same save, or saving the same numbers again, mints nothing more", async () => {
  const m = await member();
  const operationId = randomUUID();
  await save(m.id, {}, operationId);
  version.set(m.id, 0);
  expect(await save(m.id, {}, operationId)).toEqual({ version: 1 });
  await save(m.id, { priceCents: 160000, renewsOn: day(85) });
  expect(total(await grants(m.id, "review_minutes"), "quantity")).toBe(120);
  expect(total(await grants(m.id, "study_requests"), "quantity")).toBe(200);
  expect(await grants(m.id)).toHaveLength(2);
});

it("ALLOW27-03 a raised allowance for the same period tops up; a lowered one writes off unused units and keeps what was used", async () => {
  const m = await member();
  await save(m.id);
  await save(m.id, { reviewMinutes: 180 });
  const review = await grants(m.id, "review_minutes");
  expect(total(review, "quantity")).toBe(180);
  expect(total(review, "available")).toBe(180);
  const [ai] = await grants(m.id, "study_requests");
  const held = await ledger.reserve(m.id, ai!.id, 30, `allow27-03:${m.id}`);
  await ledger.consume(m.id, held, `allow27-03-use:${m.id}`);
  await save(m.id, { reviewMinutes: 180, aiRequests: 50 });
  let after = await grants(m.id, "study_requests");
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    quantity: 200,
    consumed: 30,
    adjusted: 150,
    available: 20,
  });
  // Lower than what was already used: every unused unit is written off.
  await save(m.id, { reviewMinutes: 180, aiRequests: 10 });
  after = await grants(m.id, "study_requests");
  expect(after[0]).toMatchObject({ consumed: 30, adjusted: 170, available: 0 });
  // Raising it again only grants what the new number adds over what's in use.
  await save(m.id, { reviewMinutes: 180, aiRequests: 100 });
  after = await grants(m.id, "study_requests");
  expect(total(after, "available")).toBe(70);
  expect(total(after, "consumed")).toBe(30);
});

it("ALLOW27-04 a renewal for the next period grants that period separately and leaves the current one running", async () => {
  const m = await member();
  await save(m.id);
  await save(m.id, {
    startsOn: day(81),
    endsOn: day(170),
    renewsOn: day(171),
    reviewMinutes: 60,
    aiRequests: 100,
  });
  const review = await grants(m.id, "review_minutes");
  expect(review.map((g) => [g.quantity, g.available])).toEqual([
    [120, 120],
    [60, 60],
  ]);
  expect(review[1]!.startsAt).toEqual(await torontoMidnight(day(81)));
  expect(review[1]!.expiresAt).toEqual(await torontoMidnight(day(171)));
});

it("ALLOW27-05 corrected dates that overlap the earlier period write off its unused units and grant the corrected period", async () => {
  const m = await member();
  await save(m.id);
  const [first] = await grants(m.id, "review_minutes");
  await ledger.reserve(m.id, first!.id, 20, `allow27-05:${m.id}`);
  await save(m.id, { startsOn: day(-5), endsOn: day(90), renewsOn: day(91) });
  const review = await grants(m.id, "review_minutes");
  expect(review).toHaveLength(2);
  expect(review[0]).toMatchObject({
    available: 0,
    reserved: 20,
    adjusted: 100,
  });
  expect(review[1]).toMatchObject({ quantity: 100, available: 100 });
  expect(review[1]!.startsAt).toEqual(await torontoMidnight(day(-5)));
});

it("ALLOW27-06 a period that has already ended, a zero allowance and an inactive account mint nothing", async () => {
  const m = await member();
  await save(m.id, { startsOn: day(-60), endsOn: day(-2), renewsOn: day(-1) });
  expect(await grants(m.id)).toHaveLength(0);
  const n = await member();
  await save(n.id, { reviewMinutes: 0 });
  expect(await grants(n.id, "review_minutes")).toHaveLength(0);
  await save(n.id, { reviewMinutes: 45 });
  expect(total(await grants(n.id, "review_minutes"), "available")).toBe(45);
  // A student whose account isn't active gets no units; the terms still save.
  const lapsed = await member();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
    [lapsed.id],
  );
  expect(await save(lapsed.id)).toEqual({ version: 1 });
  expect(await grants(lapsed.id)).toHaveLength(0);
});

it("ALLOW27-07 the student sees what's left, held and used of this period's allowances", async () => {
  const m = await member();
  await save(m.id);
  const [ai] = await grants(m.id, "study_requests");
  const held = await ledger.reserve(m.id, ai!.id, 5, `allow27-07:${m.id}`);
  await ledger.consume(m.id, held, `allow27-07-use:${m.id}`);
  await ledger.reserve(m.id, ai!.id, 2, `allow27-07-hold:${m.id}`);
  const shown = text((await get("/account/coaching", m.token)).text);
  expect(shown).toContain("Allowances left this period");
  expect(shown).toContain(
    "Expert review time 120 of 120 minutes left, 0 held, 0 used",
  );
  expect(shown).toContain("AI requests 193 of 200 left, 2 held, 5 used");
  expect(shown).toContain(
    "Coaching sessions are arranged with your coach and aren't counted here.",
  );
  const other = await member();
  expect(
    text((await get("/account/coaching", other.token)).text),
  ).not.toContain("Allowances left this period");
  const staffView = text(
    (await get(`/operator/coaching/${m.id}/package`, admin)).text,
  );
  expect(staffView).toContain("AI requests 193 of 200 left, 2 held, 5 used");
});

it("ALLOW27-08 AI requests above one grant's limit are split across grants, and deleting the account removes the links", async () => {
  const m = await member();
  await save(m.id, { aiRequests: 250000 });
  const ai = await grants(m.id, "study_requests");
  expect(ai.map((g) => g.quantity).sort((a, b) => b - a)).toEqual([
    100000, 100000, 50000,
  ]);
  await save(m.id, { aiRequests: 120000 });
  expect(total(await grants(m.id, "study_requests"), "available")).toBe(120000);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coaching_allowance_grants WHERE owner_id=$1",
        [m.id],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  await pool.query("DELETE FROM principals WHERE id=$1", [m.id]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coaching_allowance_grants WHERE owner_id=$1",
        [m.id],
      )
    ).rowCount,
  ).toBe(0);
});
