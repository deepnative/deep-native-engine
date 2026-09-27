import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { syntheticSlotHolds } from "../../src/slot-holds.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const slots = availabilityStore(pool);
const ledger = syntheticLedger(pool);
let clock = new Date();
const holds = syntheticSlotHolds(pool, () => clock);

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
  clock = new Date();
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function member(background: "explorer" | "professional" | "technical") {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return session.learner.id;
}

async function staff(role: "coach" | "operator" | "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token, id };
}

async function fixture() {
  const admin = await staff("platform_admin");
  const operator = await staff("operator");
  const coach = await staff("coach");
  const backup = await staff("coach");
  const registryId = randomUUID();
  const backupId = randomUUID();
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,
      qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES ($1,$2,'coach','education','coaching',$3,$4,12000,60,$5,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,$8),
       ($7,$5,'coach','education','coaching',$3,$4,12000,60,$2,
       'synthetic qualification','synthetic agreement','synthetic conflict review',$6,$8)`,
    [
      registryId,
      coach.id,
      new Date(Date.now() - 3600_000),
      new Date(endsAt.getTime() + 3600_000),
      backup.id,
      admin.id,
      backupId,
      new Date(clock.getTime() - 60_000),
    ],
  );
  const slotId = await slots.create(
    operator.token,
    registryId,
    startsAt,
    endsAt,
  );
  expect(slotId).toBeTruthy();
  return { slotId: slotId!, registryId, backupId, coach, backup, startsAt };
}

async function grant(memberId: string, key: string) {
  return ledger.grant(memberId, "coach_minutes", 60, key, {
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });
}

it("atomically holds the last explicit slot and 60 synthetic minutes for one member", async () => {
  const { slotId } = await fixture();
  const explorer = await member("explorer");
  const professional = await member("professional");
  const explorerGrant = await grant(explorer, "explorer-grant");
  const professionalGrant = await grant(professional, "professional-grant");
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  const contenders = await Promise.allSettled([
    holds.hold(explorer, slotId, explorerGrant, "explorer-hold", deadline),
    holds.hold(
      professional,
      slotId,
      professionalGrant,
      "professional-hold",
      deadline,
    ),
  ]);
  expect(
    contenders.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const winner = contenders.find(
    (result) => result.status === "fulfilled",
  ) as PromiseFulfilledResult<string>;
  const held = await pool.query(
    `SELECT h.id,h.member_id,h.state,r.quantity,r.state AS reservation_state
     FROM synthetic_slot_holds h JOIN synthetic_entitlement_reservations r
       ON r.id=h.reservation_id`,
  );
  expect(held.rows).toMatchObject([
    {
      id: winner.value,
      state: "held",
      quantity: 60,
      reservation_state: "reserved",
    },
  ]);
  const balances = await pool.query(
    "SELECT member_id,available,reserved FROM synthetic_entitlement_grants ORDER BY member_id",
  );
  expect(
    balances.rows.map((row) => [row.available, row.reserved]).sort(),
  ).toEqual([
    [0, 60],
    [60, 0],
  ]);
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE operation='reserve'",
      )
    ).rowCount,
  ).toBe(1);
  const winnerArgs: [string, string, string] =
    held.rows[0].member_id === explorer
      ? [explorer, explorerGrant, "explorer-hold"]
      : [professional, professionalGrant, "professional-hold"];
  expect(
    await holds.hold(
      winnerArgs[0],
      slotId,
      winnerArgs[1],
      winnerArgs[2],
      deadline,
    ),
  ).toBe(winner.value);
  await expect(
    holds.hold(
      winnerArgs[0],
      slotId,
      winnerArgs[1],
      winnerArgs[2],
      new Date(deadline.getTime() + 1000),
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    holds.hold(
      winnerArgs[0] === explorer ? professional : explorer,
      slotId,
      winnerArgs[0] === explorer ? professionalGrant : explorerGrant,
      winnerArgs[2],
      deadline,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    holds.hold(
      winnerArgs[0],
      randomUUID(),
      winnerArgs[1],
      winnerArgs[2],
      deadline,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    holds.hold(
      winnerArgs[0],
      slotId,
      winnerArgs[0] === explorer ? professionalGrant : explorerGrant,
      winnerArgs[2],
      deadline,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("serializes the final grant minutes against ordinary ledger reservations", async () => {
  const { slotId } = await fixture();
  const owner = await member("technical");
  const grantId = await grant(owner, "last-minute-grant");
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  const contenders = await Promise.allSettled([
    holds.hold(owner, slotId, grantId, "last-minute-hold", deadline),
    ledger.reserve(owner, grantId, 60, "last-minute-ledger"),
  ]);
  expect(
    contenders.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows[0],
  ).toEqual({ available: 0, reserved: 60 });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_reservations"))
      .rowCount,
  ).toBe(1);
  expect(
    (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
  ).toBe(contenders[0]!.status === "fulfilled" ? 1 : 0);
});

it("fails closed for wrong owner/category, retired coverage and invalid deadline", async () => {
  const { slotId, registryId, backupId, coach, backup, startsAt } =
    await fixture();
  const explorer = await member("explorer");
  const technical = await member("technical");
  const coachGrant = await grant(explorer, "owner-grant");
  const reviewGrant = await ledger.grant(
    explorer,
    "review_minutes",
    60,
    "review-grant",
    {
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    },
  );
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  await expect(
    holds.hold(technical, slotId, coachGrant, "wrong-owner", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    holds.hold(explorer, slotId, reviewGrant, "wrong-category", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  const smallGrant = await ledger.grant(
    explorer,
    "coach_minutes",
    59,
    "small-grant",
    {
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    },
  );
  await expect(
    holds.hold(explorer, slotId, smallGrant, "small-hold", deadline),
  ).rejects.toMatchObject({ code: "insufficient" });
  await expect(
    holds.hold(
      explorer,
      slotId,
      coachGrant,
      "late",
      new Date(startsAt.getTime() + 1),
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await pool.query(
    "UPDATE expert_availability_slots SET retired_at=CURRENT_TIMESTAMP WHERE id=$1",
    [slotId],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "retired-slot", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query(
    "UPDATE expert_availability_slots SET retired_at=NULL WHERE id=$1",
    [slotId],
  );
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=1 WHERE id=$1",
    [registryId],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "spent-capacity", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=0 WHERE id=$1",
    [registryId],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [explorer],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "revoked-member", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    explorer,
  ]);
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=$1 WHERE id=$2",
    [new Date(clock.getTime() - 60_000), coachGrant],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "expired-grant", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=$1 WHERE id=$2",
    [new Date(clock.getTime() + 10 * 86_400_000), coachGrant],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [coach.id],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "revoked-coach", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    coach.id,
  ]);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [backup.id],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "revoked-backup", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    backup.id,
  ]);
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=1 WHERE id=$1",
    [backupId],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "spent-backup", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query(
    "UPDATE expert_registry SET committed_minutes=0 WHERE id=$1",
    [backupId],
  );
  await pool.query(
    "UPDATE expert_registry SET retired_at=CURRENT_TIMESTAMP WHERE id=$1",
    [registryId],
  );
  await expect(
    holds.hold(explorer, slotId, coachGrant, "retired-coach", deadline),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(
    (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [coachGrant],
      )
    ).rows[0],
  ).toEqual({ available: 60, reserved: 0 });
});

it("expires only a due hold and settles its reserved minutes exactly once", async () => {
  const { slotId } = await fixture();
  const owner = await member("professional");
  const grantId = await grant(owner, "expiry-grant");
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  const holdId = await holds.hold(
    owner,
    slotId,
    grantId,
    "expiry-hold",
    deadline,
  );
  expect(await slots.list()).toEqual([]);
  await expect(holds.expire(holdId, "early-expire")).rejects.toMatchObject({
    code: "unavailable",
  });
  clock = new Date(deadline.getTime() + 1);
  expect(await holds.expire(holdId, "expire-once")).toBe(holdId);
  expect(await slots.list()).toHaveLength(1);
  expect(await holds.expire(holdId, "expire-once")).toBe(holdId);
  await expect(holds.expire(holdId, "expire-again")).rejects.toMatchObject({
    code: "already_settled",
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows[0],
  ).toEqual({ available: 60, reserved: 0, expired: 0 });
  expect(
    (
      await pool.query("SELECT state FROM synthetic_slot_holds WHERE id=$1", [
        holdId,
      ])
    ).rows[0].state,
  ).toBe("expired");
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE operation='release'",
      )
    ).rowCount,
  ).toBe(1);
});

it("keeps an expiry and a competing new hold serialized on the same slot", async () => {
  const { slotId } = await fixture();
  const owner = await member("explorer");
  const firstGrant = await grant(owner, "race-first-grant");
  const secondGrant = await grant(owner, "race-second-grant");
  const firstDeadline = new Date(clock.getTime() + 30 * 60_000);
  const firstHold = await holds.hold(
    owner,
    slotId,
    firstGrant,
    "race-first-hold",
    firstDeadline,
  );
  clock = new Date(firstDeadline.getTime() + 1);
  const secondDeadline = new Date(clock.getTime() + 30 * 60_000);
  const contenders = await Promise.allSettled([
    holds.expire(firstHold, "race-expire"),
    holds.hold(owner, slotId, secondGrant, "race-second-hold", secondDeadline),
  ]);
  expect(contenders[0]!.status).toBe("fulfilled");
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_slot_holds WHERE slot_id=$1 AND state='held'",
        [slotId],
      )
    ).rowCount,
  ).toBe(contenders[1]!.status === "fulfilled" ? 1 : 0);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [firstGrant],
      )
    ).rows[0],
  ).toEqual({ available: 60, reserved: 0 });
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [secondGrant],
      )
    ).rows[0],
  ).toEqual(
    contenders[1]!.status === "fulfilled"
      ? { available: 0, reserved: 60 }
      : { available: 60, reserved: 0 },
  );
});

it("does not let generic ledger settlement split a slot hold from its minutes", async () => {
  const { slotId } = await fixture();
  const owner = await member("technical");
  const grantId = await grant(owner, "guarded-grant");
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  const holdId = await holds.hold(
    owner,
    slotId,
    grantId,
    "guarded-hold",
    deadline,
  );
  const reservationId = (
    await pool.query<{ reservation_id: string }>(
      "SELECT reservation_id FROM synthetic_slot_holds WHERE id=$1",
      [holdId],
    )
  ).rows[0]!.reservation_id;
  await expect(
    ledger.release(owner, reservationId, "bypass-release"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    ledger.consume(owner, reservationId, "bypass-consume"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows[0],
  ).toEqual({ available: 0, reserved: 60 });
  clock = new Date(deadline.getTime() + 1);
  expect(await holds.expire(holdId, "guarded-expire")).toBe(holdId);
});

it("expires held minutes with their grant and rolls back a failed hold insertion", async () => {
  const { slotId } = await fixture();
  const owner = await member("explorer");
  const grantId = await grant(owner, "rollback-grant");
  const deadline = new Date(clock.getTime() + 30 * 60_000);
  await pool.query(`CREATE FUNCTION reject_test_slot_hold() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rejection'; END $$`);
  await pool.query(`CREATE TRIGGER reject_test_slot_hold BEFORE INSERT
    ON synthetic_slot_holds FOR EACH ROW EXECUTE FUNCTION reject_test_slot_hold()`);
  try {
    await expect(
      holds.hold(owner, slotId, grantId, "rollback-hold", deadline),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows[0],
    ).toEqual({ available: 60, reserved: 0 });
    expect(
      (await pool.query("SELECT * FROM synthetic_entitlement_reservations"))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
    ).toBe(0);
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_slot_hold ON synthetic_slot_holds",
    );
    await pool.query("DROP FUNCTION reject_test_slot_hold()");
  }
  const holdId = await holds.hold(
    owner,
    slotId,
    grantId,
    "accepted-hold",
    deadline,
  );
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=$1 WHERE id=$2",
    [new Date(clock.getTime() + 20 * 60_000), grantId],
  );
  clock = new Date(deadline.getTime() + 1);
  expect(await holds.expire(holdId, "expired-grant-release")).toBe(holdId);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows[0],
  ).toEqual({ available: 0, reserved: 0, expired: 60 });
});
