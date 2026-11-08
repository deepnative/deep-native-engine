import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventAttendanceStore } from "../../src/event-attendance.ts";
import { testPool } from "../support/database.ts";

// ATTKEY-01..05 (#42): an event attendance operation key is unique only within
// the actor who used it, so another member's key inspects and acts exactly like
// an unused one, and can never block a member's own write.
const pool = testPool();
const options = { mode: "test" as const, enabled: true, registration: true };
const attendance = eventAttendanceStore(pool, options);
const administrator = randomBytes(32).toString("hex");
let administratorId: string;

async function member() {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "work" });
  const now = (await pool.query<{ now: Date }>("SELECT clock_timestamp() now"))
    .rows[0]!.now;
  const scheduled = await eventRehearsalStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  }).schedule(
    administrator,
    randomUUID(),
    rehearsalSnapshot({
      templateId: "local-registration-rehearsal",
      templateVersion: 1,
      startsAt: new Date(+now + 180_000).toISOString(),
    }),
  );
  if (scheduled.kind !== "ready") throw Error("Invented rehearsal required");
  const registration = await eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
  }).enroll(token, scheduled.value.receipt.eventId, 1, randomUUID());
  if (registration.kind !== "enrolled")
    throw Error("Invented registration required");
  const checked = await attendance.checkPermission(token, {
    registrationId: registration.receiptId,
    administratorId,
  });
  if (checked.kind !== "ready") throw Error("Permission preview required");
  return { token, checked: checked.value };
}
function permissionId(result: { kind: string; value?: unknown }) {
  if (result.kind !== "ready")
    throw Error(`Saved permission, got ${result.kind}`);
  return (result.value as { permission: { id: string } }).permission.id;
}

beforeAll(async () => {
  await migrate(pool);
  const now = (await pool.query<{ now: Date }>("SELECT clock_timestamp() now"))
    .rows[0]!.now;
  administratorId = await authorizationStore(pool).provisionStaff(
    administrator,
    "platform_admin",
    new Date(+now + 3_600_000),
  );
});
afterAll(async () => pool.end());

it("ATTKEY-01 another member's permission key inspects exactly like an unused key", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  expect((await attendance.permit(a.token, key, a.checked)).kind).toBe("ready");
  const answer = async (k: string) => {
    const { kind, value } = (await attendance.inspect(
      b.token,
      k,
      "permit",
      b.checked,
    )) as { kind: string; value?: unknown };
    return { kind, value };
  };
  expect(await answer(randomUUID())).toEqual({ kind: "ready", value: null });
  expect(await answer(key)).toEqual({ kind: "ready", value: null });
});

it("ATTKEY-02 a member's own permission is saved under another member's key and each sees only their own", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  const mine = permissionId(await attendance.permit(a.token, key, a.checked));
  const theirs = permissionId(await attendance.permit(b.token, key, b.checked));
  expect(theirs).not.toBe(mine);
  expect(
    permissionId(await attendance.inspect(a.token, key, "permit", a.checked)),
  ).toBe(mine);
  expect(
    permissionId(await attendance.inspect(b.token, key, "permit", b.checked)),
  ).toBe(theirs);
  // A member's own replay still returns their own receipt, unchanged.
  expect(permissionId(await attendance.permit(b.token, key, b.checked))).toBe(
    theirs,
  );
});

it("ATTKEY-03 a member withdraws their own permission under another member's key", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  const own = permissionId(
    await attendance.permit(b.token, randomUUID(), b.checked),
  );
  expect((await attendance.permit(a.token, key, a.checked)).kind).toBe("ready");
  const withdrawn = await attendance.withdraw(b.token, key, own);
  expect(withdrawn.kind).toBe("ready");
  expect(
    (await attendance.inspect(b.token, key, "withdraw", { permissionId: own }))
      .kind,
  ).toBe("ready");
  // A's receipt under the same key is untouched.
  expect(
    (await attendance.inspect(a.token, key, "permit", a.checked)).kind,
  ).toBe("ready");
});

it("ATTKEY-04 a member's own key reused for a different instruction still conflicts", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  const own = permissionId(await attendance.permit(a.token, key, a.checked));
  expect((await attendance.permit(b.token, key, b.checked)).kind).toBe("ready");
  expect((await attendance.withdraw(a.token, key, own)).kind).toBe("conflict");
});

it("ATTKEY-05 re-running every migration keeps attendance keys unique per actor only", async () => {
  await migrate(pool);
  const unique = (
    await pool.query<{ columns: string[]; primary: boolean }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns, bool_or(i.indisprimary) AS primary
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid='private_event_attendance_operations'::regclass AND i.indisunique
        GROUP BY i.indexrelid`,
    )
  ).rows;
  expect(unique).toEqual([
    { columns: ["actor_id", "operation_id"], primary: false },
  ]);
  expect(
    (
      await pool.query<{ notnull: boolean }>(
        `SELECT attnotnull AS notnull FROM pg_attribute
          WHERE attrelid='private_event_attendance_operations'::regclass AND attname='operation_id'`,
      )
    ).rows[0]!.notnull,
  ).toBe(true);
});
