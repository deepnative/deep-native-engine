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
