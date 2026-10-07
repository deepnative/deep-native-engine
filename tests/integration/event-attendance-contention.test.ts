import type { Pool, PoolClient } from "pg";
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
import { attendancePermit } from "../../src/event-attendance-permissions.ts";
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
  for (let index = 0; index < 10; index++) {
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
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function blocked(waiter: number, blocker: number) {
  for (let index = 0; index < 200; index++) {
    const row = (
      await pool.query(
        "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
        [blocker, waiter],
      )
    ).rows[0];
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Required actual PostgreSQL attendance waiter was not observed");
}
let used = 0;
it.each(
  (["permission-withdrawal", "owner-erasure"] as const).flatMap((change) =>
    (["privacy-first", "observation-first"] as const).map((order) => ({
      change,
      order,
    })),
  ),
)(
  "ATTEND-04/05 $change respects $order with observed PostgreSQL waiter",
  async ({ change, order }) => {
    const f = cases[used++]!,
      preview = await attendanceObservationCheck(
        pool,
        options,
        administrator,
        f.permissionId,
      );
    if (preview.kind !== "ready")
      throw Error("Current genuine observation window required");
    const connected = latch(),
      reached = latch(),
      resume = latch();
    let pid = 0,
      paused = false;
    const controlled = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        connected.release();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (
              order === "observation-first" &&
              !paused &&
              sql.includes("FROM private_event_attendance_permissions") &&
              sql.includes("FOR UPDATE")
            ) {
              paused = true;
              reached.release();
              await resume.wait;
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const authority = await pool.connect();
    let pending: ReturnType<typeof attendanceObserve> | undefined,
      changing: Promise<unknown> | undefined;
    const mutation =
      change === "owner-erasure"
        ? "DELETE FROM principals WHERE id=$1 AND kind='member'"
        : "UPDATE private_event_attendance_permissions SET withdrawn_at=clock_timestamp() WHERE id=$1";
    const reference = change === "owner-erasure" ? f.memberId : f.permissionId;
    try {
      await authority.query("BEGIN");
      const authorityPid = (
        await authority.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      // Exact privacy SQL remains open solely to observe both serialization orders.
      // These transactions are contention evidence, not browser erasure demonstrations.
      if (order === "privacy-first")
        await authority.query(mutation, [reference]);
      pending = attendanceObserve(
        controlled,
        options,
        administrator,
        randomUUID(),
        preview.value,
      );
      await connected.wait;
      if (order === "privacy-first") {
        await blocked(pid, authorityPid);
        await authority.query("COMMIT");
        expect(await pending).toEqual({ kind: "denied" });
      } else {
        await reached.wait;
        changing = authority.query(mutation, [reference]);
        await blocked(authorityPid, pid);
        resume.release();
        expect((await pending).kind).toBe("ready");
        await changing;
        await authority.query("COMMIT");
      }
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
      const facts = (
        await pool.query(
          "SELECT id FROM private_event_attendance_observations WHERE registration_id=$1",
          [f.registrationId],
        )
      ).rows;
      expect(facts).toHaveLength(
        change === "permission-withdrawal" && order === "observation-first"
          ? 1
          : 0,
      );
      if (change === "owner-erasure") {
        const keys = (
          await pool.query(
            "SELECT actor_id,workspace_id,registration_id,instruction_hash FROM private_event_attendance_operations WHERE registration_id=$1 OR workspace_id=$2",
            [f.registrationId, f.memberId],
          )
        ).rows;
        expect(keys).toHaveLength(0);
      }
    } finally {
      resume.release();
      await pending;
      await changing;
      await authority.query("ROLLBACK");
      authority.release();
    }
  },
);
it.each(["query-reply", "commit-reply", "native-handback"] as const)(
  "ATTEND-05 current member expiry fences %s without extending saved permission",
  async (boundary) => {
    const f = cases[used++]!,
      preview = await attendanceObservationCheck(
        pool,
        options,
        administrator,
        f.permissionId,
      );
    if (preview.kind !== "ready")
      throw Error("Current observation scope required");
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE id=$1",
      [f.memberId],
    );
    let delayed = false;
    const controlled = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (
              !delayed &&
              ((boundary === "query-reply" &&
                sql.includes("FROM private_event_attendance_permissions") &&
                sql.includes("FOR UPDATE")) ||
                (boundary === "commit-reply" && sql === "COMMIT"))
            ) {
              delayed = true;
              await client.query("SELECT pg_sleep(1.5)");
            }
            return result;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            if (boundary === "native-handback" && !delayed) {
              delayed = true;
              // A real synchronous native handback delay exercises the unchanged monotonic fence.
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                1500,
              );
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const result = await attendanceObserve(
      controlled,
      options,
      administrator,
      randomUUID(),
      preview.value,
    );
    expect(result.kind).toBe(
      boundary === "query-reply" ? "denied" : "unavailable",
    );
    expect(delayed).toBe(true);
    // Wait for the original delayed query rather than restarting it after timeout.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [f.memberId],
    );
    const view = await attendanceMemberView(
      pool,
      options,
      f.token,
      f.registrationId,
    );
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") throw Error("Owning expiry readback required");
    expect(view.value.permission?.expiresAt.toISOString()).toBe(f.expiresAt);
    expect(Boolean(view.value.observation)).toBe(boundary !== "query-reply");
  },
);
it("ATTEND-06 successful observation COMMIT lost reply recovers the exact original fact without a second dispatch", async () => {
  const f = cases[used++]!,
    preview = await attendanceObservationCheck(
      pool,
      options,
      administrator,
      f.permissionId,
    );
  if (preview.kind !== "ready")
    throw Error("Current observation scope required");
  const key = randomUUID();
  let commits = 0;
  const controlled = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql === "COMMIT") {
            commits++;
            throw Error(
              "Invented lost acknowledgement after successful observation COMMIT",
            );
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(
    await attendanceObserve(
      controlled,
      options,
      administrator,
      key,
      preview.value,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(commits).toBe(1);
  const { attendanceInspect } =
    await import("../../src/event-attendance-inspection.ts");
  const result = await attendanceInspect(
    pool,
    { ...options, enabled: false },
    administrator,
    key,
    "observe",
    preview.value,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready" || result.value?.kind !== "observe")
    throw Error("Read-only original observation receipt required");
  const count = (
    await pool.query(
      "SELECT id,recorded_at FROM private_event_attendance_observations WHERE registration_id=$1",
      [f.registrationId],
    )
  ).rows;
  expect(count).toHaveLength(1);
  expect(result.value.observation.id).toBe(count[0].id);
  expect(result.value.observation.recordedAt).toEqual(count[0].recorded_at);
});
it("ATTEND-06 successful exact removal COMMIT lost reply is structural read-only recovery, never restored content", async () => {
  const f = cases[used++]!,
    preview = await attendanceObservationCheck(
      pool,
      options,
      administrator,
      f.permissionId,
    );
  if (preview.kind !== "ready") throw Error("Current scope required");
  const saved = await attendanceObserve(
    pool,
    options,
    administrator,
    randomUUID(),
    preview.value,
  );
  if (saved.kind !== "ready") throw Error("Saved fact required");
  const checked = await attendanceRemovalCheck(
    pool,
    options,
    f.token,
    saved.value.observation.id,
  );
  if (checked.kind !== "ready") throw Error("Exact owning removal required");
  const key = randomUUID();
  let commits = 0;
  const controlled = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql === "COMMIT") {
            commits++;
            throw Error(
              "Invented lost acknowledgement after successful removal COMMIT",
            );
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(
    await attendanceRemove(controlled, options, f.token, key, checked.value),
  ).toEqual({ kind: "unavailable" });
  expect(commits).toBe(1);
  const { attendanceInspect } =
    await import("../../src/event-attendance-inspection.ts");
  const recovery = await attendanceInspect(
    pool,
    { ...options, enabled: false },
    f.token,
    key,
    "remove",
    checked.value,
  );
  expect(recovery).toMatchObject({
    kind: "ready",
    value: { kind: "remove", registrationId: f.registrationId },
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM private_event_attendance_observations WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await pool.query(
        "SELECT id FROM private_event_attendance_permissions WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (await attendanceMemberView(pool, options, f.token, f.registrationId)).kind,
  ).toBe("ready");
});

it("ATTEND-02/05 simultaneous independently keyed observations produce one immutable canonical fact", async () => {
  const f = cases[used++]!,
    checked = await attendanceObservationCheck(
      pool,
      options,
      administrator,
      f.permissionId,
    );
  if (checked.kind !== "ready") throw Error("Genuine current preview required");
  const keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    keys.map((key) =>
      attendanceObserve(pool, options, administrator, key, checked.value),
    ),
  );
  expect(results.map((result) => result.kind).sort()).toEqual([
    "conflict",
    "ready",
  ]);
  expect(
    (
      await pool.query(
        "SELECT id FROM private_event_attendance_observations WHERE registration_id=$1",
        [f.registrationId],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT operation_id FROM private_event_attendance_operations WHERE registration_id=$1 AND kind='observe'",
        [f.registrationId],
      )
    ).rows,
  ).toHaveLength(1);
});
