import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { studyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { hash } from "../../src/store.ts";
import { STUDY_FIXTURE_POLICY } from "../../src/study-unit-fixture-values.ts";
import type { StudyFixtureRow } from "../../src/study-unit-fixture-transaction.ts";
const memberId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const key = "55555555-5555-4555-8555-555555555555";
const grantId = "66666666-6666-4666-8666-666666666666";
const owner = "a".repeat(64),
  admin = "b".repeat(64);
const at = new Date("2030-01-01T12:00:00.000Z"),
  expires = new Date(+at + 3600000);
function requestInstruction() {
  return {
    policy: STUDY_FIXTURE_POLICY,
    administratorId: adminId,
    memberExpiresAt: expires.toISOString(),
    administratorExpiresAt: expires.toISOString(),
    checkedAt: at.toISOString(),
    expiresAt: new Date(+at + 1800000).toISOString(),
  };
}
function issueInstruction() {
  return {
    policy: STUDY_FIXTURE_POLICY,
    requestId,
    requestExpiresAt: new Date(+at + 1800000).toISOString(),
    checkedAt: at.toISOString(),
    expiresAt: new Date(+at + 900000).toISOString(),
  };
}
function saved(): StudyFixtureRow {
  return {
    id: requestId,
    memberId,
    workspaceId,
    policy: STUDY_FIXTURE_POLICY,
    administratorId: adminId,
    memberExpiresAt: expires,
    administratorExpiresAt: expires,
    checkedAt: at,
    createdAt: at,
    expiresAt: new Date(+at + 1800000),
    grantId: null,
    issuedAt: null,
    grantExpiresAt: null,
    withdrawnAt: null,
  };
}
function fixture(
  options: { mode: "test" | "demo" | "live"; enabled: boolean } = {
    mode: "test",
    enabled: true,
  },
) {
  const state = {
    discovery: true,
    workspace: true,
    source: null as StudyFixtureRow | null,
    member: {
      id: memberId,
      kind: "member",
      expires,
      revoked: null as Date | null,
    },
    administrator: {
      id: adminId,
      kind: "staff",
      expires,
      revoked: null as Date | null,
    } as {
      id: string;
      kind: string;
      expires: Date;
      revoked: Date | null;
    } | null,
    profile: "platform_admin" as string | null,
    current: at,
    operations: new Map<
      string,
      {
        actorId: string | null;
        workspaceId: string | null;
        requestId: string | null;
        kind: string | null;
        digest: string | null;
      }
    >(),
    fail: "",
    event: null as { request_fingerprint: string; result_id: string } | null,
    grant: null as {
      id: string;
      available: number;
      expired_at: Date | null;
    } | null,
    ledgerSource: true,
    updateWinner: true,
  };
  let actor = memberId;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (state.fail && sql.includes(state.fail))
      throw Error("Invented private query failure");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [
        {
          observed: state.current,
          remaining: String(+new Date(values[0] as Date) - +state.current),
        },
      ];
    else if (sql.includes("FROM principals WHERE token_hash")) {
      actor = values[0] === hash(admin) ? adminId : memberId;
      const selected = actor === adminId ? state.administrator : state.member;
      rows =
        state.discovery && selected
          ? [{ id: actor, expires: selected.expires }]
          : [];
    } else if (sql.includes("FROM principals") && sql.includes("FOR SHARE")) {
      const selected =
        values[0] === memberId
          ? state.member
          : values[0] === adminId
            ? state.administrator
            : null;
      rows = selected ? [selected] : [];
    } else if (sql.includes("FROM staff_profiles"))
      rows =
        state.profile === null ? [] : [{ id: adminId, role: state.profile }];
    else if (sql.includes("FROM workspaces"))
      rows = state.workspace ? [{ id: workspaceId }] : [];
    else if (sql.includes("SELECT member_id AS"))
      rows = state.source
        ? [
            {
              memberId: state.source.memberId,
              administratorId: state.source.administratorId,
            },
          ]
        : [];
    else if (sql.includes("SELECT id,member_id AS"))
      rows = state.source ? [state.source] : [];
    else if (sql.includes("FROM browser_study_fixture_operations")) {
      const entry = state.operations.get(values[0] as string);
      rows = entry ? [entry] : [];
    } else if (sql.startsWith("INSERT INTO browser_study_fixture_requests")) {
      state.source = {
        ...saved(),
        id: values[0] as string,
        memberId: values[1] as string,
        workspaceId: values[2] as string,
        administratorId: values[3] as string,
        memberExpiresAt: new Date(values[5] as string),
        administratorExpiresAt: new Date(values[6] as string),
        checkedAt: new Date(values[7] as string),
        expiresAt: new Date(values[8] as string),
      };
    } else if (sql.startsWith("INSERT INTO browser_study_fixture_operations")) {
      state.operations.set(values[0] as string, {
        actorId: values[1] as string,
        workspaceId: values[2] as string,
        requestId: values[3] as string,
        kind: values[4] as string,
        digest: values[5] as string,
      });
    } else if (
      sql.startsWith("UPDATE browser_study_fixture_requests SET grant_id")
    ) {
      Object.assign(state.source!, {
        grantId: values[1],
        issuedAt: values[2],
        grantExpiresAt: new Date(values[3] as string),
      });
    } else if (
      sql.startsWith("UPDATE browser_study_fixture_requests SET withdrawn")
    )
      state.source!.withdrawnAt = state.current;
    else if (sql.includes("SELECT r.id FROM browser_study_fixture_requests"))
      rows = state.ledgerSource ? [{ id: requestId }] : [];
    else if (sql.startsWith("SELECT 1 FROM learners")) rows = [{ allowed: 1 }];
    else if (sql.startsWith("INSERT INTO synthetic_entitlement_grants")) {
      state.grant = { id: values[0] as string, available: 3, expired_at: null };
      rows = [{ id: values[0] }];
    } else if (
      sql.startsWith("SELECT withdrawn_at FROM browser_study_fixture_requests")
    )
      rows =
        state.ledgerSource && state.source?.withdrawnAt
          ? [{ withdrawn_at: state.source.withdrawnAt }]
          : [];
    else if (
      sql.includes(
        "SELECT expired_at,available FROM synthetic_entitlement_grants",
      )
    )
      rows = state.grant ? [state.grant] : [];
    else if (sql.includes("FROM synthetic_entitlement_events"))
      rows = state.event ? [state.event] : [];
    else if (sql.startsWith("INSERT INTO synthetic_entitlement_events")) {
      state.event = {
        request_fingerprint: values[7] as string,
        result_id: values[8] as string,
      };
    } else if (
      sql.startsWith("UPDATE synthetic_entitlement_grants SET expired")
    ) {
      if (state.updateWinner) {
        state.grant!.available = 0;
        state.grant!.expired_at = state.current;
        rows = [{ id: grantId }];
      }
    }
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  return {
    state,
    query,
    connect,
    release,
    store: studyUnitFixtureStore({ connect } as unknown as Pool, options),
  };
}
function ready<T>(result: { kind: string; value?: T }): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready fixture");
  return result.value!;
}
it("TESTISSUE-01 captures finite selected scope, saves one owner request and exact replays without another write", async () => {
  const f = fixture();
  const checked = ready(await f.store.checkRequest(owner, adminId));
  expect(checked).toEqual(requestInstruction());
  const first = ready(await f.store.request(owner, key, checked));
  const replay = ready(await f.store.request(owner, key, checked));
  expect(replay).toEqual(first);
  expect(ready(await f.store.member(owner)).receipt).toEqual(first);
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO browser_study_fixture_requests"),
    ),
  ).toHaveLength(1);
  expect(await f.store.request(owner, grantId, checked)).toEqual({
    kind: "conflict",
  });
  expect(await f.store.checkRequest(owner, adminId)).toEqual({
    kind: "conflict",
  });
});
it("TESTISSUE-02 issues once through one caller connection and preserves original source grant and operation", async () => {
  const f = fixture();
  f.state.source = saved();
  const checked = ready(await f.store.checkIssue(admin, requestId));
  expect(checked).toEqual(issueInstruction());
  const first = ready(await f.store.issue(admin, key, checked));
  expect(first.grantId).toBe(f.state.grant!.id);
  expect(ready(await f.store.issue(admin, key, checked))).toEqual(first);
  expect(ready(await f.store.permission(admin, requestId)).receipt).toEqual(
    first,
  );
  expect(await f.store.checkIssue(admin, requestId)).toEqual({
    kind: "denied",
  });
  expect(await f.store.issue(admin, workspaceId, checked)).toEqual({
    kind: "conflict",
  });
});
it("TESTISSUE-05 pending owner withdrawal remains available while creation is paused and keeps its slot", async () => {
  const f = fixture({ mode: "demo", enabled: false });
  f.state.source = saved();
  expect(ready(await f.store.member(owner)).creationEnabled).toBe(false);
  expect(ready(await f.store.administrator(admin)).creationEnabled).toBe(false);
  const original = ready(await f.store.withdraw(owner, key, requestId));
  expect(original.withdrawnAt).toEqual(at);
  expect(ready(await f.store.withdraw(owner, key, requestId))).toEqual(
    original,
  );
  expect(await f.store.withdraw(owner, grantId, requestId)).toEqual({
    kind: "conflict",
  });
  expect(await f.store.checkRequest(owner, adminId)).toEqual({
    kind: "denied",
  });
  expect(await f.store.request(owner, key, requestInstruction())).toEqual({
    kind: "denied",
  });
  expect(await f.store.checkIssue(admin, requestId)).toEqual({
    kind: "denied",
  });
  expect(await f.store.issue(admin, key, issueInstruction())).toEqual({
    kind: "denied",
  });
});
it("TESTISSUE-05 issued owner withdrawal records only an exact source expiry and keeps a replay receipt", async () => {
  const f = fixture();
  f.state.source = {
    ...saved(),
    grantId,
    issuedAt: at,
    grantExpiresAt: new Date(+at + 900000),
  };
  f.state.grant = { id: grantId, available: 3, expired_at: null };
  const result = ready(await f.store.withdraw(owner, key, requestId));
  expect(result.withdrawnAt).toEqual(at);
  expect(f.state.grant.available).toBe(0);
  expect(ready(await f.store.withdraw(owner, key, requestId))).toEqual(result);
});
it("TESTISSUE-06 original request, issue and withdrawal inspection only reads exact retained operations", async () => {
  for (const kind of ["request", "issue", "withdraw"] as const) {
    const f = fixture();
    f.state.source = saved();
    const input =
      kind === "request"
        ? requestInstruction()
        : kind === "issue"
          ? issueInstruction()
          : requestId;
    const instruction = kind === "withdraw" ? { requestId } : input;
    const actorId = kind === "issue" ? adminId : memberId;
    expect(
      ready(
        await f.store.inspect(
          kind === "issue" ? admin : owner,
          key,
          kind,
          input,
        ),
      ),
    ).toBeNull();
    f.state.operations.set(key, {
      actorId,
      workspaceId,
      requestId,
      kind,
      digest: hash(JSON.stringify(instruction)),
    });
    expect(
      ready(
        await f.store.inspect(
          kind === "issue" ? admin : owner,
          key,
          kind,
          input,
        ),
      )?.id,
    ).toBe(requestId);
    expect(
      f.query.mock.calls.some(
        ([sql]) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"),
      ),
    ).toBe(false);
  }
  const f = fixture();
  expect(
    ready(await f.store.inspect(owner, key, "withdraw", requestId)),
  ).toBeNull();
});
it.each(["live"] as const)(
  "TESTISSUE-08 %s mode denies all fixture use before acquiring a connection",
  async (mode) => {
    const f = fixture({ mode, enabled: true });
    expect(await f.store.member(owner)).toEqual({ kind: "denied" });
    expect(await f.store.administrator(admin)).toEqual({ kind: "denied" });
    expect(await f.store.permission(admin, requestId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.withdraw(owner, key, requestId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.inspect(owner, key, "withdraw", requestId)).toEqual({
      kind: "denied",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("TESTISSUE-03 malformed identifiers/instructions do not acquire database authority", async () => {
  const f = fixture();
  expect(await f.store.checkRequest(owner, "bad")).toEqual({ kind: "invalid" });
  expect(await f.store.request(owner, "bad", requestInstruction())).toEqual({
    kind: "invalid",
  });
  expect(await f.store.request(owner, key, {})).toEqual({ kind: "invalid" });
  expect(await f.store.checkIssue(admin, "bad")).toEqual({ kind: "invalid" });
  expect(await f.store.issue(admin, "bad", issueInstruction())).toEqual({
    kind: "invalid",
  });
  expect(await f.store.issue(admin, key, {})).toEqual({ kind: "invalid" });
  expect(await f.store.withdraw(owner, "bad", requestId)).toEqual({
    kind: "invalid",
  });
  expect(await f.store.withdraw(owner, key, "bad")).toEqual({
    kind: "invalid",
  });
  expect(await f.store.permission(admin, "bad")).toEqual({ kind: "denied" });
  expect(await f.store.inspect(owner, "bad", "withdraw", requestId)).toEqual({
    kind: "denied",
  });
  expect(await f.store.inspect(owner, key, "request", {})).toEqual({
    kind: "denied",
  });
  expect(await f.store.inspect(owner, key, "issue", {})).toEqual({
    kind: "denied",
  });
  expect(await f.store.inspect(owner, key, "withdraw", {})).toEqual({
    kind: "denied",
  });
  expect(await f.store.inspect(owner, key, "withdraw", "bad")).toEqual({
    kind: "denied",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("TESTISSUE-03 own empty state contains no receipt and no automatic grant", async () => {
  const f = fixture();
  expect(ready(await f.store.member(owner)).receipt).toBeNull();
  expect(ready(await f.store.administrator(admin)).reference).toBe(adminId);
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
for (const boundary of [
  "missing",
  "member-kind",
  "revoked",
  "wrong-role",
  "no-role",
] as const)
  it(`TESTISSUE-02 selected administrator ${boundary} cannot authorize a checked request or write`, async () => {
    const f = fixture();
    if (boundary === "missing") f.state.administrator = null;
    if (boundary === "member-kind") f.state.administrator!.kind = "member";
    if (boundary === "revoked") f.state.administrator!.revoked = at;
    if (boundary === "wrong-role") f.state.profile = "coach";
    if (boundary === "no-role") f.state.profile = null;
    expect(await f.store.checkRequest(owner, adminId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.request(owner, key, requestInstruction())).toEqual({
      kind: "denied",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });
for (const boundary of [
  "missing-credential",
  "revoked-member",
  "wrong-member-kind",
  "deleted-workspace",
] as const)
  it(`TESTISSUE-03 ${boundary} cannot read, inspect, withdraw or acquire a new policy slot`, async () => {
    const f = fixture();
    f.state.source = saved();
    if (boundary === "missing-credential") f.state.discovery = false;
    if (boundary === "revoked-member") f.state.member.revoked = at;
    if (boundary === "wrong-member-kind") f.state.member.kind = "staff";
    if (boundary === "deleted-workspace") f.state.workspace = false;
    expect(await f.store.member(owner)).toEqual({ kind: "denied" });
    expect(await f.store.withdraw(owner, key, requestId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.inspect(owner, key, "withdraw", requestId)).toEqual({
      kind: "denied",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
for (const boundary of [
  "missing-source",
  "erased-administrator",
  "other-administrator",
  "revoked-member",
  "wrong-member-kind",
  "changed-workspace",
  "wrong-request-id",
] as const)
  it(`TESTISSUE-02 exact source ${boundary} cannot transfer issuance or reveal an original receipt`, async () => {
    const f = fixture();
    f.state.source = saved();
    if (boundary === "missing-source") f.state.source = null;
    if (boundary === "erased-administrator")
      f.state.source!.administratorId = null;
    if (boundary === "other-administrator")
      f.state.source!.administratorId = grantId;
    if (boundary === "revoked-member") f.state.member.revoked = at;
    if (boundary === "wrong-member-kind") f.state.member.kind = "staff";
    if (boundary === "changed-workspace") f.state.source!.workspaceId = grantId;
    if (boundary === "wrong-request-id") f.state.source!.id = grantId;
    expect(await f.store.permission(admin, requestId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.issue(admin, key, issueInstruction())).toEqual({
      kind: "denied",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });
it("TESTISSUE-04 a renewed original member or administrator lifetime cannot replace a previously reviewed request", async () => {
  for (const actor of ["member", "administrator"] as const) {
    const f = fixture();
    f.state[actor]!.expires = new Date(+expires + 1000);
    expect(await f.store.request(owner, key, requestInstruction())).toEqual({
      kind: "denied",
    });
    expect(f.state.source).toBeNull();
  }
});
it("TESTISSUE-03 future checked instants cannot create or issue a fixture", async () => {
  const f = fixture();
  expect(
    await f.store.request(owner, key, {
      ...requestInstruction(),
      checkedAt: new Date(+at + 1000).toISOString(),
    }),
  ).toEqual({ kind: "denied" });
  f.state.source = saved();
  expect(
    await f.store.issue(admin, key, {
      ...issueInstruction(),
      checkedAt: new Date(+at + 1000).toISOString(),
    }),
  ).toEqual({ kind: "denied" });
});
it("TESTISSUE-04 issued or withdrawn policy slots cannot be checked or issued with another key", async () => {
  for (const retained of ["issued", "withdrawn"] as const) {
    const f = fixture();
    f.state.source = saved();
    if (retained === "issued") f.state.source.grantId = grantId;
    else f.state.source.withdrawnAt = at;
    expect(await f.store.checkIssue(admin, requestId)).toEqual({
      kind: "denied",
    });
    expect(await f.store.issue(admin, key, issueInstruction())).toEqual({
      kind: "conflict",
    });
  }
});
it("TESTISSUE-04 changed request deadline or shorter current source authority invalidates an offered issuance", async () => {
  for (const boundary of ["request", "member", "administrator"] as const) {
    const f = fixture();
    f.state.source = saved();
    if (boundary === "request")
      f.state.source.expiresAt = new Date(+at + 1700000);
    else f.state[boundary]!.expires = new Date(+at + 600000);
    expect(await f.store.issue(admin, key, issueInstruction())).toEqual({
      kind: "denied",
    });
    expect(f.state.grant).toBeNull();
  }
});
it("TESTISSUE-06 changed actor/workspace/scope or an anonymized reserved key cannot be replayed", async () => {
  const original = {
    actorId: memberId,
    workspaceId,
    requestId,
    kind: "withdraw",
    digest: hash(JSON.stringify({ requestId })),
  };
  for (const field of [
    "actorId",
    "workspaceId",
    "requestId",
    "kind",
    "digest",
  ] as const) {
    const f = fixture();
    f.state.source = saved();
    f.state.operations.set(key, { ...original, [field]: null });
    expect(await f.store.withdraw(owner, key, requestId)).toEqual({
      kind: "conflict",
    });
    expect(await f.store.inspect(owner, key, "withdraw", requestId)).toEqual({
      kind: "conflict",
    });
    expect(f.state.source.withdrawnAt).toBeNull();
  }
});
it("TESTISSUE-06 database failure is unavailable with a rollback and one acquired connection, never automatic redispatch", async () => {
  const f = fixture();
  f.state.fail = "INSERT INTO browser_study_fixture_requests";
  expect(await f.store.request(owner, key, requestInstruction())).toEqual({
    kind: "unavailable",
  });
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(
    1,
  );
  expect(f.release).toHaveBeenCalledTimes(1);
});
it("TESTISSUE-03 invalid session tokens cannot acquire a reader transaction", async () => {
  const f = fixture();
  expect(await f.store.member("bad")).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it("TESTISSUE-02 missing exact ledger source cannot create a grant through the caller connection", async () => {
  const f = fixture();
  f.state.source = saved();
  f.state.ledgerSource = false;
  expect(await f.store.issue(admin, key, issueInstruction())).toEqual({
    kind: "unavailable",
  });
  expect(f.state.grant).toBeNull();
});
it.each(["missing-source", "missing-grant", "no-update-winner"] as const)(
  "TESTISSUE-05 issued withdrawal %s is unavailable rather than falsely acknowledged",
  async (boundary) => {
    const f = fixture();
    f.state.source = {
      ...saved(),
      grantId,
      issuedAt: at,
      grantExpiresAt: new Date(+at + 900000),
    };
    f.state.grant = { id: grantId, available: 3, expired_at: null };
    if (boundary === "missing-source") f.state.ledgerSource = false;
    if (boundary === "missing-grant") f.state.grant = null;
    if (boundary === "no-update-winner") f.state.updateWinner = false;
    expect(await f.store.withdraw(owner, key, requestId)).toEqual({
      kind: "unavailable",
    });
    expect(f.state.operations.size).toBe(0);
  },
);
it("TESTISSUE-05 naturally settled expiry is not another withdrawal balance event", async () => {
  const f = fixture();
  f.state.source = {
    ...saved(),
    grantId,
    issuedAt: at,
    grantExpiresAt: new Date(+at + 900000),
  };
  f.state.grant = { id: grantId, available: 0, expired_at: at };
  expect(
    ready(await f.store.withdraw(owner, key, requestId)).withdrawnAt,
  ).toEqual(at);
  expect(
    f.query.mock.calls.some(
      ([sql]) =>
        sql.startsWith("UPDATE synthetic_entitlement_grants") ||
        sql.startsWith("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toBe(false);
});
