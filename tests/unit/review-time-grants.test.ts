import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
import { hash } from "../../src/store.ts";
const admin = "11111111-1111-4111-8111-111111111111",
  reviewer = "22222222-2222-4222-8222-222222222222",
  allocation = "33333333-3333-4333-8333-333333333333",
  key = "44444444-4444-4444-8444-444444444444",
  token = "a".repeat(64);
function fixture() {
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 60000);
  const state = {
    admin: true,
    reviewer: true,
    adminKind: "staff",
    reviewerKind: "staff",
    adminRole: "platform_admin",
    reviewerRole: "reviewer",
    workspace: true,
    source: true,
    allocation: true,
    eligible: true,
    expired: false,
    fail: false,
    prior: null as null | {
      id: string;
      allocationId: string;
      reviewerId: string;
      starts: Date;
      expires: Date;
    },
    grant: true,
    revoked: null as Date | null,
  };
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (state.fail) throw Error("private grant diagnostic");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [
        { remaining: "60000", valid: !state.expired, observed: new Date() },
      ];
    else if (sql.includes('token_hash AS "tokenHash"'))
      rows = [
        ...(state.admin
          ? [
              {
                id: admin,
                tokenHash: hash(token),
                kind: state.adminKind,
                expires,
              },
            ]
          : []),
        ...(state.reviewer
          ? [
              {
                id: reviewer,
                tokenHash: "other",
                kind: state.reviewerKind,
                expires,
              },
            ]
          : []),
      ];
    else if (sql.includes("FROM principals WHERE"))
      rows = state.admin ? [{ id: admin, expires }] : [];
    else if (sql.includes("SELECT principal_id AS id,role"))
      rows = [
        { id: admin, role: state.adminRole },
        { id: reviewer, role: state.reviewerRole },
      ];
    else if (sql.includes("SELECT 1 FROM staff_profiles"))
      rows = state.adminRole === "platform_admin" ? [{}] : [];
    else if (sql.includes("FROM workspaces w"))
      rows = state.workspace ? [{ id: allocation }] : [];
    else if (sql.includes("FROM evidence_objects e"))
      rows = state.source ? [{ id: allocation }] : [];
    else if (sql.includes("SELECT id FROM review_time_allocations"))
      rows = state.allocation ? [{ id: allocation }] : [];
    else if (sql.includes("idempotency_key=$2"))
      rows = state.prior ? [state.prior] : [];
    else if (sql.includes("SELECT 1 WHERE $1::timestamptz"))
      rows = state.eligible ? [{}] : [];
    else if (sql.includes("SELECT revoked_at AS revoked"))
      rows = state.grant ? [{ revoked: state.revoked }] : [];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn(),
    pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
  const grants = reviewTimeGrants(pool, { enabled: true, mode: "test" });
  return {
    state,
    starts,
    expires,
    statements,
    release,
    grants,
    grant: () =>
      grants.grant(token, allocation, reviewer, starts, expires, key),
  };
}
it.each([
  "admin",
  "reviewer",
  "workspace",
  "source",
  "allocation",
  "eligible",
] as const)("does not issue a grant when %s is unavailable", async (field) => {
  const f = fixture();
  f.state[field] = false;
  expect(await f.grant()).toEqual({ kind: "denied" });
  expect(f.statements.some((s) => s.startsWith("INSERT"))).toBe(false);
});
it.each(["adminKind", "reviewerKind", "adminRole", "reviewerRole"] as const)(
  "denies a mismatched %s",
  async (field) => {
    const f = fixture();
    f.state[field] = "member";
    expect(await f.grant()).toEqual({ kind: "denied" });
    expect(f.statements).not.toContain("COMMIT");
  },
);
it("creates a grant only after both principals and exact allocation are checked", async () => {
  const f = fixture();
  const result = await f.grant();
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied") throw Error("Expected grant");
  expect(result.grantId).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.statements.at(-1)).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledTimes(1);
});
it("replays only the original exact grant payload", async () => {
  const f = fixture();
  const prior = {
    id: key,
    allocationId: allocation,
    reviewerId: reviewer,
    starts: f.starts,
    expires: f.expires,
  };
  f.state.prior = prior;
  expect(await f.grant()).toEqual({ kind: "replayed", grantId: key });
  for (const change of [
    { allocationId: admin },
    { reviewerId: admin },
    { starts: new Date(+f.starts - 1000) },
    { expires: new Date(+f.expires + 1000) },
  ]) {
    f.state.prior = { ...prior, ...change };
    expect(await f.grant()).toEqual({ kind: "conflict" });
  }
  expect(f.statements.some((s) => s.startsWith("INSERT"))).toBe(false);
});
it.each([false, true])(
  "withholds grants after authority or database failure (driver=%s)",
  async (driver) => {
    const f = fixture();
    if (driver) f.state.fail = true;
    else f.state.expired = true;
    expect(await f.grant()).toEqual({
      kind: driver ? "unavailable" : "denied",
    });
    expect(f.statements).not.toContain("COMMIT");
  },
);
it.each(["admin", "workspace", "grant"] as const)(
  "cannot revoke without %s",
  async (field) => {
    const f = fixture();
    f.state[field] = false;
    expect(await f.grants.revoke(token, key)).toEqual({ kind: "denied" });
    expect(f.statements.some((s) => s.startsWith("UPDATE"))).toBe(false);
  },
);
it("requires administrator role for revocation and applies it only once", async () => {
  const f = fixture();
  f.state.adminRole = "reviewer";
  expect(await f.grants.revoke(token, key)).toEqual({ kind: "denied" });
  f.state.adminRole = "platform_admin";
  expect(await f.grants.revoke(token, key)).toEqual({
    kind: "applied",
    grantId: key,
  });
  f.state.revoked = new Date();
  expect(await f.grants.revoke(token, key)).toEqual({
    kind: "replayed",
    grantId: key,
  });
  expect(
    f.statements.filter((s) => s.startsWith("UPDATE review_time_grants")),
  ).toHaveLength(1);
});
it.each([false, true])(
  "withholds revocation after authority or database failure (driver=%s)",
  async (driver) => {
    const f = fixture();
    if (driver) f.state.fail = true;
    else f.state.expired = true;
    expect(await f.grants.revoke(token, key)).toEqual({
      kind: driver ? "unavailable" : "denied",
    });
  },
);
