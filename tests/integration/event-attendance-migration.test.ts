import { memberExportStore } from "../../src/member-export.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { attendanceInspect } from "../../src/event-attendance-inspection.ts";
import { attendanceHistory } from "../../src/event-attendance-history.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { testPool } from "../support/database.ts";
import {
  attendanceActors,
  attendanceExecute,
  attendanceSource,
} from "../../src/event-attendance-transaction.ts";
import {
  attendanceAdministratorReference,
  attendanceMemberView,
  attendancePermissionCheck,
} from "../../src/event-attendance-reader.ts";
import {
  attendancePermit,
  attendanceWithdraw,
} from "../../src/event-attendance-permissions.ts";
const pool = testPool();
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function fixture() {
  const token = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex");
  const db = store(pool);
  await db.create(token, { background: "professional", goal: "work" });
  const owner = await db.session(token);
  if (owner.kind !== "active") throw Error("Invented active owner required");
  const now = (
    await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now;
  const administrator = await authorizationStore(pool).provisionStaff(
    admin,
    "platform_admin",
    new Date(+now + 3600000),
  );
  const source = rehearsalSnapshot({
    templateId: "local-registration-rehearsal",
    templateVersion: 1,
    startsAt: new Date(+now + 180000).toISOString(),
  });
  const scheduled = await eventRehearsalStore(pool, {
    mode: "test",
    writes: true,
    registration: true,
  }).schedule(admin, randomUUID(), source);
  if (scheduled.kind !== "ready") throw Error("Genuine dated fixture required");
  const registration = await eventEnrollmentStore(pool, {
    mode: "test",
    enabled: true,
  }).enroll(token, scheduled.value.receipt.eventId, 1, randomUUID());
  if (registration.kind !== "enrolled")
    throw Error("Owning registration required");
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [owner.learner.id],
    )
  ).rows[0]!.id;
  return {
    token,
    admin,
    member: owner.learner.id,
    administrator,
    registration: registration.receiptId,
    workspace,
    starts: source!.startsAt,
    expires: new Date(+new Date(source!.startsAt) + 60000).toISOString(),
  };
}
async function permit(
  f: Awaited<ReturnType<typeof fixture>>,
  extra?: { starts?: string; administrator?: string },
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO private_event_attendance_permissions(id,registration_id,workspace_id,member_id,administrator_id,starts_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      f.registration,
      f.workspace,
      f.member,
      extra?.administrator ?? f.administrator,
      extra?.starts ?? f.starts,
      f.expires,
    ],
  );
  return id;
}
it("ATTEND-07 complete bounded private history crosses a page while rejecting foreign and forged cursors", async () => {
  const f = await fixture();
  const options = { mode: "test" as const, enabled: true, registration: true };
  const ids: string[] = [f.registration];
  await permit(f);
  const existing = await attendanceMemberView(
    pool,
    options,
    f.token,
    f.registration,
  );
  if (existing.kind !== "ready") throw Error("Owning first event required");
  expect(
    (
      await eventCancellationStore(pool, {
        mode: "test",
        writes: true,
        registration: true,
      }).cancel(
        f.admin,
        {
          eventId: existing.value.eventId,
          eventVersion: existing.value.eventVersion,
        },
        randomUUID(),
      )
    ).kind,
  ).toBe("ready");
  for (let i = 1; i <= 20; i++) {
    const snapshot = rehearsalSnapshot({
      templateId: "local-registration-rehearsal",
      templateVersion: 1,
      startsAt: new Date(+new Date(f.starts) + i * 60000).toISOString(),
    });
    const scheduled = await eventRehearsalStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
    }).schedule(f.admin, randomUUID(), snapshot);
    if (scheduled.kind !== "ready")
      throw Error("Actual dated history rehearsal required");
    const registered = await eventEnrollmentStore(pool, options).enroll(
      f.token,
      scheduled.value.receipt.eventId,
      1,
      randomUUID(),
    );
    if (registered.kind !== "enrolled")
      throw Error("Exact history enrollment required");
    ids.push(registered.receiptId);
    const checked = await attendancePermissionCheck(pool, options, f.token, {
      registrationId: registered.receiptId,
      administratorId: f.administrator,
    });
    if (checked.kind !== "ready")
      throw Error("Actual finite history permission required");
    expect(
      (
        await attendancePermit(
          pool,
          options,
          f.token,
          randomUUID(),
          checked.value,
        )
      ).kind,
    ).toBe("ready");
  }
  const paused = { ...options, enabled: false, registration: false };
  const secret = "invented-private-attendance-history-secret";
  const first = await attendanceHistory(pool, paused, secret, f.token);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready" || !first.value.nextCursor)
    throw Error("Bounded first page with signed continuation required");
  expect(first.value.items).toHaveLength(20);
  const second = await attendanceHistory(
    pool,
    paused,
    secret,
    f.token,
    first.value.nextCursor,
  );
  expect(second.kind).toBe("ready");
  if (second.kind !== "ready") throw Error("Owning continuation required");
  expect(second.value.items).toHaveLength(1);
  expect(second.value.nextCursor).toBeNull();
  const all = [...first.value.items, ...second.value.items];
  expect(all.map((item) => item.registrationId)).toEqual(ids);
  expect(
    all.every((item) => item.observation === null && !item.creationEnabled),
  ).toBe(true);
  const other = randomBytes(32).toString("hex");
  await store(pool).create(other, { background: "explorer", goal: "everyday" });
  expect(
    (
      await attendanceHistory(
        pool,
        paused,
        secret,
        other,
        first.value.nextCursor,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await attendanceHistory(
        pool,
        paused,
        secret,
        f.token,
        first.value.nextCursor + "forged",
      )
    ).kind,
  ).toBe("invalid");
  await store(pool).remove(f.member);
  expect(
    (
      await attendanceHistory(
        pool,
        paused,
        secret,
        f.token,
        first.value.nextCursor,
      )
    ).kind,
  ).toBe("denied");
});
it("ATTEND-06 actual committed permission with lost acknowledgment is inspected read-only while paused without renewing authority", async () => {
  const f = await fixture();
  const options = { mode: "test" as const, enabled: true, registration: true };
  const checked = await attendancePermissionCheck(pool, options, f.token, {
    registrationId: f.registration,
    administratorId: f.administrator,
  });
  if (checked.kind !== "ready") throw Error("Finite permission check required");
  const key = randomUUID();
  let lost = false;
  const uncertain = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (sql === "COMMIT" && !lost) {
                lost = true;
                throw Error(
                  "Invented lost acknowledgment after actual PostgreSQL COMMIT",
                );
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
  expect(
    (await attendancePermit(uncertain, options, f.token, key, checked.value))
      .kind,
  ).toBe("unavailable");
  expect(lost).toBe(true);
  const before = (
    await pool.query(
      "SELECT id,created_at,expires_at FROM private_event_attendance_permissions",
    )
  ).rows;
  expect(before).toHaveLength(1);
  const paused = { ...options, enabled: false, registration: false };
  const recovered = await attendanceInspect(
    pool,
    paused,
    f.token,
    key,
    "permit",
    checked.value,
  );
  expect(recovered.kind).toBe("ready");
  if (recovered.kind !== "ready" || recovered.value?.kind !== "permit")
    throw Error("Original owned permission receipt required");
  expect(recovered.value.permission.id).toBe(before[0].id);
  expect(recovered.value.permission.expiresAt).toEqual(before[0].expires_at);
  expect(
    (
      await pool.query(
        "SELECT id,created_at,expires_at FROM private_event_attendance_permissions",
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_operations",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await attendanceInspect(pool, paused, f.token, key, "permit", {
        ...checked.value,
        expiresAt: new Date(
          +new Date(checked.value.expiresAt) - 1000,
        ).toISOString(),
      })
    ).kind,
  ).toBe("conflict");
  const other = await fixture();
  expect(
    (
      await attendanceInspect(
        pool,
        paused,
        other.token,
        key,
        "permit",
        checked.value,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await attendanceInspect(
        pool,
        { ...paused, mode: "live" },
        f.token,
        key,
        "permit",
        checked.value,
      )
    ).kind,
  ).toBe("denied");
});
it("ATTEND-07 populated reapply preserves registration and never invents an observation", async () => {
  const f = await fixture();
  const id = await permit(f);
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_enrollments WHERE id=$1",
        [f.registration],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT id FROM private_event_attendance_permissions WHERE id=$1",
        [id],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("ATTEND-03 exact owned source remains readable after registration withdrawal without becoming attendance", async () => {
  const f = await fixture();
  const read = () =>
    attendanceExecute(pool, f.token, false, async (context) => {
      await attendanceActors(context, [], "member");
      return attendanceSource(context, f.registration, context.actorId);
    });
  const first = await read();
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("Own exact source required");
  expect(first.value.registrationId).toBe(f.registration);
  expect(first.value.withdrawnAt).toBeNull();
  expect(first.value.cancelledAt).toBeNull();
  expect(first.deadline).toBeGreaterThan(performance.now());
  await pool.query(
    "UPDATE private_event_enrollments SET withdrawn_at=clock_timestamp() WHERE id=$1",
    [f.registration],
  );
  const later = await read();
  expect(later.kind).toBe("ready");
  if (later.kind !== "ready") throw Error("Retained own registration required");
  expect(later.value.withdrawnAt).toBeInstanceOf(Date);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("ATTEND-03/08 another member, revoked actor and arbitrary staff cannot obtain the owned source", async () => {
  const f = await fixture(),
    other = await fixture();
  expect(
    (
      await attendanceExecute(pool, other.token, false, async (context) => {
        await attendanceActors(context, [], "member");
        return attendanceSource(context, f.registration, context.actorId);
      })
    ).kind,
  ).toBe("denied");
  expect(
    (
      await attendanceExecute(pool, f.admin, false, async (context) => {
        await attendanceActors(context, [], "member");
        return attendanceSource(context, f.registration, context.actorId);
      })
    ).kind,
  ).toBe("denied");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.member],
  );
  expect(
    (
      await attendanceExecute(pool, f.token, false, async (context) => {
        await attendanceActors(context, [], "member");
        return attendanceSource(context, f.registration, context.actorId);
      })
    ).kind,
  ).toBe("denied");
});

it("ATTEND-06 erasure anonymizes an exact operation but keeps its global key reserved", async () => {
  const f = await fixture(),
    permission = await permit(f),
    key = randomUUID();
  await pool.query(
    `INSERT INTO private_event_attendance_operations(operation_id,actor_id,workspace_id,registration_id,kind,instruction_hash,permission_id,created_at)
     VALUES($1,$2,$3,$4,'permit',$5,$6,'2000-01-01T00:00:00Z')`,
    [key, f.member, f.workspace, f.registration, "b".repeat(64), permission],
  );
  expect(
    (
      await pool.query(
        "SELECT created_at FROM private_event_attendance_operations WHERE operation_id=$1",
        [key],
      )
    ).rows[0].created_at.getUTCFullYear(),
  ).toBeGreaterThan(2000);
  await pool.query("DELETE FROM principals WHERE id=$1", [f.member]);
  const row = (
    await pool.query(
      "SELECT * FROM private_event_attendance_operations WHERE operation_id=$1",
      [key],
    )
  ).rows[0];
  expect(row.operation_id).toBe(key);
  for (const field of [
    "actor_id",
    "workspace_id",
    "registration_id",
    "kind",
    "instruction_hash",
    "permission_id",
    "observation_id",
  ])
    expect(row[field]).toBeNull();
  await expect(
    pool.query(
      "DELETE FROM private_event_attendance_operations WHERE operation_id=$1",
      [key],
    ),
  ).rejects.toThrow("Private attendance operation key is reserved");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_permissions",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("ATTEND-01/03 checking a selected finite administrator never records or infers attendance", async () => {
  const f = await fixture(),
    options = { mode: "test" as const, enabled: true, registration: true };
  const reference = await attendanceAdministratorReference(
    pool,
    options,
    f.admin,
  );
  expect(reference.kind).toBe("ready");
  if (reference.kind !== "ready")
    throw Error("Current administrator self reference required");
  expect(reference.value.reference).toBe(f.administrator);
  expect(reference.value.reference).not.toBe(f.admin);
  const checked = await attendancePermissionCheck(pool, options, f.token, {
    registrationId: f.registration,
    administratorId: reference.value.reference,
  });
  expect(checked.kind).toBe("ready");
  if (checked.kind !== "ready") throw Error("Deliberate finite check required");
  expect(checked.value.startsAt).toBe(f.starts);
  expect(+new Date(checked.value.expiresAt)).toBeLessThanOrEqual(
    +new Date(f.starts) + 3600000,
  );
  const view = await attendanceMemberView(
    pool,
    options,
    f.token,
    f.registration,
  );
  expect(view.kind).toBe("ready");
  if (view.kind !== "ready") throw Error("Own no-observation receipt required");
  expect(view.value.permission).toBeNull();
  expect(view.value.observation).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_permissions",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("ATTEND-08 creation pause retains private owning inspection while live mode and other members are denied", async () => {
  const f = await fixture(),
    other = await fixture(),
    options = { mode: "test" as const, enabled: false, registration: false };
  const view = await attendanceMemberView(
    pool,
    options,
    f.token,
    f.registration,
  );
  expect(view.kind).toBe("ready");
  if (view.kind !== "ready") throw Error("Own paused inspection required");
  expect(view.value.creationEnabled).toBe(false);
  expect(
    (
      await attendancePermissionCheck(pool, options, f.token, {
        registrationId: f.registration,
        administratorId: f.administrator,
      })
    ).kind,
  ).toBe("denied");
  expect(
    (await attendanceMemberView(pool, options, other.token, f.registration))
      .kind,
  ).toBe("denied");
  expect(
    (
      await attendanceMemberView(
        pool,
        { ...options, mode: "live" },
        f.token,
        f.registration,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (await attendanceAdministratorReference(pool, options, f.token)).kind,
  ).toBe("denied");
});

it("ATTEND-01/04/06 deliberate permission is canonical on exact-key repeat and withdrawal works while creation is paused", async () => {
  const f = await fixture(),
    options = { mode: "test" as const, enabled: true, registration: true },
    key = randomUUID();
  const checked = await attendancePermissionCheck(pool, options, f.token, {
    registrationId: f.registration,
    administratorId: f.administrator,
  });
  if (checked.kind !== "ready")
    throw Error("Finite permission preview required");
  const saved = await attendancePermit(
    pool,
    options,
    f.token,
    key,
    checked.value,
  );
  expect(saved.kind).toBe("ready");
  if (saved.kind !== "ready")
    throw Error("Deliberate saved permission required");
  expect(saved.value.permission.registrationId).toBe(f.registration);
  expect(saved.value.permission.administratorId).toBe(f.administrator);
  expect(saved.value.permission.expiresAt.toISOString()).toBe(
    checked.value.expiresAt,
  );
  const repeated = await attendancePermit(
    pool,
    options,
    f.token,
    key,
    checked.value,
  );
  expect(repeated.kind).toBe("ready");
  if (repeated.kind !== "ready")
    throw Error("Exact-key canonical recovery required");
  expect(repeated.value.permission.id).toBe(saved.value.permission.id);
  expect(repeated.value.permission.expiresAt).toEqual(
    saved.value.permission.expiresAt,
  );
  expect(
    (
      await attendancePermit(pool, options, f.token, key, {
        ...checked.value,
        expiresAt: new Date(
          +new Date(checked.value.expiresAt) - 1000,
        ).toISOString(),
      })
    ).kind,
  ).toBe("conflict");
  const withdrawKey = randomUUID(),
    paused = { ...options, enabled: false, registration: false };
  const withdrawn = await attendanceWithdraw(
    pool,
    paused,
    f.token,
    withdrawKey,
    saved.value.permission.id,
  );
  expect(withdrawn.kind).toBe("ready");
  if (withdrawn.kind !== "ready")
    throw Error("Owning withdrawal while paused required");
  expect(withdrawn.value.permission.withdrawnAt).toBeInstanceOf(Date);
  const withdrawalAgain = await attendanceWithdraw(
    pool,
    paused,
    f.token,
    withdrawKey,
    saved.value.permission.id,
  );
  expect(withdrawalAgain.kind).toBe("ready");
  if (withdrawalAgain.kind !== "ready")
    throw Error("Exact withdrawal recovery required");
  expect(withdrawalAgain.value.permission.withdrawnAt).toEqual(
    withdrawn.value.permission.withdrawnAt,
  );
  const view = await attendanceMemberView(
    pool,
    paused,
    f.token,
    f.registration,
  );
  expect(view.kind).toBe("ready");
  if (view.kind !== "ready") throw Error("Retained own source required");
  expect(view.value.permission?.withdrawnAt).toBeInstanceOf(Date);
  expect(view.value.registrationWithdrawnAt).toBeNull();
  expect(view.value.observation).toBeNull();
  const originalAfterWithdrawal = await attendancePermit(
    pool,
    options,
    f.token,
    key,
    checked.value,
  );
  expect(originalAfterWithdrawal.kind).toBe("ready");
  if (originalAfterWithdrawal.kind !== "ready")
    throw Error("Retained canonical permission required");
  expect(originalAfterWithdrawal.value.permission.id).toBe(
    saved.value.permission.id,
  );
  expect(originalAfterWithdrawal.value.permission.withdrawnAt).toEqual(
    withdrawn.value.permission.withdrawnAt,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_permissions",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_operations",
      )
    ).rows[0].n,
  ).toBe(2);
});
it("ATTEND-01/02 database denies an early permission and an observation before the genuine event window", async () => {
  const f = await fixture();
  await expect(
    permit(f, { starts: new Date(+new Date(f.starts) - 1).toISOString() }),
  ).rejects.toThrow("Exact current private attendance permission required");
  const id = await permit(f);
  await expect(
    pool.query(
      `INSERT INTO private_event_attendance_observations(id,permission_id,registration_id,workspace_id,member_id,administrator_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        id,
        f.registration,
        f.workspace,
        f.member,
        f.administrator,
      ],
    ),
  ).rejects.toThrow("Exact current observation window and permission required");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_attendance_observations",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("ATTEND-04 permission withdrawal is irreversible and cannot change its exact source or saved deadline", async () => {
  const f = await fixture(),
    id = await permit(f);
  await expect(
    pool.query(
      "UPDATE private_event_attendance_permissions SET expires_at=expires_at+interval '1 second' WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("Private attendance permission is immutable");
  await pool.query(
    "UPDATE private_event_attendance_permissions SET withdrawn_at=clock_timestamp() WHERE id=$1",
    [id],
  );
  await expect(
    pool.query(
      "UPDATE private_event_attendance_permissions SET withdrawn_at=NULL WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow("Private attendance permission is immutable");
  expect(
    (
      await pool.query(
        "SELECT withdrawn_at FROM private_event_enrollments WHERE id=$1",
        [f.registration],
      )
    ).rows[0].withdrawn_at,
  ).toBeNull();
});

it("ATTEND-06 an operation cannot borrow a permission from another exact registration", async () => {
  const first = await fixture(),
    second = await fixture(),
    permission = await permit(first);
  await expect(
    pool.query(
      `INSERT INTO private_event_attendance_operations(operation_id,actor_id,workspace_id,registration_id,kind,instruction_hash,permission_id)
       VALUES($1,$2,$3,$4,'permit',$5,$6)`,
      [
        randomUUID(),
        second.member,
        second.workspace,
        second.registration,
        "a".repeat(64),
        permission,
      ],
    ),
  ).rejects.toThrow("Exact private attendance operation source required");
});

it("ATTEND-04 replacement registration never inherits old permission or original keys", async () => {
  const f = await fixture(),
    options = { mode: "test" as const, enabled: true, registration: true };
  const preview = await attendancePermissionCheck(pool, options, f.token, {
    registrationId: f.registration,
    administratorId: f.administrator,
  });
  if (preview.kind !== "ready") throw Error("Own exact preview required");
  const key = randomUUID(),
    saved = await attendancePermit(pool, options, f.token, key, preview.value);
  if (saved.kind !== "ready") throw Error("Saved original permission required");
  const events = eventEnrollmentStore(pool, { mode: "test", enabled: true });
  const original = await events.receipt(f.token, f.registration);
  if (!original) throw Error("Retained registration required");
  expect(await events.withdraw(f.token, f.registration)).toBe("withdrawn");
  const replacement = randomUUID();
  expect(
    (
      await events.enroll(
        f.token,
        original.eventId,
        original.eventVersion,
        replacement,
      )
    ).kind,
  ).toBe("enrolled");
  const view = await attendanceMemberView(pool, options, f.token, replacement);
  expect(view).toMatchObject({
    kind: "ready",
    value: { permission: null, observation: null, registrationId: replacement },
  });
  expect(
    (
      await attendancePermit(pool, options, f.token, key, {
        ...preview.value,
        registrationId: replacement,
      })
    ).kind,
  ).toBe("conflict");
  const fresh = await attendancePermissionCheck(pool, options, f.token, {
    registrationId: replacement,
    administratorId: f.administrator,
  });
  if (fresh.kind !== "ready") throw Error("Fresh deliberate scope required");
  const added = await attendancePermit(
    pool,
    options,
    f.token,
    randomUUID(),
    fresh.value,
  );
  expect(added.kind).toBe("ready");
  if (added.kind !== "ready") throw Error("Distinct new permission required");
  expect(added.value.permission.id).not.toBe(saved.value.permission.id);
});
it("ATTEND-07 exports every retained permission over bounded live pages with owner-bound continuation and erasure", async () => {
  const f = await fixture(),
    options = { mode: "test" as const, enabled: true, registration: true },
    ids: string[] = [];
  for (let index = 0; index < 105; index++) {
    const checked = await attendancePermissionCheck(pool, options, f.token, {
      registrationId: f.registration,
      administratorId: f.administrator,
    });
    if (checked.kind !== "ready")
      throw Error("Current deliberately checked exact scope required");
    const saved = await attendancePermit(
      pool,
      options,
      f.token,
      randomUUID(),
      checked.value,
    );
    if (saved.kind !== "ready") throw Error("Actual saved permission required");
    ids.push(saved.value.permission.id);
    expect(
      (
        await attendanceWithdraw(
          pool,
          options,
          f.token,
          randomUUID(),
          saved.value.permission.id,
        )
      ).kind,
    ).toBe("ready");
  }
  const exports = memberExportStore(pool),
    seen: string[] = [];
  let cursor: string | undefined,
    firstCursor: string | undefined,
    pages = 0;
  do {
    const result = await exports.exportOwned(f.token, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Owned bounded export required");
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    expect(
      Buffer.byteLength(JSON.stringify(result.payload)),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.stringify(result.payload)).not.toContain(f.administrator);
    expect(JSON.stringify(result.payload)).not.toContain(f.admin);
    const facts = result.payload.records.eventAttendancePermissions as {
      permissionId: string;
      withdrawnAt: Date;
      registrationId: string;
    }[];
    for (const fact of facts) {
      expect(fact.registrationId).toBe(f.registration);
      expect(fact.withdrawnAt).toBeInstanceOf(Date);
      seen.push(fact.permissionId);
    }
    cursor = result.payload.page.nextCursor ?? undefined;
    firstCursor ??= cursor;
    pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(seen.sort()).toEqual(ids.sort());
  expect(new Set(seen).size).toBe(105);
  if (!firstCursor) throw Error("Actual continued export required");
  const foreign = randomBytes(32).toString("hex");
  await store(pool).create(foreign, {
    background: "explorer",
    goal: "everyday",
  });
  expect((await exports.exportOwned(foreign, firstCursor)).kind).toBe("denied");
  expect(
    (await exports.exportOwned(f.token, firstCursor + "forged")).kind,
  ).toBe("denied");
  await store(pool).remove(f.member);
  expect((await exports.exportOwned(f.token, firstCursor)).kind).toBe("denied");
  expect(
    (
      await pool.query(
        "SELECT id FROM private_event_attendance_permissions WHERE member_id=$1",
        [f.member],
      )
    ).rows,
  ).toHaveLength(0);
});

it.each(["same-key", "different-key"] as const)(
  "ATTEND-01/05 simultaneous %s confirmations preserve one exact immutable permission",
  async (kind) => {
    const f = await fixture(),
      options = { mode: "test" as const, enabled: true, registration: true };
    const checked = await attendancePermissionCheck(pool, options, f.token, {
      registrationId: f.registration,
      administratorId: f.administrator,
    });
    if (checked.kind !== "ready") throw Error("Actual owning preview required");
    const first = randomUUID(),
      keys = [first, kind === "same-key" ? first : randomUUID()];
    const results = await Promise.all(
      keys.map((key) =>
        attendancePermit(pool, options, f.token, key, checked.value),
      ),
    );
    expect(results.map((result) => result.kind).sort()).toEqual(
      kind === "same-key" ? ["ready", "ready"] : ["conflict", "ready"],
    );
    expect(
      (
        await pool.query(
          "SELECT id FROM private_event_attendance_permissions WHERE registration_id=$1",
          [f.registration],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT operation_id FROM private_event_attendance_operations WHERE registration_id=$1 AND kind='permit'",
          [f.registration],
        )
      ).rows,
    ).toHaveLength(1);
    if (kind === "same-key")
      expect(results[0]).toMatchObject({
        kind: "ready",
        value: results[1]!.kind === "ready" ? results[1]!.value : undefined,
      });
  },
);
