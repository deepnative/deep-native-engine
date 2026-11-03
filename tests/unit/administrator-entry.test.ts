import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { administratorEntry } from "../../src/administrator-entry.ts";
const token = "a".repeat(64);
function fixture() {
  const state = {
    owner: true,
    workspace: true,
    identity: true,
    previous: false,
    admin: true,
    listed: true,
    fail: "",
    expires: new Date(Date.now() + 60000),
    session_expires: new Date(Date.now() + 30000),
  };
  const query = vi.fn(async (sql: string) => {
    if (state.fail && sql.startsWith(state.fail))
      throw Error("private database failure");
    if (sql.startsWith("SELECT p.expires_at"))
      return { rows: state.admin ? [{ expires: state.expires }] : [] };
    if (sql.startsWith("SELECT count(*)::int AS total"))
      return { rows: [{ total: state.listed ? 1 : 0 }] };
    if (sql.startsWith("SELECT l.id"))
      return {
        rows: state.listed
          ? [
              {
                id: "11111111-1111-4111-8111-111111111111",
                background: "professional",
                goal: "work",
              },
            ]
          : [],
      };
    if (sql.startsWith("SELECT id,version,title"))
      return {
        rows: [{ id: "FND-001", version: 2, title: "Invented lesson" }],
      };
    if (sql.startsWith("SELECT p.id"))
      return {
        rows: state.owner
          ? [
              {
                id: "owner",
                expires: state.expires,
                session_expires: state.session_expires,
              },
            ]
          : [],
      };
    if (sql.startsWith("WITH instant"))
      return {
        rows: [{ remaining: "30000", valid: true, observed: new Date() }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: [], rowCount: state.workspace ? 1 : 0 };
    if (sql.startsWith("SELECT 1 FROM member_email_identities"))
      return { rows: [], rowCount: state.identity ? 1 : 0 };
    if (sql.startsWith("SELECT 1 FROM administrator_sessions"))
      return { rows: [], rowCount: state.previous ? 1 : 0 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool;
  return { state, query, release, store: administratorEntry(pool) };
}
afterEach(() => vi.restoreAllMocks());
it("ADMINONLY01/04 explicitly enters finite bound administration without changing member work or token", async () => {
  const f = fixture();
  expect(await f.store.status(token)).toEqual({ kind: "ready" });
  expect(
    f.query.mock.calls.some(([sql]) => /INSERT INTO|UPDATE \w+ SET/.test(sql)),
  ).toBe(false);
  const r = await f.store.enter(token);
  expect(r).toMatchObject({ kind: "ready", expires: f.state.session_expires });
  if (r.kind !== "ready") throw Error("No entry");
  expect(r.credential).toMatch(/^[a-f0-9]{64}$/);
  expect(
    f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT")),
  ).toHaveLength(3);
  expect(
    f.query.mock.calls.some(([sql]) =>
      /UPDATE principals|UPDATE learners|DELETE/.test(sql),
    ),
  ).toBe(false);
});
it("ADMINONLY02/03 denies malformed, unverified, missing and already-entered identities", async () => {
  const f = fixture();
  expect(await f.store.enter("wrong")).toEqual({ kind: "denied" });
  expect(f.query).not.toHaveBeenCalled();
  for (const key of ["owner", "workspace", "identity"] as const) {
    const g = fixture();
    g.state[key] = false;
    expect(await g.store.enter(token)).toEqual({ kind: "denied" });
    expect(g.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  }
  f.state.previous = true;
  expect(await f.store.enter(token)).toEqual({ kind: "denied" });
});
it("ADMINONLY03/04 explicit ending revokes only current-session bindings and preserves identities/history", async () => {
  const f = fixture();
  expect(await f.store.end(token)).toEqual({ kind: "ready" });
  expect(
    f.query.mock.calls
      .filter(([sql]) => sql.startsWith("UPDATE"))
      .map(([sql]) => sql),
  ).toEqual([expect.stringContaining("UPDATE administrator_sessions")]);
  expect(
    f.query.mock.calls.some(([sql]) =>
      /DELETE|UPDATE principals|UPDATE learners/.test(sql),
    ),
  ).toBe(false);
});
it("ADMINONLY05 fails closed at database and unknown commit boundaries without returning or replaying credentials", async () => {
  for (const fail of [
    "BEGIN",
    "SELECT p.id",
    "SELECT id FROM workspaces",
    "SELECT 1 FROM member_email_identities",
    "SELECT 1 FROM administrator_sessions",
    "INSERT INTO principals",
    "INSERT INTO staff_profiles",
    "INSERT INTO administrator_sessions",
    "COMMIT",
  ]) {
    const f = fixture();
    f.state.fail = fail;
    expect(await f.store.enter(token)).toEqual({ kind: "unavailable" });
    expect(
      f.query.mock.calls.filter(([sql]) => sql === "COMMIT").length,
    ).toBeLessThanOrEqual(1);
    expect(f.release).toHaveBeenCalledOnce();
  }
  const f = fixture();
  f.state.session_expires = new Date(NaN);
  expect(await f.store.enter(token)).toEqual({ kind: "unavailable" });
});

it("ADMINCON01/02 reads a bounded minimal directory and exact member summaries without private writing", async () => {
  const f = fixture(),
    id = "11111111-1111-4111-8111-111111111111";
  expect(await f.store.console!(token)).toMatchObject({
    kind: "ready",
    value: { members: [{ id, background: "professional", goal: "work" }] },
  });
  const result = await f.store.console!(token, id);
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      selected: { member: { id }, plans: [], invoices: [], enrollments: [] },
    },
  });
  expect(
    f.query.mock.calls.some(([s]) =>
      /INSERT|UPDATE|DELETE|instruction|response_text/.test(s),
    ),
  ).toBe(false);
  f.state.listed = false;
  expect(await f.store.console!(token, id)).toEqual({ kind: "not-found" });
  expect(await f.store.console!(token)).toMatchObject({
    kind: "ready",
    value: { members: [] },
  });
});
it("ADMINCON04 fences console reads by exact finite admin authority and fails closed on unknown outcomes", async () => {
  const f = fixture();
  expect(await f.store.console!("wrong")).toEqual({ kind: "denied" });
  expect(await f.store.console!(token, "wrong")).toEqual({ kind: "denied" });
  expect(f.query).not.toHaveBeenCalled();
  f.state.admin = false;
  expect(await f.store.console!(token)).toEqual({ kind: "denied" });
  for (const fail of ["SELECT l.id", "COMMIT"]) {
    const g = fixture();
    g.state.fail = fail;
    expect(await g.store.console!(token)).toEqual({ kind: "unavailable" });
    expect(g.release).toHaveBeenCalledOnce();
  }
});
