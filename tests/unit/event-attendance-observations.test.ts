import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import { EventCancellationFailure } from "../../src/event-cancellation-lifetime.ts";
import type {
  AttendanceContext,
  AttendanceSource,
} from "../../src/event-attendance-transaction.ts";
import {
  attendanceProtectedPermission,
  attendanceObservationCheck,
  attendanceStaffPermission,
  attendanceObserve,
} from "../../src/event-attendance-observations.ts";
const member = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  admin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = new Date("2026-10-07T18:00:00.000Z"),
  expiry = new Date(+now + 3600000);
const checked = {
  permissionId: id,
  registrationId: member,
  eventId: "invented-rehearsal",
  eventVersion: 1,
  startsAt: now.toISOString(),
  expiresAt: expiry.toISOString(),
};
const observation = {
  id: admin,
  permissionId: id,
  registrationId: member,
  recordedAt: now,
};
const originalOperation = {
  actorId: admin,
  registrationId: member,
  kind: "observe",
  instructionHash: hash(JSON.stringify(checked)),
  observationId: admin,
};
let context: AttendanceContext, source: AttendanceSource;
let state: {
  locator: object | undefined;
  permission:
    | {
        id: string;
        registrationId: string;
        administratorId: string;
        startsAt: Date;
        expiresAt: Date;
        createdAt: Date;
        withdrawnAt: Date | null;
      }
    | undefined;
  observation: typeof observation | undefined;
  inserted: typeof observation | undefined;
  operation: Record<string, unknown> | undefined;
};
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  source: vi.fn(),
}));
vi.mock(
  "../../src/event-attendance-transaction.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/event-attendance-transaction.ts")
    >()),
    attendanceExecute: mocks.execute,
    attendanceActors: mocks.actors,
    attendanceSource: mocks.source,
  }),
);
const pool = {} as Pool,
  options = { mode: "test" as const, enabled: true, registration: true };
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    locator: {
      registrationId: member,
      memberId: member,
      administratorId: admin,
    },
    permission: {
      id,
      registrationId: member,
      administratorId: admin,
      startsAt: now,
      expiresAt: expiry,
      createdAt: now,
      withdrawnAt: null,
    },
    observation: undefined,
    inserted: observation,
    operation: undefined,
  };
  const query = vi.fn(async (sql: string) => {
    const row = sql.includes(
      'SELECT registration_id AS "registrationId",member_id',
    )
      ? state.locator
      : sql.includes("FROM private_event_attendance_permissions")
        ? state.permission
        : sql.includes("FROM private_event_attendance_observations")
          ? state.observation
          : sql.includes("FROM private_event_attendance_operations")
            ? state.operation
            : sql.includes("INSERT INTO private_event_attendance_observations")
              ? state.inserted
              : undefined;
    return { rows: row ? [row] : [] };
  });
  context = {
    actorId: admin,
    credentialHash: "invented",
    expires: [expiry],
    enteredAt: now,
    tx: { query, observe: vi.fn(async () => now) },
  } as unknown as AttendanceContext;
  source = {
    registrationId: member,
    memberId: member,
    workspaceId: member,
    eventId: checked.eventId,
    eventVersion: 1,
    title: "Invented rehearsal",
    startsAt: now,
    endsAt: expiry,
    withdrawnAt: null,
    cancelledAt: null,
  };
  mocks.actors.mockResolvedValue({
    principals: new Map([
      [member, { id: member, kind: "member", expires: expiry, revoked: null }],
    ]),
  });
  mocks.source.mockImplementation(async () => source);
  mocks.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return {
        kind: "ready",
        value: await use(context),
        observedAt: now,
        deadline: performance.now() + 60000,
      };
    } catch (error) {
      if (error instanceof EventCancellationFailure)
        return { kind: error.kind };
      throw error;
    }
  });
});
it("ATTEND-02/05 selected permission rechecks member, source and protected window before returning exact scope", async () => {
  const result = await attendanceProtectedPermission(context, id);
  expect(result.permission).toMatchObject({
    id,
    registrationId: member,
    title: source.title,
  });
  expect(mocks.actors).toHaveBeenCalledWith(
    context,
    [member],
    "platform_admin",
  );
  expect(mocks.source).toHaveBeenCalledWith(context, member, member);
  expect(context.expires).toEqual([expiry, expiry, expiry, expiry]);
  expect(context.tx.observe).toHaveBeenCalledTimes(2);
});
it.each([
  "missing-locator",
  "foreign-admin",
  "missing-member",
  "staff-member",
  "revoked-member",
  "missing-permission",
  "changed-admin",
  "withdrawn-permission",
  "withdrawn-registration",
  "cancelled-event",
  "permission-not-started",
  "event-not-started",
])(
  "ATTEND-02/04 private permission boundary %s denies without observation",
  async (condition) => {
    if (condition === "missing-locator") state.locator = undefined;
    if (condition === "foreign-admin")
      state.locator = {
        registrationId: member,
        memberId: member,
        administratorId: member,
      };
    if (condition === "missing-member")
      mocks.actors.mockResolvedValue({ principals: new Map() });
    if (condition === "staff-member" || condition === "revoked-member")
      mocks.actors.mockResolvedValue({
        principals: new Map([
          [
            member,
            {
              id: member,
              kind: condition === "staff-member" ? "staff" : "member",
              expires: expiry,
              revoked: condition === "revoked-member" ? now : null,
            },
          ],
        ]),
      });
    if (condition === "missing-permission") state.permission = undefined;
    if (condition === "changed-admin")
      state.permission!.administratorId = member;
    if (condition === "withdrawn-permission")
      state.permission!.withdrawnAt = now;
    if (condition === "withdrawn-registration") source.withdrawnAt = now;
    if (condition === "cancelled-event") source.cancelledAt = now;
    if (condition === "permission-not-started")
      state.permission!.startsAt = new Date(+now + 1);
    if (condition === "event-not-started") source.startsAt = new Date(+now + 1);
    await expect(
      attendanceProtectedPermission(context, id),
    ).rejects.toMatchObject({ kind: "denied" });
    expect(
      vi
        .mocked(context.tx.query)
        .mock.calls.some(([sql]) => sql.includes("INSERT")),
    ).toBe(false);
  },
);
it("ATTEND-02 check returns canonical permission window and paused creation retains finite staff inspection", async () => {
  expect(
    await attendanceObservationCheck(pool, options, "credential", id),
  ).toMatchObject({ kind: "ready", value: checked });
  expect(
    await attendanceStaffPermission(
      pool,
      { ...options, enabled: false },
      "credential",
      id,
    ),
  ).toMatchObject({
    kind: "ready",
    value: { id, startsAt: now, expiresAt: expiry },
  });
});
it("ATTEND-08 invalid and unavailable creation paths acquire no attendance context", async () => {
  expect(
    await attendanceObservationCheck(pool, options, "credential", "bad"),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceObservationCheck(
      pool,
      { ...options, enabled: false },
      "credential",
      id,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await attendanceStaffPermission(
      pool,
      { ...options, mode: "live" },
      "credential",
      id,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await attendanceStaffPermission(pool, options, "credential", "bad"),
  ).toEqual({ kind: "denied" });
  expect(await attendanceObserve(pool, options, "credential", id, {})).toEqual({
    kind: "invalid",
  });
  expect(
    await attendanceObserve(pool, options, "credential", "bad", checked),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceObserve(
      pool,
      { ...options, registration: false },
      "credential",
      id,
      checked,
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("ATTEND-02 deliberate observation stores a database-timed fact and one reserved operation without changing consent", async () => {
  const result = await attendanceObserve(
    pool,
    options,
    "credential",
    id,
    checked,
  );
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      kind: "observe",
      observation: {
        ...observation,
        attribution: "Local platform administrator",
      },
    },
  });
  const writes = vi
    .mocked(context.tx.query)
    .mock.calls.filter(([sql]) => sql.includes("INSERT"));
  expect(writes).toHaveLength(2);
  expect(writes[0]![1]).toContain(member);
  expect(writes[1]![1]).toContain(hash(JSON.stringify(checked)));
  expect(
    vi
      .mocked(context.tx.query)
      .mock.calls.some(([sql]) => /^\s*(UPDATE|DELETE)\b/.test(sql)),
  ).toBe(false);
});
it("ATTEND-06 original observation repeats canonically without a second fact or changed timestamp", async () => {
  state.observation = observation;
  state.operation = originalOperation;
  expect(
    await attendanceObserve(pool, options, "credential", id, checked),
  ).toMatchObject({
    kind: "ready",
    value: {
      observation: {
        ...observation,
        attribution: "Local platform administrator",
      },
    },
  });
  expect(
    vi
      .mocked(context.tx.query)
      .mock.calls.some(([sql]) => sql.includes("INSERT")),
  ).toBe(false);
});
it.each([
  "actorId",
  "registrationId",
  "kind",
  "instructionHash",
  "observationId",
  "missing-fact",
  "different-permission",
])(
  "ATTEND-06 reserved observation mismatch %s cannot disclose or replace a fact",
  async (condition) => {
    state.observation = observation;
    state.operation = { ...originalOperation };
    if (condition === "missing-fact") state.observation = undefined;
    else if (condition === "different-permission")
      state.observation = { ...observation, permissionId: member };
    else state.operation[condition] = "different";
    expect(
      await attendanceObserve(pool, options, "credential", id, checked),
    ).toEqual({ kind: "conflict" });
    expect(
      vi
        .mocked(context.tx.query)
        .mock.calls.some(([sql]) => sql.includes("INSERT")),
    ).toBe(false);
  },
);
it("ATTEND-02/06 altered checked window or new key for an existing observation cannot overwrite the original", async () => {
  expect(
    await attendanceObserve(pool, options, "credential", id, {
      ...checked,
      eventVersion: 2,
    }),
  ).toEqual({ kind: "conflict" });
  state.observation = observation;
  expect(
    await attendanceObserve(pool, options, "credential", id, checked),
  ).toEqual({ kind: "conflict" });
  expect(
    vi
      .mocked(context.tx.query)
      .mock.calls.some(([sql]) => sql.includes("INSERT")),
  ).toBe(false);
});

it("ATTEND-02 missing insertion receipt fails without reserving a successful operation", async () => {
  state.inserted = undefined;
  expect(
    await attendanceObserve(pool, options, "credential", id, checked),
  ).toEqual({ kind: "unavailable" });
  expect(
    vi
      .mocked(context.tx.query)
      .mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO private_event_attendance_operations"),
      ),
  ).toHaveLength(0);
});
