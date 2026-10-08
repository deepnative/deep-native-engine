import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import { EventCancellationFailure } from "../../src/event-cancellation-lifetime.ts";
import type {
  AttendanceContext,
  AttendanceSource,
} from "../../src/event-attendance-transaction.ts";
import {
  attendancePermit,
  attendanceWithdraw,
  attendanceOwnedPermission,
} from "../../src/event-attendance-permissions.ts";
const member = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  admin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = new Date("2026-10-07T18:00:00.000Z"),
  expiry = new Date(+now + 3600000);
const checked = {
  registrationId: member,
  administratorId: admin,
  eventId: "invented-rehearsal",
  eventVersion: 1,
  title: "Invented rehearsal",
  eventStartsAt: now.toISOString(),
  eventEndsAt: expiry.toISOString(),
  startsAt: now.toISOString(),
  expiresAt: expiry.toISOString(),
};
const original = {
  actorId: member,
  workspaceId: member,
  registrationId: member,
  kind: "permit",
  instructionHash: hash(JSON.stringify(checked)),
  permissionId: id,
};
let context: AttendanceContext, source: AttendanceSource;
let state: {
  locator: object | undefined;
  operation: Record<string, unknown> | undefined;
  originalLocator: object | undefined;
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
  active: object[];
  observations: object[];
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
    locator: { registrationId: member },
    operation: undefined,
    originalLocator: undefined,
    permission: {
      id,
      registrationId: member,
      administratorId: admin,
      startsAt: now,
      expiresAt: expiry,
      createdAt: now,
      withdrawnAt: null,
    },
    active: [],
    observations: [],
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("withdrawn_at IS NULL FOR UPDATE"))
      return { rows: state.active };
    if (sql.includes("FROM private_event_attendance_observations"))
      return { rows: state.observations };
    if (sql.startsWith("INSERT INTO private_event_attendance_permissions")) {
      state.permission!.id = String(values![0]);
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE private_event_attendance_permissions")) {
      state.permission!.withdrawnAt = now;
      return { rows: [] };
    }
    const row = sql.includes('SELECT registration_id AS "registrationId"')
      ? state.locator
      : sql.includes('SELECT permission_id AS "permissionId"')
        ? state.originalLocator
        : sql.includes("FROM private_event_attendance_operations")
          ? state.operation
          : sql.includes("FROM private_event_attendance_permissions")
            ? state.permission
            : undefined;
    return { rows: row ? [row] : [] };
  });
  context = {
    actorId: member,
    credentialHash: "invented",
    enteredAt: now,
    expires: [expiry],
    tx: { query, observe: vi.fn(async () => now) },
  } as unknown as AttendanceContext;
  source = {
    registrationId: member,
    memberId: member,
    workspaceId: member,
    eventId: checked.eventId,
    eventVersion: 1,
    title: checked.title,
    startsAt: now,
    endsAt: expiry,
    withdrawnAt: null,
    cancelledAt: null,
  };
  mocks.actors.mockResolvedValue({
    principals: new Map([
      [admin, { id: admin, kind: "staff", expires: expiry, revoked: null }],
    ]),
    profiles: new Map([[admin, "platform_admin"]]),
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
const writes = () =>
  vi
    .mocked(context.tx.query)
    .mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql));
it("ATTEND-01 deliberate checked permission creates one finite selected grant and reserves its original key", async () => {
  const result = await attendancePermit(
    pool,
    options,
    "credential",
    id,
    checked,
  );
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      kind: "permit",
      permission: {
        registrationId: member,
        administratorId: admin,
        startsAt: now,
        expiresAt: expiry,
      },
    },
  });
  expect(writes()).toHaveLength(2);
  expect(writes()[0]![1]?.slice(1)).toEqual([
    member,
    member,
    member,
    admin,
    checked.startsAt,
    checked.expiresAt,
  ]);
  expect(writes()[1]![1]).toEqual([
    id,
    member,
    member,
    member,
    "permit",
    hash(JSON.stringify(checked)),
    state.permission!.id,
  ]);
});
it("ATTEND-06 retained withdrawn original receipt repeats without new grant even after selected staff erasure", async () => {
  state.originalLocator = { permissionId: id };
  state.operation = original;
  state.permission!.withdrawnAt = now;
  mocks.actors.mockResolvedValue({
    principals: new Map(),
    profiles: new Map(),
  });
  expect(
    await attendancePermit(pool, options, "credential", id, checked),
  ).toMatchObject({
    kind: "ready",
    value: { permission: { id, withdrawnAt: now } },
  });
  expect(writes()).toHaveLength(0);
  const calls = vi.mocked(context.tx.query).mock.calls;
  expect(
    calls.findIndex(([sql]) => sql.includes("WHERE id=$1 AND registration_id")),
  ).toBeLessThan(
    calls.findIndex(([sql]) => sql.includes("pg_advisory_xact_lock")),
  );
});
it.each([
  "actorId",
  "workspaceId",
  "registrationId",
  "kind",
  "instructionHash",
  "permissionId",
])(
  "ATTEND-06 reserved original permission mismatch %s conflicts without replacement",
  async (field) => {
    state.operation = {
      ...original,
      [field]: field === "permissionId" ? null : "different",
    };
    expect(
      await attendancePermit(pool, options, "credential", id, checked),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it.each(["missing", "member", "revoked", "wrong-role"])(
  "ATTEND-01 selected administrator %s cannot receive a new permission",
  async (condition) => {
    mocks.actors.mockResolvedValue({
      principals:
        condition === "missing"
          ? new Map()
          : new Map([
              [
                admin,
                {
                  id: admin,
                  kind: condition === "member" ? "member" : "staff",
                  expires: expiry,
                  revoked: condition === "revoked" ? now : null,
                },
              ],
            ]),
      profiles: new Map([
        [admin, condition === "wrong-role" ? "moderator" : "platform_admin"],
      ]),
    });
    expect(
      await attendancePermit(pool, options, "credential", id, checked),
    ).toEqual({ kind: "denied" });
    expect(writes()).toHaveLength(0);
  },
);
it.each([
  "withdrawn",
  "cancelled",
  "event",
  "version",
  "title",
  "start",
  "end",
  "request-bound",
  "actor-bound",
  "elapsed",
])(
  "ATTEND-01/05 changed source or finite bound %s denies a new grant",
  async (condition) => {
    if (condition === "withdrawn") source.withdrawnAt = now;
    if (condition === "cancelled") source.cancelledAt = now;
    if (condition === "event") source.eventId = "other-event";
    if (condition === "version") source.eventVersion = 2;
    if (condition === "title") source.title = "Different title";
    if (condition === "start") source.startsAt = new Date(+now - 1);
    if (condition === "end") source.endsAt = new Date(+expiry + 1);
    if (condition === "request-bound") context.enteredAt = new Date(+now - 1);
    if (condition === "actor-bound") context.expires = [new Date(+expiry - 1)];
    if (condition === "elapsed")
      vi.mocked(context.tx.observe).mockResolvedValue(expiry);
    expect(
      await attendancePermit(pool, options, "credential", id, checked),
    ).toEqual({ kind: "denied" });
    expect(writes()).toHaveLength(0);
  },
);
it.each(["active", "observation"])(
  "ATTEND-01 new key cannot replace an existing %s",
  async (existing) => {
    if (existing === "active") state.active = [{ id }];
    else state.observations = [{ id }];
    expect(
      await attendancePermit(pool, options, "credential", id, checked),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it("ATTEND-04 owning withdrawal works while creation is paused and retains its original receipt", async () => {
  const paused = { ...options, enabled: false, registration: false };
  expect(
    await attendanceWithdraw(pool, paused, "credential", id, id),
  ).toMatchObject({
    kind: "ready",
    value: { kind: "withdraw", permission: { id, withdrawnAt: now } },
  });
  expect(writes()).toHaveLength(2);
  state.operation = {
    ...original,
    kind: "withdraw",
    instructionHash: hash(JSON.stringify({ permissionId: id })),
  };
  const count = writes().length;
  expect(
    await attendanceWithdraw(pool, paused, "credential", id, id),
  ).toMatchObject({
    kind: "ready",
    value: { permission: { withdrawnAt: now } },
  });
  expect(writes()).toHaveLength(count);
});
it("ATTEND-04 foreign or removed permission cannot be withdrawn or read as another owned source", async () => {
  state.locator = undefined;
  expect(await attendanceWithdraw(pool, options, "credential", id, id)).toEqual(
    { kind: "denied" },
  );
  state.permission = undefined;
  await expect(
    attendanceOwnedPermission(context, source, id),
  ).rejects.toMatchObject({ kind: "denied" });
  expect(writes()).toHaveLength(0);
});
it("ATTEND-08 invalid instructions and live/paused creation acquire no transaction", async () => {
  expect(
    await attendancePermit(pool, options, "credential", "bad", checked),
  ).toEqual({ kind: "invalid" });
  expect(await attendancePermit(pool, options, "credential", id, {})).toEqual({
    kind: "invalid",
  });
  expect(
    await attendancePermit(
      pool,
      { ...options, enabled: false },
      "credential",
      id,
      checked,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await attendanceWithdraw(pool, options, "credential", "bad", id),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceWithdraw(pool, options, "credential", id, "bad"),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceWithdraw(
      pool,
      { ...options, mode: "live" },
      "credential",
      id,
      id,
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
