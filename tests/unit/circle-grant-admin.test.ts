import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import { hash } from "../../src/store.ts";
import type {
  CircleGrantInput,
  CircleGrantResult,
} from "../../src/circle-grant-values.ts";
const actor = "00000000-0000-4000-8000-000000000001",
  target = "00000000-0000-4000-8000-000000000002",
  grantId = "00000000-0000-4000-8000-000000000003",
  key = "00000000-0000-4000-8000-000000000004",
  other = "00000000-0000-4000-8000-000000000005";
const token = "a".repeat(64),
  at = new Date("2026-10-06T12:00:00.000Z"),
  expiry = new Date(+at + 3600000),
  credentialExpiry = new Date(+at + 7200000),
  scope = { staffId: target, circleId: "everyday-ai" };
const input: CircleGrantInput = {
  ...scope,
  idempotencyKey: key,
  expiresAt: expiry,
};
type Row = Record<string, unknown>;
function fixture(
  options = {
    mode: "test" as "test" | "demo" | "live",
    writes: true,
    discussion: true,
  },
) {
  const person = (id: string): Row => ({
    id,
    kind: "staff",
    tokenHash: id === actor ? hash(token) : hash("b".repeat(64)),
    expiresAt: credentialExpiry,
    active: true,
  });
  const saved: Row = {
    ...scope,
    grantId,
    role: "moderator",
    purpose: "circle-discussion-test-v1",
    createdBy: actor,
    idempotencyKey: key,
    startsAt: at,
    expiresAt: expiry,
    createdAt: at,
    revokedAt: null,
  };
  const state = {
    actorFound: true,
    people: [person(actor), person(target)],
    roles: [
      { id: actor, role: "platform_admin" },
      { id: target, role: "moderator" },
    ],
    grants: [] as Row[],
    audit: [] as Row[],
    candidates: undefined as string[] | undefined,
    future: true,
    futureMissing: false,
    insertWinner: null as Row | null,
    insertNoWinner: false,
    changedMissing: false,
    fail: "",
  };
  const statements: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (state.fail && sql.includes(state.fail))
      throw Error("private database detail");
    let rows: Row[] = [];
    if (sql.includes("WITH instant"))
      rows = [{ remaining: "10000", observed: at }];
    else if (sql.startsWith("SELECT id FROM principals"))
      rows = state.actorFound ? [{ id: actor }] : [];
    else if (sql.includes('token_hash AS "tokenHash"'))
      rows = state.people.filter((p) =>
        (values[0] as string[]).includes(p.id as string),
      );
    else if (sql.includes("FROM staff_profiles"))
      rows = state.roles.filter((p) => (values[0] as string[]).includes(p.id));
    else if (sql.includes("timestamptz>clock_timestamp()"))
      rows = state.futureMissing ? [] : [{ valid: state.future }];
    else if (sql.startsWith("INSERT INTO preview_circle_moderator_grants")) {
      if (state.insertWinner) {
        state.grants.push(state.insertWinner);
        rows = [];
      } else if (!state.insertNoWinner) {
        const row = {
          ...saved,
          grantId: values[0],
          staffId: values[1],
          role: values[2],
          circleId: values[3],
          purpose: values[4],
          createdBy: values[5],
          idempotencyKey: values[6],
          expiresAt: values[7],
        };
        state.grants.push(row);
        rows = [row];
      }
    } else if (sql.startsWith("INSERT INTO preview_circle_grant_audit"))
      state.audit.push({
        grantId: values[2],
        actorId: values[0],
        staffId: values[1],
        circleId: values[3],
        action: sql.includes("'created'") ? "created" : "revoked",
        at,
      });
    else if (sql.startsWith("UPDATE preview_circle_moderator_grants")) {
      if (!state.changedMissing) {
        const row = state.grants.find((g) => g.grantId === values[0]);
        if (row) {
          row.revokedAt = at;
          rows = [{ revokedAt: at }];
        }
      }
    } else if (sql.startsWith("WITH retained"))
      rows = (
        state.candidates ??
        [
          ...new Set(
            [...state.grants, ...state.audit]
              .filter(
                (g) => g.staffId === values[0] && g.circleId === values[1],
              )
              .map((g) => g.grantId as string),
          ),
        ].sort()
      )
        .filter((id) => !values[2] || id > (values[2] as string))
        .slice(0, 21)
        .map((id) => ({ id }));
    else if (sql.startsWith("SELECT id FROM preview_circle_moderator_grants"))
      rows = state.grants
        .filter(
          (g) =>
            g.idempotencyKey === values[0] &&
            g.createdBy === values[1] &&
            g.staffId === values[2] &&
            g.circleId === values[3],
        )
        .map((g) => ({ id: g.grantId }));
    else if (sql.includes("FROM preview_circle_moderator_grants")) {
      if (sql.includes("WHERE idempotency_key=$1"))
        rows = state.grants.filter((g) => g.idempotencyKey === values[0]);
      else if (sql.includes("id=ANY"))
        rows = state.grants.filter(
          (g) =>
            (values[0] as string[]).includes(g.grantId as string) &&
            g.staffId === values[1] &&
            g.circleId === values[2],
        );
      else
        rows = state.grants.filter(
          (g) =>
            g.grantId === values[0] &&
            g.staffId === values[1] &&
            g.circleId === values[2],
        );
    } else if (sql.includes("FROM preview_circle_grant_audit"))
      rows = state.audit.filter(
        (g) =>
          g.staffId === values[0] &&
          g.circleId === values[1] &&
          (values[2] as string[]).includes(g.grantId as string),
      );
    return { rows };
  });
  const release = vi.fn(),
    connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const store = circleGrantAdminStore(
    { connect } as unknown as Pool,
    "invented-native-store-secret",
    options,
  );
  return { store, state, saved, statements, connect, release };
}
function ready<T>(result: CircleGrantResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected invented ready result");
  return result.value;
}
it("CIRADM-01 derives own identity and reference from current selected staff authority", async () => {
  const f = fixture();
  expect(ready(await f.store.admin(token))).toEqual({
    reference: {
      staffId: actor,
      role: "platform_admin",
      expiresAt: credentialExpiry,
    },
    creationEnabled: true,
  });
  f.state.roles[0]!.role = "moderator";
  expect(ready(await f.store.reference(token))).toEqual({
    staffId: actor,
    role: "moderator",
    expiresAt: credentialExpiry,
  });
  expect(await f.store.admin(token)).toEqual({ kind: "denied" });
  expect(
    ready(
      await fixture({
        mode: "demo",
        writes: true,
        discussion: true,
      }).store.reference(token),
    ).role,
  ).toBe("platform_admin");
});
it("CIRADM-01 supports explicit self-target without using a caller-supplied actor or role", async () => {
  const f = fixture();
  expect(
    ready(await f.store.check(token, "self", scope.circleId)),
  ).toMatchObject({
    staffId: actor,
    role: "platform_admin",
    circleId: scope.circleId,
  });
  expect(
    ready(await f.store.check(token, target, scope.circleId)),
  ).toMatchObject({ staffId: target, role: "moderator" });
});
it.each(["malformed", "", "b".repeat(64)])(
  "CIRADM-05 denies absent or unselected staff credentials %s",
  async (credential) => {
    const f = fixture();
    if (credential.length === 64) f.state.actorFound = false;
    expect(await f.store.admin(credential)).toEqual({ kind: "denied" });
  },
);
it("CIRADM-08 denies live mode and pauses creation without blocking retained history/revocation", async () => {
  const live = fixture({ mode: "live", writes: true, discussion: true });
  expect(await live.store.admin(token)).toEqual({ kind: "denied" });
  expect(live.connect).not.toHaveBeenCalled();
  for (const options of [
    { mode: "test" as const, writes: false, discussion: true },
    { mode: "test" as const, writes: true, discussion: false },
  ]) {
    const f = fixture(options);
    f.state.grants.push({ ...f.saved });
    expect(ready(await f.store.admin(token)).creationEnabled).toBe(false);
    expect(await f.store.create(token, input)).toEqual({ kind: "denied" });
    expect(
      ready(
        await f.store.inspect(token, scope, { kind: "grant", value: grantId }),
      ),
    ).toMatchObject({ grantId });
    expect(ready(await f.store.revoke(token, scope, grantId))).toMatchObject({
      state: "revoked",
    });
  }
});
it.each(["missing", "member", "inactive", "rotated", "role"])(
  "CIRADM-05 denies %s actor authority after locked reread",
  async (change) => {
    const f = fixture();
    if (change === "missing")
      f.state.people = f.state.people.filter((p) => p.id !== actor);
    else if (change === "role") f.state.roles[0]!.role = "reviewer";
    else
      Object.assign(
        f.state.people[0]!,
        change === "member"
          ? { kind: "member" }
          : change === "inactive"
            ? { active: false }
            : { tokenHash: hash("c".repeat(64)) },
      );
    expect(await f.store.admin(token)).toEqual({ kind: "denied" });
    expect(await f.store.reference(token)).toEqual({ kind: "denied" });
  },
);
it.each(["missing", "member", "inactive", "role", "date"])(
  "CIRADM-01 denies %s current target while retaining historical inspection",
  async (change) => {
    const f = fixture();
    if (change === "missing")
      f.state.people = f.state.people.filter((p) => p.id !== target);
    else if (change === "role") f.state.roles[1]!.role = "reviewer";
    else
      Object.assign(
        f.state.people[1]!,
        change === "member"
          ? { kind: "member" }
          : change === "inactive"
            ? { active: false }
            : { expiresAt: new Date(NaN) },
      );
    expect(await f.store.check(token, target, scope.circleId)).toEqual({
      kind: "denied",
    });
    f.state.grants.push({ ...f.saved });
    expect(
      ready(
        await f.store.inspect(token, scope, { kind: "grant", value: grantId }),
      ),
    ).toMatchObject({ state: "ineffective" });
  },
);
it("CIRADM-02 rejects invalid references and finite windows before creation", async () => {
  const f = fixture();
  expect(await f.store.check(token, "invalid", scope.circleId)).toEqual({
    kind: "invalid",
  });
  expect(await f.store.check(token, target, "unknown")).toEqual({
    kind: "invalid",
  });
  for (const bad of [
    { staffId: "bad" },
    { circleId: "unknown" },
    { idempotencyKey: "bad" },
    { expiresAt: new Date(NaN) },
    { expiresAt: "invalid" },
  ])
    expect(
      await f.store.create(token, { ...input, ...bad } as CircleGrantInput),
    ).toEqual({ kind: "invalid" });
  expect(
    await f.store.create(token, {
      ...input,
      expiresAt: new Date(+credentialExpiry + 1),
    }),
  ).toEqual({ kind: "invalid" });
  f.state.future = false;
  expect(await f.store.create(token, input)).toEqual({ kind: "invalid" });
  f.state.futureMissing = true;
  expect(await f.store.create(token, input)).toEqual({ kind: "invalid" });
  expect(f.state.grants).toHaveLength(0);
});
it("CIRADM-02 creates one exact finite grant and content-free audit, retaining current authority", async () => {
  const f = fixture();
  const result = ready(await f.store.create(token, input));
  expect(result).toMatchObject({
    ...scope,
    role: "moderator",
    purpose: "circle-discussion-test-v1",
    expiresAt: expiry,
    state: "current",
    source: "retained",
    createdBy: actor,
  });
  expect(f.state.audit).toHaveLength(1);
  expect(f.state.audit[0]).toMatchObject({ action: "created", actorId: actor });
  expect(result).not.toHaveProperty("idempotencyKey");
  expect(ready(await f.store.create(token, input))).toEqual(result);
  expect(f.state.grants).toHaveLength(1);
  expect(f.state.audit).toHaveLength(1);
});
it.each(["staffId", "circleId", "createdBy", "expiresAt"] as const)(
  "CIRADM-04 conflicts changed saved %s without exposing a foreign instruction",
  async (field) => {
    const f = fixture();
    f.state.grants.push({
      ...f.saved,
      [field]:
        field === "expiresAt"
          ? new Date(+expiry + 1)
          : field === "circleId"
            ? "technical-practice"
            : other,
    });
    expect(await f.store.create(token, input)).toEqual({ kind: "conflict" });
    expect(f.state.audit).toHaveLength(0);
  },
);
it("CIRADM-04 handles a concurrent global-key winner without another audit or reactivation", async () => {
  const f = fixture();
  f.state.insertWinner = { ...f.saved, revokedAt: at };
  expect(ready(await f.store.create(token, input))).toMatchObject({
    grantId,
    state: "revoked",
    revokedAt: at,
  });
  expect(f.state.audit).toHaveLength(0);
  const absent = fixture();
  absent.state.insertNoWinner = true;
  expect(await absent.store.create(token, input)).toEqual({
    kind: "unavailable",
  });
});
it.each(["current", "future", "expired", "revoked", "ineffective"] as const)(
  "CIRADM-06 projects retained %s state at its observation without renewing authority",
  async (state) => {
    const f = fixture();
    f.state.grants.push({
      ...f.saved,
      startsAt: state === "future" ? new Date(+at + 1000) : at,
      expiresAt: state === "expired" ? at : expiry,
      revokedAt: state === "revoked" ? at : null,
    });
    if (state === "ineffective") f.state.people[1]!.expiresAt = at;
    expect(
      ready(
        await f.store.inspect(token, scope, { kind: "grant", value: grantId }),
      ),
    ).toMatchObject({ state });
  },
);
it("CIRADM-04 inspects keys only for their current creator/exact scope, preserving unknown outcomes", async () => {
  const f = fixture();
  f.state.grants.push({ ...f.saved });
  expect(
    ready(await f.store.inspect(token, scope, { kind: "key", value: key })),
  ).toMatchObject({ grantId });
  f.state.grants[0]!.createdBy = other;
  expect(
    ready(await f.store.inspect(token, scope, { kind: "key", value: key })),
  ).toBeNull();
  expect(
    ready(await f.store.inspect(token, scope, { kind: "grant", value: other })),
  ).toBeNull();
});
it("CIRADM-07 shows only surviving audit facts after source erasure without resurrecting key/role/window", async () => {
  const f = fixture();
  f.state.people = f.state.people.filter((p) => p.id !== target);
  f.state.audit.push(
    { ...scope, grantId, actorId: actor, action: "created", at },
    { ...scope, grantId, actorId: actor, action: "revoked", at },
  );
  expect(
    ready(
      await f.store.inspect(token, scope, { kind: "grant", value: grantId }),
    ),
  ).toEqual({
    ...scope,
    grantId,
    source: "absent",
    state: "source-absent",
    audit: [
      { actorId: actor, action: "created", at },
      { actorId: actor, action: "revoked", at },
    ],
  });
  expect(
    ready(await f.store.inspect(token, scope, { kind: "key", value: key })),
  ).toBeNull();
});
it("CIRADM-06 bounds history to 20 records and exact signed continuation, including retained and absent grants", async () => {
  const f = fixture();
  const ids = Array.from(
    { length: 21 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
  );
  f.state.grants.push(...ids.map((id) => ({ ...f.saved, grantId: id })));
  const first = ready(await f.store.history(token, scope));
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).toBeTruthy();
  const second = ready(await f.store.history(token, scope, first.nextCursor!));
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(await f.store.history(token, scope, "malformed")).toEqual({
    kind: "invalid",
  });
  const empty = ready(await fixture().store.history(token, scope));
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
});
it("CIRADM-03 revokes only one exact grant and emits no repeated audit", async () => {
  const f = fixture();
  f.state.grants.push(
    { ...f.saved },
    { ...f.saved, grantId: other, idempotencyKey: other },
  );
  expect(ready(await f.store.revoke(token, scope, grantId))).toMatchObject({
    state: "revoked",
  });
  expect(f.state.grants[1]!.revokedAt).toBeNull();
  expect(ready(await f.store.revoke(token, scope, grantId))).toMatchObject({
    state: "revoked",
  });
  expect(f.state.audit).toHaveLength(1);
  expect(await f.store.revoke(token, scope, key)).toEqual({ kind: "denied" });
  const lost = fixture();
  lost.state.grants.push({ ...lost.saved });
  lost.state.changedMissing = true;
  expect(await lost.store.revoke(token, scope, grantId)).toEqual({
    kind: "unavailable",
  });
});
it("CIRADM-05 rejects malformed inspection, history and revoke instructions without database access", async () => {
  const f = fixture();
  for (const badScope of [
    { ...scope, staffId: "bad" },
    { ...scope, circleId: "unknown" },
  ]) {
    expect(
      await f.store.inspect(token, badScope, { kind: "key", value: key }),
    ).toEqual({ kind: "invalid" });
    expect(await f.store.history(token, badScope)).toEqual({ kind: "invalid" });
    expect(await f.store.revoke(token, badScope, grantId)).toEqual({
      kind: "invalid",
    });
  }
  expect(
    await f.store.inspect(token, scope, { kind: "key", value: "bad" }),
  ).toEqual({ kind: "invalid" });
  expect(
    await f.store.inspect(token, scope, { kind: "other", value: key } as never),
  ).toEqual({ kind: "invalid" });
  expect(await f.store.revoke(token, scope, "bad")).toEqual({
    kind: "invalid",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("CIRADM-04 withholds raw database failures instead of fabricating a receipt", async () => {
  const f = fixture();
  f.state.fail = "FROM staff_profiles";
  expect(await f.store.admin(token)).toEqual({ kind: "unavailable" });
});
