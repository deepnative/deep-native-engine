import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import { EventCancellationFailure } from "../../src/event-cancellation-lifetime.ts";
import type {
  AttendanceContext,
  AttendanceSource,
} from "../../src/event-attendance-transaction.ts";
import type { AttendanceOperationKind } from "../../src/event-attendance-values.ts";
import { attendanceInspect } from "../../src/event-attendance-inspection.ts";
const member = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  admin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = new Date("2026-10-07T18:00:00.000Z"),
  expiry = new Date(+now + 3600000);
const permit = {
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
const observe = {
  permissionId: id,
  registrationId: member,
  eventId: permit.eventId,
  eventVersion: 1,
  startsAt: permit.startsAt,
  expiresAt: permit.expiresAt,
};
const remove = { registrationId: member, observationId: admin };
const permission = {
  id,
  registrationId: member,
  administratorId: admin,
  eventId: permit.eventId,
  eventVersion: 1,
  title: permit.title,
  startsAt: now,
  expiresAt: expiry,
  createdAt: now,
  withdrawnAt: null,
};
const observation = {
  id: admin,
  permissionId: id,
  registrationId: member,
  recordedAt: now,
};
let context: AttendanceContext, source: AttendanceSource;
let state: {
  discovered: Record<string, unknown> | undefined;
  saved: Record<string, unknown> | undefined;
  locator: object | undefined;
  observation: typeof observation | undefined;
};
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  source: vi.fn(),
  protected: vi.fn(),
  owned: vi.fn(),
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
vi.mock(
  "../../src/event-attendance-observations.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/event-attendance-observations.ts")
    >()),
    attendanceProtectedPermission: mocks.protected,
  }),
);
vi.mock(
  "../../src/event-attendance-permissions.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/event-attendance-permissions.ts")
    >()),
    attendanceOwnedPermission: mocks.owned,
  }),
);
const pool = {} as Pool,
  options = { mode: "test" as const, enabled: false, registration: false };
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    discovered: undefined,
    saved: undefined,
    locator: { registrationId: member },
    observation,
  };
  context = {
    actorId: member,
    credentialHash: "invented",
    enteredAt: now,
    expires: [expiry],
    tx: {
      observe: vi.fn(),
      query: vi.fn(async (sql: string) => {
        const row = sql.includes("FROM private_event_attendance_operations")
          ? sql.includes("FOR UPDATE")
            ? state.saved
            : state.discovered
          : sql.includes("FROM private_event_attendance_permissions")
            ? state.locator
            : sql.includes("FROM private_event_attendance_observations")
              ? state.observation
              : undefined;
        return { rows: row ? [row] : [] };
      }),
    },
  } as unknown as AttendanceContext;
  source = {
    registrationId: member,
    memberId: member,
    workspaceId: member,
    eventId: permit.eventId,
    eventVersion: 1,
    title: permit.title,
    startsAt: now,
    endsAt: expiry,
    withdrawnAt: null,
    cancelledAt: null,
  };
  mocks.source.mockImplementation(async () => source);
  mocks.protected.mockImplementation(async () => ({ source, permission }));
  mocks.owned.mockResolvedValue(permission);
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
function saved(kind: AttendanceOperationKind, input: object) {
  state.saved = {
    actorId: context.actorId,
    workspaceId: member,
    registrationId: member,
    kind,
    instructionHash: hash(JSON.stringify(input)),
    permissionId: kind === "remove" ? null : id,
    observationId: kind === "observe" ? admin : null,
  };
  state.discovered = { ...state.saved };
}
const writes = () =>
  vi
    .mocked(context.tx.query)
    .mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql));
it.each(["permit", "withdraw", "remove", "observe"] as const)(
  "ATTEND-06 original %s receipt is inspected without a new key, write or renewed grant",
  async (kind) => {
    if (kind === "observe") context.actorId = admin;
    const input =
      kind === "permit"
        ? permit
        : kind === "withdraw"
          ? { permissionId: id }
          : kind === "remove"
            ? remove
            : observe;
    saved(kind, input);
    const result = await attendanceInspect(
      pool,
      options,
      "credential",
      id,
      kind,
      input,
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready")
      throw Error("Canonical unit inspection required");
    expect(result.value?.kind).toBe(kind);
    expect(writes()).toHaveLength(0);
    expect(mocks.execute).toHaveBeenCalledWith(
      pool,
      "credential",
      false,
      expect.any(Function),
    );
    if (kind === "observe") {
      expect(result.value).toMatchObject({
        observation: {
          ...observation,
          attribution: "Local platform administrator",
        },
      });
      expect(mocks.protected).toHaveBeenCalledWith(context, id);
    } else if (kind === "remove")
      expect(result.value).toEqual({
        kind: "remove",
        registrationId: member,
        removed: true,
      });
    else
      expect(result.value).toMatchObject({
        permission: { id, expiresAt: expiry, createdAt: now },
      });
  },
);
it("ATTEND-06 missing original operation returns only absence after fresh owning authority and global-key inspection", async () => {
  expect(
    await attendanceInspect(pool, options, "credential", id, "permit", permit),
  ).toMatchObject({ kind: "ready", value: null });
  expect(mocks.actors).toHaveBeenCalledWith(context, [], "member");
  expect(mocks.source).toHaveBeenCalledWith(context, member, member);
  expect(context.tx.query).toHaveBeenCalledWith(
    expect.stringContaining("pg_advisory_xact_lock"),
    [id],
  );
  expect(writes()).toHaveLength(0);
});
it.each([
  "actorId",
  "workspaceId",
  "registrationId",
  "kind",
  "instructionHash",
])(
  "ATTEND-06 conflicting or foreign saved %s cannot disclose the original receipt",
  async (field) => {
    saved("permit", permit);
    state.saved![field] = "different";
    expect(
      await attendanceInspect(
        pool,
        options,
        "credential",
        id,
        "permit",
        permit,
      ),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it.each([
  "foreign-actor",
  "foreign-source",
  "removed-permission",
  "changed-permission",
])(
  "ATTEND-06 original owning permission link %s is not rebound",
  async (condition) => {
    saved("permit", permit);
    if (condition === "foreign-actor") state.discovered!.actorId = admin;
    if (condition === "foreign-source")
      state.discovered!.registrationId = admin;
    if (condition === "removed-permission")
      state.discovered!.permissionId = null;
    if (condition === "changed-permission")
      mocks.owned.mockResolvedValue({ ...permission, id: admin });
    expect(
      await attendanceInspect(
        pool,
        options,
        "credential",
        id,
        "permit",
        permit,
      ),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it("ATTEND-06 removed withdrawal source is located only from the same actor's same-kind original operation and never recreated", async () => {
  saved("withdraw", { permissionId: id });
  state.locator = undefined;
  expect(
    await attendanceInspect(pool, options, "credential", id, "withdraw", {
      permissionId: id,
    }),
  ).toMatchObject({ kind: "ready", value: { kind: "withdraw" } });
  expect(mocks.source).toHaveBeenCalledWith(context, member, member);
  expect(writes()).toHaveLength(0);
});
it.each(["missing", "foreign", "wrong-kind", "erased-source"])(
  "ATTEND-06 unavailable withdrawal discovery %s grants no source authority",
  async (condition) => {
    saved("withdraw", { permissionId: id });
    state.locator = undefined;
    if (condition === "missing") state.discovered = undefined;
    if (condition === "foreign") state.discovered!.actorId = admin;
    if (condition === "wrong-kind") state.discovered!.kind = "permit";
    if (condition === "erased-source") state.discovered!.registrationId = null;
    expect(
      await attendanceInspect(pool, options, "credential", id, "withdraw", {
        permissionId: id,
      }),
    ).toEqual({ kind: "denied" });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  },
);
it.each([
  "missing-fact",
  "changed-fact",
  "changed-operation-permission",
  "changed-fact-permission",
])(
  "ATTEND-06 original observation %s cannot reveal or replace another fact",
  async (condition) => {
    context.actorId = admin;
    saved("observe", observe);
    if (condition === "missing-fact") state.observation = undefined;
    if (condition === "changed-fact")
      state.observation = { ...observation, id: member };
    if (condition === "changed-operation-permission")
      state.saved!.permissionId = member;
    if (condition === "changed-fact-permission")
      state.observation = { ...observation, permissionId: member };
    expect(
      await attendanceInspect(
        pool,
        options,
        "credential",
        id,
        "observe",
        observe,
      ),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it("ATTEND-06 current selected observation scope is rechecked before original operation contents", async () => {
  context.actorId = admin;
  saved("observe", observe);
  source.registrationId = admin;
  expect(
    await attendanceInspect(
      pool,
      options,
      "credential",
      id,
      "observe",
      observe,
    ),
  ).toEqual({ kind: "denied" });
  mocks.protected.mockRejectedValueOnce(new EventCancellationFailure("denied"));
  expect(
    await attendanceInspect(
      pool,
      options,
      "credential",
      id,
      "observe",
      observe,
    ),
  ).toEqual({ kind: "denied" });
});
it.each([
  null,
  false,
  "bad",
  [],
  {},
  { wrong: id },
  { permissionId: "bad" },
  { permissionId: id, extra: true },
])(
  "ATTEND-06 malformed withdrawal instruction %j cannot start inspection",
  async (input) => {
    expect(
      await attendanceInspect(
        pool,
        options,
        "credential",
        id,
        "withdraw",
        input,
      ),
    ).toEqual({ kind: "invalid" });
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it.each(["permit", "observe", "remove"] as const)(
  "ATTEND-06 malformed %s scope cannot start inspection",
  async (kind) => {
    expect(
      await attendanceInspect(pool, options, "credential", id, kind, {}),
    ).toEqual({ kind: "invalid" });
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("ATTEND-08 invalid key, unsupported instruction and live mode cannot inspect private storage", async () => {
  expect(
    await attendanceInspect(
      pool,
      options,
      "credential",
      "bad",
      "permit",
      permit,
    ),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceInspect(
      pool,
      options,
      "credential",
      id,
      "unsupported" as AttendanceOperationKind,
      {},
    ),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceInspect(
      pool,
      { ...options, mode: "live" },
      "credential",
      id,
      "permit",
      permit,
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
