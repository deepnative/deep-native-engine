import { afterEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { STAFF_ROLES } from "../../src/authorization.ts";
const token = "a".repeat(64);
function fixture() {
  const state = {
    principal: true,
    profile: true,
    role: "operator",
    expires: new Date(Date.now() + 60000),
    remaining: "60000",
    observation: true,
    fail: "",
    releaseFailure: false,
  };
  const query = vi.fn(async (sql: string) => {
    if (state.fail && sql.startsWith(state.fail))
      throw Error("SECRET-DATABASE-SENTINEL");
    if (sql.includes("FROM principals"))
      return {
        rows: state.principal
          ? [{ id: "test-id", expires: state.expires }]
          : [],
      };
    if (sql.includes("FROM staff_profiles"))
      return { rows: state.profile ? [{ role: state.role }] : [] };
    if (sql.startsWith("WITH instant"))
      return {
        rows: [{ remaining: "60000", valid: true, observed: new Date() }],
      };
    if (sql.startsWith("SELECT EXTRACT"))
      return {
        rows: state.observation ? [{ remaining: state.remaining }] : [],
      };
    return { rows: [] };
  });
  const release = vi.fn(() => {
    if (state.releaseFailure) throw Error("SECRET-HANDBACK-SENTINEL");
  });
  const connect = vi.fn(
    async () => ({ query, release }) as unknown as PoolClient,
  );
  return {
    state,
    query,
    release,
    connect,
    store: staffEntryStore({ connect } as unknown as Pool),
  };
}
afterEach(() => vi.restoreAllMocks());
it("STAFF-01-ROLES admits each actual current staff role without authority writes or renewal", async () => {
  for (const role of STAFF_ROLES) {
    const f = fixture();
    f.state.role = role;
    const r = await f.store.admit(token);
    expect(r).toMatchObject({ kind: "ready", role });
    if (r.kind !== "ready") throw Error("No admission");
    expect(r.deadline).toBeGreaterThan(performance.now());
    expect(
      f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql)),
    ).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  }
});
it("STAFF-03-CREDENTIAL refuses malformed, missing or nonstaff principal/profile and defensive unknown-role results", async () => {
  const f = fixture();
  expect(await f.store.admit("malformed")).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
  for (const key of ["principal", "profile"] as const) {
    const g = fixture();
    g.state[key] = false;
    expect(await g.store.admit(token)).toEqual({ kind: "denied" });
  }
  f.state.role = "owner";
  expect(await f.store.admit(token)).toEqual({ kind: "denied" });
});
it("STAFF-06-EXPIRY refuses invalid and expired database observation and preserves conservative HTTP deadline", async () => {
  for (const remaining of [
    "",
    " ",
    "NaN",
    "Infinity",
    undefined,
    0,
    "0",
    "-1",
  ]) {
    const f = fixture();
    f.state.remaining = remaining as string;
    expect(await f.store.admit(token)).toEqual({
      kind: remaining === "0" || remaining === "-1" ? "denied" : "unavailable",
    });
  }
  const f = fixture();
  f.state.observation = false;
  expect(await f.store.admit(token)).toEqual({ kind: "unavailable" });
  f.state.expires = new Date(NaN);
  expect(await f.store.admit(token)).toEqual({ kind: "unavailable" });
});
it("STAFF-06-FAULTS sanitizes command failures and never replays uncertain admission", async () => {
  for (const fail of [
    "BEGIN",
    "SET LOCAL statement",
    "SET LOCAL lock",
    "SELECT set_config",
    "SELECT id,expires",
    "WITH instant",
    "SELECT role",
    "SELECT EXTRACT",
    "COMMIT",
  ]) {
    const f = fixture();
    f.state.fail = fail;
    expect(await f.store.admit(token)).toEqual({ kind: "unavailable" });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(
      f.query.mock.calls.filter(([sql]) => sql === "COMMIT").length,
    ).toBeLessThanOrEqual(1);
  }
  const f = fixture();
  f.connect.mockRejectedValueOnce(Error("PRIVATE-CONNECTION"));
  expect(await f.store.admit(token)).toEqual({ kind: "unavailable" });
  const g = fixture();
  g.state.releaseFailure = true;
  expect(await g.store.admit(token)).toEqual({ kind: "unavailable" });
  const h = fixture();
  h.state.profile = false;
  h.state.fail = "ROLLBACK";
  expect(await h.store.admit(token)).toEqual({ kind: "unavailable" });
});
it("STAFF-06-FAULTS bounds acquisition and late connection handback without replay", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const f = fixture();
    let releaseConnection!: (client: PoolClient) => void;
    f.connect.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseConnection = r;
        }),
    );
    const pending = f.store.admit(token);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await pending).toEqual({ kind: "unavailable" });
    releaseConnection({
      query: f.query,
      release: f.release,
    } as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("STAFF-06-FAULTS bounds unknown BEGIN/query completion, discards connection and does not rollback behind it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const f = fixture();
    f.query.mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.store.admit(token);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ kind: "unavailable" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN"]);
  } finally {
    vi.useRealTimers();
  }
});
