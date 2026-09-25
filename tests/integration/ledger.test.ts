import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { billingMonth } from "../../src/offers.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
const window = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function member(background: "explorer" | "professional" | "technical") {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const result = await db.session(token);
  expect(result.kind).toBe("active");
  if (result.kind !== "active")
    throw new Error("Synthetic member setup failed.");
  return result.learner.id;
}

it("records separate immutable events without minting service units from learner background", async () => {
  const explorer = await member("explorer");
  const professional = await member("professional");
  const technical = await member("technical");
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rowCount,
  ).toBe(0);
  const coach = await ledger.grant(
    explorer,
    "coach_minutes",
    3,
    "fixture-coach",
    window,
  );
  const review = await ledger.grant(
    explorer,
    "review_minutes",
    2,
    "fixture-review",
    window,
  );
  expect(
    await ledger.grant(explorer, "coach_minutes", 3, "fixture-coach", window),
  ).toBe(coach);
  await expect(
    ledger.grant(explorer, "coach_minutes", 4, "fixture-coach", window),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    ledger.reserve(professional, coach, 1, "other-member"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    ledger.reserve(technical, review, 1, "third-member"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const reservation = await ledger.reserve(explorer, coach, 2, "reserve-coach");
  expect(await ledger.reserve(explorer, coach, 2, "reserve-coach")).toBe(
    reservation,
  );
  await expect(
    ledger.reserve(explorer, coach, 2, "too-many"),
  ).rejects.toMatchObject({ code: "insufficient" });
  await expect(
    ledger.consume(professional, reservation, "other-consume"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await ledger.consume(explorer, reservation, "consume-once")).toBe(
    reservation,
  );
  expect(await ledger.consume(explorer, reservation, "consume-once")).toBe(
    reservation,
  );
  await expect(
    ledger.release(explorer, reservation, "late-release"),
  ).rejects.toMatchObject({ code: "already_settled" });
  const amounts = await pool.query<{
    category: string;
    available: number;
    reserved: number;
    consumed: number;
  }>(
    `SELECT category,available,reserved,consumed
      FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY category`,
    [explorer],
  );
  expect(amounts.rows).toEqual([
    { category: "coach_minutes", available: 1, reserved: 0, consumed: 2 },
    { category: "review_minutes", available: 2, reserved: 0, consumed: 0 },
  ]);
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE member_id=$1 ORDER BY created_at,id",
        [explorer],
      )
    ).rows
      .map((row) => row.operation)
      .sort(),
  ).toEqual(["consume", "grant", "grant", "reserve"]);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_grants WHERE member_id=$1",
        [professional],
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    pool.query(
      "UPDATE synthetic_entitlement_events SET quantity=3 WHERE idempotency_key='fixture-coach'",
    ),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query(
      "DELETE FROM synthetic_entitlement_events WHERE idempotency_key='fixture-coach'",
    ),
  ).rejects.toThrow(/immutable/);
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [explorer],
  );
  await expect(
    ledger.reserve(explorer, coach, 1, "revoked-reserve"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await db.remove(explorer);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE member_id=$1",
        [explorer],
      )
    ).rowCount,
  ).toBe(0);
});

it("writes off only unused synthetic grant units without changing held or consumed history", async () => {
  const owner = await member("explorer");
  const other = await member("professional");
  const grant = await ledger.grant(
    owner,
    "coach_minutes",
    3,
    "writeoff-grant",
    window,
  );
  const review = await ledger.grant(
    owner,
    "review_minutes",
    2,
    "writeoff-review",
    window,
  );
  const held = await ledger.reserve(owner, grant, 1, "writeoff-hold");
  await expect(
    ledger.adjust(other, grant, 1, "writeoff-other"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await ledger.adjust(owner, grant, 1, "writeoff-once")).toBe(grant);
  expect(await ledger.adjust(owner, grant, 1, "writeoff-once")).toBe(grant);
  await expect(
    ledger.adjust(owner, grant, 2, "writeoff-once"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    ledger.adjust(owner, grant, 2, "writeoff-too-many"),
  ).rejects.toMatchObject({ code: "insufficient" });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({
    available: 1,
    reserved: 1,
    consumed: 0,
    expired: 0,
    adjusted: 1,
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
        [review],
      )
    ).rows[0],
  ).toEqual({
    available: 2,
    reserved: 0,
    consumed: 0,
    expired: 0,
    adjusted: 0,
  });
  expect(await ledger.consume(owner, held, "writeoff-consume")).toBe(held);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({
    available: 1,
    reserved: 0,
    consumed: 1,
    expired: 0,
    adjusted: 1,
  });
  expect(
    (
      await pool.query(
        "SELECT operation,quantity,reservation_id FROM synthetic_entitlement_events WHERE idempotency_key='writeoff-once'",
      )
    ).rows[0],
  ).toEqual({ operation: "adjust", quantity: 1, reservation_id: null });
  await expect(
    pool.query(
      "UPDATE synthetic_entitlement_grants SET adjusted=adjusted+1 WHERE id=$1",
      [grant],
    ),
  ).rejects.toThrow();
});

it("serializes a final synthetic unit between reservation and writeoff", async () => {
  const owner = await member("technical");
  const grant = await ledger.grant(
    owner,
    "coach_minutes",
    1,
    "race-adjust-grant",
    window,
  );
  const blocker = await pool.connect();
  let transactionOpen = false;
  let attempts: [Promise<string>, Promise<string>] | undefined;
  let results: PromiseSettledResult<string>[];
  try {
    await blocker.query("BEGIN");
    transactionOpen = true;
    await blocker.query(
      "UPDATE synthetic_entitlement_grants SET available=available WHERE id=$1",
      [grant],
    );
    const blockerPid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    attempts = [
      ledger.reserve(owner, grant, 1, "race-adjust-reserve"),
      ledger.adjust(owner, grant, 1, "race-adjust-writeoff"),
    ];
    let blocked = false;
    for (let check = 0; check < 100; check += 1) {
      const count = (
        await pool.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
           WHERE datname=current_database()
             AND $1::integer=ANY(pg_blocking_pids(pid))`,
          [blockerPid],
        )
      ).rows[0]!.count;
      if (Number(count) >= 1) {
        blocked = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await blocker.query("COMMIT");
    transactionOpen = false;
    results = await Promise.allSettled(attempts);
  } finally {
    if (transactionOpen) await blocker.query("ROLLBACK");
    if (attempts) await Promise.allSettled(attempts);
    blocker.release();
  }
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result.status === "rejected")[0],
  ).toMatchObject({ reason: { code: "insufficient" } });
  const balance = (
    await pool.query(
      "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
      [grant],
    )
  ).rows[0];
  expect(balance).toEqual(
    results[0]?.status === "fulfilled"
      ? { available: 0, reserved: 1, consumed: 0, expired: 0, adjusted: 0 }
      : { available: 0, reserved: 0, consumed: 0, expired: 0, adjusted: 1 },
  );
  expect(
    (
      await pool.query(
        "SELECT operation FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation IN ('reserve','adjust')",
        [grant],
      )
    ).rows,
  ).toHaveLength(1);
});

it("keeps written-off units separate from expired availability", async () => {
  const owner = await member("professional");
  const end = new Date("2026-02-01T00:00:00.000Z");
  let current = new Date("2026-01-31T23:59:59.999Z");
  const clocked = syntheticLedger(pool, () => current);
  const grant = await clocked.grant(
    owner,
    "review_minutes",
    3,
    "adjust-expiry-grant",
    {
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: end.toISOString(),
    },
  );
  expect(await clocked.adjust(owner, grant, 1, "adjust-before-expiry")).toBe(
    grant,
  );
  current = end;
  await expect(
    clocked.adjust(owner, grant, 1, "adjust-at-expiry"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await clocked.expire(owner, grant, "expire-after-adjust")).toBe(grant);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 2,
    adjusted: 1,
  });
  expect(
    (
      await pool.query(
        "SELECT operation,quantity FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation IN ('adjust','expire') ORDER BY created_at",
        [grant],
      )
    ).rows,
  ).toEqual([
    { operation: "adjust", quantity: 1 },
    { operation: "expire", quantity: 2 },
  ]);
});

it("rolls back a failed writeoff event without changing balances", async () => {
  const owner = await member("explorer");
  const grant = await ledger.grant(
    owner,
    "study_requests",
    1,
    "failed-adjust-grant",
    window,
  );
  await pool.query(`CREATE FUNCTION reject_test_adjust_event() RETURNS trigger AS $$
    BEGIN IF NEW.operation='adjust' THEN RAISE EXCEPTION 'synthetic event rejected'; END IF;
    RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER reject_test_adjust_event BEFORE INSERT
    ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_test_adjust_event()`);
  try {
    await expect(
      ledger.adjust(owner, grant, 1, "failed-adjust"),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_adjust_event ON synthetic_entitlement_events",
    );
    await pool.query("DROP FUNCTION reject_test_adjust_event()");
  }
  expect(
    (
      await pool.query(
        "SELECT available,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 1, adjusted: 0 });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_entitlement_events WHERE idempotency_key='failed-adjust'",
      )
    ).rowCount,
  ).toBe(0);
  expect(await ledger.adjust(owner, grant, 1, "failed-adjust")).toBe(grant);
});

it("serializes two last-unit reservations and makes release available once", async () => {
  const owner = await member("explorer");
  const grant = await ledger.grant(
    owner,
    "review_minutes",
    1,
    "last-unit-grant",
    window,
  );
  const attempts = await Promise.allSettled([
    ledger.reserve(owner, grant, 1, "last-unit-a"),
    ledger.reserve(owner, grant, 1, "last-unit-b"),
  ]);
  const won = attempts.filter((item) => item.status === "fulfilled");
  const lost = attempts.filter((item) => item.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ reason: { code: "insufficient" } });
  const reservation = (won[0] as PromiseFulfilledResult<string>).value;
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 0, reserved: 1, consumed: 0 });
  expect(await ledger.release(owner, reservation, "release-last")).toBe(
    reservation,
  );
  expect(await ledger.release(owner, reservation, "release-last")).toBe(
    reservation,
  );
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 1, reserved: 0, consumed: 0 });
});

it("rolls back a balance change when event persistence fails", async () => {
  const owner = await member("technical");
  const grant = await ledger.grant(
    owner,
    "study_requests",
    1,
    "rollback-grant",
    window,
  );
  await pool.query(`CREATE FUNCTION reject_test_ledger_event() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'synthetic rejected event'; END; $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER reject_test_ledger_event BEFORE INSERT
    ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_test_ledger_event()`);
  try {
    await expect(
      ledger.reserve(owner, grant, 1, "failed-reserve"),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_ledger_event ON synthetic_entitlement_events",
    );
    await pool.query("DROP FUNCTION reject_test_ledger_event()");
  }
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 1, reserved: 0, consumed: 0 });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_reservations"))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE idempotency_key='failed-reserve'",
      )
    ).rowCount,
  ).toBe(0);
  expect(await ledger.reserve(owner, grant, 1, "failed-reserve")).toMatch(
    /^[0-9a-f-]{36}$/,
  );
});

it("expires Jan 31 and leap-year grants without reviving reserved units", async () => {
  const owner = await member("professional");
  let current = new Date("2028-02-28T23:59:59.999Z");
  const clocked = syntheticLedger(pool, () => current);
  const period = {
    startsAt: `${billingMonth("2028-01-31", 0)}T00:00:00.000Z`,
    expiresAt: `${billingMonth("2028-01-31", 1)}T00:00:00.000Z`,
  };
  const grant = await clocked.grant(
    owner,
    "coach_minutes",
    3,
    "leap-grant",
    period,
  );
  const held = await clocked.reserve(owner, grant, 1, "leap-hold");
  current = new Date(period.expiresAt);
  await expect(
    clocked.reserve(owner, grant, 1, "at-leap-end"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const expiryKeys = ["leap-expire-a", "leap-expire-b"] as const;
  const race = await Promise.allSettled(
    expiryKeys.map((key) => clocked.expire(owner, grant, key)),
  );
  expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(race.filter((item) => item.status === "rejected")[0]).toMatchObject({
    reason: { code: "already_settled" },
  });
  const winner = race.findIndex((item) => item.status === "fulfilled");
  const winnerKey = expiryKeys[winner]!;
  const loserKey = expiryKeys[1 - winner]!;
  expect(await clocked.expire(owner, grant, winnerKey)).toBe(grant);
  await expect(clocked.expire(owner, grant, loserKey)).rejects.toMatchObject({
    code: "already_settled",
  });
  expect(await clocked.release(owner, held, "leap-release")).toBe(held);
  const balance = await pool.query(
    "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
    [grant],
  );
  expect(balance.rows[0]).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 3,
  });
  const events = await pool.query(
    "SELECT operation,quantity,idempotency_key FROM synthetic_entitlement_events WHERE grant_id=$1 ORDER BY created_at",
    [grant],
  );
  expect(events.rows.map((item) => item.operation).sort()).toEqual([
    "expire",
    "grant",
    "release",
    "reserve",
  ]);
  expect(
    events.rows.find((item) => item.operation === "expire")?.quantity,
  ).toBe(2);
  expect(
    events.rows.find((item) => item.operation === "expire")?.idempotency_key,
  ).toBe(winnerKey);
  const feb = `${billingMonth("2026-01-31", 1)}T00:00:00.000Z`;
  expect(feb).toBe("2026-02-28T00:00:00.000Z");
});

it("rolls back an expiry event failure and leaves a held unit consumable", async () => {
  const owner = await member("explorer");
  const end = new Date("2026-02-28T00:00:00.000Z");
  let current = new Date("2026-02-27T00:00:00.000Z");
  const clocked = syntheticLedger(pool, () => current);
  const period = {
    startsAt: "2026-01-31T00:00:00.000Z",
    expiresAt: end.toISOString(),
  };
  const grant = await clocked.grant(
    owner,
    "study_requests",
    2,
    "rollback-expiry-grant",
    period,
  );
  const held = await clocked.reserve(owner, grant, 1, "rollback-expiry-hold");
  current = end;
  await pool.query(`CREATE FUNCTION reject_test_expiry_event() RETURNS trigger AS $$
    BEGIN IF NEW.operation='expire' THEN RAISE EXCEPTION 'synthetic expiry rejected'; END IF;
    RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER reject_test_expiry_event BEFORE INSERT
    ON synthetic_entitlement_events FOR EACH ROW EXECUTE FUNCTION reject_test_expiry_event()`);
  try {
    await expect(
      clocked.expire(owner, grant, "rollback-expiry"),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await pool.query(
      "DROP TRIGGER reject_test_expiry_event ON synthetic_entitlement_events",
    );
    await pool.query("DROP FUNCTION reject_test_expiry_event()");
  }
  expect(
    (
      await pool.query(
        "SELECT available,reserved,expired,expired_at FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 1, reserved: 1, expired: 0, expired_at: null });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM synthetic_entitlement_events WHERE idempotency_key='rollback-expiry'",
      )
    ).rowCount,
  ).toBe(0);
  expect(await clocked.expire(owner, grant, "rollback-expiry")).toBe(grant);
  expect(await clocked.consume(owner, held, "consume-held")).toBe(held);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0],
  ).toEqual({ available: 0, reserved: 0, consumed: 1, expired: 1 });
  await expect(
    clocked.expire(owner, grant, "consume-held"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner],
  );
  await expect(
    clocked.reserve(owner, grant, 1, "inactive-member"),
  ).rejects.toMatchObject({ code: "unavailable" });
});
