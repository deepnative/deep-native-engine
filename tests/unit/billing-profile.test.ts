import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { billingProfileStore } from "../../src/billing-profile.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
const pool = {} as Pool,
  token = "a".repeat(64),
  expiry = new Date("2099-01-01"),
  profile = {
    name: "陳 Invented",
    email: " RECIPIENT@EXAMPLE.INVALID ",
    revision: 0,
  };
let member: unknown, workspace: boolean, current: unknown;
const query = vi.fn(async (sql: string) => ({
  rows: sql.startsWith("SELECT p.id")
    ? member
      ? [member]
      : []
    : sql.startsWith("SELECT name")
      ? current
        ? [current]
        : []
      : [],
  rowCount: sql.startsWith("SELECT id FROM workspaces") ? Number(workspace) : 1,
}));
const observe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  member = { id: "owned", expires: expiry };
  workspace = true;
  current = null;
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe } as unknown as PracticeTransaction),
  );
});
it("BILLPROFILE02 reads only the authenticated member profile and normalizes a saved recipient", async () => {
  const s = billingProfileStore(pool);
  expect(await s.read(token)).toEqual({ kind: "ready", value: null });
  expect(await s.save(token, profile)).toEqual({
    kind: "ready",
    value: { ...profile, email: "recipient@example.invalid", revision: 1 },
  });
  expect(query).toHaveBeenLastCalledWith(
    expect.stringContaining("INSERT INTO billing_profiles"),
    ["owned", profile.name, "recipient@example.invalid", 1],
  );
  current = { ...profile, email: "recipient@example.invalid", revision: 1 };
  expect(await s.read(token)).toEqual({ kind: "ready", value: current });
  expect(await s.save(token, { ...profile, revision: 1 })).toMatchObject({
    kind: "ready",
    value: { revision: 2 },
  });
  expect(observe).toHaveBeenCalledWith([expiry]);
});
it("BILLPROFILE02 rejects malformed credentials and details before touching storage", async () => {
  const s = billingProfileStore(pool);
  for (const value of [null, "", "a".repeat(63)])
    expect(await s.read(value as string)).toEqual({ kind: "denied" });
  for (const input of [
    null,
    undefined,
    {},
    { ...profile, name: "" },
    { ...profile, name: "a".repeat(201) },
    { ...profile, email: null },
    { ...profile, email: "bad" },
    { ...profile, revision: -1 },
    { ...profile, revision: NaN },
  ])
    expect(await s.save(token, input as typeof profile)).toEqual({
      kind: "invalid",
    });
  expect(query).not.toHaveBeenCalled();
});
it("BILLPROFILE02 fences expired/revoked/missing members, deletion and stale edits", async () => {
  const s = billingProfileStore(pool);
  member = null;
  expect(await s.read(token)).toEqual({ kind: "denied" });
  member = { id: "owned", expires: expiry };
  workspace = false;
  expect(await s.save(token, profile)).toEqual({ kind: "denied" });
  workspace = true;
  expect(await s.save(token, { ...profile, revision: 1 })).toEqual({
    kind: "conflict",
  });
  current = { ...profile, revision: 2 };
  expect(await s.save(token, profile)).toEqual({ kind: "conflict" });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it("BILLPROFILE02 reports uncertain storage and authority failures without retry", async () => {
  const s = billingProfileStore(pool);
  for (const error of [
    Error("offline"),
    new PracticeLifetimeFailure("unavailable"),
    new PracticeLifetimeFailure("denied"),
  ]) {
    vi.mocked(practiceTransaction).mockRejectedValueOnce(error);
    expect(await s.read(token)).toEqual({
      kind:
        error instanceof PracticeLifetimeFailure && error.kind === "denied"
          ? "denied"
          : "unavailable",
    });
  }
});
