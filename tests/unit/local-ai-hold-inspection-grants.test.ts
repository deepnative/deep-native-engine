import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import { localAiHoldInspectionGrants } from "../../src/local-ai-hold-inspection-grants.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const tx = vi.hoisted(() => ({
  query: vi.fn(),
  observe: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../src/sample-feedback-lifetime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/sample-feedback-lifetime.ts")
  >()),
  sampleFeedbackTransaction: tx.run,
}));
const pool = {} as Pool,
  token = "a".repeat(64);
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const admin = id(1),
  operator = id(2),
  member = id(3),
  job = id(4),
  key = id(5),
  grantId = id(6);
function fixture() {
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 60000),
    authorityExpires = new Date(Date.now() + 3600000);
  const state = {
    target: true,
    actor: true,
    owner: true,
    operator: true,
    actorKind: "staff",
    ownerKind: "member",
    operatorKind: "staff",
    actorRole: "platform_admin",
    operatorRole: "operator",
    operatorCurrent: true,
    workspace: true,
    job: true,
    eligible: true,
    insert: true,
    revocationTarget: true,
    exactGrant: true,
    revoked: null as Date | null,
    prior: undefined as
      | {
          id: string;
          jobId: string;
          staffId: string;
          starts: Date;
          expires: Date;
        }
      | undefined,
  };
  tx.query.mockImplementation(async (sql: string, values: unknown[]) => {
    let rows: unknown[] = [];
    if (
      sql.startsWith(
        'SELECT member_id AS "memberId" FROM local_ai_test_unit_jobs',
      )
    )
      rows = state.target ? [{ memberId: member }] : [];
    else if (sql.startsWith('SELECT member_id AS "memberId",job_id'))
      rows = state.revocationTarget ? [{ memberId: member, jobId: job }] : [];
    else if (sql.includes('token_hash AS "tokenHash"'))
      rows = [
        ...(state.actor
          ? [
              {
                id: admin,
                tokenHash: hash(token),
                kind: state.actorKind,
                expires: authorityExpires,
              },
            ]
          : []),
        ...(state.owner ? [{ id: member, kind: state.ownerKind }] : []),
        ...(state.operator
          ? [
              {
                id: operator,
                kind: state.operatorKind,
                expires: authorityExpires,
              },
            ]
          : []),
      ];
    else if (sql.includes("FROM principals WHERE id=$1"))
      rows = state.operatorCurrent ? [{ id: operator }] : [];
    else if (sql.includes("FROM staff_profiles"))
      rows = [
        { id: admin, role: state.actorRole },
        { id: operator, role: state.operatorRole },
      ];
    else if (sql.includes("FROM workspaces"))
      rows = state.workspace ? [{ memberId: member }] : [];
    else if (
      sql.startsWith("SELECT j.id") ||
      sql.startsWith("SELECT id FROM adapter_jobs")
    )
      rows = state.job ? [{ id: job }] : [];
    else if (sql.startsWith("SELECT 1 WHERE"))
      rows = state.eligible ? [{}] : [];
    else if (sql.startsWith("INSERT INTO local_ai_hold_inspection_grants"))
      rows = state.insert ? [{ id: values[0] }] : [];
    else if (sql.includes("WHERE granted_by=$1"))
      rows = state.prior ? [state.prior] : [];
    else if (sql.startsWith("SELECT revoked_at AS revoked"))
      rows = state.exactGrant ? [{ revoked: state.revoked }] : [];
    else if (!/^(INSERT|UPDATE)/.test(sql))
      throw Error("Unexpected database test operation");
    return { rows, rowCount: rows.length };
  });
  const grants = localAiHoldInspectionGrants(pool, true);
  return {
    state,
    starts,
    expires,
    authorityExpires,
    grants,
    grant: () => grants.grant(token, job, operator, starts, expires, key),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  tx.run.mockImplementation(async (_pool, _write, use) => use(tx));
  tx.observe.mockResolvedValue(undefined);
});
it("creates only the exact metadata purpose and atomic content-free grant event", async () => {
  const f = fixture();
  const result = await f.grant();
  expect(result.kind).toBe("applied");
  expect(tx.run.mock.calls[0]?.[1]).toBe(true);
  const inserts = tx.query.mock.calls.filter(([sql]) =>
    sql.startsWith("INSERT"),
  );
  expect(inserts).toHaveLength(2);
  expect(inserts[0]?.[1].slice(1)).toEqual([
    job,
    member,
    operator,
    "local-ai-hold-inspection-test-v1",
    f.starts,
    f.expires,
    admin,
    key,
  ]);
  expect(inserts[1]?.[0]).toContain("'grant-created'");
  expect(JSON.stringify(inserts)).not.toContain(token);
});
it.each([
  "target",
  "actor",
  "owner",
  "operator",
  "operatorCurrent",
  "workspace",
  "job",
  "eligible",
] as const)(
  "denies unavailable %s without grant/event writes",
  async (field) => {
    const f = fixture();
    f.state[field] = false;
    expect(await f.grant()).toEqual({ kind: "denied" });
    expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  },
);
it.each([
  "actorKind",
  "ownerKind",
  "operatorKind",
  "actorRole",
  "operatorRole",
] as const)("denies mismatched %s", async (field) => {
  const f = fixture();
  f.state[field] = "other";
  expect(await f.grant()).toEqual({ kind: "denied" });
});
it("rejects self-assignment and validity beyond current principal lifetimes", async () => {
  const f = fixture();
  expect(
    await f.grants.grant(token, job, admin, f.starts, f.expires, key),
  ).toEqual({ kind: "denied" });
  expect(
    await f.grants.grant(
      token,
      job,
      operator,
      f.starts,
      new Date(+f.authorityExpires + 1),
      key,
    ),
  ).toEqual({ kind: "denied" });
});
it("accepts an unchanged instruction replay but refuses each changed contract field", async () => {
  const f = fixture();
  f.state.insert = false;
  const prior = {
    id: grantId,
    jobId: job,
    staffId: operator,
    starts: f.starts,
    expires: f.expires,
  };
  f.state.prior = prior;
  expect(await f.grant()).toEqual({ kind: "replayed", grantId });
  for (const change of [
    { jobId: id(99) },
    { staffId: id(99) },
    { starts: new Date(+f.starts - 1) },
    { expires: new Date(+f.expires - 1) },
  ]) {
    f.state.prior = { ...prior, ...change };
    expect(await f.grant()).toEqual({ kind: "conflict" });
  }
  expect(
    tx.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO local_ai_hold_inspection_events"),
    ),
  ).toHaveLength(0);
  f.state.prior = undefined;
  expect(await f.grant()).toEqual({ kind: "unavailable" });
});
it("rejects malformed grant instructions before acquiring authority", async () => {
  const f = fixture();
  const args = [token, job, operator, f.starts, f.expires, key] as const;
  for (const [index, value] of [
    [0, "bad"],
    [1, "bad"],
    [2, "bad"],
    [3, "not a date"],
    [3, new Date(NaN)],
    [4, "not a date"],
    [4, new Date(NaN)],
    [4, f.starts],
    [5, "bad"],
  ] as const) {
    const changed = [...args];
    changed[index] = value as never;
    expect(
      await f.grants.grant(...(changed as unknown as typeof args)),
    ).toEqual({ kind: "denied" });
  }
  expect(tx.run).not.toHaveBeenCalled();
  expect(await localAiHoldInspectionGrants(pool, false).grant(...args)).toEqual(
    { kind: "unavailable" },
  );
});
it.each([
  "revocationTarget",
  "actor",
  "owner",
  "workspace",
  "job",
  "exactGrant",
] as const)("cannot revoke without current %s", async (field) => {
  const f = fixture();
  f.state[field] = false;
  expect(await f.grants.revoke(token, grantId)).toEqual({ kind: "denied" });
  expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
    false,
  );
});
it("revokes an exact grant once and keeps prior identity/history on replay", async () => {
  const f = fixture();
  expect(await f.grants.revoke(token, grantId)).toEqual({
    kind: "applied",
    grantId,
  });
  f.state.revoked = new Date();
  expect(await f.grants.revoke(token, grantId)).toEqual({
    kind: "replayed",
    grantId,
  });
  expect(
    tx.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE")),
  ).toHaveLength(1);
  expect(
    tx.query.mock.calls.filter(([sql]) => sql.includes("'grant-revoked'")),
  ).toHaveLength(1);
});
it("denies malformed revoke boundaries without database work", async () => {
  const f = fixture();
  expect(await f.grants.revoke("bad", grantId)).toEqual({ kind: "denied" });
  expect(await f.grants.revoke(token, "bad")).toEqual({ kind: "denied" });
  expect(tx.run).not.toHaveBeenCalled();
});
it.each([
  new SampleFeedbackFailure("denied"),
  new SampleFeedbackFailure("unavailable"),
  Error("invented private database error"),
])("withholds grant/revoke after transaction failure", async (error) => {
  const f = fixture();
  tx.run.mockRejectedValue(error);
  const expected = {
    kind:
      error instanceof SampleFeedbackFailure && error.kind === "denied"
        ? "denied"
        : "unavailable",
  };
  expect(await f.grant()).toEqual(expected);
  expect(await f.grants.revoke(token, grantId)).toEqual(expected);
});
