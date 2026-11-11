import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { ledgerReconciliationStore } from "../../src/ledger-reconciliation.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { sampleHoldCancellationStore } from "../../src/sample-hold-cancellations.ts";
import { testPool } from "../support/database.ts";

// #27 STAFFCANCEL (F-BUILD-03-C) against real PostgreSQL.
const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
const holds = memberSlotHolds(pool);
const cancellations = sampleHoldCancellationStore(pool, { mode: "test" });

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function staff(
  role: "coach" | "operator" | "platform_admin" | "reviewer",
) {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 10 * 86_400_000),
  );
  return { token, id };
}
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Synthetic member missing");
  return { token, id: session.learner.id };
}

async function world() {
  const admin = await staff("platform_admin");
  const operator = await staff("operator");
  const coach = await staff("coach");
  const backup = await staff("coach");
  const registry = randomUUID();
  const firstStart = Date.now() + 3 * 86_400_000;
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
     VALUES($1,$2,'coach','education','coaching',$3,$4,12000,480,$5,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP),
     ($7,$5,'coach','education','coaching',$3,$4,12000,480,$2,'synthetic qualification','synthetic agreement','synthetic conflict',$6,CURRENT_TIMESTAMP)`,
    [
      registry,
      coach.id,
      new Date(Date.now() - 3_600_000),
      new Date(firstStart + 86_400_000),
      backup.id,
      admin.id,
      randomUUID(),
    ],
  );
  let count = 0;
  const slot = async () => {
    const startsAt = new Date(firstStart + count++ * 7_200_000);
    const id = await availabilityStore(pool).create(
      operator.token,
      registry,
      startsAt,
      new Date(startsAt.getTime() + 3_600_000),
    );
    expect(id).toBeTruthy();
    return id!;
  };
  return { operator, coach, admin, slot };
}

const window = {
  startsAt: new Date(Date.now() - 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
};
async function heldBy(slotId: string) {
  const owner = await member();
  const grantId = await ledger.grant(
    owner.id,
    "coach_minutes",
    60,
    randomUUID(),
    window,
  );
  const requestId = randomUUID();
  await holds.request(owner.token, slotId, grantId, requestId);
  const holdId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM synthetic_slot_holds WHERE slot_id=$1 AND state='held'",
      [slotId],
    )
  ).rows[0]!.id;
  return { owner, grantId, requestId, holdId };
}
async function events(grantId: string) {
  return (
    await pool.query(
      `SELECT * FROM synthetic_entitlement_events WHERE grant_id=$1 ORDER BY created_at,id`,
      [grantId],
    )
  ).rows;
}
async function grants(memberId: string) {
  return (
    await pool.query(
      `SELECT id,quantity,available,reserved,adjusted,starts_at,expires_at
       FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY created_at,id`,
      [memberId],
    )
  ).rows;
}

it("STAFFCANCEL-01/03 cancels a held sample, appends history and adds one replacement credit with the original dates", async () => {
  const { operator, slot } = await world();
  const slotId = await slot();
  const { owner, grantId, requestId, holdId } = await heldBy(slotId);
  const before = await events(grantId);
  const reconcile = async () => {
    const report = await ledgerReconciliationStore(pool).snapshot(
      operator.token,
    );
    if (report.kind !== "ready") throw new Error("Reconciliation unavailable");
    return report.value.categories.find((c) => c.category === "coach_minutes")!;
  };
  // A sample hold's reserve event already names the hold, not the
  // reservation, so the report counts it; cancellation must add nothing more.
  const baseline = (await reconcile()).reconciliation;
  const list = await cancellations.list(operator.token);
  expect(list).toMatchObject({
    kind: "ready",
    held: [{ holdId, slotId, domain: "education", serviceType: "coaching" }],
    recent: [],
  });
  // Staff see no member identity.
  expect(JSON.stringify(list)).not.toContain(owner.id);

  const cancelRequest = randomUUID();
  const result = await cancellations.cancel(
    operator.token,
    holdId,
    cancelRequest,
    "coach-unavailable",
  );
  expect(result).toMatchObject({
    kind: "applied",
    cancellation: {
      holdId,
      slotId,
      reason: "coach-unavailable",
      replacementMinutes: 60,
      replacementStartsAt: new Date(window.startsAt),
      replacementExpiresAt: new Date(window.expiresAt),
      cancelledByReader: true,
    },
  });
  const [original, replacement] = await grants(owner.id);
  expect(original).toMatchObject({
    id: grantId,
    available: 0,
    reserved: 0,
    adjusted: 60,
  });
  expect(replacement).toMatchObject({
    quantity: 60,
    available: 60,
    reserved: 0,
    starts_at: new Date(window.startsAt),
    expires_at: new Date(window.expiresAt),
  });
  const after = await events(grantId);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(
    after
      .slice(before.length)
      .map((e) => e.operation)
      .sort(),
  ).toEqual(["adjust", "release"]);
  expect((await events(replacement.id)).map((e) => e.operation)).toEqual([
    "grant",
  ]);
  // The ledger reconciliation finds no new discrepancy in either credit.
  expect(await reconcile()).toMatchObject({
    reconciliation: baseline,
    observed: { granted: 120, available: 60, reserved: 0, adjusted: 60 },
  });

  // The member's receipt says so, with the replacement's own dates.
  const receipt = await holds.get(owner.token, requestId);
  expect(receipt).toMatchObject({
    state: "cancelled",
    cancellation: {
      reason: "coach-unavailable",
      replacementMinutes: 60,
      replacementStartsAt: window.startsAt,
      replacementExpiresAt: window.expiresAt,
    },
  });
  // The window is open again and the replacement credit can hold it.
  expect(
    (await availabilityStore(pool).list()).map((item) => item.id),
  ).toContain(slotId);
  const snapshot = await holds.snapshot(owner.token);
  expect(snapshot.grants.map((g) => g.id)).toEqual([replacement.id]);
  await holds.request(owner.token, slotId, replacement.id, randomUUID());
  expect(await grants(owner.id)).toHaveLength(2);

  // History cannot be rewritten.
  await expect(
    pool.query(
      "UPDATE sample_hold_staff_cancellations SET reason='scheduling-error'",
    ),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("DELETE FROM sample_hold_staff_cancellations"),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query(
      "UPDATE synthetic_entitlement_events SET quantity=1 WHERE grant_id=$1",
      [grantId],
    ),
  ).rejects.toThrow(/immutable/);
  expect(await cancellations.list(operator.token)).toMatchObject({
    kind: "ready",
    recent: [{ holdId, reason: "coach-unavailable", cancelledByReader: true }],
  });
});

it("STAFFCANCEL-04/05 replays one request once and refuses a stale form or a reused request ID", async () => {
  const { operator, admin, slot } = await world();
  const first = await heldBy(await slot());
  const second = await heldBy(await slot());
  const request = randomUUID();
  const replays = await Promise.all(
    [1, 2, 3].map(() =>
      cancellations.cancel(
        operator.token,
        first.holdId,
        request,
        "scheduling-error",
      ),
    ),
  );
  expect(replays.map((r) => r.kind).sort()).toEqual([
    "applied",
    "replayed",
    "replayed",
  ]);
  expect(await grants(first.owner.id)).toHaveLength(2);
  // A second, separately opened form for the same hold is now stale.
  expect(
    await cancellations.cancel(
      admin.token,
      first.holdId,
      randomUUID(),
      "scheduling-error",
    ),
  ).toEqual({ kind: "stale" });
  // The same request ID cannot cancel another hold or change its reason.
  for (const [holdId, reason] of [
    [second.holdId, "scheduling-error"],
    [first.holdId, "member-request"],
  ] as const)
    expect(
      await cancellations.cancel(operator.token, holdId, request, reason),
    ).toEqual({ kind: "conflict" });
  // Another operator cannot replay this operator's request.
  expect(
    await cancellations.cancel(
      admin.token,
      first.holdId,
      request,
      "scheduling-error",
    ),
  ).toEqual({ kind: "conflict" });
  // A member's own withdrawal makes a staff form stale too.
  await holds.withdraw(second.owner.token, second.requestId);
  expect(
    await cancellations.cancel(
      operator.token,
      second.holdId,
      randomUUID(),
      "member-request",
    ),
  ).toEqual({ kind: "stale" });
  expect(await grants(second.owner.id)).toHaveLength(1);
  expect(
    (await pool.query("SELECT 1 FROM sample_hold_staff_cancellations"))
      .rowCount,
  ).toBe(1);
});

it("STAFFCANCEL-06 denies members, other staff roles and expired staff without disclosure", async () => {
  const { coach, operator, slot } = await world();
  const { owner, holdId } = await heldBy(await slot());
  const reviewer = await staff("reviewer");
  const missing = randomUUID();
  for (const token of [coach.token, reviewer.token, owner.token]) {
    expect(await cancellations.list(token)).toEqual({ kind: "denied" });
    for (const target of [holdId, missing])
      expect(
        await cancellations.cancel(
          token,
          target,
          randomUUID(),
          "coach-unavailable",
        ),
      ).toEqual({ kind: "denied" });
  }
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
    [operator.id],
  );
  expect(await cancellations.list(operator.token)).toEqual({
    kind: "denied",
  });
  expect(
    await cancellations.cancel(
      operator.token,
      holdId,
      randomUUID(),
      "coach-unavailable",
    ),
  ).toEqual({ kind: "denied" });
  expect(
    (
      await pool.query("SELECT state FROM synthetic_slot_holds WHERE id=$1", [
        holdId,
      ])
    ).rows,
  ).toEqual([{ state: "held" }]);
});

it("STAFFCANCEL-06 an authorized operator also learns only that an unknown hold is unavailable", async () => {
  const { operator } = await world();
  expect(
    await cancellations.cancel(
      operator.token,
      randomUUID(),
      randomUUID(),
      "coach-unavailable",
    ),
  ).toEqual({ kind: "denied" });
});

it("STAFFCANCEL-07 refuses when the reserved credit's own dates have ended, and keeps the hold", async () => {
  const { operator, slot } = await world();
  const { owner, grantId, holdId } = await heldBy(await slot());
  // Shift the credit's period into the past, as if it ended during the hold.
  await pool.query(
    `ALTER TABLE synthetic_entitlement_grants DISABLE TRIGGER USER;
     UPDATE synthetic_entitlement_grants SET starts_at=clock_timestamp()-interval '2 hours',
       expires_at=clock_timestamp()-interval '1 second' WHERE id='${grantId}';
     ALTER TABLE synthetic_entitlement_grants ENABLE TRIGGER USER;`,
  );
  expect(
    await cancellations.cancel(
      operator.token,
      holdId,
      randomUUID(),
      "coach-unavailable",
    ),
  ).toEqual({ kind: "ended" });
  expect(await grants(owner.id)).toHaveLength(1);
  expect(
    (
      await pool.query("SELECT state FROM synthetic_slot_holds WHERE id=$1", [
        holdId,
      ])
    ).rows,
  ).toEqual([{ state: "held" }]);
});

it("STAFFCANCEL-01 keeps the record when the cancelling staff account is removed, and is removed with the member", async () => {
  const { slot } = await world();
  const { owner, holdId } = await heldBy(await slot());
  const operator = await staff("operator");
  expect(
    (
      await cancellations.cancel(
        operator.token,
        holdId,
        randomUUID(),
        "member-request",
      )
    ).kind,
  ).toBe("applied");
  await pool.query("DELETE FROM principals WHERE id=$1", [operator.id]);
  expect(
    (
      await pool.query(
        "SELECT staff_id,reason FROM sample_hold_staff_cancellations",
      )
    ).rows,
  ).toEqual([{ staff_id: null, reason: "member-request" }]);
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(
    (await pool.query("SELECT 1 FROM sample_hold_staff_cancellations"))
      .rowCount,
  ).toBe(0);
});

it("STAFFCANCEL-09 refuses on a live site and an invalid reason before reaching the database", async () => {
  const live = sampleHoldCancellationStore(pool, { mode: "live" });
  expect(await live.list("a".repeat(64))).toEqual({ kind: "unavailable" });
  const { operator } = await world();
  await expect(
    pool.query("SELECT * FROM staff_cancel_sample_hold($1,$2,$3,$4)", [
      "x",
      randomUUID(),
      randomUUID(),
      "free text",
    ]),
  ).rejects.toMatchObject({ code: "DN001" });
  expect(
    await cancellations.cancel(
      operator.token,
      randomUUID(),
      randomUUID(),
      "free text",
    ),
  ).toEqual({ kind: "invalid" });
});

async function download(token: string) {
  const exporter = memberExportStore(pool);
  const all: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined;
  for (;;) {
    const page = await exporter.exportOwned(token, cursor);
    if (page.kind !== "ready") throw Error(`Download ${page.kind}`);
    for (const [name, rows] of Object.entries(page.payload.records))
      (all[name] ??= []).push(...rows);
    if (!page.payload.page.nextCursor)
      return { version: page.payload.version, all };
    cursor = page.payload.page.nextCursor;
  }
}

it("HOLDCANCEL-EXP-01/02/03 the member's download shows why and when staff cancelled their sample hold, never who, and never another member's", async () => {
  const { slot, operator } = await world();
  const mine = await heldBy(await slot());
  const theirs = await heldBy(await slot());
  const kept = await heldBy(await slot());
  const staffRequest = randomUUID();
  for (const [hold, request, reason] of [
    [mine, staffRequest, "coach-unavailable"],
    [theirs, randomUUID(), "scheduling-error"],
  ] as const)
    expect(
      (await cancellations.cancel(operator.token, hold.holdId, request, reason))
        .kind,
    ).toBe("applied");
  const replacement = (
    await pool.query<{ id: string }>(
      "SELECT replacement_grant_id AS id FROM sample_hold_staff_cancellations WHERE hold_id=$1",
      [mine.holdId],
    )
  ).rows[0]!.id;

  const { version, all } = await download(mine.owner.token);
  expect(version).toBe("local-member-records-v49");
  expect(all.sampleHoldCancellations).toEqual([
    {
      sampleHoldId: mine.requestId,
      reason: "coach-unavailable",
      cancelledAt: expect.any(Date),
      originalGrantId: mine.grantId,
      replacementGrantId: replacement,
      label: "SAMPLE HOLD · NOT A BOOKING",
    },
  ]);
  // It names the hold as the member's own download already does.
  expect(all.sampleHolds).toEqual([
    expect.objectContaining({ id: mine.requestId, state: "cancelled" }),
  ]);
  const text = JSON.stringify(all);
  for (const hidden of [
    operator.id,
    staffRequest,
    theirs.requestId,
    theirs.grantId,
    "scheduling-error",
  ])
    expect(text).not.toContain(hidden);
  // A member whose hold was not cancelled has no cancellation row.
  expect(
    (await download(kept.owner.token)).all.sampleHoldCancellations,
  ).toEqual([]);
  // Baseline: the record goes with the account.
  await pool.query("DELETE FROM principals WHERE id=$1", [mine.owner.id]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM sample_hold_staff_cancellations WHERE member_id=$1",
        [mine.owner.id],
      )
    ).rowCount,
  ).toBe(0);
});
