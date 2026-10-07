import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import { EventCancellationFailure } from "../../src/event-cancellation-lifetime.ts";
import type { AttendanceContext } from "../../src/event-attendance-transaction.ts";
import {
  attendanceRemovalCheck,
  attendanceRemove,
} from "../../src/event-attendance-removal.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checked = { registrationId: id, observationId: other };
const original = {
  actorId: id,
  registrationId: id,
  kind: "remove",
  instructionHash: hash(JSON.stringify(checked)),
};
let context: AttendanceContext,
  state: {
    locator: object | undefined;
    observation: { id: string } | undefined;
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
  options = { mode: "test" as const, enabled: false, registration: false };
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    locator: { registrationId: id, permissionId: other },
    observation: { id: other },
    operation: undefined,
  };
  context = {
    actorId: id,
    credentialHash: "invented",
    enteredAt: new Date("2026-10-07T18:00:00Z"),
    expires: [],
    tx: {
      observe: vi.fn(),
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes('SELECT registration_id AS "registrationId"')
          ? state.locator
            ? [state.locator]
            : []
          : sql.includes("FROM private_event_attendance_observations")
            ? state.observation
              ? [state.observation]
              : []
            : sql.includes("FROM private_event_attendance_operations")
              ? state.operation
                ? [state.operation]
                : []
              : [],
      })),
    },
  } as unknown as AttendanceContext;
  mocks.source.mockResolvedValue({
    registrationId: id,
    memberId: id,
    workspaceId: id,
  });
  mocks.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return {
        kind: "ready",
        value: await use(context),
        observedAt: context.enteredAt,
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
    .mock.calls.filter(([sql]) => /^\s*(DELETE|INSERT|UPDATE)\b/.test(sql));
it("ATTEND-04 owning distinct removal preview checks exact fact after ordered permission locking while creation is paused", async () => {
  expect(
    await attendanceRemovalCheck(pool, options, "credential", other),
  ).toMatchObject({ kind: "ready", value: checked });
  expect(mocks.actors).toHaveBeenCalledWith(context, [], "member");
  expect(context.tx.query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY id FOR UPDATE"),
    [id, id],
  );
  expect(writes()).toHaveLength(0);
});
it.each(["locator", "observation"])(
  "ATTEND-04 removed or foreign %s cannot create a removal preview",
  async (field) => {
    state[field as "locator" | "observation"] = undefined;
    expect(
      await attendanceRemovalCheck(pool, options, "credential", other),
    ).toEqual({ kind: "denied" });
    expect(writes()).toHaveLength(0);
  },
);
it("ATTEND-04 deliberate own removal deletes identifying permission links and reserves structural recovery without deleting registration", async () => {
  expect(
    await attendanceRemove(pool, options, "credential", other, checked),
  ).toMatchObject({
    kind: "ready",
    value: { kind: "remove", registrationId: id, removed: true },
  });
  expect(writes()).toHaveLength(2);
  expect(writes()[0]![0]).toContain(
    "DELETE FROM private_event_attendance_permissions",
  );
  expect(writes()[0]![1]).toEqual([id, id, id]);
  expect(writes()[1]![1]).toEqual([
    other,
    id,
    id,
    id,
    original.instructionHash,
  ]);
  expect(
    writes().some(([sql]) => sql.includes("private_event_enrollments")),
  ).toBe(false);
});
it("ATTEND-06 removed fact is not recreated on exact original-key recovery", async () => {
  state.observation = undefined;
  state.operation = original;
  expect(
    await attendanceRemove(pool, options, "credential", other, checked),
  ).toMatchObject({
    kind: "ready",
    value: { kind: "remove", registrationId: id, removed: true },
  });
  expect(writes()).toHaveLength(0);
});
it.each(["actorId", "registrationId", "kind", "instructionHash"])(
  "ATTEND-06 altered or foreign original removal %s cannot replace the fact",
  async (field) => {
    state.operation = { ...original, [field]: "different" };
    expect(
      await attendanceRemove(pool, options, "credential", other, checked),
    ).toEqual({ kind: "conflict" });
    expect(writes()).toHaveLength(0);
  },
);
it.each([undefined, { id }])(
  "ATTEND-04 missing or changed exact observation cannot be removed %j",
  async (observation) => {
    state.observation = observation;
    expect(
      await attendanceRemove(pool, options, "credential", other, checked),
    ).toEqual({ kind: "denied" });
    expect(writes()).toHaveLength(0);
  },
);
it("ATTEND-08 invalid removal and live mode do not inspect private storage", async () => {
  expect(
    await attendanceRemovalCheck(pool, options, "credential", "guessed"),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceRemovalCheck(
      pool,
      { ...options, mode: "live" },
      "credential",
      other,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await attendanceRemove(pool, options, "credential", "guessed", checked),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceRemove(pool, options, "credential", other, {}),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceRemove(
      pool,
      { ...options, mode: "live" },
      "credential",
      other,
      checked,
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
