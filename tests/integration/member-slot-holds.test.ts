import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import request from "supertest";
import type { Pool } from "pg";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const slots = availabilityStore(pool);
const ledger = syntheticLedger(pool);
let clock = new Date();
const memberHolds = memberSlotHolds(pool);

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
  return { id: session.learner.id, token };
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
  return {
    slotId: slotId!,
    registryId,
    backupId,
    coach,
    backup,
    startsAt,
    operator,
    admin,
  };
}

async function grant(memberId: string, key: string) {
  return ledger.grant(memberId, "coach_minutes", 60, key, {
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });
}

it("requires an explicit current allowance for every background and returns a private stable sample receipt", async () => {
  const fixtureRow = await fixture();
  for (const background of ["explorer", "professional", "technical"] as const) {
    const owner = await member(background);
    expect(await memberHolds.snapshot(owner.token)).toEqual({
      grants: [],
      receipts: [],
    });
    await expect(
      memberHolds.request(
        owner.token,
        fixtureRow.slotId,
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    const grantId = await grant(owner.id, `${background}-grant`);
    const requestId = randomUUID();
    expect((await memberHolds.snapshot(owner.token)).grants).toEqual([
      { id: grantId, category: "coach_minutes" },
    ]);
    expect(
      await memberHolds.request(
        owner.token,
        fixtureRow.slotId,
        grantId,
        requestId,
      ),
    ).toBe(requestId);
    const receipt = await memberHolds.get(owner.token, requestId);
    expect(receipt).toMatchObject({
      id: requestId,
      slotId: fixtureRow.slotId,
      domain: "education",
      serviceType: "coaching",
      state: "held",
      quantity: 60,
    });
    // The hold deadline uses PostgreSQL's clock; a host/DB clock difference
    // must not look like an allowance longer than the ten-minute contract.
    const databaseClock = (
      await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0];
    if (!databaseClock) throw new Error("Missing database clock observation");
    const remaining =
      receipt!.expiresAt.getTime() - databaseClock.now.getTime();
    expect(remaining).toBeGreaterThan(590_000);
    expect(remaining).toBeLessThanOrEqual(600_000);
    expect(receipt!.expiresAt.getTime()).toBeLessThan(
      fixtureRow.startsAt.getTime(),
    );
    expect(Object.keys(receipt!).sort()).toEqual(
      [
        "id",
        "slotId",
        "domain",
        "serviceType",
        "startsAt",
        "endsAt",
        "expiresAt",
        "state",
        "quantity",
      ].sort(),
    );
    expect(
      await memberHolds.request(
        owner.token,
        fixtureRow.slotId,
        grantId,
        requestId,
      ),
    ).toBe(requestId);
    expect((await memberHolds.get(owner.token, requestId))!.expiresAt).toEqual(
      receipt!.expiresAt,
    );
    await expect(
      memberHolds.request(owner.token, randomUUID(), grantId, requestId),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      memberHolds.request(
        owner.token,
        fixtureRow.slotId,
        randomUUID(),
        requestId,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const other = await member("explorer");
    expect(await memberHolds.get(other.token, requestId)).toBeNull();
    expect(await memberHolds.get(fixtureRow.admin.token, requestId)).toBeNull();
    expect((await memberHolds.snapshot(other.token)).receipts).toEqual([]);
    await pool.query(
      "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
      [owner.id],
    );
    expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
      "expired",
    );
    expect(
      await memberHolds.request(
        owner.token,
        fixtureRow.slotId,
        grantId,
        requestId,
      ),
    ).toBe(requestId);
    expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
      "expired",
    );
    expect(
      (
        await pool.query(
          "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 60, reserved: 0, expired: 0 }]);
    expect(
      (
        await pool.query(
          "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 ORDER BY operation",
          [owner.id],
        )
      ).rows,
    ).toEqual([
      { operation: "grant" },
      { operation: "release" },
      { operation: "reserve" },
    ]);
  }
});

it("rejects forged ownership, wrong/expired/exhausted grants, stale slots and unavailable sessions or staff without reserving", async () => {
  const f = await fixture();
  const owner = await member("professional");
  const other = await member("technical");
  const grantId = await grant(owner.id, "denial-grant");
  const wrong = await ledger.grant(
    owner.id,
    "review_minutes",
    60,
    "wrong-category",
    {
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  );
  const denied = (token = owner.token, slot = f.slotId, g = grantId) =>
    expect(
      memberHolds.request(token, slot, g, randomUUID()),
    ).rejects.toMatchObject({ code: "unavailable" });
  await denied(other.token);
  await denied(f.admin.token);
  await denied("forged");
  await denied(owner.token, randomUUID());
  await denied(owner.token, f.slotId, wrong);
  for (const change of [
    [
      "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      grantId,
    ],
    [
      "UPDATE expert_availability_slots SET retired_at=clock_timestamp() WHERE id=$1",
      "UPDATE expert_availability_slots SET retired_at=NULL WHERE id=$1",
      f.slotId,
    ],
    [
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      "UPDATE principals SET revoked_at=NULL WHERE id=$1",
      f.coach.id,
    ],
    [
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      "UPDATE principals SET revoked_at=NULL WHERE id=$1",
      f.backup.id,
    ],
    [
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      "UPDATE principals SET revoked_at=NULL WHERE id=$1",
      owner.id,
    ],
    [
      "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      owner.id,
    ],
  ]) {
    await pool.query(change[0]!, [change[2]]);
    await denied();
    await pool.query(change[1]!, [change[2]]);
  }
  await ledger.reserve(owner.id, grantId, 60, "exhausted");
  await expect(
    memberHolds.request(owner.token, f.slotId, grantId, randomUUID()),
  ).rejects.toMatchObject({ code: "insufficient" });
  expect((await memberHolds.snapshot(owner.token)).grants).toEqual([
    { id: wrong, category: "review_minutes" },
  ]);
  expect(
    (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
  ).toBe(0);
  expect(
    (await pool.query("SELECT * FROM synthetic_member_hold_receipts")).rowCount,
  ).toBe(0);
});

it("serializes two members on the last slot and holds against the final ledger minutes", async () => {
  const f = await fixture();
  const a = await member("explorer"),
    b = await member("technical");
  const ga = await grant(a.id, "race-a"),
    gb = await grant(b.id, "race-b");
  const attempts = await Promise.allSettled([
    memberHolds.request(a.token, f.slotId, ga, randomUUID()),
    memberHolds.request(b.token, f.slotId, gb, randomUUID()),
  ]);
  expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(
    (await pool.query("SELECT * FROM synthetic_member_hold_receipts")).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants ORDER BY available",
      )
    ).rows,
  ).toEqual([
    { available: 0, reserved: 60 },
    { available: 60, reserved: 0 },
  ]);
  const f2 = await fixture();
  const c = await member("professional"),
    gc = await grant(c.id, "race-c");
  const units = await Promise.allSettled([
    memberHolds.request(c.token, f2.slotId, gc, randomUUID()),
    ledger.reserve(c.id, gc, 60, "last-ledger-unit"),
  ]);
  expect(units.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [gc],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 60 }]);
});

it("settles a due incumbent once while its owner reloads and a new member reserves, preserving expired grant units", async () => {
  const f = await fixture();
  const a = await member("explorer"),
    b = await member("professional");
  const ga = await grant(a.id, "incumbent"),
    gb = await grant(b.id, "contender");
  const first = randomUUID(),
    second = randomUUID();
  await memberHolds.request(a.token, f.slotId, ga, first);
  expect(await slots.list()).toEqual([]);
  await pool.query(
    "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
    [a.id],
  );
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [ga],
  );
  expect(await slots.list()).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT state FROM synthetic_slot_holds WHERE member_id=$1",
        [a.id],
      )
    ).rows[0].state,
  ).toBe("held");
  const outcomes = await Promise.all([
    memberHolds.get(a.token, first),
    memberHolds.request(b.token, f.slotId, gb, second),
  ]);
  expect(outcomes[0]!.state).toBe("expired");
  expect(outcomes[1]).toBe(second);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [ga],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 0, expired: 60 }]);
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
        [a.id],
      )
    ).rowCount,
  ).toBe(1);
  expect((await memberHolds.get(b.token, second))!.state).toBe("held");
});

it("rolls back a receipt-write fault with its slot, reservation and debit and clips the test deadline before a near slot", async () => {
  const f = await fixture(),
    owner = await member("technical");
  const grantId = await grant(owner.id, "rollback");
  const requestId = randomUUID();
  await pool.query(
    "CREATE FUNCTION reject_test_member_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt fault'; END $$",
  );
  await pool.query(
    "CREATE TRIGGER reject_test_member_receipt BEFORE INSERT ON synthetic_member_hold_receipts FOR EACH ROW EXECUTE FUNCTION reject_test_member_receipt()",
  );
  try {
    await expect(
      memberHolds.request(owner.token, f.slotId, grantId, requestId),
    ).rejects.toMatchObject({ code: "uncertain" });
    expect(await memberHolds.get(owner.token, requestId)).toBeNull();
    expect(
      (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT * FROM synthetic_entitlement_reservations"))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 60, reserved: 0 }]);
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_member_receipt ON synthetic_member_hold_receipts",
    );
    await pool.query("DROP FUNCTION reject_test_member_receipt()");
  }
  await pool.query(
    "UPDATE expert_availability_slots SET starts_at=statement_timestamp()+interval '2 minutes',ends_at=statement_timestamp()+interval '62 minutes' WHERE id=$1",
    [f.slotId],
  );
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  const receipt = await memberHolds.get(owner.token, requestId);
  expect(receipt!.startsAt.getTime() - receipt!.expiresAt.getTime()).toBe(1000);
});

it("rechecks member expiry after waiting on a slot and rolls back the uncertain-time reservation", async () => {
  const f = await fixture(),
    owner = await member("professional");
  const grantId = await grant(owner.id, "wait-expiry"),
    requestId = randomUUID();
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query(
    "SELECT id FROM expert_availability_slots WHERE id=$1 FOR UPDATE",
    [f.slotId],
  );
  const pending = memberHolds
    .request(owner.token, f.slotId, grantId, requestId)
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT member_sample_hold(%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0].count,
          ),
        { timeout: 3000 },
      )
      .toBe(1);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
    await lock.query("COMMIT");
    expect(await pending).toMatchObject({ error: { code: "unavailable" } });
    expect(await memberHolds.get(owner.token, requestId)).toBeNull();
    expect(
      (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 60, reserved: 0 }]);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    await pending;
  }
});

it.each(["grant", "member"] as const)(
  "expires held units when %s expires during a receipt lock wait",
  async (kind) => {
    const f = await fixture(),
      owner = await member("explorer");
    const grantId = await grant(owner.id, "settle-wait-grant"),
      requestId = randomUUID();
    await memberHolds.request(owner.token, f.slotId, grantId, requestId);
    await pool.query(
      "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
      [owner.id],
    );
    const lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query(
      "SELECT id FROM expert_availability_slots WHERE id=$1 FOR UPDATE",
      [f.slotId],
    );
    const pending = memberHolds.get(owner.token, requestId);
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await pool.query(
                  "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT settle_member_sample_holds(%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
                )
              ).rows[0].count,
            ),
          { timeout: 3000 },
        )
        .toBe(1);
      await pool.query(
        kind === "grant"
          ? "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp() WHERE id=$1"
          : "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
        [kind === "grant" ? grantId : owner.id],
      );
      await lock.query("COMMIT");
      await pending;
      expect(
        (
          await pool.query(
            "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
            [grantId],
          )
        ).rows,
      ).toEqual([{ available: 0, reserved: 0, expired: 60 }]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await pending;
    }
  },
);

it("lets two members exchange due independent sample slots without a member-lock cycle", async () => {
  const fa = await fixture(),
    fb = await fixture();
  const a = await member("technical"),
    b = await member("professional");
  const oldA = await grant(a.id, "swap-old-a"),
    oldB = await grant(b.id, "swap-old-b");
  const newA = await grant(a.id, "swap-new-a"),
    newB = await grant(b.id, "swap-new-b");
  await memberHolds.request(a.token, fa.slotId, oldA, randomUUID());
  await memberHolds.request(b.token, fb.slotId, oldB, randomUUID());
  await pool.query(
    "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second'",
  );
  await pool.query(`CREATE FUNCTION pause_test_sample_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.state='held' AND NEW.state='expired' THEN PERFORM pg_advisory_xact_lock(385,hashtext(NEW.member_id::text)); END IF;
    RETURN NEW; END $$`);
  await pool.query(
    "CREATE TRIGGER pause_test_sample_expiry BEFORE UPDATE ON synthetic_slot_holds FOR EACH ROW EXECUTE FUNCTION pause_test_sample_expiry()",
  );
  const lockA = await pool.connect(),
    lockB = await pool.connect();
  await lockA.query("SELECT pg_advisory_lock(385,hashtext($1))", [a.id]);
  await lockB.query("SELECT pg_advisory_lock(385,hashtext($1))", [b.id]);
  const pending = Promise.allSettled([
    memberHolds.request(a.token, fb.slotId, newA, randomUUID()),
    memberHolds.request(b.token, fa.slotId, newB, randomUUID()),
  ]);
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT %sample%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0].count,
          ),
        { timeout: 3000 },
      )
      .toBe(2);
    await Promise.all([
      lockA.query("SELECT pg_advisory_unlock(385,hashtext($1))", [a.id]),
      lockB.query("SELECT pg_advisory_unlock(385,hashtext($1))", [b.id]),
    ]);
    const results = await pending;
    expect(results.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS count FROM synthetic_slot_holds WHERE state='held'",
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id IN ($1,$2)",
          [oldA, oldB],
        )
      ).rows,
    ).toEqual([
      { available: 60, reserved: 0 },
      { available: 60, reserved: 0 },
    ]);
  } finally {
    await lockA.query("SELECT pg_advisory_unlock_all()");
    await lockB.query("SELECT pg_advisory_unlock_all()");
    lockA.release();
    lockB.release();
    await pending;
    await pool.query(
      "DROP TRIGGER pause_test_sample_expiry ON synthetic_slot_holds",
    );
    await pool.query("DROP FUNCTION pause_test_sample_expiry()");
  }
});

it("recovers the same private receipt after a committed database write loses its response", async () => {
  const f = await fixture(),
    owner = await member("explorer");
  const grantId = await grant(owner.id, "lost-response"),
    requestId = randomUUID();
  const responseLoss = memberSlotHolds({
    query: async (sql: string, values: unknown[]) => {
      const result = await pool.query(sql, values);
      if (sql.startsWith("SELECT member_sample_hold("))
        throw new Error("synthetic transport response lost");
      return result;
    },
  } as unknown as import("pg").Pool);
  await expect(
    responseLoss.request(owner.token, f.slotId, grantId, requestId),
  ).rejects.toMatchObject({ code: "uncertain" });
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe("held");
  expect(
    (await memberHolds.snapshot(owner.token)).receipts.map((x) => x.id),
  ).toEqual([requestId]);
  expect(
    await memberHolds.request(owner.token, f.slotId, grantId, requestId),
  ).toBe(requestId);
  expect(
    (await pool.query("SELECT * FROM synthetic_slot_holds")).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE operation='reserve'",
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 60 }]);
});

it("may settle an already-due incumbent before a denied contender but never leaves a new hold or debit", async () => {
  const f = await fixture(),
    owner = await member("explorer"),
    other = await member("technical");
  const grantId = await grant(owner.id, "due-before-denial"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  await pool.query(
    "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second'",
  );
  await expect(
    memberHolds.request(other.token, f.slotId, grantId, randomUUID()),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
    "expired",
  );
  expect(
    (await pool.query("SELECT * FROM synthetic_slot_holds WHERE state='held'"))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 60, reserved: 0 }]);
});

it("withdraws an owner's active hold once, retains exact receipt fields, and frees the same sample slot for a new request", async () => {
  const f = await fixture();
  for (const background of ["explorer", "professional", "technical"] as const) {
    const owner = await member(background);
    const grantId = await grant(owner.id, `withdraw-${background}`),
      requestId = randomUUID();
    await memberHolds.request(owner.token, f.slotId, grantId, requestId);
    const before = await memberHolds.get(owner.token, requestId);
    const outcomes = await Promise.all([
      memberHolds.withdraw(owner.token, requestId),
      memberHolds.withdraw(owner.token, requestId),
    ]);
    expect(outcomes).toEqual([requestId, requestId]);
    expect(await memberHolds.get(owner.token, requestId)).toEqual({
      ...before,
      state: "released",
    });
    expect((await memberHolds.snapshot(owner.token)).receipts).toEqual([
      { ...before, state: "released" },
    ]);
    expect(
      await memberHolds.request(owner.token, f.slotId, grantId, requestId),
    ).toBe(requestId);
    expect(await slots.list()).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed,expired,quantity FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([
      { available: 60, reserved: 0, consumed: 0, expired: 0, quantity: 60 },
    ]);
    expect(
      (
        await pool.query(
          "SELECT state,released_at,expired_at FROM synthetic_slot_holds WHERE member_id=$1",
          [owner.id],
        )
      ).rows[0],
    ).toMatchObject({
      state: "released",
      released_at: expect.any(Date),
      expired_at: null,
    });
    expect(
      (
        await pool.query(
          "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 ORDER BY operation",
          [owner.id],
        )
      ).rows,
    ).toEqual([
      { operation: "grant" },
      { operation: "release" },
      { operation: "reserve" },
    ]);
    await expect(
      pool.query(
        "UPDATE synthetic_entitlement_events SET quantity=0 WHERE member_id=$1 AND operation='release'",
        [owner.id],
      ),
    ).rejects.toThrow("immutable");
    const next = randomUUID();
    await memberHolds.request(owner.token, f.slotId, grantId, next);
    expect((await memberHolds.get(owner.token, next))!.state).toBe("held");
    await memberHolds.withdraw(owner.token, next);
  }
});

it("denies withdrawal by outsiders, staff, stale sessions, forged IDs and mismatched categories without disclosing or changing an owner hold", async () => {
  const f = await fixture(),
    owner = await member("explorer"),
    other = await member("professional");
  const grantId = await grant(owner.id, "withdraw-denials"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  const holdId = (
    await pool.query(
      "SELECT hold_id FROM synthetic_member_hold_receipts WHERE request_id=$1",
      [requestId],
    )
  ).rows[0].hold_id;
  for (const token of [
    other.token,
    f.admin.token,
    f.operator.token,
    f.coach.token,
    "forged",
  ]) {
    await expect(memberHolds.withdraw(token, requestId)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await memberHolds.get(token, requestId)).toBeNull();
  }
  for (const id of [randomUUID(), holdId])
    await expect(memberHolds.withdraw(owner.token, id)).rejects.toMatchObject({
      code: "unavailable",
    });
  for (const kind of ["revoked_at", "expires_at"]) {
    await pool.query(
      `UPDATE principals SET ${kind}=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [owner.id],
    );
    await expect(
      memberHolds.withdraw(owner.token, requestId),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await memberHolds.get(owner.token, requestId)).toBeNull();
    await pool.query(
      kind === "revoked_at"
        ? "UPDATE principals SET revoked_at=NULL WHERE id=$1"
        : "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [owner.id],
    );
  }
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET category='review_minutes' WHERE id=$1",
    [grantId],
  );
  await expect(
    memberHolds.withdraw(owner.token, requestId),
  ).rejects.toMatchObject({ code: "unavailable" });
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET category='coach_minutes' WHERE id=$1",
    [grantId],
  );
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe("held");
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE operation='release'",
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 60 }]);
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  await expect(
    memberHolds.withdraw(owner.token, requestId),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await memberHolds.get(owner.token, requestId)).toBeNull();
  expect(
    (await pool.query("SELECT * FROM synthetic_member_hold_receipts")).rowCount,
  ).toBe(0);
});

it("withdraws an active hold against a separately expired grant without reviving its units", async () => {
  const f = await fixture(),
    owner = await member("technical"),
    grantId = await grant(owner.id, "withdraw-expired-grant"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [grantId],
  );
  await ledger.expire(owner.id, grantId, "expire-before-withdrawal");
  expect(await memberHolds.withdraw(owner.token, requestId)).toBe(requestId);
  expect(await memberHolds.withdraw(owner.token, requestId)).toBe(requestId);
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
    "released",
  );
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired,quantity FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 0, expired: 60, quantity: 60 }]);
  expect((await memberHolds.snapshot(owner.token)).grants).toEqual([]);
});

it("serializes due expiry, withdrawal and last-slot contenders into one terminal receipt and one replacement hold", async () => {
  const f = await fixture(),
    owner = await member("technical"),
    other = await member("explorer"),
    third = await member("professional");
  const grantId = await grant(owner.id, "withdraw-expiry"),
    otherGrant = await grant(other.id, "withdraw-contender"),
    thirdGrant = await grant(third.id, "withdraw-third"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  await pool.query(
    "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
    [owner.id],
  );
  const results = await Promise.allSettled([
    memberHolds.withdraw(owner.token, requestId),
    memberHolds.get(owner.token, requestId),
    memberHolds.request(other.token, f.slotId, otherGrant, randomUUID()),
    memberHolds.request(third.token, f.slotId, thirdGrant, randomUUID()),
  ]);
  expect(results[0]).toMatchObject({ status: "fulfilled", value: requestId });
  expect(results[1]).toMatchObject({
    status: "fulfilled",
    value: { state: "expired" },
  });
  expect(results.slice(2).filter((x) => x.status === "fulfilled")).toHaveLength(
    1,
  );
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
    "expired",
  );
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_slot_holds WHERE slot_id=$1 AND state='held'",
        [f.slotId],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
        [owner.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 60, reserved: 0, expired: 0 }]);
});

it.each(["grant", "member", "revoked", "deadline"] as const)(
  "rechecks %s after withdrawal waits for the slot lock",
  async (kind) => {
    const f = await fixture(),
      owner = await member("professional"),
      grantId = await grant(owner.id, "withdraw-wait"),
      requestId = randomUUID();
    await memberHolds.request(owner.token, f.slotId, grantId, requestId);
    const lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query(
      "SELECT id FROM expert_availability_slots WHERE id=$1 FOR UPDATE",
      [f.slotId],
    );
    const pending = memberHolds.withdraw(owner.token, requestId).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await pool.query(
                  "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT withdraw_member_sample_hold(%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
                )
              ).rows[0].count,
            ),
          { timeout: 3000 },
        )
        .toBe(1);
      if (kind === "grant")
        await pool.query(
          "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp() WHERE id=$1",
          [grantId],
        );
      else if (kind === "deadline")
        await pool.query(
          "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp() WHERE member_id=$1",
          [owner.id],
        );
      else
        await pool.query(
          kind === "member"
            ? "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1"
            : "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [owner.id],
        );
      await lock.query("COMMIT");
      if (kind === "member" || kind === "revoked") {
        expect(await pending).toMatchObject({ error: { code: "unavailable" } });
        expect(await memberHolds.get(owner.token, requestId)).toBeNull();
        expect(
          (
            await pool.query(
              "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
              [grantId],
            )
          ).rows,
        ).toEqual([{ available: 0, reserved: 60, expired: 0 }]);
      } else {
        expect(await pending).toEqual({ value: requestId });
        expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
          kind === "deadline" ? "expired" : "released",
        );
        expect(
          (
            await pool.query(
              "SELECT available,reserved,expired FROM synthetic_entitlement_grants WHERE id=$1",
              [grantId],
            )
          ).rows,
        ).toEqual([
          {
            available: kind === "grant" ? 0 : 60,
            reserved: 0,
            expired: kind === "grant" ? 60 : 0,
          },
        ]);
      }
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await pending;
    }
  },
);

it("rolls a withdrawal event failure back completely and recovers a committed withdrawal whose response was lost", async () => {
  const f = await fixture(),
    owner = await member("explorer"),
    grantId = await grant(owner.id, "withdraw-fault"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  await pool.query(
    "CREATE FUNCTION reject_test_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='release' THEN RAISE EXCEPTION 'synthetic release event fault'; END IF; RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER reject_test_withdrawal BEFORE INSERT ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_test_withdrawal()",
  );
  try {
    await expect(
      memberHolds.withdraw(owner.token, requestId),
    ).rejects.toMatchObject({ code: "uncertain" });
    expect((await memberHolds.get(owner.token, requestId))!.state).toBe("held");
    expect(await slots.list()).toEqual([]);
    expect(
      (await pool.query("SELECT state FROM synthetic_entitlement_reservations"))
        .rows,
    ).toEqual([{ state: "reserved" }]);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: 60 }]);
    expect(
      (
        await pool.query(
          "SELECT * FROM synthetic_entitlement_events WHERE operation='release'",
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_withdrawal ON synthetic_entitlement_events",
    );
    await pool.query("DROP FUNCTION reject_test_withdrawal()");
  }
  const responseLoss = memberSlotHolds({
    query: async (sql: string, values: unknown[]) => {
      await pool.query(sql, values);
      throw new Error("synthetic transport loss");
    },
  } as unknown as import("pg").Pool);
  await expect(
    responseLoss.withdraw(owner.token, requestId),
  ).rejects.toMatchObject({ code: "uncertain" });
  expect((await memberHolds.get(owner.token, requestId))!.state).toBe(
    "released",
  );
  expect(await memberHolds.withdraw(owner.token, requestId)).toBe(requestId);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE operation='release'",
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 60, reserved: 0 }]);
});

it("releases an active hold while two last-slot contenders wait, admitting exactly one new owner", async () => {
  const f = await fixture(),
    owner = await member("professional"),
    b = await member("explorer"),
    c = await member("technical");
  const grantId = await grant(owner.id, "active-withdrawal-owner"),
    gb = await grant(b.id, "active-withdrawal-b"),
    gc = await grant(c.id, "active-withdrawal-c"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query(
    "SELECT id FROM expert_availability_slots WHERE id=$1 FOR UPDATE",
    [f.slotId],
  );
  const withdrawn = memberHolds.withdraw(owner.token, requestId);
  let contenders: Promise<PromiseSettledResult<string>[]> | undefined;
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT withdraw_member_sample_hold(%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0].count,
          ),
        { timeout: 3000 },
      )
      .toBe(1);
    contenders = Promise.allSettled([
      memberHolds.request(b.token, f.slotId, gb, randomUUID()),
      memberHolds.request(c.token, f.slotId, gc, randomUUID()),
    ]);
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE query LIKE 'SELECT member_sample_hold(%' AND wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()",
              )
            ).rows[0].count,
          ),
        { timeout: 3000 },
      )
      .toBe(2);
    await lock.query("COMMIT");
    expect(await withdrawn).toBe(requestId);
    expect(
      (await contenders).filter((x) => x.status === "fulfilled"),
    ).toHaveLength(1);
    const receipt = await memberHolds.get(owner.token, requestId);
    expect(receipt!.state).toBe("released");
    expect(receipt!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      (
        await pool.query(
          "SELECT * FROM synthetic_slot_holds WHERE slot_id=$1 AND state='held'",
          [f.slotId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT * FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
          [owner.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
    ).toEqual([{ available: 60, reserved: 0 }]);
    expect(
      (
        await pool.query(
          "SELECT available,reserved FROM synthetic_entitlement_grants WHERE id IN ($1,$2) ORDER BY available",
          [gb, gc],
        )
      ).rows,
    ).toEqual([
      { available: 0, reserved: 60 },
      { available: 60, reserved: 0 },
    ]);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    await withdrawn;
    await contenders;
  }
});

it.each(["held", "due", "released"] as const)(
  "withholds retained %s sample receipts and grants after committed workspace deletion at store and HTTP boundaries",
  async (state) => {
    const f = await fixture(),
      owner = await member("professional"),
      other = await member("explorer");
    const grantId = await grant(owner.id, "retained-receipt"),
      requestId = randomUUID();
    await memberHolds.request(owner.token, f.slotId, grantId, requestId);
    if (state === "released")
      await memberHolds.withdraw(owner.token, requestId);
    const extraGrant = await grant(owner.id, "retained-available-grant");
    const receipt = await memberHolds.get(owner.token, requestId);
    expect(receipt).toMatchObject({
      id: requestId,
      state: state === "released" ? "released" : "held",
    });
    expect((await memberHolds.snapshot(owner.token)).grants).toContainEqual({
      id: extraGrant,
      category: "coach_minutes",
    });
    if (state === "due")
      await pool.query(
        "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
        [owner.id],
      );
    const before = await retainedHoldRows(owner.id);
    await pool.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [owner.id],
    );
    expect((await db.session(owner.token)).kind).toBe("active");
    expect.soft(await memberHolds.get(owner.token, requestId)).toBeNull();
    await expect
      .soft(memberHolds.snapshot(owner.token))
      .rejects.toMatchObject({ code: "unavailable" });
    await withLoopback(
      app(db, {
        origin: "http://127.0.0.1:3000",
        secret: "synthetic-hold-secret",
        memberSlotHolds: memberHolds,
        availability: slots,
      }),
      async (server) => {
        for (const [path, status] of [
          [`/availability/holds/${requestId}`, 404],
          ["/availability", 403],
        ] as const) {
          const response = await request(server)
            .get(path)
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `${COOKIE}=${owner.token}`);
          expect.soft(response.status).toBe(status);
          for (const marker of [
            requestId,
            extraGrant,
            f.slotId,
            receipt!.startsAt.toISOString(),
            "Education · coaching",
            "Your sample hold receipt",
            "Reserved test quantity",
          ])
            expect.soft(response.text).not.toContain(marker);
        }
        const unaffected = await request(server)
          .get("/availability")
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${other.token}`);
        expect(unaffected.status).toBe(200);
        expect(unaffected.text).not.toContain(requestId);
      },
    );
    expect(await memberHolds.get(other.token, requestId)).toBeNull();
    expect(await memberHolds.snapshot(other.token)).toEqual({
      grants: [],
      receipts: [],
    });
    expect(await retainedHoldRows(owner.id)).toEqual(before);
  },
);

async function retainedHoldRows(memberId: string) {
  return (
    await pool.query(
      `SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM synthetic_member_hold_receipts r WHERE member_id=$1) AS receipts,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM synthetic_slot_holds h WHERE member_id=$1) AS holds,
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM synthetic_entitlement_grants g WHERE member_id=$1) AS grants,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM synthetic_entitlement_events e WHERE member_id=$1) AS events`,
      [memberId],
    )
  ).rows;
}

async function heldReceipt() {
  const f = await fixture(),
    owner = await member("technical");
  const grantId = await grant(owner.id, "private-read"),
    requestId = randomUUID();
  await memberHolds.request(owner.token, f.slotId, grantId, requestId);
  return { ...f, owner, grantId, requestId };
}
const readKinds = ["get", "snapshot"] as const;
type ReadKind = (typeof readKinds)[number];
function privateRead(
  api: ReturnType<typeof memberSlotHolds>,
  kind: ReadKind,
  token: string,
  requestId: string,
) {
  return kind === "get" ? api.get(token, requestId) : api.snapshot(token);
}
async function deniedRead(
  pending: ReturnType<typeof privateRead>,
  kind: ReadKind,
) {
  if (kind === "get") expect(await pending).toBeNull();
  else await expect(pending).rejects.toMatchObject({ code: "unavailable" });
}
async function blocksOn(pid: number, fragment: string) {
  await expect
    .poll(
      async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
     AND pid<>pg_backend_pid() AND $1::integer=ANY(pg_blocking_pids(pid))
     AND position($2 in query)>0`,
              [pid, fragment],
            )
          ).rows[0].count,
        ),
      { timeout: 3000 },
    )
    .toBe(1);
}

it.each(
  readKinds.flatMap((kind) =>
    ["principal", "workspace"].map((lock) => ({ kind, lock })),
  ),
)(
  "denies $kind when deletion commits during its $lock lock wait",
  async ({ kind, lock }) => {
    const f = await heldReceipt(),
      before = await retainedHoldRows(f.owner.id);
    const holder = await pool.connect();
    let pending: ReturnType<typeof privateRead> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      if (lock === "principal")
        await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
          f.owner.id,
        ]);
      await holder.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [f.owner.id],
      );
      pending = privateRead(memberHolds, kind, f.owner.token, f.requestId);
      // Attach rejection handling before releasing the lock.
      const denial = deniedRead(pending, kind);
      await blocksOn(
        pid,
        lock === "principal" ? "FOR SHARE OF p" : "SELECT id FROM workspaces",
      );
      await holder.query("COMMIT");
      await denial;
      expect(await retainedHoldRows(f.owner.id)).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      holder.release();
    }
  },
);

it.each(readKinds)(
  "finishes a %s read before deletion waiting on its workspace lock",
  async (kind) => {
    const f = await heldReceipt();
    const before = await privateRead(
      memberHolds,
      kind,
      f.owner.token,
      f.requestId,
    );
    let entered!: () => void, resume!: () => void;
    const locked = new Promise<void>((resolve) => (entered = resolve)),
      proceed = new Promise<void>((resolve) => (resume = resolve));
    let readerPid = 0;
    let fenced = false;
    const paused = memberSlotHolds({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("SELECT id FROM workspaces")) fenced = true;
            if (
              fenced &&
              sql.includes(
                kind === "get"
                  ? "SELECT r.request_id"
                  : "SELECT g.id,g.category",
              )
            ) {
              readerPid = (await client.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid;
              entered();
              await proceed;
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    const reading = privateRead(paused, kind, f.owner.token, f.requestId);
    const deletion = await pool.connect();
    let deleting: Promise<void> | undefined;
    try {
      await locked;
      deleting = (async () => {
        await deletion.query("BEGIN");
        await deletion.query(
          "SELECT id FROM principals WHERE id=$1 FOR SHARE",
          [f.owner.id],
        );
        // Match the real deletion marker: shared principal authorization,
        // then exclusive workspace ownership before publishing deleting_at.
        await deletion.query(
          "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
          [f.owner.id],
        );
        await deletion.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [f.owner.id],
        );
        await deletion.query("COMMIT");
      })();
      await blocksOn(readerPid, "SELECT id FROM workspaces");
      expect(
        (
          await pool.query(
            "SELECT deleting_at FROM workspaces WHERE owner_principal_id=$1",
            [f.owner.id],
          )
        ).rows,
      ).toEqual([{ deleting_at: null }]);
      resume();
      expect(await reading).toEqual(before);
      await deleting;
      await deniedRead(
        privateRead(memberHolds, kind, f.owner.token, f.requestId),
        kind,
      );
    } finally {
      resume();
      await Promise.allSettled([reading, ...(deleting ? [deleting] : [])]);
      await deletion.query("ROLLBACK");
      deletion.release();
    }
  },
);

it.each(
  readKinds.flatMap((kind) =>
    ["principal", "workspace"].map((lock) => ({ kind, lock })),
  ),
)(
  "withholds $kind after session expiry during its $lock lock wait",
  async ({ kind, lock }) => {
    const f = await heldReceipt(),
      before = await retainedHoldRows(f.owner.id);
    const holder = await pool.connect(),
      waiter = await pool.connect();
    let pending: ReturnType<typeof privateRead> | undefined;
    try {
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [f.owner.id],
      );
      await holder.query("BEGIN");
      await holder.query(
        lock === "principal"
          ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
          : "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [f.owner.id],
      );
      const borrowed = memberSlotHolds({
        query: pool.query.bind(pool),
        connect: async () => ({
          query: waiter.query.bind(waiter),
          release() {},
        }),
      } as unknown as Pool);
      pending = privateRead(borrowed, kind, f.owner.token, f.requestId);
      const denial = deniedRead(pending, kind);
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                `SELECT
         $1::integer=ANY(pg_blocking_pids(a.pid)) AS blocked,
         a.xact_start<p.expires_at AS started_before_expiry,
         p.expires_at<=clock_timestamp() AS expired
         FROM pg_stat_activity a CROSS JOIN principals p WHERE a.pid=$2 AND p.id=$3 AND a.wait_event_type='Lock'`,
                [holderPid, waiterPid, f.owner.id],
              )
            ).rows[0],
          { timeout: 5000 },
        )
        .toEqual({ blocked: true, started_before_expiry: true, expired: true });
      await holder.query("COMMIT");
      await denial;
      expect(await retainedHoldRows(f.owner.id)).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      holder.release();
      waiter.release();
    }
  },
  10000,
);

it.each(
  readKinds.flatMap((kind) =>
    ["read", "commit"].map((stage) => ({ kind, stage })),
  ),
)(
  "withholds $kind after a $stage failure without replaying the read transaction",
  async ({ kind, stage }) => {
    const f = await heldReceipt(),
      before = await retainedHoldRows(f.owner.id);
    let reads = 0,
      discarded: Error | undefined,
      released = false;
    const broken = memberSlotHolds({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("SELECT r.request_id")) {
              reads++;
              if (stage === "read" && reads === 2)
                throw new Error("Synthetic private read fault");
            }
            if (sql === "COMMIT" && stage === "commit")
              throw new Error("Synthetic lost read commit reply");
            return result;
          },
          release(error?: Error) {
            released = true;
            discarded = error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    await expect(
      privateRead(broken, kind, f.owner.token, f.requestId),
    ).rejects.toThrow(
      stage === "read"
        ? "Synthetic private read fault"
        : "Synthetic lost read commit reply",
    );
    expect(reads).toBe(2);
    expect(released).toBe(true);
    expect(discarded).toBeInstanceOf(Error);
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
    expect(await memberHolds.get(f.owner.token, f.requestId)).toMatchObject({
      id: f.requestId,
      state: "held",
    });
  },
);

it("withholds receipts and grants for unavailable owners and never returns an outsider's receipt", async () => {
  const f = await heldReceipt();
  const other = await member("explorer");
  const before = await retainedHoldRows(f.owner.id);
  expect(await memberHolds.get(other.token, f.requestId)).toBeNull();
  expect(await memberHolds.snapshot(other.token)).toEqual({
    grants: [],
    receipts: [],
  });
  for (const token of ["forged", f.admin.token]) {
    expect(await memberHolds.get(token, f.requestId)).toBeNull();
    await expect(memberHolds.snapshot(token)).rejects.toMatchObject({
      code: "unavailable",
    });
  }
  for (const change of [
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    "UPDATE principals SET revoked_at=NULL,expires_at=clock_timestamp() WHERE id=$1",
  ]) {
    await pool.query(change, [f.owner.id]);
    expect(await memberHolds.get(f.owner.token, f.requestId)).toBeNull();
    await expect(memberHolds.snapshot(f.owner.token)).rejects.toMatchObject({
      code: "unavailable",
    });
  }
  expect(await retainedHoldRows(f.owner.id)).toEqual(before);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    [f.owner.id],
  );
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    f.owner.id,
  ]);
  expect(await memberHolds.get(f.owner.token, f.requestId)).toBeNull();
  await expect(memberHolds.snapshot(f.owner.token)).rejects.toMatchObject({
    code: "unavailable",
  });
});

it.each(readKinds)(
  "withholds %s retained data after a successful delayed COMMIT reply crosses DB session expiry",
  async (kind) => {
    const f = await heldReceipt();
    await memberHolds.withdraw(f.owner.token, f.requestId);
    const before = await retainedHoldRows(f.owner.id);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",
      [f.owner.id],
    );
    let validAtFinal = false,
      commits = 0,
      rollbacks = 0;
    const delayed = memberSlotHolds({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql.includes("AS valid"))
              validAtFinal = response.rows[0]?.valid === true;
            if (sql === "COMMIT") {
              commits++;
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            if (sql === "ROLLBACK") rollbacks++;
            return response;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    await deniedRead(
      privateRead(delayed, kind, f.owner.token, f.requestId),
      kind,
    );
    expect(validAtFinal).toBe(true);
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [f.owner.id],
        )
      ).rows[0].expired,
    ).toBe(true);
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
    // Fixture-only reauthorization permits a fresh observation of durable state,
    // not a retry of the uncertain reader or an application renewal promise.
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [f.owner.id],
    );
    expect(await memberHolds.get(f.owner.token, f.requestId)).toMatchObject({
      id: f.requestId,
      state: "released",
    });
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
  },
);

it.each(["receipt", "list"] as const)(
  "actual private %s HTTP does not render owned retained markers after delayed successful commit expiry",
  async (kind) => {
    const f = await heldReceipt();
    await memberHolds.withdraw(f.owner.token, f.requestId);
    const before = await retainedHoldRows(f.owner.id);
    let commits = 0;
    const delayed = memberSlotHolds({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return response;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    await withLoopback(
      app(db, {
        origin: "http://127.0.0.1:3000",
        secret: "invented-handback-http",
        memberSlotHolds: delayed,
        availability: slots,
      }),
      async (server) => {
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",
          [f.owner.id],
        );
        const response = await request(server)
          .get(
            kind === "receipt"
              ? `/availability/holds/${f.requestId}`
              : "/availability",
          )
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${f.owner.token}`);
        expect(response.status).toBe(kind === "receipt" ? 404 : 403);
        for (const marker of [
          f.requestId,
          f.grantId,
          "Your sample hold receipt",
          "Reserved test quantity",
        ])
          expect(response.text).not.toContain(marker);
        expect(commits).toBe(1);
      },
    );
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
  },
);

it.each(readKinds)(
  "fresh %s recovery observes a committed lazy settlement once after a lost reply",
  async (kind) => {
    const f = await heldReceipt();
    await pool.query(
      "UPDATE synthetic_slot_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE member_id=$1",
      [f.owner.id],
    );
    let settlements = 0,
      rollbacks = 0;
    const broken = memberSlotHolds({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql.includes("SELECT settle_member_sample_holds")) {
              settlements++;
              throw Error("invented lost settlement reply");
            }
            if (sql === "ROLLBACK") rollbacks++;
            return response;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    await expect(
      privateRead(broken, kind, f.owner.token, f.requestId),
    ).rejects.toThrow("invented lost settlement reply");
    expect(settlements).toBe(1);
    expect(rollbacks).toBe(0);
    const settled = await retainedHoldRows(f.owner.id);
    expect(await memberHolds.get(f.owner.token, f.requestId)).toMatchObject({
      state: "expired",
    });
    await memberHolds.snapshot(f.owner.token);
    expect(await retainedHoldRows(f.owner.id)).toEqual(settled);
    expect(
      (
        await pool.query(
          "SELECT operation,quantity FROM synthetic_entitlement_events WHERE member_id=$1 AND operation='release'",
          [f.owner.id],
        )
      ).rows,
    ).toEqual([{ operation: "release", quantity: 60 }]);
  },
);

it.each(
  readKinds.flatMap((kind) =>
    ["mutation", "reader"].map((winner) => ({ kind, winner })),
  ),
)(
  "preserves actual principal revocation winner order for $kind when $winner wins",
  async ({ kind, winner }) => {
    const f = await heldReceipt(),
      other = await member("explorer");
    await memberHolds.withdraw(f.owner.token, f.requestId);
    const before = await retainedHoldRows(f.owner.id);
    const expected = await privateRead(
      memberHolds,
      kind,
      f.owner.token,
      f.requestId,
    );
    const mutation = await pool.connect();
    let entered!: () => void, resume!: () => void;
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let readerPid = 0,
      fenced = false;
    const paused = memberSlotHolds({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql.includes("SELECT id FROM workspaces")) fenced = true;
            if (
              winner === "reader" &&
              fenced &&
              sql.includes("SELECT r.request_id")
            ) {
              readerPid = (await client.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid;
              entered();
              await proceed;
            }
            return response;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    let reading: ReturnType<typeof privateRead> | undefined;
    let changing: Promise<unknown> | undefined;
    try {
      await mutation.query("BEGIN");
      const mutationPid = (
        await mutation.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      if (winner === "mutation") {
        await mutation.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
        reading = privateRead(paused, kind, f.owner.token, f.requestId);
        const denial = deniedRead(reading, kind);
        await blocksOn(mutationPid, "FOR SHARE OF p");
        await mutation.query("COMMIT");
        await denial;
      } else {
        reading = privateRead(paused, kind, f.owner.token, f.requestId);
        await locked;
        changing = mutation.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
        await blocksOn(readerPid, "UPDATE principals");
        resume();
        expect(await reading).toEqual(expected);
        await changing;
        await mutation.query("COMMIT");
        await deniedRead(
          privateRead(memberHolds, kind, f.owner.token, f.requestId),
          kind,
        );
      }
      expect(await retainedHoldRows(f.owner.id)).toEqual(before);
      expect(await memberHolds.snapshot(other.token)).toEqual({
        grants: [],
        receipts: [],
      });
    } finally {
      resume();
      await Promise.allSettled([
        ...(reading ? [reading] : []),
        ...(changing ? [changing] : []),
      ]);
      await mutation.query("ROLLBACK");
      mutation.release();
    }
  },
  15000,
);

it.each(
  readKinds.flatMap((kind) =>
    ["read", "commit"].map((stage) => ({ kind, stage })),
  ),
)(
  "bounds a nonresolving real $stage driver reply for $kind and frees owned locks without replay",
  async ({ kind, stage }) => {
    const f = await heldReceipt(),
      other = await member("explorer");
    await memberHolds.withdraw(f.owner.token, f.requestId);
    const before = await retainedHoldRows(f.owner.id);
    let entered!: () => void;
    const stalled = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let receiptReads = 0,
      commits = 0,
      rollbacks = 0,
      readerPid = 0;
    let discarded: Error | undefined;
    const broken = memberSlotHolds({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql.includes("SELECT r.request_id")) receiptReads++;
            if (sql === "COMMIT") commits++;
            if (sql === "ROLLBACK") rollbacks++;
            if (
              (stage === "read" &&
                receiptReads === 2 &&
                sql.includes("SELECT r.request_id")) ||
              (stage === "commit" && sql === "COMMIT")
            ) {
              readerPid = (await client.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid;
              entered();
              return await new Promise<never>(() => {});
            }
            return response;
          },
          release(error?: Error) {
            discarded = error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const started = performance.now();
    const reading = privateRead(broken, kind, f.owner.token, f.requestId);
    const withheld = expect(reading).rejects.toMatchObject({
      code: "unavailable",
    });
    const mutation = await pool.connect();
    let changing: Promise<unknown> | undefined;
    try {
      await stalled;
      await mutation.query("BEGIN");
      changing = mutation.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.owner.id],
      );
      if (stage === "read") await blocksOn(readerPid, "UPDATE principals");
      else await changing; // COMMIT is durable even though its driver reply is withheld.
      await withheld;
      expect(performance.now() - started).toBeLessThan(10000);
      expect(discarded).toBeInstanceOf(Error);
      expect(commits).toBe(stage === "commit" ? 1 : 0);
      expect(rollbacks).toBe(0);
      await changing;
      await mutation.query("COMMIT");
      await deniedRead(
        privateRead(memberHolds, kind, f.owner.token, f.requestId),
        kind,
      );
      expect(await retainedHoldRows(f.owner.id)).toEqual(before);
      expect(await memberHolds.snapshot(other.token)).toEqual({
        grants: [],
        receipts: [],
      });
    } finally {
      await Promise.allSettled([reading, ...(changing ? [changing] : [])]);
      await mutation.query("ROLLBACK");
      mutation.release();
    }
  },
  15000,
);

it.each(readKinds)(
  "withholds %s private data when actual client handback crosses DB session expiry after known commit",
  async (kind) => {
    const f = await heldReceipt();
    await memberHolds.withdraw(f.owner.token, f.requestId);
    const before = await retainedHoldRows(f.owner.id);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",
      [f.owner.id],
    );
    let validAtCommit = false,
      commits = 0,
      rollbacks = 0,
      releases = 0;
    const delayed = memberSlotHolds({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              validAtCommit = (
                await client.query(
                  "SELECT expires_at>clock_timestamp() AS valid FROM principals WHERE id=$1",
                  [f.owner.id],
                )
              ).rows[0].valid;
            }
            if (sql === "ROLLBACK") rollbacks++;
            return response;
          },
          release(error?: Error) {
            releases++;
            client.release(error);
            // PoolClient.release is synchronous. Delay its successful return
            // after actual disposal while the independent database clock advances.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
          },
        };
      },
    } as unknown as Pool);
    await deniedRead(
      privateRead(delayed, kind, f.owner.token, f.requestId),
      kind,
    );
    expect(validAtCommit).toBe(true);
    expect(commits).toBe(1);
    expect(rollbacks).toBe(0);
    expect(releases).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [f.owner.id],
        )
      ).rows[0].expired,
    ).toBe(true);
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [f.owner.id],
    );
    expect(await memberHolds.get(f.owner.token, f.requestId)).toMatchObject({
      id: f.requestId,
      state: "released",
    });
    expect(await retainedHoldRows(f.owner.id)).toEqual(before);
  },
);
