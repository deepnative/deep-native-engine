import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
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
    expect(receipt!.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(receipt!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      600_000,
    );
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
