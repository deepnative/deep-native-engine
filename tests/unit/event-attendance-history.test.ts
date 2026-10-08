import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { EventCancellationFailure } from "../../src/event-cancellation-lifetime.ts";
import { attendanceHistory } from "../../src/event-attendance-history.ts";
import { workflowReviewCursor } from "../../src/workflow-review-cursor.ts";
import type { AttendanceContext } from "../../src/event-attendance-transaction.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = "2026-10-07T18:00:00.000001Z",
  secret = "invented-attendance-history-secret";
const options = { mode: "test" as const, enabled: false, registration: false },
  pool = {} as Pool;
const codec = workflowReviewCursor(secret, "attendance-history");
const rows = Array.from({ length: 21 }, (_, i) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, "0")}`,
  createdAt: time,
}));
let context: AttendanceContext,
  state: {
    workspace: object | undefined;
    cursorExists: boolean;
    rows: typeof rows;
  };
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  source: vi.fn(),
  read: vi.fn(),
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
vi.mock("../../src/event-attendance-reader.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/event-attendance-reader.ts")
  >()),
  attendanceReadOwned: mocks.read,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state = { workspace: { id }, cursorExists: true, rows: [] };
  context = {
    actorId: id,
    credentialHash: "invented",
    enteredAt: new Date(time),
    expires: [new Date("2026-10-07T19:00:00Z")],
    tx: {
      observe: vi.fn(),
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM workspaces")
          ? state.workspace
            ? [state.workspace]
            : []
          : sql.includes("SELECT id FROM private_event_enrollments")
            ? state.cursorExists
              ? [{ id }]
              : []
            : state.rows,
      })),
    },
  } as unknown as AttendanceContext;
  mocks.source.mockImplementation(async (_context, registrationId) => ({
    registrationId,
  }));
  mocks.read.mockImplementation(async (_context, source) => ({
    registrationId: source.registrationId,
    observation: null,
  }));
  mocks.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return {
        kind: "ready",
        value: await use(context),
        observedAt: new Date(time),
        deadline: performance.now() + 60000,
      };
    } catch (error) {
      if (error instanceof EventCancellationFailure)
        return { kind: error.kind };
      throw error;
    }
  });
});
it("ATTEND-07 empty owning history has no invented records or continuation", async () => {
  expect(
    await attendanceHistory(pool, options, secret, "credential"),
  ).toMatchObject({ kind: "ready", value: { items: [], nextCursor: null } });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.actors).toHaveBeenCalledWith(context, [], "member");
});
it("ATTEND-07 one bounded page keeps all exact source references without premature continuation", async () => {
  state.rows = rows.slice(0, 20);
  const result = await attendanceHistory(pool, options, secret, "credential");
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready")
    throw Error("Owning bounded unit history required");
  expect(result.value.items.map((item) => item.registrationId)).toEqual(
    state.rows.map((item) => item.id),
  );
  expect(result.value.nextCursor).toBeNull();
});
it("ATTEND-07 overflowing page returns only20 and binds actor, exact microsecond timestamp and original last reference", async () => {
  state.rows = rows;
  const first = await attendanceHistory(pool, options, secret, "credential");
  if (first.kind !== "ready" || !first.value.nextCursor)
    throw Error("Signed continuation required");
  expect(first.value.items).toHaveLength(20);
  expect(mocks.read).toHaveBeenCalledTimes(20);
  expect(codec.read(first.value.nextCursor)).toEqual({
    actorId: id,
    createdAt: time,
    id: rows[19]!.id,
  });
  state.rows = rows.slice(20);
  const second = await attendanceHistory(
    pool,
    options,
    secret,
    "credential",
    first.value.nextCursor,
  );
  expect(second).toMatchObject({
    kind: "ready",
    value: { items: [{ registrationId: rows[20]!.id }], nextCursor: null },
  });
  expect(context.tx.query).toHaveBeenCalledWith(
    expect.stringContaining("created_at=$4::timestamptz"),
    [rows[19]!.id, id, id, time],
  );
});
it.each(["foreign", "erased-cursor", "missing-workspace"])(
  "ATTEND-07 current owner boundary %s rejects even an authenticated cursor",
  async (condition) => {
    if (condition === "erased-cursor") state.cursorExists = false;
    if (condition === "missing-workspace") state.workspace = undefined;
    const cursor = codec.sign({
      actorId: condition === "foreign" ? other : id,
      createdAt: time,
      id: rows[0]!.id,
    });
    expect(
      await attendanceHistory(pool, options, secret, "credential", cursor),
    ).toEqual({ kind: "denied" });
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
it("ATTEND-07 forged, cross-purpose and live cursors never start a private transaction", async () => {
  expect(
    await attendanceHistory(pool, options, secret, "credential", "forged"),
  ).toEqual({ kind: "invalid" });
  const cursor = workflowReviewCursor(secret, "member-history").sign({
    actorId: id,
    createdAt: time,
    id,
  });
  expect(
    await attendanceHistory(pool, options, secret, "credential", cursor),
  ).toEqual({ kind: "invalid" });
  expect(
    await attendanceHistory(
      pool,
      { ...options, mode: "live" },
      secret,
      "credential",
    ),
  ).toEqual({ kind: "denied" });
  expect(mocks.execute).not.toHaveBeenCalled();
});
