import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
const token = "b".repeat(64),
  actorId = "22222222-2222-4222-8222-222222222222",
  key = "44444444-4444-4444-8444-444444444444";
const at = new Date("2026-10-06T12:00:00Z");
const snapshot = rehearsalSnapshot({
  templateId: "local-registration-rehearsal",
  templateVersion: 1,
  startsAt: "2026-10-07T12:00:00.000Z",
})!;
function fixture(
  options: Partial<Parameters<typeof eventRehearsalStore>[1]> = {},
) {
  const state = {
    actor: true,
    role: "platform_admin" as string | null,
    valid: true,
    count: 0 as unknown,
    guard: true,
    saved: null as Record<string, unknown> | null,
    delayed: null as Record<string, unknown> | null,
    reads: 0,
    finalMissing: false,
    fail: "",
  };
  const retained = (id = "33333333-3333-4333-8333-333333333333") => ({
    id,
    eventId: `local-rehearsal-${id}`,
    eventVersion: 1,
    title: snapshot.title,
    startsAt: new Date(snapshot.startsAt),
    endsAt: new Date(snapshot.endsAt),
    scheduledAt: at,
    actorId,
    snapshot,
  });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (state.fail && sql.includes(state.fail))
      throw Error("Invented private driver diagnostics");
    let rows: unknown[] = [];
    if (sql.includes("EXTRACT(EPOCH"))
      rows = [{ remaining: "60000", observed: at }];
    else if (sql.includes("FROM principals"))
      rows = state.actor
        ? [{ id: actorId, expires: new Date(+at + 60000) }]
        : [];
    else if (sql.includes("FROM staff_profiles"))
      rows = state.role === null ? [] : [{ role: state.role }];
    else if (sql.includes("AS valid")) rows = [{ valid: state.valid }];
    else if (sql.includes("AS count")) rows = [{ count: state.count }];
    else if (sql.includes("WHERE id=1 FOR UPDATE"))
      rows = state.guard ? [{ id: 1 }] : [];
    else if (sql.startsWith("INSERT INTO private_event_rehearsals("))
      state.saved = retained(values[0] as string);
    else if (sql.includes("WHERE o.idempotency_key")) {
      state.reads++;
      if (state.reads === 2 && state.delayed) state.saved = state.delayed;
      rows =
        state.saved && !(state.finalMissing && state.reads >= 3)
          ? [state.saved]
          : [];
    } else if (sql.includes("WHERE r.id=$1 AND o.actor_id=$2"))
      rows =
        state.saved && state.saved.actorId === actorId ? [state.saved] : [];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const service = eventRehearsalStore({ connect } as unknown as Pool, {
    mode: "test",
    writes: true,
    registration: true,
    ...options,
  });
  return { state, retained, query, connect, release, service };
}
it.each([{ mode: "live" as const }, {}])(
  "REHSCHED-05 malformed or live authority cannot acquire a connection %j",
  async (options) => {
    const f = fixture(options);
    expect(await f.service.admin(options.mode ? token : "bad")).toEqual({
      kind: "denied",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it.each([null, "operator", "reviewer", "moderator", "editor", "coach"])(
  "REHSCHED-05 profile %s lacks scheduling authority",
  async (role) => {
    const f = fixture();
    f.state.role = role;
    expect(await f.service.admin(token)).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  },
);
it("REHSCHED-05 missing current principal cannot access roles or schedules", async () => {
  const f = fixture();
  f.state.actor = false;
  expect(await f.service.admin(token)).toEqual({ kind: "denied" });
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("FROM staff_profiles")),
  ).toBe(false);
});
it.each([{ writes: false }, { registration: false }, {}])(
  "REHSCHED-08 capabilities preserve explicit creation switches %j",
  async (options) => {
    const f = fixture(options),
      enabled = options.writes !== false && options.registration !== false;
    expect(await f.service.admin(token)).toMatchObject({
      kind: "ready",
      value: { creationEnabled: enabled },
    });
    expect(
      await f.service.preview(token, {
        templateId: snapshot.templateId,
        templateVersion: 1,
        startsAt: snapshot.startsAt,
      }),
    ).toMatchObject({
      kind: "ready",
      value: { snapshot, creationEnabled: enabled },
    });
    if (!enabled)
      expect(await f.service.schedule(token, key, snapshot)).toEqual({
        kind: "unavailable",
      });
  },
);
it("REHSCHED-01/06 deliberate creation exposes one canonical receipt without private actor/instruction fields", async () => {
  const f = fixture();
  const result = await f.service.schedule(token, key, snapshot);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing scheduling fixture");
  expect(result.value.replayed).toBe(false);
  expect(Object.keys(result.value.receipt).sort()).toEqual(
    [
      "id",
      "eventId",
      "eventVersion",
      "title",
      "startsAt",
      "endsAt",
      "scheduledAt",
    ].sort(),
  );
  expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(
    1,
  );
  expect(f.release).toHaveBeenCalledOnce();
  expect(await f.service.receipt(token, result.value.receipt.id)).toMatchObject(
    { kind: "ready", value: result.value.receipt },
  );
});
it.each(["preview", "schedule", "inspectOperation", "receipt"] as const)(
  "REHSCHED-04 malformed %s is rejected without connection",
  async (method) => {
    const f = fixture();
    const result =
      method === "preview"
        ? await f.service.preview(token, {})
        : method === "receipt"
          ? await f.service.receipt(token, "bad")
          : await f.service[method](token, key, {});
    expect(result).toEqual({ kind: "invalid" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it.each(["schedule", "inspectOperation"] as const)(
  "REHSCHED-06 invalid %s key cannot access saved state",
  async (method) => {
    const f = fixture();
    expect(await f.service[method](token, "bad", snapshot)).toEqual({
      kind: "invalid",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("REHSCHED-06 absent operation and absent canonical receipt remain unknown without creating anything", async () => {
  const f = fixture();
  expect(await f.service.inspectOperation(token, key, snapshot)).toMatchObject({
    kind: "ready",
    value: null,
  });
  expect(
    await f.service.receipt(token, "33333333-3333-4333-8333-333333333333"),
  ).toMatchObject({ kind: "ready", value: null });
  expect(f.state.saved).toBeNull();
});
it("REHSCHED-06 exact prior key remains recoverable after creation pause without new write", async () => {
  const f = fixture({ writes: false });
  f.state.saved = f.retained();
  expect(await f.service.schedule(token, key, snapshot)).toMatchObject({
    kind: "ready",
    value: { replayed: true, receipt: { id: f.state.saved.id } },
  });
  expect(await f.service.inspectOperation(token, key, snapshot)).toMatchObject({
    kind: "ready",
    value: { id: f.state.saved.id },
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([null, "foreign"])(
  "REHSCHED-06 erased or foreign creator %s cannot reuse a reserved key",
  async (actor) => {
    const f = fixture();
    f.state.saved = { ...f.retained(), actorId: actor };
    expect(await f.service.schedule(token, key, snapshot)).toEqual({
      kind: "conflict",
    });
    expect(await f.service.inspectOperation(token, key, snapshot)).toEqual({
      kind: "conflict",
    });
  },
);
it("REHSCHED-06 changed original instruction conflicts without writing", async () => {
  const f = fixture();
  f.state.saved = {
    ...f.retained(),
    snapshot: { ...snapshot, title: "Changed" },
  };
  expect(await f.service.schedule(token, key, snapshot)).toEqual({
    kind: "conflict",
  });
});
it("REHSCHED-06 an exact winner committed while admission waited is recovered before new inserts", async () => {
  const f = fixture();
  f.state.delayed = f.retained();
  expect(await f.service.schedule(token, key, snapshot)).toMatchObject({
    kind: "ready",
    value: { replayed: true },
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([20, 21])(
  "REHSCHED-04 %s open rehearsals deny creation and disable proposed confirmation",
  async (count) => {
    const f = fixture();
    f.state.count = count;
    expect(
      await f.service.preview(token, {
        templateId: snapshot.templateId,
        templateVersion: 1,
        startsAt: snapshot.startsAt,
      }),
    ).toMatchObject({ kind: "ready", value: { creationEnabled: false } });
    expect(await f.service.schedule(token, key, snapshot)).toEqual({
      kind: "unavailable",
    });
  },
);
it.each([null, -1, 1.5, "0"])(
  "REHSCHED-04 unavailable admission count %s fails closed",
  async (count) => {
    const f = fixture();
    f.state.count = count;
    expect(await f.service.schedule(token, key, snapshot)).toEqual({
      kind: "unavailable",
    });
  },
);
it("REHSCHED-04 invalid time refuses creation and checked preview", async () => {
  const f = fixture();
  f.state.valid = false;
  expect(await f.service.schedule(token, key, snapshot)).toEqual({
    kind: "invalid",
  });
  expect(
    await f.service.preview(token, {
      templateId: snapshot.templateId,
      templateVersion: 1,
      startsAt: snapshot.startsAt,
    }),
  ).toEqual({ kind: "invalid" });
});
it("REHSCHED-04 absent admission guard cannot create a schedule", async () => {
  const f = fixture();
  f.state.guard = false;
  expect(await f.service.schedule(token, key, snapshot)).toEqual({
    kind: "unavailable",
  });
});
it("REHSCHED-06 missing final immutable read never claims confirmed creation", async () => {
  const f = fixture();
  f.state.finalMissing = true;
  expect(await f.service.schedule(token, key, snapshot)).toEqual({
    kind: "unavailable",
  });
  expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});
it("REHSCHED-06 driver failure never exposes private diagnostics", async () => {
  const f = fixture();
  f.state.fail = "FROM principals";
  expect(await f.service.admin(token)).toEqual({ kind: "unavailable" });
  expect(f.release).toHaveBeenCalledOnce();
});
