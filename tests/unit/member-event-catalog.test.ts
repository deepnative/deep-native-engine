import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { memberEventCatalog } from "../../src/member-event-catalog.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
const token = "invented-member",
  event = EVENT_PREVIEWS[0]!,
  at = new Date("2026-10-06T12:00:00Z");
function fixture(mode: "test" | "live" = "test") {
  const state = { member: true, workspace: true, fail: false };
  const query = vi.fn(async (sql: string) => {
    if (state.fail) throw Error("Invented private driver detail");
    const rows = sql.includes("WITH instant")
      ? [{ remaining: "60000", observed: at }]
      : sql.includes("FROM principals")
        ? state.member
          ? [{ id: "invented", expires: new Date(+at + 60000) }]
          : []
        : sql.includes("FROM workspaces")
          ? state.workspace
            ? [{ id: "invented" }]
            : []
          : [];
    return { rows, rowCount: rows.length };
  });
  const connect = vi.fn(
    async () => ({ query, release: vi.fn() }) as unknown as PoolClient,
  );
  const reader = {
    acceptsReference: vi.fn(() => true),
    find: vi.fn(async () => event),
    list: vi.fn(async () => [event]),
  };
  return {
    state,
    query,
    connect,
    reader,
    service: memberEventCatalog({ connect } as unknown as Pool, mode, reader),
  };
}
it.each(["", "   "])(
  "REHSCHED-05 blank member authority %j cannot acquire a connection",
  async (token) => {
    const f = fixture();
    expect(await f.service.list(token)).toEqual({ kind: "denied" });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("REHSCHED-08 live mode denies invented catalog access without connecting", async () => {
  const f = fixture("live");
  expect(await f.service.list(token)).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it.each(["member", "workspace"] as const)(
  "REHSCHED-05 absent current %s denies catalog reads",
  async (missing) => {
    const f = fixture();
    f.state[missing] = false;
    expect(await f.service.list(token)).toEqual({ kind: "denied" });
    expect(f.reader.list).not.toHaveBeenCalled();
  },
);
it("REHSCHED-02 current member can discover and read the exact immutable snapshot", async () => {
  const f = fixture();
  expect(await f.service.list(token)).toMatchObject({
    kind: "ready",
    value: [event],
  });
  expect(await f.service.find(token, event.id, event.version)).toMatchObject({
    kind: "ready",
    value: event,
  });
});
it("REHSCHED-04 malformed and unknown references cannot materialize an event", async () => {
  const f = fixture();
  expect(await f.service.find(token, "foreign/id", 1)).toEqual({
    kind: "invalid",
  });
  expect(f.connect).not.toHaveBeenCalled();
  f.reader.acceptsReference.mockReturnValue(false);
  expect(await f.service.find(token, event.id, 1)).toMatchObject({
    kind: "ready",
    value: undefined,
  });
  expect(f.reader.find).not.toHaveBeenCalled();
});
it("REHSCHED-06 query failure returns unavailable without diagnostics", async () => {
  const f = fixture();
  f.state.fail = true;
  expect(await f.service.list(token)).toEqual({ kind: "unavailable" });
});
