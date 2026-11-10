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
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #42 QA-004 M15 (R12): calendar edges of a student's coaching period. The
// period is whole Toronto calendar days: its allowance units start at Toronto
// midnight on the start date and expire at Toronto midnight after the end
// date (#27). Renewal dates are compared with today's UTC date (#317). There
// is no booking, cancellation or refund date policy to test (owner, 9 Nov
// 2026). Invented people and numbers only; years are computed so the cases
// never fall into the past.
const pool = testPool(),
  members = store(pool),
  terms = coachingTermsStore(pool),
  auth = authorizationStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "coaching-term-dates-test";
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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (date: string, days: number) =>
  iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
/** The nth Sunday (1-based) of a month, as YYYY-MM-DD. */
function sunday(year: number, month: number, nth: number) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return iso(new Date(Date.UTC(year, month - 1, 1 + offset + 7 * (nth - 1))));
}
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// Two years ahead: every period below is in the future whenever this runs.
const YEAR = new Date().getUTCFullYear() + 2;
const SPRING = sunday(YEAR, 3, 2), // clocks go forward: a 23-hour day
  FALL = sunday(YEAR, 11, 1); // clocks go back: a 25-hour day
let LEAP = YEAR;
while (!leap(LEAP)) LEAP++;
const base = {
  priceCents: 120000,
  reviewMinutes: 60,
  coachingSessions: 2,
  aiRequests: 20,
};
const period = (
  startsOn: string,
  endsOn: string,
  renewsOn = plus(endsOn, 1),
): CoachingTermsValues => ({ ...base, startsOn, endsOn, renewsOn });
const version = new Map<string, number>();
async function save(ownerId: string, values: CoachingTermsValues) {
  const saved = ready(
    await terms.save(admin, {
      ...values,
      ownerId,
      expectedVersion: version.get(ownerId) ?? 0,
      operationId: randomUUID(),
    }),
  );
  version.set(ownerId, saved.version);
  return saved;
}
const windows = async (memberId: string) =>
  (
    await pool.query<{ starts: string; expires: string; hours: number }>(
      `SELECT DISTINCT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') AS starts,
       to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') AS expires,
       (extract(epoch FROM expires_at-starts_at)/3600)::integer AS hours
       FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY 1`,
      [memberId],
    )
  ).rows;
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (path: string, token: string, fields: Record<string, string>) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
const count = async (id: string) =>
  (
    await pool.query<{ n: number }>(
      "SELECT count(*)::integer n FROM coaching_terms WHERE owner_id=$1",
      [id],
    )
  ).rows[0]!.n;
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

it("TERMDATE42-01 a period on the spring clock change is the whole 23-hour Toronto day, and the day before ends where it begins", async () => {
  const gap = await member();
  await save(gap.id, period(SPRING, SPRING));
  // Midnight is still standard time (UTC-5); the next midnight is daylight time (UTC-4).
  expect(await windows(gap.id)).toEqual([
    {
      starts: `${SPRING}T05:00Z`,
      expires: `${plus(SPRING, 1)}T04:00Z`,
      hours: 23,
    },
  ]);
  const before = await member();
  await save(before.id, period(plus(SPRING, -7), plus(SPRING, -1)));
  expect((await windows(before.id))[0]!.expires).toBe(`${SPRING}T05:00Z`);
});

it("TERMDATE42-02 a period on the autumn clock change is the whole 25-hour day; the repeated hour belongs to it once, and a renewal starts exactly where it ends", async () => {
  const fold = await member();
  await save(fold.id, period(FALL, FALL));
  expect(await windows(fold.id)).toEqual([
    {
      starts: `${FALL}T04:00Z`,
      expires: `${plus(FALL, 1)}T05:00Z`,
      hours: 25,
    },
  ]);
  // The renewal for the next period: no gap and no shared instant.
  await save(fold.id, period(plus(FALL, 1), plus(FALL, 30)));
  const [first, next] = await windows(fold.id);
  expect(next!.starts).toBe(first!.expires);
  // Each period keeps its own units: nothing was written off or granted twice.
  expect(
    (
      await pool.query<{ starts: string; category: string; n: number }>(
        `SELECT to_char(c.starts_on,'YYYY-MM-DD') AS starts,c.category,sum(g.available)::integer AS n
         FROM coaching_allowance_grants c JOIN synthetic_entitlement_grants g ON g.id=c.grant_id
         WHERE c.owner_id=$1 GROUP BY 1,2 ORDER BY 1,2`,
        [fold.id],
      )
    ).rows.map((r) => [r.starts, r.n]),
  ).toEqual([
    [FALL, 60],
    [FALL, 20],
    [plus(FALL, 1), 60],
    [plus(FALL, 1), 20],
  ]);
});

it("TERMDATE42-03 a leap day and a 31 January to month-end period are kept as entered; dates that don't exist are refused and nothing is saved", async () => {
  const m = await member();
  const feb29 = `${LEAP}-02-29`;
  await save(m.id, period(`${LEAP}-01-31`, feb29, `${LEAP}-03-01`));
  expect(await windows(m.id)).toEqual([
    expect.objectContaining({
      starts: `${LEAP}-01-31T05:00Z`,
      expires: `${LEAP}-03-01T05:00Z`,
    }),
  ]);
  const page = text((await get("/account/coaching", m.token)).text);
  expect(page).toContain(`January 31, ${LEAP} to February 29, ${LEAP}`);
  expect(page).toContain(`Renewal date March 1, ${LEAP}`);
  const form = {
    price: "1200.00",
    startsOn: `${LEAP + 1}-01-31`,
    endsOn: `${LEAP + 1}-02-28`,
    renewsOn: `${LEAP + 1}-03-01`,
    reviewMinutes: "60",
    coachingSessions: "2",
    aiRequests: "20",
  };
  const n = await member();
  for (const wrong of [
    { endsOn: `${LEAP + 1}-02-29` }, // not a leap year
    { endsOn: `${LEAP}-02-30` },
    { startsOn: `${LEAP + 1}-01-32` },
    { renewsOn: `${LEAP + 1}-04-31` },
    { renewsOn: `${LEAP + 1}-13-01` },
    { endsOn: `${LEAP + 1}-01-30` }, // ends before it starts
    { renewsOn: `${LEAP + 1}-01-30` }, // renews before it starts
  ]) {
    const refused = await post(`/operator/coaching/${n.id}/terms`, admin, {
      ...form,
      ...wrong,
      revision: "0",
      operationId: randomUUID(),
    });
    expect(refused.status, JSON.stringify(wrong)).toBe(422);
  }
  expect(await count(n.id)).toBe(0);
  // The same form with real dates saves: 28 February is that year's month end.
  const saved = await post(`/operator/coaching/${n.id}/terms`, admin, {
    ...form,
    revision: "0",
    operationId: randomUUID(),
  });
  expect(saved.status).toBe(303);
  expect((await windows(n.id))[0]!.expires).toBe(`${LEAP + 1}-03-01T05:00Z`);
});

it("TERMDATE42-04 a period ending today in Toronto is still open until Toronto midnight; one that ended yesterday grants nothing", async () => {
  const { today, midnight } = (
    await pool.query<{ today: string; midnight: Date }>(
      `SELECT to_char(d,'YYYY-MM-DD') AS today,((d+1)::timestamp AT TIME ZONE 'America/Toronto') AS midnight
       FROM (SELECT (clock_timestamp() AT TIME ZONE 'America/Toronto')::date AS d) t`,
    )
  ).rows[0]!;
  const open = await member();
  await save(open.id, period(plus(today, -30), today));
  const live = (
    await pool.query<{ expires: Date; ahead: boolean }>(
      "SELECT DISTINCT expires_at AS expires,expires_at>clock_timestamp() AS ahead FROM synthetic_entitlement_grants WHERE member_id=$1",
      [open.id],
    )
  ).rows;
  expect(live).toEqual([{ expires: midnight, ahead: true }]);
  expect(text((await get("/account/coaching", open.token)).text)).toContain(
    "60 of 60 minutes left, 0 held, 0 used",
  );
  const ended = await member();
  await save(ended.id, period(plus(today, -30), plus(today, -1)));
  expect(await windows(ended.id)).toEqual([]);
  const page = text((await get("/account/coaching", ended.token)).text);
  expect(page).toContain("Your coaching terms");
  expect(page).not.toContain("Allowances left this period");
});

it("TERMDATE42-05 a one-day period with a same-day renewal date is valid, and the renewals list turns over at the UTC date: overdue, due today, due tomorrow, day 30 in, day 31 out", async () => {
  const today = (
    await pool.query<{ d: string }>(
      "SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d",
    )
  ).rows[0]!.d;
  const made: { id: string; offset: number }[] = [];
  for (const offset of [-1, 0, 1, 30, 31]) {
    const m = await member();
    // One day long; the renewal date may equal the start date.
    const starts = plus(today, Math.min(offset, 0) - 1);
    await save(m.id, period(starts, starts, plus(today, offset)));
    made.push({ id: m.id, offset });
  }
  const sameDay = await member();
  await save(sameDay.id, period(today, today, today));
  expect((await windows(sameDay.id))[0]).toMatchObject({
    starts: expect.stringMatching(new RegExp(`^${today}T0[45]:00Z$`)),
  });
  const listed = ready(await terms.renewalsDue(admin));
  expect(
    made.map((m) => listed.find((r) => r.ownerId === m.id)?.days ?? null),
  ).toEqual([-1, 0, 1, 30, null]);
  expect(listed.find((r) => r.ownerId === sameDay.id)?.days).toBe(0);
  const page = (await get("/operator/coaching", admin)).text.match(
    /<section[^>]*aria-labelledby="renewals-due".*?<\/section>/,
  )![0];
  const row = (id: string) =>
    text(page.match(new RegExp(`<li><a href="[^"]*${id}".*?</li>`))?.[0] ?? "");
  expect(row(made[0]!.id)).toContain("1 day overdue");
  expect(row(made[1]!.id)).toContain("due today");
  expect(row(made[2]!.id)).toContain("due in 1 day");
  expect(row(made[3]!.id)).toContain("due in 30 days");
  expect(row(made[4]!.id)).toBe("");
});
