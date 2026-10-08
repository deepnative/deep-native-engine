import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type {
  AttendanceContext,
  AttendanceSource,
} from "../../src/event-attendance-transaction.ts";
import {
  attendanceAdministratorReference,
  attendanceCreation,
  attendanceLocal,
  attendanceMemberView,
  attendancePermissionCheck,
  attendanceReadOwned,
} from "../../src/event-attendance-reader.ts";
const member = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  admin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  registration = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = new Date("2026-10-07T18:00:00.000Z"),
  expiry = new Date(+now + 3600000);
let context: AttendanceContext, source: AttendanceSource;
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  source: vi.fn(),
}));
vi.mock("../../src/event-attendance-transaction.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/event-attendance-transaction.ts")
    >();
  return {
    ...actual,
    attendanceExecute: mocks.execute,
    attendanceActors: mocks.actors,
    attendanceSource: mocks.source,
  };
});
const pool = {} as Pool,
  options = { mode: "test" as const, enabled: true, registration: true };
const scope = { registrationId: registration, administratorId: admin };
const permission = {
  id: admin,
  registrationId: registration,
  administratorId: admin,
  startsAt: now,
  expiresAt: expiry,
  createdAt: now,
  withdrawnAt: null,
};
const observation = {
  id: member,
  permissionId: admin,
  registrationId: registration,
  recordedAt: now,
};
beforeEach(() => {
  vi.clearAllMocks();
  context = {
    actorId: member,
    credentialHash: "invented",
    enteredAt: now,
    expires: [expiry],
    tx: { query: vi.fn(), observe: vi.fn(async () => now) },
  } as unknown as AttendanceContext;
  source = {
    registrationId: registration,
    memberId: member,
    workspaceId: member,
    eventId: "invented-rehearsal",
    eventVersion: 1,
    title: "Invented rehearsal",
    startsAt: now,
    endsAt: expiry,
    withdrawnAt: null,
    cancelledAt: null,
  };
  mocks.source.mockImplementation(async () => source);
  mocks.actors.mockResolvedValue({
    principals: new Map([
      [admin, { id: admin, kind: "staff", expires: expiry, revoked: null }],
    ]),
    profiles: new Map([[admin, "platform_admin"]]),
  });
  mocks.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return {
        kind: "ready",
        value: await use(context),
        observedAt: now,
        deadline: performance.now() + 60000,
      };
    } catch (error) {
      if (error && typeof error === "object" && "kind" in error)
        return { kind: error.kind };
      throw error;
    }
  });
});
it.each(["test", "demo", "live"] as const)(
  "ATTEND-08 attendance creation requires local mode %s and both explicit switches",
  (mode) => {
    expect(attendanceLocal({ ...options, mode })).toBe(mode !== "live");
    expect(attendanceCreation({ ...options, mode })).toBe(mode !== "live");
    expect(attendanceCreation({ ...options, mode, enabled: false })).toBe(
      false,
    );
    expect(attendanceCreation({ ...options, mode, registration: false })).toBe(
      false,
    );
  },
);
it("ATTEND-03 own receipt uses current actor and exact registration and never fabricates missing attendance", async () => {
  vi.mocked(context.tx.query).mockResolvedValue({ rows: [] } as never);
  const result = await attendanceMemberView(
    pool,
    options,
    "member-credential",
    registration,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Owning unit result required");
  expect(result.value).toMatchObject({
    registrationId: registration,
    permission: null,
    observation: null,
    creationEnabled: true,
  });
  expect(mocks.actors).toHaveBeenCalledWith(context, [], "member");
  expect(mocks.source).toHaveBeenCalledWith(context, registration, member);
});
it.each([{ ...options, mode: "live" as const }, options])(
  "ATTEND-03 invalid or live member scope denied before reading %j",
  async (settings) => {
    expect(
      (
        await attendanceMemberView(
          pool,
          settings,
          "member",
          settings.mode === "live" ? registration : "guessed",
        )
      ).kind,
    ).toBe("denied");
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("ATTEND-03/07 retained observation and permission have generic attribution and exact historical event context while paused", async () => {
  vi.mocked(context.tx.query)
    .mockResolvedValueOnce({ rows: [permission] } as never)
    .mockResolvedValueOnce({ rows: [observation] } as never);
  source.withdrawnAt = now;
  source.cancelledAt = now;
  const result = await attendanceReadOwned(context, source, {
    ...options,
    enabled: false,
  });
  expect(result).toMatchObject({
    registrationWithdrawnAt: now,
    cancelledAt: now,
    creationEnabled: false,
    permission: { ...permission, eventId: source.eventId, title: source.title },
    observation: {
      ...observation,
      attribution: "Local platform administrator",
    },
  });
  expect(context.tx.query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("LIMIT 1 FOR UPDATE"),
    [registration, member, member],
  );
});
it("ATTEND-02 administrator reference is its current noncredential identity while creation is paused", async () => {
  context.actorId = admin;
  expect(
    await attendanceAdministratorReference(
      pool,
      { ...options, enabled: false },
      "private-credential",
    ),
  ).toMatchObject({
    kind: "ready",
    value: { reference: admin, creationEnabled: false },
  });
  expect(mocks.actors).toHaveBeenCalledWith(context, [], "platform_admin");
});
it("ATTEND-08 live administrator reference is denied without principal discovery", async () => {
  expect(
    await attendanceAdministratorReference(
      pool,
      { ...options, mode: "live" },
      "credential",
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("ATTEND-01 finite preview chooses later actual/event start and earliest event/member/admin deadline without saving a permission", async () => {
  source.startsAt = new Date(+now - 60000);
  source.endsAt = new Date(+expiry + 1000);
  const adminExpiry = new Date(+now + 1200000);
  mocks.actors.mockResolvedValue({
    principals: new Map([
      [
        admin,
        { id: admin, kind: "staff", expires: adminExpiry, revoked: null },
      ],
    ]),
    profiles: new Map([[admin, "platform_admin"]]),
  });
  const result = await attendancePermissionCheck(
    pool,
    options,
    "member-credential",
    scope,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Finite unit check required");
  expect(result.value.startsAt).toBe(now.toISOString());
  expect(result.value.expiresAt).toBe(adminExpiry.toISOString());
  expect(result.value.eventStartsAt).toBe(source.startsAt.toISOString());
  expect(context.tx.query).not.toHaveBeenCalled();
  expect(mocks.actors).toHaveBeenCalledWith(context, [admin], "member");
});
it.each([
  "missing",
  "member",
  "revoked",
  "wrong-role",
  "withdrawn",
  "cancelled",
  "no-window",
])(
  "ATTEND-01 selected authority/source %s cannot yield a usable permission",
  async (condition) => {
    const actor = {
      id: admin,
      kind: condition === "member" ? "member" : "staff",
      expires: expiry,
      revoked: condition === "revoked" ? now : null,
    };
    mocks.actors.mockResolvedValue({
      principals:
        condition === "missing" ? new Map() : new Map([[admin, actor]]),
      profiles: new Map([
        [admin, condition === "wrong-role" ? "moderator" : "platform_admin"],
      ]),
    });
    if (condition === "withdrawn") source.withdrawnAt = now;
    if (condition === "cancelled") source.cancelledAt = now;
    if (condition === "no-window") source.startsAt = expiry;
    expect(
      await attendancePermissionCheck(pool, options, "member", scope),
    ).toEqual({ kind: "denied" });
    expect(context.tx.query).not.toHaveBeenCalled();
  },
);
it("ATTEND-01 invalid scope and paused creation cannot request a preview", async () => {
  expect(await attendancePermissionCheck(pool, options, "member", {})).toEqual({
    kind: "invalid",
  });
  expect(
    await attendancePermissionCheck(
      pool,
      { ...options, registration: false },
      "member",
      scope,
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
