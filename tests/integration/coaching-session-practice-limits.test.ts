import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { availabilityStore } from "../../src/availability.ts";
import { catalogStore } from "../../src/catalog.ts";
import {
  coachingTermsStore,
  type CoachingTermsValues,
} from "../../src/coaching-terms.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { sampleHoldCancellationStore } from "../../src/sample-hold-cancellations.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #823 owner decision 11 Nov 2026: an administrator sets each student's session
// length and practice-conversation limit in the coaching terms. Invented people
// and amounts only.
const pool = testPool(),
  members = store(pool),
  terms = coachingTermsStore(pool),
  auth = authorizationStore(pool),
  slots = availabilityStore(pool),
  ledger = syntheticLedger(pool),
  holds = memberSlotHolds(pool),
  practice = practiceSessionStore(pool),
  catalog = catalogStore(pool),
  cancellations = sampleHoldCancellationStore(pool, { mode: "test" });
const origin = "http://127.0.0.1:3000",
  secret = "coaching-limits-test";
const application = app(members, {
  origin,
  secret,
  mode: "test",
  simpleInvoices: simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  coachingTerms: terms,
});
const token = () => randomBytes(32).toString("hex");
async function member() {
  const value = token();
  await members.create(value, { background: "explorer", goal: "everyday" });
  const s = await members.session(value, "account");
  if (s.kind !== "active") throw Error("Invented student missing");
  return { token: value, id: s.learner.id };
}
async function staff(role: "platform_admin" | "operator" | "coach") {
  const value = token();
  const id = await auth.provisionStaff(
    value,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token: value, id };
}
const agreed: CoachingTermsValues = {
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: 0,
  coachingSessions: 6,
  aiRequests: 0,
};
const form = {
  price: "1200.00",
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: "0",
  coachingSessions: "6",
  aiRequests: "0",
};
let admin: { token: string; id: string };
async function setTerms(
  ownerId: string,
  limits: { sessionMinutes?: number; practiceExchanges?: number },
) {
  const version = (
    await pool.query<{ n: number }>(
      "SELECT count(*)::integer n FROM coaching_terms WHERE owner_id=$1",
      [ownerId],
    )
  ).rows[0]!.n;
  const result = await terms.save(admin.token, {
    ...agreed,
    ...limits,
    ownerId,
    expectedVersion: version,
    operationId: randomUUID(),
  });
  expect(result).toEqual({ kind: "ready", value: { version: version + 1 } });
}
const get = (path: string, value: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${value}`),
  );
const post = (path: string, value: string, fields: Record<string, string>) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${value}`)
      .type("form")
      .send({ csrf: csrf(value, secret), ...fields }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
const stored = async (ownerId: string) =>
  (
    await pool.query<{ version: number; minutes: number; exchanges: number }>(
      "SELECT version,session_minutes AS minutes,practice_exchanges AS exchanges FROM coaching_terms WHERE owner_id=$1 ORDER BY version",
      [ownerId],
    )
  ).rows;

/** Four future one-hour coaching slots with a verified coach and backup. */
async function slotWorld() {
  const operator = await staff("operator"),
    coach = await staff("coach"),
    backup = await staff("coach");
  const registry = randomUUID();
  const first = Date.now() + 3 * 86_400_000;
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES($1,$2,'coach','education','coaching',$3,$4,12000,480,$5,'invented qualification','invented agreement','invented conflict review',$6,CURRENT_TIMESTAMP),
     ($7,$5,'coach','education','coaching',$3,$4,12000,480,$2,'invented qualification','invented agreement','invented conflict review',$6,CURRENT_TIMESTAMP)`,
    [
      registry,
      coach.id,
      new Date(Date.now() - 3_600_000),
      new Date(first + 10 * 86_400_000),
      backup.id,
      admin.id,
      randomUUID(),
    ],
  );
  const slotIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const startsAt = new Date(first + i * 2 * 3_600_000);
    const id = await slots.create(
      operator.token,
      registry,
      startsAt,
      new Date(startsAt.getTime() + 3_600_000),
    );
    expect(id).toBeTruthy();
    slotIds.push(id!);
  }
  return { operator, slotIds };
}
const grant = (memberId: string, quantity = 60) =>
  ledger.grant(memberId, "coach_minutes", quantity, randomUUID(), {
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });
const counters = async (grantId: string) =>
  (
    await pool.query<{
      available: number;
      reserved: number;
      expired: number;
      adjusted: number;
    }>(
      "SELECT available,reserved,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
      [grantId],
    )
  ).rows[0]!;
async function hold(owner: { token: string }, slotId: string, grantId: string) {
  const requestId = randomUUID();
  expect(await holds.request(owner.token, slotId, grantId, requestId)).toBe(
    requestId,
  );
  return requestId;
}

/** Two published invented lessons a student can practise against. */
async function lessons() {
  const editor = token(),
    reviewer = token();
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  for (const id of ["SYN-823", "SYN-824"]) {
    expect(
      await catalog.createDraft(editor, {
        id,
        version: 1,
        kind: "lesson",
        origin: "curated",
        title: `Invented practice source ${id}`,
        body: "Compare only invented examples against this exact source.",
        owner: "Invented editor",
        sources: "Original invented work",
        rights: "Owned invented work",
        goals: [],
        backgrounds: [],
        domains: [],
        prerequisites: "None",
        rubric: null,
        rubricVersion: null,
      }),
    ).toBe(true);
    expect(await catalog.submit(editor, id, 1)).toBe(true);
    expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
    expect(await catalog.publish(editor, id, 1)).toBe(true);
  }
}
async function begin(owner: { token: string }, contentId: string) {
  const result = await practice.start(owner.token, {
    contentId,
    contentVersion: 1,
    goal: "everyday",
    promptVersion: "practice-v1",
  });
  if (result.kind !== "started") throw Error("Practice start denied");
  return result.sessionId;
}
const say = (owner: { token: string }, id: string, sequence: number) =>
  practice.append(owner.token, id, {
    expectedSequence: sequence,
    response: `Invented response ${sequence}`,
  });

beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
  admin = await staff("platform_admin");
});
afterAll(() => pool.end());

it("LIMITS823-01 an administrator saves a student's session length and practice-conversation limit with the other terms, and both people see them", async () => {
  const m = await member();
  const blank = await get(`/operator/coaching/${m.id}/package`, admin.token);
  expect(blank.status).toBe(200);
  expect(blank.text).toMatch(
    /<input name="sessionMinutes" type="number" min="15" max="60" step="1" value="60" required>/,
  );
  expect(blank.text).toMatch(
    /<input name="practiceExchanges" type="number" min="1" max="50" step="1" value="15" required>/,
  );
  const saved = await post(`/operator/coaching/${m.id}/terms`, admin.token, {
    ...form,
    sessionMinutes: "45",
    practiceExchanges: "3",
    revision: "0",
    operationId: randomUUID(),
  });
  expect(saved.status).toBe(303);
  expect(await stored(m.id)).toEqual([
    { version: 1, minutes: 45, exchanges: 3 },
  ]);
  for (const page of [
    await get(`/operator/coaching/${m.id}/package`, admin.token),
    await get("/account/coaching", m.token),
  ]) {
    expect(page.status).toBe(200);
    expect(text(page.text)).toContain("Session length 45 minutes");
    expect(text(page.text)).toContain(
      "Practice conversation limit 3 exchanges",
    );
  }
  // The form now starts from the saved values.
  const again = await get(`/operator/coaching/${m.id}/package`, admin.token);
  expect(again.text).toMatch(/name="sessionMinutes"[^>]* value="45"/);
  expect(again.text).toMatch(/name="practiceExchanges"[^>]* value="3"/);
});

it("LIMITS823-02 values outside 15 to 60 minutes or 1 to 50 exchanges are refused, and the form explains the bounds", async () => {
  const m = await member();
  const page = await get(`/operator/coaching/${m.id}/package`, admin.token);
  expect(text(page.text)).toContain(
    "Session length is 15 to 60 minutes, because an expert's time slot is one hour.",
  );
  expect(text(page.text)).toContain(
    "A practice conversation can have 1 to 50 exchanges.",
  );
  for (const wrong of [
    { sessionMinutes: "14" },
    { sessionMinutes: "61" },
    { sessionMinutes: "45.5" },
    { sessionMinutes: "" },
    { practiceExchanges: "0" },
    { practiceExchanges: "51" },
    { practiceExchanges: "many" },
  ]) {
    const refused = await post(
      `/operator/coaching/${m.id}/terms`,
      admin.token,
      {
        ...form,
        sessionMinutes: "45",
        practiceExchanges: "3",
        ...wrong,
        revision: "0",
        operationId: randomUUID(),
      },
    );
    expect(refused.status).toBe(422);
    expect(text(refused.text)).toContain(
      "session length (15 to 60 minutes) and practice-conversation limit (1 to 50 exchanges)",
    );
  }
  for (const wrong of [
    { sessionMinutes: 14 },
    { sessionMinutes: 61 },
    { practiceExchanges: 0 },
    { practiceExchanges: 51 },
  ])
    expect(
      await terms.save(admin.token, {
        ...agreed,
        ...wrong,
        ownerId: m.id,
        expectedVersion: 0,
        operationId: randomUUID(),
      }),
    ).toEqual({ kind: "invalid" });
  expect(await stored(m.id)).toEqual([]);
  // The database refuses them too.
  for (const [minutes, exchanges] of [
    [14, 15],
    [61, 15],
    [60, 0],
    [60, 51],
  ])
    await expect(
      pool.query(
        "INSERT INTO coaching_terms(id,owner_id,version,price_cents,starts_on,ends_on,renews_on,review_minutes,coaching_sessions,ai_requests,session_minutes,practice_exchanges,actor_id,operation_id,digest) VALUES($1,$2,1,100,'2026-12-01','2026-12-31','2026-12-31',0,0,0,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          m.id,
          minutes,
          exchanges,
          admin.id,
          randomUUID(),
          "a".repeat(64),
        ],
      ),
    ).rejects.toThrow(/check constraint/);
});

it("LIMITS823-03 terms saved without the two values, and a student with no terms, keep 60 minutes and 15 exchanges", async () => {
  const m = await member();
  const saved = await post(`/operator/coaching/${m.id}/terms`, admin.token, {
    ...form,
    revision: "0",
    operationId: randomUUID(),
  });
  expect(saved.status).toBe(303);
  expect(await stored(m.id)).toEqual([
    { version: 1, minutes: 60, exchanges: 15 },
  ]);
  expect(text((await get("/account/coaching", m.token)).text)).toContain(
    "Session length 60 minutes",
  );

  const none = await member();
  const { slotIds } = await slotWorld();
  const grantId = await grant(none.id);
  const requestId = await hold(none, slotIds[0]!, grantId);
  expect(await holds.get(none.token, requestId)).toMatchObject({
    quantity: 60,
  });
  expect(await counters(grantId)).toMatchObject({ available: 0, reserved: 60 });
  await lessons();
  const id = await begin(none, "SYN-823");
  for (let n = 1; n <= 15; n++) expect(await say(none, id, n)).toBe("saved");
  expect(await say(none, id, 16)).toBe("full");
  expect(await practice.detail(none.token, id)).toMatchObject({
    availability: "full",
    exchangeLimit: 15,
  });
});

it("LIMITS823-04 a new session hold reserves the student's own session length, and withdrawing, expiring or a staff cancellation returns exactly that", async () => {
  const m = await member();
  await setTerms(m.id, { sessionMinutes: 45 });
  const { slotIds, operator } = await slotWorld();
  const grantId = await grant(m.id, 180);
  expect((await holds.snapshot(m.token)).sessionMinutes).toBe(45);

  const withdrawn = await hold(m, slotIds[0]!, grantId);
  expect(await holds.get(m.token, withdrawn)).toMatchObject({
    state: "held",
    quantity: 45,
  });
  expect(await counters(grantId)).toMatchObject({
    available: 135,
    reserved: 45,
  });
  await holds.withdraw(m.token, withdrawn);
  expect(await counters(grantId)).toMatchObject({
    available: 180,
    reserved: 0,
  });
  expect(await holds.get(m.token, withdrawn)).toMatchObject({
    state: "released",
    quantity: 45,
  });

  const expiring = await hold(m, slotIds[1]!, grantId);
  await pool.query(
    "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE state='held' AND member_id=$1",
    [m.id],
  );
  expect(await holds.get(m.token, expiring)).toMatchObject({
    state: "expired",
    quantity: 45,
  });
  expect(await counters(grantId)).toMatchObject({
    available: 180,
    reserved: 0,
  });

  await hold(m, slotIds[2]!, grantId);
  const holdId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM synthetic_slot_holds WHERE state='held' AND member_id=$1",
      [m.id],
    )
  ).rows[0]!.id;
  expect(
    await cancellations.cancel(
      operator.token,
      holdId,
      randomUUID(),
      "coach-unavailable",
    ),
  ).toMatchObject({ kind: "applied" });
  expect(await counters(grantId)).toMatchObject({
    available: 135,
    reserved: 0,
    adjusted: 45,
  });
  expect(
    (
      await pool.query<{ quantity: number; available: number }>(
        "SELECT g.quantity,g.available FROM sample_hold_staff_cancellations c JOIN synthetic_entitlement_grants g ON g.id=c.replacement_grant_id WHERE c.hold_id=$1",
        [holdId],
      )
    ).rows,
  ).toEqual([{ quantity: 45, available: 45 }]);
  // Every ledger entry for these holds is 45 minutes.
  expect(
    (
      await pool.query<{ quantity: number }>(
        "SELECT DISTINCT quantity FROM synthetic_entitlement_events WHERE member_id=$1 AND operation IN ('reserve','release','adjust')",
        [m.id],
      )
    ).rows,
  ).toEqual([{ quantity: 45 }]);
});

it("LIMITS823-05 a change to the session length applies to new holds only, and a student with too few minutes left for their session can't hold one", async () => {
  const m = await member();
  await setTerms(m.id, { sessionMinutes: 45 });
  const { slotIds } = await slotWorld();
  const grantId = await grant(m.id, 80);
  const first = await hold(m, slotIds[0]!, grantId);
  await setTerms(m.id, { sessionMinutes: 30 });
  expect(await holds.get(m.token, first)).toMatchObject({
    state: "held",
    quantity: 45,
  });
  const second = await hold(m, slotIds[1]!, grantId);
  expect(await holds.get(m.token, second)).toMatchObject({ quantity: 30 });
  expect(await counters(grantId)).toMatchObject({ available: 5, reserved: 75 });
  // 5 minutes are left: not enough for a 30-minute session.
  expect((await holds.snapshot(m.token)).grants).toEqual([]);
  await expect(
    holds.request(m.token, slotIds[2]!, grantId, randomUUID()),
  ).rejects.toMatchObject({ code: "insufficient" });
  await holds.withdraw(m.token, first);
  expect(await counters(grantId)).toMatchObject({
    available: 50,
    reserved: 30,
  });
});

it("LIMITS823-06 a new practice conversation takes the student's own limit, and a change applies to new conversations only", async () => {
  const m = await member();
  await setTerms(m.id, { practiceExchanges: 3 });
  await lessons();
  const first = await begin(m, "SYN-823");
  expect(await practice.detail(m.token, first)).toMatchObject({
    availability: "available",
    exchangeLimit: 3,
  });
  for (let n = 1; n <= 3; n++) expect(await say(m, first, n)).toBe("saved");
  expect(await say(m, first, 4)).toBe("full");
  expect(await practice.detail(m.token, first)).toMatchObject({
    availability: "full",
    nextSequence: null,
    exchangeLimit: 3,
  });

  await setTerms(m.id, { practiceExchanges: 20 });
  expect(await say(m, first, 4)).toBe("full");
  expect(await practice.detail(m.token, first)).toMatchObject({
    availability: "full",
    exchangeLimit: 3,
  });
  const second = await begin(m, "SYN-824");
  for (let n = 1; n <= 20; n++) expect(await say(m, second, n)).toBe("saved");
  expect(await say(m, second, 21)).toBe("full");
  const detail = await practice.detail(m.token, second);
  expect(detail).toMatchObject({ availability: "full", exchangeLimit: 20 });
  expect(detail!.exchanges).toHaveLength(20);
  // The database holds a conversation to its own limit as well.
  await expect(
    pool.query(
      "INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt) VALUES($1,4,'x','x','x')",
      [first],
    ),
  ).rejects.toThrow(/limit/i);
});

it("LIMITS823-07 the student's download lists both values in every terms version, without the administrator", async () => {
  const m = await member();
  await setTerms(m.id, {});
  await setTerms(m.id, { sessionMinutes: 30, practiceExchanges: 8 });
  const exporter = memberExportStore(pool);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.exportOwned(m.token, cursor);
    if (page.kind !== "ready") throw Error("Expected an export page");
    rows.push(...(page.payload.records.coachingTerms ?? []));
    cursor = page.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(rows).toMatchObject([
    { version: 1, sessionMinutes: 60, practiceExchanges: 15 },
    { version: 2, sessionMinutes: 30, practiceExchanges: 8 },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/actor|operation|digest/);
});
