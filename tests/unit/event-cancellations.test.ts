import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import { EVENT_PREVIEWS, type EventPreview } from "../../src/events.ts";
import { hash } from "../../src/store.ts";
const token = "b".repeat(64),
  actorId = "22222222-2222-4222-8222-222222222222",
  key = "44444444-4444-4444-8444-444444444444",
  id = "33333333-3333-4333-8333-333333333333";
const at = new Date("2026-10-06T12:00:00.000Z");
const event: EventPreview = {
  ...EVENT_PREVIEWS[0]!,
  status: "current",
  localRegistration: true,
  startsAt: "2030-01-01T12:00:00.000Z",
  endsAt: "2030-01-01T13:00:00.000Z",
};
const scope = { eventId: event.id, eventVersion: event.version };
const snapshot = {
  title: event.title,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  capacity: event.fixtureCapacity,
};
const saved = () => ({
  ...scope,
  id,
  title: event.title,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  cancelledAt: at,
});
type Operation = {
  actorId: string | null;
  eventId: string;
  eventVersion: number;
  cancellationId: string;
};
function fixture(
  options: {
    mode?: "test" | "demo" | "live";
    writes?: boolean;
    registration?: boolean;
    catalog?: readonly EventPreview[];
    catalogReader?: Parameters<
      typeof eventCancellationStore
    >[1]["catalogReader"];
  } = {},
) {
  const state = {
    actor: true,
    profile: "platform_admin" as string | null,
    future: true,
    receipt: null as ReturnType<typeof saved> | null,
    inventory: {
      title: event.title,
      startsAt: new Date(event.startsAt),
      endsAt: new Date(event.endsAt),
      capacity: event.fixtureCapacity,
    } as
      | typeof snapshot
      | { title: string; startsAt: Date; endsAt: Date; capacity: number }
      | null,
    cancellationState: { id: null as string | null } as {
      id: string | null;
    } | null,
    operations: new Map<string, Operation>(),
    delayedPrior: null as Operation | null,
    operationReads: 0,
    insertWinner: undefined as Operation | null | undefined,
    fail: "",
    receiptMissing: false,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (state.fail && sql.includes(state.fail))
      throw new Error("private diagnostics");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [{ remaining: "60000", observed: at }];
    else if (sql.includes("FROM principals"))
      rows = state.actor
        ? [{ id: actorId, expires: new Date(+at + 60000) }]
        : [];
    else if (sql.includes("FROM staff_profiles"))
      rows = state.profile === null ? [] : [{ role: state.profile }];
    else if (sql.includes("AS future")) rows = [{ future: state.future }];
    else if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM private_event_cancellation_operations")
    ) {
      state.operationReads++;
      if (state.operationReads === 2 && state.delayedPrior)
        state.operations.set(key, state.delayedPrior);
      const op = state.operations.get(values[0] as string);
      rows = op ? [op] : [];
    } else if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM private_event_cancellations c")
    )
      rows = state.receipt && !state.receiptMissing ? [state.receipt] : [];
    else if (sql.startsWith("SELECT capacity"))
      rows = state.inventory ? [{ capacity: state.inventory.capacity }] : [];
    else if (sql.startsWith("SELECT title"))
      rows = state.inventory ? [state.inventory] : [];
    else if (sql.startsWith("SELECT cancellation_id"))
      rows = state.cancellationState ? [state.cancellationState] : [];
    else if (sql.startsWith("INSERT INTO private_event_cancellations("))
      state.receipt = { ...saved(), id: values[0] as string };
    else if (sql.startsWith("UPDATE private_event_cancellation_state"))
      state.cancellationState = { id: values[0] as string };
    else if (
      sql.startsWith("INSERT INTO private_event_cancellation_operations")
    ) {
      if (state.insertWinner !== undefined) {
        if (state.insertWinner) state.operations.set(key, state.insertWinner);
      } else {
        state.operations.set(values[0] as string, {
          actorId: values[1] as string,
          eventId: values[2] as string,
          eventVersion: values[3] as number,
          cancellationId: values[4] as string,
        });
        rows = [{ idempotency_key: values[0] }];
      }
    }
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const store = eventCancellationStore({ connect } as unknown as Pool, {
    mode: "test",
    writes: true,
    registration: true,
    catalog: [event],
    ...options,
  });
  const retain = () => {
    state.receipt = saved();
    state.cancellationState = { id };
    state.operations.set(key, { ...scope, actorId, cancellationId: id });
  };
  return { state, query, release, connect, store, retain };
}
it.each(["live" as const])(
  "EVCANCEL-08 %s mode cannot acquire authority",
  async (mode) => {
    const f = fixture({ mode });
    expect(await f.store.admin(token)).toEqual({ kind: "denied" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("EVCANCEL-05 invalid credential cannot acquire a connection", async () => {
  const f = fixture();
  expect(await f.store.admin("bad")).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it.each(["reviewer", "moderator", "coach", "operator", "editor", null])(
  "EVCANCEL-05 %s profile cannot obtain administrator metadata",
  async (profile) => {
    const f = fixture();
    f.state.profile = profile;
    expect(await f.store.admin(token)).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  },
);
it("EVCANCEL-05 selected hashed credential and current role are checked before returning capabilities", async () => {
  const f = fixture();
  expect(await f.store.admin(token)).toMatchObject({
    kind: "ready",
    value: { creationEnabled: true },
  });
  expect(
    f.query.mock.calls.find(([sql]) => sql.includes("FROM principals"))?.[1],
  ).toEqual([hash(token)]);
  expect(f.release).toHaveBeenCalledOnce();
});
it("EVCANCEL-05 missing selected principal denies without role or event lookup", async () => {
  const f = fixture();
  f.state.actor = false;
  expect(await f.store.admin(token)).toEqual({ kind: "denied" });
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("FROM staff_profiles")),
  ).toBe(false);
});
it.each(["preview", "inspect", "inspectOperation", "cancel"] as const)(
  "EVCANCEL-05 malformed %s reference cannot read or write",
  async (method) => {
    const f = fixture();
    const invalid = { eventId: "foreign/id", eventVersion: 1 };
    expect(await f.store[method](token, invalid, key)).toEqual({
      kind: "invalid",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it.each(["inspectOperation", "cancel"] as const)(
  "EVCANCEL-06 malformed %s key cannot connect",
  async (method) => {
    const f = fixture();
    expect(await f.store[method](token, scope, "bad")).toEqual({
      kind: "invalid",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("REHSCHED-07 default trusted Git catalog preserves the original static rehearsal preview", async () => {
  const f = fixture({ catalog: undefined });
  const trusted = EVENT_PREVIEWS.find(
    (item) => item.localRegistration === true,
  )!;
  expect(
    await f.store.preview(token, {
      eventId: trusted.id,
      eventVersion: trusted.version,
    }),
  ).toMatchObject({
    kind: "ready",
    value: { event: trusted, creationEnabled: true, receipt: null },
  });
  expect(trusted.startsAt).not.toBe(event.startsAt);
  expect(f.release).toHaveBeenCalledOnce();
});
it("EVCANCEL-01 future opted-in preview allows an explicit new cancellation", async () => {
  const f = fixture();
  expect(await f.store.preview(token, scope)).toMatchObject({
    kind: "ready",
    value: { event, creationEnabled: true, receipt: null },
  });
});
it.each([{ writes: false }, { registration: false }])(
  "EVCANCEL-08 paused %j preserves read capability but prevents new keys",
  async (options) => {
    const f = fixture(options);
    expect(await f.store.admin(token)).toMatchObject({
      kind: "ready",
      value: { creationEnabled: false },
    });
    expect(await f.store.preview(token, scope)).toMatchObject({
      kind: "ready",
      value: { creationEnabled: false },
    });
    expect(await f.store.cancel(token, scope, key, snapshot)).toEqual({
      kind: "unavailable",
    });
  },
);
it("EVCANCEL-01 past preview cannot offer new cancellation", async () => {
  const f = fixture();
  f.state.future = false;
  expect(await f.store.preview(token, scope)).toMatchObject({
    kind: "ready",
    value: { creationEnabled: false },
  });
});
it.each([{ status: "retired" as const }, { localRegistration: false }])(
  "EVCANCEL-01 unavailable catalog state %j cannot preview or cancel",
  async (changes) => {
    const f = fixture({ catalog: [{ ...event, ...changes }] });
    expect(await f.store.preview(token, scope)).toEqual({
      kind: "unavailable",
    });
    expect(await f.store.cancel(token, scope, key)).toEqual({
      kind: "unavailable",
    });
  },
);
it("EVCANCEL-01 unknown version cannot be materialized", async () => {
  const f = fixture({ catalog: [] });
  expect(await f.store.preview(token, scope)).toEqual({ kind: "unavailable" });
  expect(await f.store.cancel(token, scope, key)).toEqual({
    kind: "unavailable",
  });
});
it("EVCANCEL-03 cancelled preview closes creation and retains canonical receipt", async () => {
  const f = fixture();
  f.retain();
  expect(await f.store.preview(token, scope)).toMatchObject({
    kind: "ready",
    value: { creationEnabled: false, receipt: saved() },
  });
  expect(await f.store.inspect(token, scope)).toMatchObject({
    kind: "ready",
    value: saved(),
  });
});
it("EVCANCEL-06 missing canonical or operation inspection is unknown rather than a write", async () => {
  const f = fixture();
  expect(await f.store.inspect(token, scope)).toMatchObject({
    kind: "ready",
    value: null,
  });
  expect(await f.store.inspectOperation(token, scope, key)).toMatchObject({
    kind: "ready",
    value: null,
  });
  expect(f.state.operations.size).toBe(0);
});
it("EVCANCEL-06 creator key reveals its exact retained receipt", async () => {
  const f = fixture();
  f.retain();
  expect(await f.store.inspectOperation(token, scope, key)).toMatchObject({
    kind: "ready",
    value: saved(),
  });
});
it.each([
  { actorId: null },
  { actorId: "other" },
  { eventId: "other-event" },
  { eventVersion: event.version + 1 },
])(
  "EVCANCEL-06 reserved key mismatch %j denies inspection and replay",
  async (changes) => {
    const f = fixture();
    f.retain();
    f.state.operations.set(key, {
      ...scope,
      actorId,
      cancellationId: id,
      ...changes,
    });
    expect(await f.store.inspectOperation(token, scope, key)).toEqual({
      kind: "conflict",
    });
    expect(await f.store.cancel(token, scope, key)).toEqual({
      kind: "conflict",
    });
  },
);
it("EVCANCEL-06 inconsistent operation cannot claim a confirmed receipt", async () => {
  const f = fixture();
  f.retain();
  f.state.operations.get(key)!.cancellationId = "other";
  expect(await f.store.inspectOperation(token, scope, key)).toEqual({
    kind: "unavailable",
  });
  expect(await f.store.cancel(token, scope, key)).toEqual({
    kind: "unavailable",
  });
});
it("EVCANCEL-06 replay remains available when creation is paused and catalog retired", async () => {
  const f = fixture({ writes: false, catalog: [] });
  f.retain();
  expect(await f.store.cancel(token, scope, key, snapshot)).toMatchObject({
    kind: "ready",
    value: { receipt: saved(), replayed: true },
  });
});
it.each([
  { title: "changed" },
  { startsAt: "2031-01-01T12:00:00.000Z" },
  { endsAt: "2031-01-01T13:00:00.000Z" },
  { capacity: event.fixtureCapacity + 1 },
])(
  "EVCANCEL-01 changed checked snapshot %j conflicts for both creation and replay",
  async (changes) => {
    const f = fixture();
    expect(
      await f.store.cancel(token, scope, key, { ...snapshot, ...changes }),
    ).toEqual({ kind: "conflict" });
    f.retain();
    expect(
      await f.store.cancel(token, scope, key, { ...snapshot, ...changes }),
    ).toEqual({ kind: "conflict" });
  },
);
it("EVCANCEL-06 retained snapshot requires its immutable inventory capacity", async () => {
  const f = fixture();
  f.retain();
  f.state.inventory = null;
  expect(await f.store.cancel(token, scope, key, snapshot)).toEqual({
    kind: "conflict",
  });
});
it("EVCANCEL-06 missing retained canonical receipt cannot claim replay", async () => {
  const f = fixture();
  f.retain();
  f.state.receipt = null;
  expect(await f.store.cancel(token, scope, key)).toEqual({
    kind: "unavailable",
  });
});
it("EVCANCEL-02 creates one canonical cancellation and creator operation", async () => {
  const f = fixture();
  const result = await f.store.cancel(token, scope, key, snapshot);
  expect(result).toMatchObject({
    kind: "ready",
    value: { replayed: false, receipt: { ...scope, title: event.title } },
  });
  expect(f.state.operations.size).toBe(1);
  expect(f.state.operations.get(key)?.cancellationId).toBe(f.state.receipt?.id);
  expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
});
it("EVCANCEL-02 a new key for already-cancelled state retains the same canonical ID", async () => {
  const f = fixture();
  f.retain();
  f.state.operations.clear();
  expect(await f.store.cancel(token, scope, key)).toMatchObject({
    kind: "ready",
    value: { receipt: saved(), replayed: false },
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO private_event_cancellations("),
    ),
  ).toBe(false);
});
it("EVCANCEL-06 key claimed while waiting on inventory is rechecked before creating a fact", async () => {
  const f = fixture();
  f.state.receipt = saved();
  f.state.delayedPrior = { ...scope, actorId, cancellationId: id };
  expect(await f.store.cancel(token, scope, key, snapshot)).toMatchObject({
    kind: "ready",
    value: { replayed: true },
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO private_event_cancellations("),
    ),
  ).toBe(false);
});
it.each(["missing", "title", "start", "end", "capacity"])(
  "EVCANCEL-01 inventory %s mismatch refuses cancellation",
  async (change) => {
    const f = fixture();
    if (change === "missing") f.state.inventory = null;
    else
      f.state.inventory = {
        title: change === "title" ? "changed" : event.title,
        startsAt: new Date(change === "start" ? "2031-01-01" : event.startsAt),
        endsAt: new Date(change === "end" ? "2031-01-01" : event.endsAt),
        capacity:
          change === "capacity"
            ? event.fixtureCapacity + 1
            : event.fixtureCapacity,
      };
    expect(await f.store.cancel(token, scope, key)).toEqual({
      kind: "conflict",
    });
    expect(f.state.receipt).toBeNull();
  },
);
it("EVCANCEL-02 absent cancellation fence is unavailable, never silently recreated", async () => {
  const f = fixture();
  f.state.cancellationState = null;
  expect(await f.store.cancel(token, scope, key)).toEqual({
    kind: "unavailable",
  });
  expect(f.state.receipt).toBeNull();
});
it("EVCANCEL-06 compatible operation insert winner retains the canonical cancellation", async () => {
  const f = fixture();
  f.retain();
  f.state.operations.clear();
  f.state.insertWinner = { ...scope, actorId, cancellationId: id };
  expect(await f.store.cancel(token, scope, key)).toMatchObject({
    kind: "ready",
    value: { receipt: saved() },
  });
});
it.each([
  null,
  { ...scope, actorId: "foreign", cancellationId: id },
  { ...scope, actorId, cancellationId: "foreign" },
])(
  "EVCANCEL-06 missing/incompatible operation winner %j cannot commit",
  async (winner) => {
    const f = fixture();
    f.retain();
    f.state.operations.clear();
    f.state.insertWinner = winner;
    expect(await f.store.cancel(token, scope, key)).toEqual({
      kind: winner === null ? "unavailable" : "conflict",
    });
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  },
);
it("EVCANCEL-02 absent final canonical read cannot confirm a successful cancellation", async () => {
  const f = fixture();
  f.state.receiptMissing = true;
  expect(await f.store.cancel(token, scope, key)).toEqual({
    kind: "unavailable",
  });
  expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});
it("EVCANCEL-05 database error is unavailable without exposing diagnostics", async () => {
  const f = fixture();
  f.state.fail = "FROM principals";
  expect(await f.store.admin(token)).toEqual({ kind: "unavailable" });
  expect(f.release).toHaveBeenCalledOnce();
});

it("REHSCHED-03 cancellation uses the injected shared catalog under current administrator authority", async () => {
  const reader = {
    acceptsReference: () => true,
    find: vi.fn(async () => event),
    list: async () => [event],
  };
  const f = fixture({ catalogReader: reader });
  expect(await f.store.preview(token, scope)).toMatchObject({
    kind: "ready",
    value: { event },
  });
  expect(await f.store.cancel(token, scope, key, snapshot)).toMatchObject({
    kind: "ready",
  });
  expect(reader.find).toHaveBeenCalled();
});
