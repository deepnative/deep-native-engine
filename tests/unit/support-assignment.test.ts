import { afterEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { hash } from "../../src/store.ts";
import * as lifetime from "../../src/sample-feedback-lifetime.ts";
import {
  supportAssignmentStore,
  type AssignmentInput,
  type AssignmentResult,
} from "../../src/support-assignment.ts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const admin = id(1),
  owner = id(2),
  operator = id(3),
  requestId = id(4),
  grantId = id(5),
  key = id(6),
  token = "a".repeat(64),
  past = new Date("2026-01-01T00:00:00Z"),
  future = new Date("2100-01-01T00:00:00Z");
const input: AssignmentInput = {
  requestId,
  staffId: operator,
  idempotencyKey: key,
  startsAt: past,
  expiresAt: new Date(+future - 1000),
};
const grant = () => ({
  id: grantId,
  requestId,
  staffId: operator,
  role: "operator",
  startsAt: past,
  expiresAt: input.expiresAt,
  createdAt: past,
  revokedAt: null as Date | null,
  cursorAt: "2026-01-01T00:00:00.000001Z",
  idempotencyKey: key,
  grantedBy: admin,
});
function ready<T>(result: AssignmentResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing assignment result");
  return result.value;
}
type Override = (sql: string, values: unknown[]) => unknown[] | undefined;
function fixture(
  options: {
    actor?: string;
    override?: Override;
    defaultSecret?: boolean;
  } = {},
) {
  const actor = options.actor ?? admin;
  const people = [admin, owner, operator].map((i) => ({
    id: i,
    kind: i === owner ? "member" : "staff",
    tokenHash: hash(token),
    expiresAt: future,
    active: true,
  }));
  const roles = [
    { id: admin, role: "platform_admin" },
    { id: operator, role: "operator" },
  ];
  const state = {
    actor: true,
    people,
    roles,
    workspace: true,
    deleting: false,
    request: true,
    withdrawn: false,
    grants: [] as ReturnType<typeof grant>[],
    failure: "",
    releaseFailure: false,
    remaining: "60000",
    observed: new Date(),
    handoff: true,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (state.failure && sql.startsWith(state.failure))
      throw Error("PRIVATE-DATABASE-DETAIL");
    const overridden = options.override?.(sql, values);
    if (overridden !== undefined) return { rows: overridden };
    if (sql.startsWith("WITH instant"))
      return {
        rows: [{ remaining: "60000", valid: true, observed: new Date() }],
      };
    if (sql.startsWith("WITH handoff"))
      return {
        rows: state.handoff
          ? [{ remaining: state.remaining, observed: state.observed }]
          : [],
      };
    if (sql.startsWith("SELECT id FROM principals"))
      return { rows: state.actor ? [{ id: actor }] : [] };
    if (sql.includes("FROM principals WHERE id=ANY"))
      return {
        rows: state.people.filter((p) =>
          (values[0] as string[]).includes(p.id),
        ),
      };
    if (sql.includes("FROM staff_profiles"))
      return {
        rows: state.roles.filter((p) => (values[0] as string[]).includes(p.id)),
      };
    if (sql.includes("FROM workspaces"))
      return {
        rows: state.workspace
          ? [{ memberId: owner, deletingAt: state.deleting ? past : null }]
          : [],
      };
    if (sql.includes("FROM support_requests"))
      return {
        rows: state.request
          ? [
              {
                requestId,
                memberId: owner,
                workspaceId: owner,
                withdrawnAt: state.withdrawn ? past : null,
              },
            ]
          : [],
      };
    if (sql.includes("FROM support_request_grants")) {
      const rows = sql.includes("WHERE id=ANY")
        ? state.grants.filter((g) => (values[0] as string[]).includes(g.id))
        : sql.includes("WHERE granted_by")
          ? state.grants.filter(
              (g) =>
                g.grantedBy === values[0] && g.idempotencyKey === values[1],
            )
          : sql.includes("WHERE id=$1")
            ? state.grants.filter(
                (g) => g.id === values[0] && g.requestId === values[1],
              )
            : state.grants.filter(
                (g) =>
                  g.requestId === values[0] &&
                  (!values[1] ||
                    (g.idempotencyKey === values[1] &&
                      g.grantedBy === values[2])),
              );
      return { rows };
    }
    if (sql.startsWith("INSERT INTO support_request_grants")) {
      state.grants.push({
        ...grant(),
        id: values[0] as string,
        requestId: values[1] as string,
        staffId: values[2] as string,
        role: values[3] as string,
        startsAt: values[4] as Date,
        expiresAt: values[5] as Date,
        grantedBy: values[6] as string,
        idempotencyKey: values[7] as string,
      });
    }
    if (sql.startsWith("UPDATE support_request_grants"))
      state.grants.find((g) => g.id === values[0])!.revokedAt = new Date();
    return { rows: [] };
  });
  const release = vi.fn(() => {
    if (state.releaseFailure) throw Error("PRIVATE-HANDBACK");
  });
  const connect = vi.fn(
      async () => ({ query, release }) as unknown as PoolClient,
    ),
    pool = { connect } as unknown as Pool;
  return {
    state,
    query,
    release,
    connect,
    store: options.defaultSecret
      ? supportAssignmentStore(pool)
      : supportAssignmentStore(pool, "unit-assignment-secret"),
  };
}
afterEach(() => vi.restoreAllMocks());
it("SUPADM-07-RECOVERY an unexpected transaction-boundary exception remains sanitized and is never retried", async () => {
  const transaction = vi
    .spyOn(lifetime, "sampleFeedbackTransaction")
    .mockRejectedValueOnce(Error("PRIVATE-TRANSACTION-BOUNDARY"));
  expect(await fixture().store.admin(token)).toEqual({ kind: "unavailable" });
  expect(transaction).toHaveBeenCalledOnce();
});
it("SUPADM-01-REFERENCES current own operator and admin exact eligibility expose only their bounded reference metadata", async () => {
  const f = fixture({ actor: operator, defaultSecret: true });
  expect(ready(await f.store.reference(token))).toEqual({
    staffId: operator,
    expiresAt: future,
  });
  const g = fixture();
  expect(ready(await g.store.admin(token))).toBeNull();
  expect(ready(await g.store.check(token, requestId, operator))).toEqual({
    requestId,
    staffId: operator,
    expiresAt: future,
  });
  expect(
    g.query.mock.calls.some(([s]) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
});
it("SUPADM-02-ASSIGN and SUPADM-03-IDEMPOTENCY record, replay, conflict and revoke without widening role or restoring revoked work", async () => {
  const f = fixture(),
    saved = ready(await f.store.assign(token, input));
  expect(saved.disposition).toBe("created");
  expect(ready(await f.store.assign(token, input))).toEqual({
    ...saved,
    disposition: "replayed",
  });
  expect(
    await f.store.assign(token, {
      ...input,
      expiresAt: new Date(+input.expiresAt - 1),
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    ready(await f.store.revoke(token, requestId, saved.grantId)).disposition,
  ).toBe("revoked");
  expect(
    ready(await f.store.revoke(token, requestId, saved.grantId)).disposition,
  ).toBe("already-revoked");
  expect(await f.store.assign(token, input)).toEqual({ kind: "conflict" });
  const events = f.query.mock.calls.filter(([s]) =>
    s.startsWith("INSERT INTO support_request_events"),
  );
  expect(events.map(([, v]) => v![4])).toEqual([
    "grant-created",
    "grant-revoked",
  ]);
});
it("SUPADM-02-ASSIGN refuses overlong expiry rather than modifying the confirmed window", async () => {
  const f = fixture();
  expect(
    await f.store.assign(token, { ...input, expiresAt: new Date(+future + 1) }),
  ).toEqual({ kind: "invalid" });
  expect(f.state.grants).toEqual([]);
});
it("SUPADM-05-BOUNDARIES malformed identifiers, credentials and nonfinite or inverted windows deny before connection", async () => {
  const f = fixture();
  expect(await f.store.admin("invalid")).toEqual({ kind: "denied" });
  for (const field of ["requestId", "staffId", "idempotencyKey"] as const)
    expect(
      await f.store.assign(token, { ...input, [field]: "invalid" }),
    ).toEqual({ kind: "denied" });
  for (const patch of [
    { startsAt: "not-date" },
    { expiresAt: "not-date" },
    { startsAt: new Date(NaN) },
    { expiresAt: new Date(NaN) },
    { expiresAt: past },
    { expiresAt: new Date(+past - 1) },
  ])
    expect(
      await f.store.assign(token, { ...input, ...patch } as AssignmentInput),
    ).toEqual({ kind: "denied" });
  expect(await f.store.check(token, "bad", operator)).toEqual({
    kind: "denied",
  });
  expect(await f.store.check(token, requestId, "bad")).toEqual({
    kind: "denied",
  });
  expect(await f.store.history(token, "bad")).toEqual({ kind: "denied" });
  expect(await f.store.history(token, requestId, undefined, "bad")).toEqual({
    kind: "denied",
  });
  expect(await f.store.history(token, requestId, "cursor", key)).toEqual({
    kind: "denied",
  });
  expect(await f.store.revoke(token, "bad", grantId)).toEqual({
    kind: "denied",
  });
  expect(await f.store.revoke(token, requestId, "bad")).toEqual({
    kind: "denied",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("SUPADM-05-BOUNDARIES missing, replaced, inactive and nonstaff actor locks cannot authorize metadata", async () => {
  const missing = fixture();
  missing.state.actor = false;
  expect(await missing.store.admin(token)).toEqual({ kind: "denied" });
  for (const patch of [
    { kind: "member" },
    { active: false },
    { tokenHash: hash("b".repeat(64)) },
  ]) {
    const f = fixture();
    Object.assign(f.state.people[0]!, patch);
    expect(await f.store.admin(token)).toEqual({ kind: "denied" });
  }
  const absent = fixture();
  absent.state.people.shift();
  expect(await absent.store.admin(token)).toEqual({ kind: "denied" });
  const role = fixture();
  role.state.roles[0]!.role = "coach";
  expect(await role.store.admin(token)).toEqual({ kind: "denied" });
});
it("SUPADM-01-REFERENCES refuses missing unsafe workspaces, wrong-kind targets and withdrawn or inactive new assignments", async () => {
  for (const property of ["request", "workspace"] as const) {
    const f = fixture();
    f.state[property] = false;
    expect(await f.store.check(token, requestId, operator)).toEqual({
      kind: "denied",
    });
  }
  for (const property of ["deleting", "withdrawn"] as const) {
    const f = fixture();
    f.state[property] = true;
    expect(await f.store.check(token, requestId, operator)).toEqual({
      kind: "denied",
    });
  }
  for (const index of [1, 2]) {
    const f = fixture();
    f.state.people[index]!.active = false;
    expect(await f.store.check(token, requestId, operator)).toEqual({
      kind: "denied",
    });
  }
  const wrongOwner = fixture();
  wrongOwner.state.people[1]!.kind = "staff";
  expect(await wrongOwner.store.check(token, requestId, operator)).toEqual({
    kind: "denied",
  });
  const wrongStaff = fixture();
  wrongStaff.state.people[2]!.kind = "member";
  expect(await wrongStaff.store.check(token, requestId, operator)).toEqual({
    kind: "denied",
  });
  const role = fixture();
  role.state.roles[1]!.role = "coach";
  expect(await role.store.check(token, requestId, operator)).toEqual({
    kind: "denied",
  });
  const self = fixture();
  expect(await self.store.check(token, requestId, admin)).toEqual({
    kind: "denied",
  });
});
it("SUPADM-06-LIFETIME rechecks exact request/workspace/grant mapping after locks", async () => {
  for (const override of [
    (s: string) =>
      s.includes("FROM workspaces")
        ? [{ memberId: id(99), deletingAt: null }]
        : undefined,
    (s: string) =>
      s.includes("FROM support_requests") && s.includes("FOR SHARE")
        ? []
        : undefined,
    (s: string) =>
      s.includes("FROM support_requests") && s.includes("FOR SHARE")
        ? [{ memberId: id(99), workspaceId: owner }]
        : undefined,
    (s: string) =>
      s.includes("FROM support_requests") && s.includes("FOR SHARE")
        ? [{ memberId: owner, workspaceId: id(99) }]
        : undefined,
  ]) {
    const f = fixture({ override });
    expect(await f.store.check(token, requestId, operator)).toEqual({
      kind: "denied",
    });
  }
  for (const patch of [
    null,
    { requestId: id(99) },
    { staffId: id(99) },
    { cursorAt: "changed" },
  ]) {
    const f = fixture({
      override: (s) =>
        s.includes("WHERE id=ANY") && s.includes("support_request_grants")
          ? patch
            ? [{ ...grant(), ...patch }]
            : []
          : undefined,
    });
    f.state.grants = [grant()];
    expect(await f.store.history(token, requestId)).toEqual({ kind: "denied" });
  }
  for (const patch of [null, { requestId: id(99) }, { staffId: id(99) }]) {
    const f = fixture({
      override: (s) =>
        s.includes("WHERE id=ANY") && s.includes("support_request_grants")
          ? patch
            ? [{ ...grant(), ...patch }]
            : []
          : undefined,
    });
    f.state.grants = [grant()];
    expect(await f.store.revoke(token, requestId, grantId)).toEqual({
      kind: "denied",
    });
  }
  expect(await fixture().store.revoke(token, requestId, grantId)).toEqual({
    kind: "denied",
  });
});
it("SUPADM-08-READS-ROLLBACK projects historical states without imposing their expiry as admin authority", async () => {
  const f = fixture();
  f.state.grants = [
    grant(),
    { ...grant(), id: id(7), startsAt: future },
    { ...grant(), id: id(8), expiresAt: past },
    { ...grant(), id: id(9), revokedAt: past },
  ];
  expect(
    ready(await f.store.history(token, requestId)).items.map((i) => i.state),
  ).toEqual(["current", "scheduled", "expired", "revoked"]);
  for (const change of [
    () => {
      f.state.withdrawn = true;
    },
    () => {
      f.state.people[2]!.active = false;
    },
    () => {
      f.state.people[2]!.expiresAt = past;
    },
    () => {
      f.state.roles[1]!.role = "coach";
    },
    () => {
      f.state.people[1]!.active = false;
    },
    () => {
      f.state.people[1]!.expiresAt = past;
    },
  ]) {
    f.state.withdrawn = false;
    f.state.people[1]!.active = true;
    f.state.people[1]!.expiresAt = future;
    f.state.people[2]!.active = true;
    f.state.people[2]!.expiresAt = future;
    f.state.roles[1]!.role = "operator";
    change();
    expect(ready(await f.store.history(token, requestId)).items[0]!.state).toBe(
      "ineffective",
    );
  }
  expect(ready(await f.store.assign(token, input)).disposition).toBe(
    "replayed",
  );
  expect(
    ready(await f.store.revoke(token, requestId, grantId)).disposition,
  ).toBe("revoked");
});
it("SUPADM-08-READS-ROLLBACK bounds each exact page and permits only scoped cursor and own key recovery", async () => {
  const f = fixture();
  f.state.grants = Array.from({ length: 21 }, (_, n) => ({
    ...grant(),
    id: id(10 + n),
  }));
  const page = ready(await f.store.history(token, requestId));
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeTruthy();
  expect((await f.store.history(token, requestId, page.nextCursor!)).kind).toBe(
    "ready",
  );
  expect(await f.store.history(token, requestId, "forged")).toEqual({
    kind: "denied",
  });
  expect(
    ready(await f.store.history(token, requestId, undefined, id(99))).items,
  ).toEqual([]);
  expect(
    ready(await f.store.history(token, requestId, undefined, key)).items,
  ).toHaveLength(20);
  expect(
    f.query.mock.calls.some(([s]) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
});
it("SUPADM-06-LIFETIME withholds malformed/late final observations and returns only a conservative finite deadline", async () => {
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
    expect(await f.store.admin(token)).toEqual({
      kind: remaining === "0" || remaining === "-1" ? "denied" : "unavailable",
    });
  }
  const absent = fixture();
  absent.state.handoff = false;
  expect(await absent.store.admin(token)).toEqual({ kind: "unavailable" });
  for (const observed of [undefined, new Date(NaN)]) {
    const f = fixture();
    f.state.observed = observed as Date;
    expect(await f.store.admin(token)).toEqual({ kind: "unavailable" });
  }
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const f = fixture(),
    r = await f.store.admin(token);
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("No result");
  expect(r.deadline).toBe(11000);
  expect(r.deadline).toBeGreaterThan(performance.now());
});
it("SUPADM-07-RECOVERY sanitizes acquisition/query/audit/commit/rollback/release failures with no automatic retry", async () => {
  for (const failure of [
    "BEGIN",
    "SET LOCAL",
    "SELECT set_config",
    "SELECT id FROM principals",
    "SELECT id,kind",
    "WITH instant",
    "SELECT principal_id",
    "SELECT id AS",
    "SELECT owner_principal_id",
    "INSERT INTO support_request_grants",
    "INSERT INTO support_request_events",
    "WITH handoff",
    "COMMIT",
  ]) {
    const f = fixture();
    f.state.failure = failure;
    expect(await f.store.assign(token, input)).toEqual({ kind: "unavailable" });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  }
  const connect = fixture();
  connect.connect.mockRejectedValueOnce(Error("PRIVATE-ACQUIRE"));
  expect(await connect.store.admin(token)).toEqual({ kind: "unavailable" });
  const release = fixture();
  release.state.releaseFailure = true;
  expect(await release.store.admin(token)).toEqual({ kind: "unavailable" });
  const rollback = fixture();
  rollback.state.roles = [];
  rollback.state.failure = "ROLLBACK";
  expect(await rollback.store.admin(token)).toEqual({ kind: "unavailable" });
});
