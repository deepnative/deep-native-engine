import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import {
  attendanceMemberView,
  attendancePermissionCheck,
} from "../../src/event-attendance-reader.ts";
import {
  attendancePermit,
  attendanceWithdraw,
} from "../../src/event-attendance-permissions.ts";
import {
  attendanceObservationCheck,
  attendanceObserve,
  attendanceStaffPermission,
} from "../../src/event-attendance-observations.ts";
import {
  attendanceRemovalCheck,
  attendanceRemove,
} from "../../src/event-attendance-removal.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const options = { mode: "test" as const, enabled: true, registration: true };
const administrator = randomBytes(32).toString("hex"),
  outsider = randomBytes(32).toString("hex");
let administratorId: string;
const cases: {
  token: string;
  memberId: string;
  registrationId: string;
  permissionId: string;
  startsAt: string;
  expiresAt: string;
}[] = [];

// This new setup budget is defined before its first execution. It exists only
// to observe the real two-minute scheduler margin, not to alter any existing
// test timeout, published date, database clock or application lifetime fence.
beforeAll(async () => {
  await migrate(pool);
  const now = (await pool.query<{ now: Date }>("SELECT clock_timestamp() now"))
    .rows[0]!.now;
  administratorId = await authorizationStore(pool).provisionStaff(
    administrator,
    "platform_admin",
    new Date(+now + 3600000),
  );
  await authorizationStore(pool).provisionStaff(
    outsider,
    "platform_admin",
    new Date(+now + 3600000),
  );
  for (let index = 0; index < 4; index++) {
    const token = randomBytes(32).toString("hex"),
      members = store(pool);
    await members.create(token, {
      background:
        index === 0 ? "technical" : index === 1 ? "professional" : "explorer",
      goal: "work",
    });
    const owner = await members.session(token);
    if (owner.kind !== "active") throw Error("Current invented owner required");
    const observed = (
      await pool.query<{ now: Date }>("SELECT clock_timestamp() now")
    ).rows[0]!.now;
    const snapshot = rehearsalSnapshot({
      templateId: "local-registration-rehearsal",
      templateVersion: 1,
      startsAt: new Date(+observed + 125000).toISOString(),
    });
    const scheduled = await eventRehearsalStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
    }).schedule(administrator, randomUUID(), snapshot);
    if (scheduled.kind !== "ready")
      throw Error("Genuinely scheduled rehearsal required");
    const registration = await eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
    }).enroll(token, scheduled.value.receipt.eventId, 1, randomUUID());
    if (registration.kind !== "enrolled")
      throw Error("Actual future registration required");
    const checked = await attendancePermissionCheck(pool, options, token, {
      registrationId: registration.receiptId,
      administratorId,
    });
    if (checked.kind !== "ready")
      throw Error("Exact finite permission preview required");
    const permitted = await attendancePermit(
      pool,
      options,
      token,
      randomUUID(),
      checked.value,
    );
    if (permitted.kind !== "ready")
      throw Error("Deliberate saved permission required");
    const f = {
      token,
      memberId: owner.learner.id,
      registrationId: registration.receiptId,
      permissionId: permitted.value.permission.id,
      startsAt: checked.value.startsAt,
      expiresAt: checked.value.expiresAt,
    };
    cases.push(f);
    expect(
      (
        await attendanceObservationCheck(
          pool,
          options,
          administrator,
          f.permissionId,
        )
      ).kind,
    ).toBe("denied");
  }
  const latest = new Date(Math.max(...cases.map((f) => +new Date(f.startsAt))));
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)",
    [latest],
  );
  expect(
    (
      await pool.query<{ current: boolean }>(
        "SELECT clock_timestamp()>=$1::timestamptz current",
        [latest],
      )
    ).rows[0]!.current,
  ).toBe(true);
}, 150000);
afterAll(() => pool.end());

async function record(f: (typeof cases)[number]) {
  const checked = await attendanceObservationCheck(
    pool,
    options,
    administrator,
    f.permissionId,
  );
  if (checked.kind !== "ready")
    throw Error("Selected administrator observation preview required");
  const key = randomUUID(),
    saved = await attendanceObserve(
      pool,
      options,
      administrator,
      key,
      checked.value,
    );
  expect(saved.kind).toBe("ready");
  if (saved.kind !== "ready")
    throw Error("Deliberate current-window observation required");
  return { key, checked: checked.value, observation: saved.value.observation };
}
it("ATTEND-02/06 records one PostgreSQL-timed human observation and exact-key repeat cannot renew or backdate it", async () => {
  const f = cases[0]!,
    saved = await record(f);
  const again = await attendanceObserve(
    pool,
    options,
    administrator,
    saved.key,
    saved.checked,
  );
  expect(again.kind).toBe("ready");
  if (again.kind !== "ready")
    throw Error("Canonical observation recovery required");
  expect(again.value.observation).toEqual(saved.observation);
  expect(saved.observation.attribution).toBe("Local platform administrator");
  expect(
    (
      await pool.query<{ bounded: boolean }>(
        `SELECT o.recorded_at>=i.starts_at AND o.recorded_at<i.ends_at AND o.recorded_at>=p.starts_at AND o.recorded_at<p.expires_at bounded
     FROM private_event_attendance_observations o JOIN private_event_enrollments e ON e.id=o.registration_id
     JOIN private_event_inventory i USING(event_id,event_version) JOIN private_event_attendance_permissions p ON p.id=o.permission_id WHERE o.id=$1`,
        [saved.observation.id],
      )
    ).rows[0]!.bounded,
  ).toBe(true);
  expect(
    (
      await attendanceObserve(pool, options, administrator, saved.key, {
        ...saved.checked,
        expiresAt: new Date(
          +new Date(saved.checked.expiresAt) - 1000,
        ).toISOString(),
      })
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await attendanceObserve(
        pool,
        options,
        administrator,
        randomUUID(),
        saved.checked,
      )
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("ATTEND-03/08 only the selected administrator sees the protected exact scope; creation pause preserves finite inspection", async () => {
  const f = cases[0]!,
    paused = { ...options, enabled: false, registration: false };
  expect(
    (
      await attendanceStaffPermission(
        pool,
        paused,
        administrator,
        f.permissionId,
      )
    ).kind,
  ).toBe("ready");
  expect(
    (await attendanceStaffPermission(pool, options, outsider, f.permissionId))
      .kind,
  ).toBe("denied");
  expect(
    (
      await attendanceStaffPermission(
        pool,
        options,
        cases[1]!.token,
        f.permissionId,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await attendanceObservationCheck(
        pool,
        paused,
        administrator,
        f.permissionId,
      )
    ).kind,
  ).toBe("denied");
  const view = await attendanceMemberView(
    pool,
    paused,
    f.token,
    f.registrationId,
  );
  expect(view.kind).toBe("ready");
  if (view.kind !== "ready") throw Error("Private owning observation required");
  expect(view.value.observation?.registrationId).toBe(f.registrationId);
  expect(view.value.creationEnabled).toBe(false);
});
it("ATTEND-04/06 withdrawal retains the owner's fact, while distinct removal deletes permission links and is canonical on repeat", async () => {
  const f = cases[1]!,
    saved = await record(f),
    paused = { ...options, enabled: false, registration: false };
  expect(
    (
      await attendanceWithdraw(
        pool,
        paused,
        f.token,
        randomUUID(),
        f.permissionId,
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await attendanceStaffPermission(
        pool,
        options,
        administrator,
        f.permissionId,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await attendanceObserve(
        pool,
        options,
        administrator,
        saved.key,
        saved.checked,
      )
    ).kind,
  ).toBe("denied");
  const retained = await attendanceMemberView(
    pool,
    paused,
    f.token,
    f.registrationId,
  );
  if (retained.kind !== "ready")
    throw Error("Own retained observation required");
  expect(retained.value.observation?.id).toBe(saved.observation.id);
  const checked = await attendanceRemovalCheck(
    pool,
    paused,
    f.token,
    saved.observation.id,
  );
  if (checked.kind !== "ready")
    throw Error("Deliberate exact removal preview required");
  const key = randomUUID(),
    removed = await attendanceRemove(pool, paused, f.token, key, checked.value);
  expect(removed.kind).toBe("ready");
  expect(
    await attendanceRemove(pool, paused, f.token, key, checked.value),
  ).toMatchObject({
    kind: "ready",
    value: { kind: "remove", registrationId: f.registrationId, removed: true },
  });
  expect(
    (
      await attendanceRemove(pool, paused, f.token, key, {
        ...checked.value,
        observationId: randomUUID(),
      })
    ).kind,
  ).toBe("conflict");
  const view = await attendanceMemberView(
    pool,
    paused,
    f.token,
    f.registrationId,
  );
  if (view.kind !== "ready") throw Error("Unchanged registration required");
  expect(view.value.permission).toBeNull();
  expect(view.value.observation).toBeNull();
  expect(view.value.registrationWithdrawnAt).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_permissions WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("ATTEND-07 owner erasure removes observations and anonymizes all reserved keys without revival", async () => {
  const f = cases[2]!,
    saved = await record(f);
  await pool.query("DELETE FROM principals WHERE id=$1", [f.memberId]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT actor_id,registration_id,kind,instruction_hash FROM private_event_attendance_operations WHERE operation_id=$1",
        [saved.key],
      )
    ).rows[0],
  ).toEqual({
    actor_id: null,
    registration_id: null,
    kind: null,
    instruction_hash: null,
  });
  expect(
    (
      await attendanceObserve(
        pool,
        options,
        administrator,
        saved.key,
        saved.checked,
      )
    ).kind,
  ).toBe("denied");
});
it("ATTEND-07 administrator erasure keeps generic owner attribution without transferring staff access", async () => {
  const f = cases[3]!,
    saved = await record(f);
  await pool.query("DELETE FROM principals WHERE id=$1", [administratorId]);
  const view = await attendanceMemberView(
    pool,
    options,
    f.token,
    f.registrationId,
  );
  expect(view.kind).toBe("ready");
  if (view.kind !== "ready")
    throw Error("Retained own generic attribution required");
  expect(view.value.permission?.administratorId).toBeNull();
  expect(view.value.observation?.id).toBe(saved.observation.id);
  expect(view.value.observation?.attribution).toBe(
    "Local platform administrator",
  );
  expect(
    (await attendanceStaffPermission(pool, options, outsider, f.permissionId))
      .kind,
  ).toBe("denied");
  expect(
    (
      await attendanceStaffPermission(
        pool,
        options,
        administrator,
        f.permissionId,
      )
    ).kind,
  ).toBe("denied");
});
