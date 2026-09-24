import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
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
  );
  const review = await ledger.grant(
    explorer,
    "review_minutes",
    2,
    "fixture-review",
  );
  expect(
    await ledger.grant(explorer, "coach_minutes", 3, "fixture-coach"),
  ).toBe(coach);
  await expect(
    ledger.grant(explorer, "coach_minutes", 4, "fixture-coach"),
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

it("serializes two last-unit reservations and makes release available once", async () => {
  const owner = await member("explorer");
  const grant = await ledger.grant(
    owner,
    "review_minutes",
    1,
    "last-unit-grant",
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
