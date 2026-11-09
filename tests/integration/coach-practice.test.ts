import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../src/app.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { COOKIE } from "../../src/session.ts";
import {
  memberSlotHolds,
  SlotHoldFailure,
  type MemberSlotHolds,
} from "../../src/slot-holds.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
const holds = memberSlotHolds(pool);
const practiceSessions = practiceSessionStore(pool);
const origin = "http://127.0.0.1:3000";
const application = (memberHolds?: MemberSlotHolds) =>
  app(db, {
    origin,
    secret: "synthetic-coach-practice",
    practiceSessions,
    ...(memberHolds ? { memberSlotHolds: memberHolds } : {}),
  });
const live = application(holds);

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Synthetic member missing");
  return { id: session.learner.id, token };
}
function history(token: string, path = "/practice-sessions", target = live) {
  return withLoopback(target, (server) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}
const window = (hours = 240) => ({
  startsAt: new Date(Date.now() - 3600_000).toISOString(),
  expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
});
async function coachSlot() {
  const auth = authorizationStore(pool);
  const expires = new Date(Date.now() + 10 * 86_400_000);
  const staff = async (role: "coach" | "operator" | "platform_admin") => {
    const token = randomBytes(32).toString("hex");
    return { token, id: await auth.provisionStaff(token, role, expires) };
  };
  const admin = await staff("platform_admin");
  const operator = await staff("operator");
  const coach = await staff("coach");
  const backup = await staff("coach");
  const registryId = randomUUID();
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 3600_000);
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
      qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP),
       ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,CURRENT_TIMESTAMP)`,
    [
      registryId,
      coach.id,
      new Date(Date.now() - 3600_000),
      new Date(endsAt.getTime() + 3600_000),
      backup.id,
      admin.id,
      randomUUID(),
    ],
  );
  const slotId = await availabilityStore(pool).create(
    operator.token,
    registryId,
    startsAt,
    endsAt,
  );
  expect(slotId).toBeTruthy();
  return { slotId: slotId!, startsAt, endsAt };
}

it("COACHMOCK-01 practice-session units and background never open human practice", async () => {
  for (const background of ["explorer", "professional", "technical"] as const) {
    const owner = await member(background);
    await ledger.grant(
      owner.id,
      "mock_sessions",
      3,
      `coachmock-01-${background}`,
      window(),
    );
    const page = await history(owner.token);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Practice interview with a coach");
    expect(page.text).toContain(
      "A practice interview with a person needs coach minutes.",
    );
    expect(page.text).toContain("practice-session units can't be used instead");
    expect(page.text).toContain("No coach is booked for you.");
    expect(page.text).not.toContain('href="/availability"');
  }
});

it("COACHMOCK-02 only a current coach-minute grant links to sample coaching windows", async () => {
  const owner = await member();
  await ledger.grant(
    owner.id,
    "review_minutes",
    60,
    "coachmock-02-r",
    window(),
  );
  expect((await history(owner.token)).text).toContain("needs coach minutes");
  await ledger.grant(owner.id, "coach_minutes", 60, "coachmock-02-c", window());
  const page = await history(owner.token);
  expect(page.text).toContain('href="/availability"');
  expect(page.text).toContain("A sample hold isn't a booking");
  expect(page.text).not.toContain("needs coach minutes");
});

it("COACHMOCK-03 lists only the member's own coaching holds as not a booking", async () => {
  const slot = await coachSlot();
  const owner = await member("professional");
  const other = await member("technical");
  const grantId = await ledger.grant(
    owner.id,
    "coach_minutes",
    60,
    "coachmock-03-owner",
    window(),
  );
  await ledger.grant(
    other.id,
    "coach_minutes",
    60,
    "coachmock-03-other",
    window(),
  );
  const requestId = randomUUID();
  expect(
    await holds.request(owner.token, slot.slotId, grantId, requestId),
  ).toBe(requestId);
  const page = await history(owner.token);
  expect(page.text).toContain("Your sample coaching holds");
  expect(page.text).toContain("Sample hold with a coach · not a booking");
  expect(page.text).toContain(`href="/availability/holds/${requestId}"`);
  expect(page.text).toContain(`datetime="${slot.startsAt.toISOString()}"`);
  expect(page.text).toContain("Held until");
  // The slot is now held, so no grant has 60 free minutes left to offer.
  expect(page.text).toContain("needs coach minutes");
  const otherPage = await history(other.token);
  expect(otherPage.text).not.toContain(requestId);
  expect(otherPage.text).not.toContain("Your sample coaching holds");
  expect(otherPage.text).toContain('href="/availability"');
  await holds.withdraw(owner.token, requestId);
  expect((await history(owner.token)).text).toContain("You withdrew it");
});

it("COACHMOCK-05 a failed check keeps history readable, and later pages leave the section out", async () => {
  const owner = await member();
  const failing: MemberSlotHolds = {
    ...holds,
    snapshot: async () => {
      throw new SlotHoldFailure("uncertain");
    },
  };
  const page = await history(
    owner.token,
    "/practice-sessions",
    application(failing),
  );
  expect(page.status).toBe(200);
  expect(page.text).toContain(
    "We couldn't check your coach minutes or sample holds just now.",
  );
  expect(page.text).toContain("Private session history");
  const disabled = await history(
    owner.token,
    "/practice-sessions",
    application(),
  );
  expect(disabled.text).toContain("needs coach minutes");
  const after = Buffer.from(
    // The history cursor carries microseconds.
    JSON.stringify([
      new Date().toISOString().replace("Z", "000Z"),
      randomUUID(),
    ]),
  ).toString("base64url");
  const later = await history(owner.token, `/practice-sessions?after=${after}`);
  expect(later.status).toBe(200);
  expect(later.text).not.toContain("Practice interview with a coach");
});
