import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger, type SyntheticCompletion } from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
const window = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
const review = (
  reference = "synthetic:review-001",
): Extract<SyntheticCompletion, { deliveredMinutes: number }> => ({
  reference,
  category: "review_minutes",
  deliveredMinutes: 20,
  preparationMinutes: 10,
});
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return session.learner.id;
}
async function fixture(
  memberId: string,
  key: string,
  category:
    "review_minutes" | "support_minutes" | "study_requests" = "review_minutes",
  quantity = 30,
) {
  const grantId = await ledger.grant(
    memberId,
    category,
    quantity,
    `${key}-grant`,
    window,
  );
  const reservationId = await ledger.reserve(
    memberId,
    grantId,
    quantity,
    `${key}-reserve`,
  );
  return { grantId, reservationId };
}
async function balance(grantId: string) {
  return (
    await pool.query(
      `SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1`,
      [grantId],
    )
  ).rows[0];
}
async function race(grantIds: string[], actions: (() => Promise<string>)[]) {
  const blocker = await pool.connect();
  let pending: Promise<PromiseSettledResult<string>[]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM synthetic_entitlement_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [grantIds],
    );
    const pid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    pending = Promise.allSettled(actions.map((action) => action()));
    let blocked = false;
    for (let check = 0; check < 100; check++) {
      const waiting = (
        await pool.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`,
          [pid],
        )
      ).rows[0]!.count;
      if (Number(waiting) > 0) {
        blocked = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await blocker.query("COMMIT");
    return await pending;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
}

it.each([
  ["technical", review(), 30],
  [
    "professional",
    {
      reference: "synthetic:support-001",
      category: "support_minutes",
      deliveredMinutes: 30,
      preparationMinutes: 0,
    },
    30,
  ],
  [
    "explorer",
    {
      reference: "synthetic:study-001",
      category: "study_requests",
      quantity: 1,
    },
    1,
  ],
] as const)(
  "settles an explicit %s completion with immutable linked evidence",
  async (background, completion, quantity) => {
    const owner = await member(background);
    expect(
      (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rowCount,
    ).toBe(0);
    const { grantId, reservationId } = await fixture(
      owner,
      "success",
      completion.category,
      quantity,
    );
    const result = await ledger.settleCompletion(
      owner,
      reservationId,
      "settlement",
      completion,
    );
    await migrate(pool);
    expect(
      await ledger.settleCompletion(
        owner,
        reservationId,
        "settlement",
        completion,
      ),
    ).toBe(result);
    expect(await balance(grantId)).toEqual({
      available: 0,
      reserved: 0,
      consumed: quantity,
      expired: 0,
      adjusted: 0,
    });
    const records = (
      await pool.query(
        `SELECT s.id,s.member_id,s.grant_id,s.reservation_id,s.completion_ref,s.category,s.quantity,s.delivered_minutes,s.preparation_minutes,e.operation,e.result_id,e.quantity AS event_quantity,r.state
    FROM synthetic_entitlement_settlements s JOIN synthetic_entitlement_events e ON e.id=s.id
    JOIN synthetic_entitlement_reservations r ON r.id=s.reservation_id WHERE s.id=$1`,
        [result],
      )
    ).rows;
    expect(records).toEqual([
      {
        id: result,
        member_id: owner,
        grant_id: grantId,
        reservation_id: reservationId,
        completion_ref: completion.reference,
        category: completion.category,
        quantity,
        delivered_minutes:
          completion.category === "study_requests"
            ? null
            : completion.deliveredMinutes,
        preparation_minutes:
          completion.category === "study_requests"
            ? null
            : completion.preparationMinutes,
        operation: "consume",
        result_id: result,
        event_quantity: quantity,
        state: "consumed",
      },
    ]);
    await expect(
      pool.query(
        "UPDATE synthetic_entitlement_settlements SET completion_ref='synthetic:changed' WHERE id=$1",
        [result],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("DELETE FROM synthetic_entitlement_settlements WHERE id=$1", [
        result,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      ledger.release(owner, reservationId, "late-release"),
    ).rejects.toMatchObject({ code: "already_settled" });
    await db.remove(owner);
    expect(
      (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
        .rowCount,
    ).toBe(0);
    await expect(
      ledger.settleCompletion(owner, reservationId, "settlement", completion),
    ).rejects.toMatchObject({ code: "unavailable" });
  },
);

it.each(["consume", "release"] as const)(
  "cannot attach completion evidence after ordinary %s already settled the reservation",
  async (operation) => {
    const owner = await member();
    const { grantId, reservationId } = await fixture(owner, "settled");
    await ledger[operation](owner, reservationId, "previous");
    await expect(
      ledger.settleCompletion(owner, reservationId, "completion", review()),
    ).rejects.toMatchObject({ code: "already_settled" });
    expect(await balance(grantId)).toEqual({
      available: operation === "release" ? 30 : 0,
      reserved: 0,
      consumed: operation === "consume" ? 30 : 0,
      expired: 0,
      adjusted: 0,
    });
    expect(
      (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
        .rowCount,
    ).toBe(0);
  },
);

it("denies cross-member, category and quantity substitution and conflicting or reused references", async () => {
  const owner = await member();
  const other = await member("professional");
  const first = await fixture(owner, "first");
  const support = await fixture(owner, "support", "support_minutes");
  const second = await fixture(owner, "second");
  const foreign = await fixture(other, "foreign");
  for (const [who, reservation, completion] of [
    [other, first.reservationId, review()],
    [owner, support.reservationId, review()],
    [owner, first.reservationId, { ...review(), deliveredMinutes: 21 }],
    [owner, randomUUID(), review()],
  ] as const)
    await expect(
      ledger.settleCompletion(who, reservation, randomUUID(), completion),
    ).rejects.toMatchObject({ code: "unavailable" });
  const result = await ledger.settleCompletion(
    owner,
    first.reservationId,
    "original",
    review(),
  );
  for (const completion of [
    review("synthetic:other-reference"),
    { ...review(), deliveredMinutes: 19, preparationMinutes: 11 },
    { ...review(), category: "support_minutes" as const },
  ])
    await expect(
      ledger.settleCompletion(
        owner,
        first.reservationId,
        "original",
        completion,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    ledger.settleCompletion(other, first.reservationId, "original", review()),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    ledger.consume(owner, first.reservationId, "original"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  for (const [who, reservationId] of [
    [owner, second.reservationId],
    [other, foreign.reservationId],
  ])
    await expect(
      ledger.settleCompletion(who!, reservationId!, "reused-ref", review()),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(
    await ledger.settleCompletion(
      owner,
      first.reservationId,
      "original",
      review(),
    ),
  ).toBe(result);
  for (const untouched of [support, second, foreign])
    expect(await balance(untouched.grantId)).toEqual({
      available: 0,
      reserved: 30,
      consumed: 0,
      expired: 0,
      adjusted: 0,
    });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE operation='consume'",
      )
    ).rowCount,
  ).toBe(1);
  await expect(
    ledger.settleCompletion(
      owner,
      second.reservationId,
      "recovered",
      review("synthetic:second-reference"),
    ),
  ).resolves.toMatch(/^[0-9a-f-]{36}$/);
});

it.each(["same-key", "different-key", "release", "consume"] as const)(
  "serializes concurrent completion versus %s without double consumption",
  async (contender) => {
    const owner = await member();
    const { grantId, reservationId } = await fixture(owner, "race");
    const results = await race(
      [grantId],
      [
        () =>
          ledger.settleCompletion(owner, reservationId, "completion", review()),
        () =>
          contender === "release" || contender === "consume"
            ? ledger[contender](owner, reservationId, "contender")
            : ledger.settleCompletion(
                owner,
                reservationId,
                contender === "same-key" ? "completion" : "duplicate",
                review(),
              ),
      ],
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(contender === "same-key" ? 2 : 1);
    if (contender === "same-key")
      expect(winners[0]!.value).toBe(winners[1]!.value);
    else
      expect(
        results.find((result) => result.status === "rejected")!.reason,
      ).toMatchObject({ code: "already_settled" });
    const row = await balance(grantId);
    expect(row.reserved).toBe(0);
    expect(row.available + row.consumed).toBe(30);
    expect(row.expired + row.adjusted).toBe(0);
    const events = (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE operation IN ('consume','release')",
      )
    ).rows;
    expect(events).toHaveLength(1);
    const settled = (
      await pool.query("SELECT * FROM synthetic_entitlement_settlements")
    ).rowCount;
    expect(settled).toBe(
      results[0]!.status === "fulfilled"
        ? 1
        : contender === "different-key"
          ? 1
          : 0,
    );
  },
);

it("allows one completion reference to win across simultaneous separate members and grants", async () => {
  const owner = await member();
  const other = await member("professional");
  const first = await fixture(owner, "ref-a");
  const second = await fixture(other, "ref-b");
  const results = await race(
    [first.grantId, second.grantId],
    [
      () =>
        ledger.settleCompletion(
          owner,
          first.reservationId,
          "ref-first",
          review(),
        ),
      () =>
        ledger.settleCompletion(
          other,
          second.reservationId,
          "ref-second",
          review(),
        ),
    ],
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results.find((result) => result.status === "rejected")!.reason,
  ).toMatchObject({ code: "idempotency_conflict" });
  expect(
    await Promise.all([balance(first.grantId), balance(second.grantId)]),
  ).toEqual(
    expect.arrayContaining([
      { available: 0, reserved: 30, consumed: 0, expired: 0, adjusted: 0 },
      { available: 0, reserved: 0, consumed: 30, expired: 0, adjusted: 0 },
    ]),
  );
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE operation='consume'",
      )
    ).rowCount,
  ).toBe(1);
});

it("rolls back completion evidence and balances when its consume event fails, then recovers", async () => {
  const owner = await member();
  const { grantId, reservationId } = await fixture(owner, "rollback");
  await pool.query(`CREATE FUNCTION reject_test_completion_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='consume' THEN RAISE EXCEPTION 'synthetic-sensitive-marker'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_completion_event BEFORE INSERT ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_test_completion_event()`);
  try {
    await expect(
      ledger.settleCompletion(
        owner,
        reservationId,
        "rollback-completion",
        review(),
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Synthetic entitlement ledger: unavailable.",
    });
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_completion_event ON synthetic_entitlement_events; DROP FUNCTION reject_test_completion_event()",
    );
  }
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 30,
    consumed: 0,
    expired: 0,
    adjusted: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT state FROM synthetic_entitlement_reservations WHERE id=$1",
        [reservationId],
      )
    ).rows[0],
  ).toEqual({ state: "reserved" });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE operation='consume'",
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    ledger.settleCompletion(
      owner,
      reservationId,
      "rollback-completion",
      review(),
    ),
  ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 30,
    expired: 0,
    adjusted: 0,
  });
  expect(pool.waitingCount).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it("preserves reserved settlement after expiry and member revocation without restoring availability", async () => {
  const owner = await member();
  let now = new Date("2028-01-31T00:00:00.000Z");
  const clocked = syntheticLedger(pool, () => now);
  const grantId = await clocked.grant(
    owner,
    "review_minutes",
    90,
    "late-grant",
    { startsAt: now.toISOString(), expiresAt: "2028-02-29T00:00:00.000Z" },
  );
  const completed = await clocked.reserve(owner, grantId, 30, "late-reserve");
  const released = await clocked.reserve(
    owner,
    grantId,
    30,
    "late-release-reserve",
  );
  now = new Date("2028-02-29T00:00:00.000Z");
  await clocked.expire(owner, grantId, "late-expiry");
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP,expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner],
  );
  await expect(
    clocked.reserve(owner, grantId, 1, "no-new-reserve"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const result = await clocked.settleCompletion(
    owner,
    completed,
    "late-completion",
    review(),
  );
  expect(
    await clocked.settleCompletion(
      owner,
      completed,
      "late-completion",
      review(),
    ),
  ).toBe(result);
  await clocked.release(owner, released, "late-release");
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 30,
    expired: 60,
    adjusted: 0,
  });
});

it("excludes every slot-hold reservation from the completion bridge", async () => {
  const owner = await member();
  const { grantId, reservationId } = await fixture(owner, "held");
  // Schema-only invented hold establishes the exclusion boundary; it does not
  // claim that an unverified fixture expert can be booked or deliver service.
  const reviewer = await authorizationStore(pool).provisionStaff(
    randomBytes(32).toString("hex"),
    "reviewer",
    new Date(Date.now() + 86400_000),
  );
  const registryId = randomUUID();
  const slotId = randomUUID();
  const holdId = randomUUID();
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes)
    VALUES($1,$2,'reviewer','education','formal-review',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '2 days',0,60)`,
    [registryId, reviewer],
  );
  await pool.query(
    `INSERT INTO expert_availability_slots(id,expert_registry_id,starts_at,ends_at,created_by)
    VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 day',CURRENT_TIMESTAMP+interval '25 hours',$3)`,
    [slotId, registryId, reviewer],
  );
  await pool.query(
    `INSERT INTO synthetic_slot_holds(id,slot_id,member_id,grant_id,reservation_id,state,expires_at)
    VALUES($1,$2,$3,$4,$5,'held',CURRENT_TIMESTAMP+interval '30 minutes')`,
    [holdId, slotId, owner, grantId, reservationId],
  );
  for (const state of ["held", "expired"]) {
    if (state === "expired")
      await pool.query(
        "UPDATE synthetic_slot_holds SET state='expired',expired_at=CURRENT_TIMESTAMP WHERE id=$1",
        [holdId],
      );
    await expect(
      ledger.settleCompletion(owner, reservationId, `held-${state}`, review()),
    ).rejects.toMatchObject({ code: "unavailable" });
  }
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 30,
    consumed: 0,
    expired: 0,
    adjusted: 0,
  });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_settlements"))
      .rowCount,
  ).toBe(0);
});
