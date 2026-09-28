import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { syntheticSlotHolds } from "../../src/slot-holds.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const slots = availabilityStore(pool);
const hour = 3_600_000;
let clock: Date;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  clock = new Date();
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function staff(role: "coach" | "operator" | "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 24 * hour),
  );
  return { token, id };
}

async function fixture(pair: [number, number], domain = "education") {
  const operator = await staff("operator");
  const admin = await staff("platform_admin");
  const coaches = await Promise.all([
    staff("coach"),
    staff("coach"),
    staff("coach"),
  ]);
  const startsAt = new Date(clock.getTime() + 3 * 24 * hour);
  const endsAt = new Date(startsAt.getTime() + hour);
  async function roster(primary: number, backup: number, rosterDomain: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
        starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
        qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
       VALUES($1,$2,'coach',$3,'coaching',$4,$5,12000,600,$6,
        'synthetic qualification','synthetic agreement','synthetic conflict review',$7,$4)`,
      [
        id,
        coaches[primary]!.id,
        rosterDomain,
        new Date(clock.getTime() - hour),
        new Date(endsAt.getTime() + 24 * hour),
        coaches[backup]!.id,
        admin.id,
      ],
    );
    return id;
  }
  // Every principal has verified coverage; the source rows differ independently
  // of whether their primary/backup roles share a principal.
  for (const rosterDomain of new Set(["education", domain])) {
    for (let index = 0; index < coaches.length; index++)
      await roster(index, (index + 1) % coaches.length, rosterDomain);
  }
  const firstRegistry = await roster(0, 1, "education");
  const secondRegistry = await roster(pair[0], pair[1], domain);
  return {
    operator,
    admin,
    coaches,
    startsAt,
    endsAt,
    firstRegistry,
    secondRegistry,
  };
}

async function snapshot() {
  const rows = {} as Record<string, unknown[]>;
  for (const table of [
    "expert_availability_slots",
    "synthetic_slot_holds",
    "synthetic_entitlement_grants",
    "synthetic_entitlement_reservations",
    "synthetic_entitlement_events",
  ])
    rows[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return rows;
}

async function memberGrant(key: string) {
  const token = randomBytes(32).toString("hex");
  const db = store(pool);
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  const memberId = session.learner.id;
  const grantId = await syntheticLedger(pool).grant(
    memberId,
    "coach_minutes",
    120,
    key,
    {
      startsAt: new Date(clock.getTime() - hour).toISOString(),
      expiresAt: new Date(clock.getTime() + 10 * 24 * hour).toISOString(),
    },
  );
  return { token, memberId, grantId };
}

const pairings: [string, [number, number]][] = [
  ["primary/primary", [0, 2]],
  ["primary/backup", [2, 0]],
  ["backup/primary", [1, 2]],
  ["backup/backup", [2, 1]],
  ["reciprocal primary/backup", [1, 0]],
];

it.each(pairings)(
  "refuses %s overlap without changing persisted slots or ledger",
  async (label, pair) => {
    const f = await fixture(pair, "creative");
    const first = await slots.create(
      f.operator.token,
      f.firstRegistry,
      f.startsAt,
      f.endsAt,
    );
    expect(first).toBeTruthy();
    await memberGrant("unchanged-grant");
    const before = await snapshot();
    const second = await slots.create(
      f.operator.token,
      f.secondRegistry,
      new Date(f.startsAt.getTime() + 30 * 60_000),
      new Date(f.endsAt.getTime() + 30 * 60_000),
    );
    const after = await snapshot();
    if (label === "reciprocal primary/backup")
      await writeFile(
        "artifacts/availability-conflict-state.json",
        JSON.stringify({ first, second, before, after }, null, 2),
      );
    expect({ second, persisted: after }).toEqual({
      second: null,
      persisted: before,
    });
  },
);

it.each(pairings)(
  "serializes simultaneous %s attempts on separate PostgreSQL connections",
  async (_label, pair) => {
    const f = await fixture(pair);
    const blocker = await pool.connect();
    const names = [randomUUID(), randomUUID()];
    const contenders = names.map(
      (name) =>
        new Pool({
          connectionString: process.env.DNE_TEST_DATABASE_URL,
          max: 1,
          application_name: name,
          statement_timeout: 4000,
        }),
    );
    let attempts: Promise<(string | null)[]> | undefined;
    try {
      await blocker.query("BEGIN");
      for (const id of f.coaches.map((coach) => coach.id).sort())
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [id],
        );
      attempts = Promise.all(
        contenders.map((connection, index) =>
          availabilityStore(connection).create(
            f.operator.token,
            index === 0 ? f.firstRegistry : f.secondRegistry,
            f.startsAt,
            f.endsAt,
          ),
        ),
      );
      // Attach a rejection observer immediately so timeout evidence stays bounded.
      void attempts.catch(() => {});
      let waiting = 0;
      for (let poll = 0; poll < 200 && waiting < 2; poll++) {
        waiting = Number(
          (
            await pool.query(
              `SELECT COUNT(*) AS count FROM pg_stat_activity
         WHERE application_name=ANY($1) AND wait_event='advisory'
           AND cardinality(pg_blocking_pids(pid))>0`,
              [names],
            )
          ).rows[0].count,
        );
        if (waiting < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(2);
      await blocker.query("COMMIT");
      const outcomes = await attempts;
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(
        (await pool.query("SELECT * FROM expert_availability_slots")).rowCount,
      ).toBe(1);
      expect(await slots.list()).toHaveLength(1);
      expect((await snapshot()).synthetic_entitlement_events).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await attempts?.catch(() => {});
      await Promise.all(contenders.map((connection) => connection.end()));
    }
  },
);

it.each(pairings)(
  "hides pre-existing %s conflicts and rejects new holds without ledger changes",
  async (_label, pair) => {
    const f = await fixture(pair);
    const first = await slots.create(
      f.operator.token,
      f.firstRegistry,
      f.startsAt,
      f.endsAt,
    );
    const second = randomUUID();
    // Simulate retained rows written before this integrity correction.
    await pool.query(
      `INSERT INTO expert_availability_slots
    (id,expert_registry_id,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5)`,
      [second, f.secondRegistry, f.startsAt, f.endsAt, f.operator.id],
    );
    const member = await memberGrant("conflict-grant");
    const before = await snapshot();
    const holds = syntheticSlotHolds(pool, () => clock);
    const deadline = new Date(clock.getTime() + 30 * 60_000);
    for (const slotId of [first!, second])
      await expect(
        holds.hold(
          member.memberId,
          slotId,
          member.grantId,
          `conflict-${slotId}`,
          deadline,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
    expect(await slots.list()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  },
);

it("accepts adjacent cross-role windows and retirement restores preview while preserving hold expiry", async () => {
  const f = await fixture([1, 0]);
  const first = await slots.create(
    f.operator.token,
    f.firstRegistry,
    f.startsAt,
    f.endsAt,
  );
  const adjacent = await slots.create(
    f.operator.token,
    f.secondRegistry,
    f.endsAt,
    new Date(f.endsAt.getTime() + hour),
  );
  expect(first).toBeTruthy();
  expect(adjacent).toBeTruthy();
  expect(await slots.list()).toHaveLength(2);
  const member = await memberGrant("recovery-grant");
  const holds = syntheticSlotHolds(pool, () => clock);
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  const holdId = await holds.hold(
    member.memberId,
    first!,
    member.grantId,
    "before-conflict",
    deadline,
  );
  const conflict = randomUUID();
  await pool.query(
    `INSERT INTO expert_availability_slots
    (id,expert_registry_id,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5)`,
    [conflict, f.secondRegistry, f.startsAt, f.endsAt, f.operator.id],
  );
  expect((await slots.list()).map((slot) => slot.id)).toEqual([adjacent]);
  const before = await snapshot();
  await expect(
    holds.hold(
      member.memberId,
      conflict,
      member.grantId,
      "denied-conflict",
      deadline,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await snapshot()).toEqual(before);
  // Replay is the existing hold, never a new commitment or event.
  expect(
    await holds.hold(
      member.memberId,
      first!,
      member.grantId,
      "before-conflict",
      deadline,
    ),
  ).toBe(holdId);
  // Rerunning migrations preserves historical conflicting rows and active holds.
  await migrate(pool);
  expect(await snapshot()).toEqual(before);
  clock = deadline;
  expect(await holds.expire(holdId, "recover-after-conflict")).toBe(holdId);
  expect(await holds.expire(holdId, "recover-after-conflict")).toBe(holdId);
  expect((await slots.list()).map((slot) => slot.id)).toEqual([adjacent]);
  expect(await slots.retire(f.operator.token, conflict)).toBe(true);
  expect((await slots.list()).map((slot) => slot.id)).toEqual([
    first,
    adjacent,
  ]);
  const after = await snapshot();
  expect(after.expert_availability_slots).toHaveLength(3);
  expect(after.synthetic_slot_holds).toMatchObject([
    { id: holdId, state: "expired" },
  ]);
  expect(after.synthetic_entitlement_grants).toMatchObject([
    { available: 120, reserved: 0, consumed: 0, expired: 0 },
  ]);
  expect(after.synthetic_entitlement_reservations).toMatchObject([
    { state: "released", quantity: 60 },
  ]);
  expect(after.synthetic_entitlement_events).toHaveLength(3);
  for (const event of before.synthetic_entitlement_events!)
    expect(after.synthetic_entitlement_events).toContainEqual(event);
  expect(await slots.retire(f.operator.token, first!)).toBe(true);
  expect(
    await slots.create(
      f.operator.token,
      f.secondRegistry,
      f.startsAt,
      f.endsAt,
    ),
  ).toBeTruthy();
});

it("preserves member/coach denials, revoked operators and verification requirements", async () => {
  const f = await fixture([1, 0]);
  const member = await memberGrant("role-grant");
  const before = await snapshot();
  for (const token of [member.token, f.coaches[0]!.token])
    expect(
      await slots.create(token, f.firstRegistry, f.startsAt, f.endsAt),
    ).toBeNull();
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [f.operator.id],
  );
  expect(
    await slots.create(f.operator.token, f.firstRegistry, f.startsAt, f.endsAt),
  ).toBeNull();
  await pool.query(
    "UPDATE expert_registry SET verified_by=NULL,verified_at=NULL WHERE id=$1",
    [f.firstRegistry],
  );
  expect(
    await slots.create(f.admin.token, f.firstRegistry, f.startsAt, f.endsAt),
  ).toBeNull();
  expect(await snapshot()).toEqual(before);
});
