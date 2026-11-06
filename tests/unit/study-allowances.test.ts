import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { hash } from "../../src/store.ts";
import { studyAllowanceStore } from "../../src/study-allowances.ts";

const memberId = "11111111-1111-4111-8111-111111111111",
  workspaceId = "33333333-3333-4333-8333-333333333333",
  key = "55555555-5555-4555-8555-555555555555",
  owner = "a".repeat(64);
const at = new Date("2030-01-15T12:00:00.000Z"),
  expires = new Date("2030-06-01T00:00:00.000Z"),
  start = new Date("2030-01-01T00:00:00.000Z"),
  end = new Date("2030-02-01T00:00:00.000Z");
const version = "study-allowance-test-v1";
const instruction = {
  policyVersion: version,
  periodStart: start.toISOString(),
};
const saved = {
  id: "c",
  policyVersion: version,
  quantity: 5,
  periodStart: start,
  periodEnd: end,
  createdAt: at,
  available: 5,
  reserved: 0,
  consumed: 0,
  expired: 0,
};
function fixture(
  enabled = true,
  mode: "test" | "demo" | "live" = "test",
  practiceUnits?: boolean,
) {
  const state = {
    actor: true,
    claim: null as typeof saved | null,
    mockClaim: null as typeof saved | null,
    claimByKey: null as typeof saved | null,
    policy: { version, periodLimit: 5 } as {
      version: string;
      periodLimit: number;
    } | null,
    fail: "",
    inserted: [] as unknown[][],
    grants: [] as unknown[][],
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (state.fail && sql.includes(state.fail)) throw Error("Invented failure");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [
        {
          observed: at,
          remaining: String(+new Date(values[0] as Date) - +at),
        },
      ];
    else if (sql.includes("FROM principals WHERE token_hash"))
      rows = state.actor ? [{ id: memberId, expires }] : [];
    else if (sql.includes("FROM principals") && sql.includes("FOR SHARE"))
      rows = [{ id: memberId, kind: "member", expires, revoked: null }];
    else if (sql.includes("FROM workspaces")) rows = [{ id: workspaceId }];
    else if (sql.includes("FROM study_allowance_policies"))
      rows = state.policy ? [state.policy] : [];
    else if (sql.includes("c.operation_key=$2"))
      rows = state.claimByKey ? [state.claimByKey] : [];
    else if (sql.includes("c.category='mock_sessions' AND c.period_start=$2"))
      rows = state.mockClaim ? [state.mockClaim] : [];
    else if (sql.includes("c.period_start=$2"))
      rows = state.claim ? [state.claim] : [];
    else if (sql.includes("FROM learners l JOIN principals")) rows = [{}];
    else if (sql.includes("INSERT INTO synthetic_entitlement_grants"))
      state.grants.push(values);
    else if (sql.startsWith("INSERT INTO study_allowance_claims")) {
      state.inserted.push(values);
      if (values[9] === "mock_sessions") state.mockClaim = saved;
      else state.claim = saved;
    }
    return { rows, rowCount: rows.length };
  });
  const client = {
    query,
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return {
    state,
    query,
    store: studyAllowanceStore(pool, { mode, enabled, practiceUnits }),
  };
}

it("ALLOW-01 reads the policy, month and absence of a claim without writing", async () => {
  const f = fixture();
  const result = await f.store.member(owner);
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      policy: { version },
      period: { start, end },
      claim: null,
      creationEnabled: true,
    },
  });
  expect(f.query).toHaveBeenCalledWith(expect.any(String), [hash(owner)]);
  expect(f.state.grants).toEqual([]);
  expect(f.state.inserted).toEqual([]);
});
it("ALLOW-06 an unset policy and a paused store still read", async () => {
  const f = fixture(false);
  f.state.policy = null;
  expect(await f.store.member(owner)).toMatchObject({
    kind: "ready",
    value: { policy: null, creationEnabled: false },
  });
});
it("ALLOW-06 denies live mode, an unknown member and a malformed credential", async () => {
  expect((await fixture(true, "live").store.member(owner)).kind).toBe("denied");
  expect(
    (await fixture(true, "live").store.claim(owner, key, instruction)).kind,
  ).toBe("denied");
  const f = fixture();
  f.state.actor = false;
  expect((await f.store.member(owner)).kind).toBe("denied");
  expect((await f.store.member("short")).kind).toBe("denied");
});
it("ALLOW-02 grants exactly the policy limit until the month ends and records the claim", async () => {
  const f = fixture();
  const result = await f.store.claim(owner, key, instruction);
  expect(result).toMatchObject({ kind: "ready", value: saved });
  expect(f.state.grants).toHaveLength(1);
  expect(f.state.grants[0]!.slice(1)).toEqual([
    memberId,
    "study_requests",
    5,
    at.toISOString(),
    end.toISOString(),
  ]);
  expect(f.state.inserted[0]!.slice(1, 7)).toEqual([
    memberId,
    workspaceId,
    version,
    start,
    end,
    5,
  ]);
  expect(f.state.inserted[0]![8]).toBe(key);
});
it("ALLOW-03 an exact replay returns the original claim and grants nothing", async () => {
  const f = fixture();
  f.state.claimByKey = saved;
  expect(await f.store.claim(owner, key, instruction)).toMatchObject({
    kind: "ready",
    value: saved,
  });
  expect(f.state.grants).toEqual([]);
});
it.each([
  [{ ...instruction, policyVersion: "study-allowance-test-v2" }],
  [{ ...instruction, periodStart: "2030-02-01T00:00:00.000Z" }],
])(
  "ALLOW-03 a reused key with a changed instruction conflicts",
  async (changed) => {
    const f = fixture();
    f.state.claimByKey = saved;
    expect((await f.store.claim(owner, key, changed)).kind).toBe("conflict");
    expect(f.state.grants).toEqual([]);
  },
);
it("ALLOW-03 another key in a claimed month returns the original claim", async () => {
  const f = fixture();
  f.state.claim = saved;
  expect(await f.store.claim(owner, key, instruction)).toMatchObject({
    kind: "ready",
    value: saved,
  });
  expect(f.state.grants).toEqual([]);
});
it("ALLOW-04 a form from another month conflicts", async () => {
  const f = fixture();
  const result = await f.store.claim(owner, key, {
    ...instruction,
    periodStart: "2029-12-01T00:00:00.000Z",
  });
  expect(result.kind).toBe("conflict");
  expect(f.state.grants).toEqual([]);
});
it.each([[{ version: "study-allowance-test-v2", periodLimit: 7 }], [null]])(
  "ALLOW-05 a superseded version conflicts: %j",
  async (policy) => {
    const f = fixture();
    f.state.policy = policy;
    expect((await f.store.claim(owner, key, instruction)).kind).toBe(
      "conflict",
    );
    expect(f.state.grants).toEqual([]);
  },
);
it("ALLOW-06 refuses a malformed key or instruction, and any claim while paused", async () => {
  const f = fixture();
  expect((await f.store.claim(owner, "bad", instruction)).kind).toBe("invalid");
  expect((await f.store.claim(owner, key, { period: 1 })).kind).toBe("invalid");
  expect((await fixture(false).store.claim(owner, key, instruction)).kind).toBe(
    "denied",
  );
});
it("ALLOW-03 a failed grant or claim write reports unavailable, never success", async () => {
  for (const fail of [
    "INSERT INTO synthetic_entitlement_grants",
    "INSERT INTO study_allowance_claims",
    "COMMIT",
  ]) {
    const f = fixture();
    f.state.fail = fail;
    expect((await f.store.claim(owner, key, instruction)).kind).toBe(
      "unavailable",
    );
  }
});
const mockInstruction = {
  policyVersion: "mock-allowance-test-v1",
  periodStart: start.toISOString(),
};
it("MOCK-07 practice claims are refused and hidden unless practice units are on", async () => {
  const f = fixture();
  await expect(f.store.claim(owner, key, mockInstruction)).resolves.toEqual({
    kind: "denied",
  });
  expect(await f.store.member(owner)).toMatchObject({
    value: { practice: null },
  });
  f.state.mockClaim = saved;
  expect(await f.store.member(owner)).toMatchObject({
    value: { practice: { claim: saved } },
  });
});
it("MOCK-01 a practice claim uses its own category, key and slot", async () => {
  const f = fixture(true, "test", true);
  f.state.policy = { version: "mock-allowance-test-v1", periodLimit: 3 };
  f.state.claim = saved;
  const claimed = await f.store.claim(owner, key, mockInstruction);
  expect(claimed.kind).toBe("ready");
  expect(f.state.inserted[0]?.[9]).toBe("mock_sessions");
  expect(f.state.grants[0]).toEqual(
    expect.arrayContaining(["mock_sessions", 3]),
  );
  expect(
    f.query.mock.calls.some(
      ([, values]) => values?.[0] === `mock-allowance:${memberId}:2030-01`,
    ),
  ).toBe(true);
  expect(await f.store.member(owner)).toMatchObject({
    value: { practice: { policy: { periodLimit: 3 }, claim: saved } },
  });
});
