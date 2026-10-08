import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { studyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  authority = authorizationStore(pool);
const enabled = studyUnitFixtureStore(pool, { mode: "test", enabled: true });
const paused = studyUnitFixtureStore(pool, { mode: "test", enabled: false });
const ledger = syntheticLedger(pool);
const token = () => randomBytes(32).toString("hex");
function value<T>(result: { kind: string; value?: T }): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready")
    throw new Error("Expected authorized fixture result");
  return result.value!;
}
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
});
afterAll(async () => pool.end());
async function fixture() {
  const owner = token(),
    admin = token();
  await members.create(owner, { background: "explorer", goal: "everyday" });
  const session = await members.session(owner);
  if (session.kind !== "active") throw new Error("Expected invented member");
  const administratorId = await authority.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const checked = value(await enabled.checkRequest(owner, administratorId));
  const requestKey = randomUUID();
  const request = value(await enabled.request(owner, requestKey, checked));
  return {
    owner,
    memberId: session.learner.id,
    admin,
    administratorId,
    checked,
    requestKey,
    request,
  };
}
async function issued() {
  const f = await fixture();
  const issueChecked = value(await enabled.checkIssue(f.admin, f.request.id));
  const issueKey = randomUUID();
  const receipt = value(await enabled.issue(f.admin, issueKey, issueChecked));
  return { ...f, issueChecked, issueKey, receipt };
}
it("TESTISSUE-02/04 exactly selected issuance and canonical replays create one linked immutable three-unit grant", async () => {
  const f = await issued();
  const replay = value(
    await enabled.issue(f.admin, f.issueKey, f.issueChecked),
  );
  expect(replay.grantId).toBe(f.receipt.grantId);
  expect(+replay.grantExpiresAt!).toBe(+f.receipt.grantExpiresAt!);
  expect(
    await enabled.issue(f.admin, randomUUID(), f.issueChecked),
  ).toMatchObject({ kind: "conflict" });
  expect(await enabled.request(f.owner, randomUUID(), f.checked)).toMatchObject(
    { kind: "conflict" },
  );
  expect(
    (
      await pool.query(
        "SELECT category,quantity FROM synthetic_entitlement_grants",
      )
    ).rows,
  ).toEqual([{ category: "study_requests", quantity: 3 }]);
  expect(
    (
      await pool.query(
        "SELECT operation,quantity FROM synthetic_entitlement_events",
      )
    ).rows,
  ).toEqual([{ operation: "grant", quantity: 3 }]);
  const outsider = token();
  await authority.provisionStaff(
    outsider,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  expect(await enabled.permission(outsider, f.request.id)).toMatchObject({
    kind: "denied",
  });
  expect(
    await enabled.issue(outsider, f.issueKey, f.issueChecked),
  ).toMatchObject({ kind: "denied" });
});
it("TESTISSUE-05 withdrawal preserves held and consumed units and a later hold release cannot revive withdrawn units", async () => {
  const f = await issued();
  const grantId = f.receipt.grantId!;
  const held = await ledger.reserve(f.memberId, grantId, 1, "fixture-held");
  const used = await ledger.reserve(f.memberId, grantId, 1, "fixture-used");
  await ledger.settleCompletion(f.memberId, used, "fixture-consume", {
    reference: "synthetic:fixture-study",
    category: "study_requests",
    quantity: 1,
  });
  await expect(
    ledger.expire(f.memberId, grantId, "premature-natural-expiry"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const key = randomUUID();
  value(await enabled.withdraw(f.owner, key, f.request.id));
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 1, consumed: 1, expired: 1 }]);
  await ledger.release(f.memberId, held, "fixture-later-release");
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [grantId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 0, consumed: 1, expired: 2 }]);
  value(await enabled.withdraw(f.owner, key, f.request.id));
  expect(
    (
      await pool.query(
        "SELECT quantity FROM synthetic_entitlement_events WHERE idempotency_key=$1",
        [`browser-study-fixture-withdraw:${f.request.id}`],
      )
    ).rows,
  ).toEqual([{ quantity: 1 }]);
  expect(await enabled.request(f.owner, randomUUID(), f.checked)).toMatchObject(
    { kind: "conflict" },
  );
});
it("TESTISSUE-05/08 paused creation still permits owner withdrawal and retains the cancelled policy slot", async () => {
  const f = await fixture();
  expect(await paused.checkRequest(f.owner, f.administratorId)).toMatchObject({
    kind: "denied",
  });
  expect(await paused.checkIssue(f.admin, f.request.id)).toMatchObject({
    kind: "denied",
  });
  const cancelled = value(
    await paused.withdraw(f.owner, randomUUID(), f.request.id),
  );
  expect(cancelled.withdrawnAt).not.toBeNull();
  expect(cancelled.grantId).toBeNull();
  expect(value(await paused.member(f.owner)).receipt?.id).toBe(f.request.id);
  expect(await enabled.checkIssue(f.admin, f.request.id)).toMatchObject({
    kind: "denied",
  });
  expect(await enabled.request(f.owner, randomUUID(), f.checked)).toMatchObject(
    { kind: "conflict" },
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("TESTISSUE-07 reapplication preserves populated linkage; member erasure removes owned facts and anonymizes original operation reservations", async () => {
  const f = await issued();
  await migrate(pool);
  expect(value(await enabled.member(f.owner)).receipt?.grantId).toBe(
    f.receipt.grantId,
  );
  await members.remove(f.memberId);
  expect(
    (await pool.query("SELECT * FROM browser_study_fixture_requests")).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rows,
  ).toEqual([]);
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_events")).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT actor_id,workspace_id,request_id,kind,instruction_hash FROM browser_study_fixture_operations",
      )
    ).rows,
  ).toEqual([
    {
      actor_id: null,
      workspace_id: null,
      request_id: null,
      kind: null,
      instruction_hash: null,
    },
    {
      actor_id: null,
      workspace_id: null,
      request_id: null,
      kind: null,
      instruction_hash: null,
    },
  ]);
  expect(await enabled.member(f.owner)).toMatchObject({ kind: "denied" });
});

async function observedWaiters(fragment: string, minimum: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database()
       AND wait_event_type='Lock' AND query LIKE $1`,
      [`%${fragment}%`],
    );
    if (result.rows[0]!.n >= minimum) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected observed PostgreSQL lock waiters");
}
for (const first of ["issue", "withdraw"] as const) {
  it(`TESTISSUE-04/05 observed PostgreSQL ${first}-first ordering serializes issuance and withdrawal without reminting`, async () => {
    const f = await fixture();
    const checked = value(await enabled.checkIssue(f.admin, f.request.id));
    const blocker = await pool.connect();
    let issued: ReturnType<typeof enabled.issue> | undefined,
      withdrawn: ReturnType<typeof enabled.withdraw> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [f.memberId],
      );
      if (first === "issue")
        issued = enabled.issue(f.admin, randomUUID(), checked);
      else withdrawn = enabled.withdraw(f.owner, randomUUID(), f.request.id);
      await observedWaiters("FROM workspaces WHERE owner_principal_id", 1);
      if (first === "issue")
        withdrawn = enabled.withdraw(f.owner, randomUUID(), f.request.id);
      else issued = enabled.issue(f.admin, randomUUID(), checked);
      await observedWaiters("FROM workspaces WHERE owner_principal_id", 2);
      await blocker.query("COMMIT");
      const results = await Promise.all([issued!, withdrawn!]);
      expect(results[1].kind).toBe("ready");
      expect(results[0].kind).toBe(first === "issue" ? "ready" : "conflict");
      const row = (
        await pool.query(
          "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants",
        )
      ).rows;
      expect(row).toEqual(
        first === "issue"
          ? [{ available: 0, reserved: 0, consumed: 0, expired: 3 }]
          : [],
      );
      expect(
        value(await enabled.member(f.owner)).receipt?.withdrawnAt,
      ).not.toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await Promise.allSettled([
        ...(issued ? [issued] : []),
        ...(withdrawn ? [withdrawn] : []),
      ]);
    }
  });
}
it("TESTISSUE-07 selected administrator erasure preserves owned history but never transfers pending issuance", async () => {
  const f = await fixture();
  await pool.query("DELETE FROM principals WHERE id=$1", [f.administratorId]);
  const owned = value(await enabled.member(f.owner));
  expect(owned.receipt?.administratorId).toBeNull();
  expect(owned.receipt?.id).toBe(f.request.id);
  const replacement = token();
  await authority.provisionStaff(
    replacement,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  expect(await enabled.checkIssue(replacement, f.request.id)).toMatchObject({
    kind: "denied",
  });
  expect(await enabled.permission(replacement, f.request.id)).toMatchObject({
    kind: "denied",
  });
  value(await enabled.withdraw(f.owner, randomUUID(), f.request.id));
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
      )
    ).rows[0].n,
  ).toBe(0);
});

for (const operation of ["request", "issue", "withdraw"] as const)
  for (const boundary of ["before-commit", "after-commit", "release"] as const)
    it(`TESTISSUE-06 ${operation} ${boundary} uncertainty requires deliberate original-key inspection and never automatically repeats a write`, async () => {
      const f = operation === "withdraw" ? await issued() : await fixture();
      const key = randomUUID();
      const instruction =
        operation === "request"
          ? f.checked
          : operation === "issue"
            ? value(await enabled.checkIssue(f.admin, f.request.id))
            : f.request.id;
      // Request uncertainty must start with no existing lifetime policy slot.
      // Use a separate newly enrolled owner; never delete or reset a slot.
      let actor = operation === "issue" ? f.admin : f.owner;
      let checked = instruction;
      if (operation === "request") {
        actor = token();
        await members.create(actor, {
          background: "professional",
          goal: "work",
        });
        checked = value(await enabled.checkRequest(actor, f.administratorId));
      }
      let commits = 0,
        connections = 0;
      const faulted = {
        connect: async () => {
          connections++;
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return async (sql: string, values: unknown[] = []) => {
                  if (sql === "COMMIT") {
                    commits++;
                    if (boundary === "before-commit")
                      throw Error("Invented pre-commit interruption");
                  }
                  const result = await target.query(sql, values);
                  if (sql === "COMMIT" && boundary === "after-commit")
                    throw Error("Invented lost commit reply");
                  return result;
                };
              if (property === "release")
                return (error?: Error) => {
                  target.release(error);
                  if (boundary === "release")
                    throw Error("Invented handback interruption");
                };
              const entry = Reflect.get(target, property);
              return typeof entry === "function" ? entry.bind(target) : entry;
            },
          });
        },
      } as unknown as Pool;
      const interrupted = studyUnitFixtureStore(faulted, {
        mode: "test",
        enabled: true,
      });
      const act = (service: typeof enabled) =>
        operation === "request"
          ? service.request(actor, key, checked)
          : operation === "issue"
            ? service.issue(actor, key, checked)
            : service.withdraw(actor, key, checked as string);
      expect(await act(interrupted)).toMatchObject({ kind: "unavailable" });
      expect({ commits, connections }).toEqual({ commits: 1, connections: 1 });
      const persisted = await pool.query(
        "SELECT request_id FROM browser_study_fixture_operations WHERE operation_id=$1",
        [key],
      );
      expect(persisted.rows).toHaveLength(boundary === "before-commit" ? 0 : 1);
      const facts = await pool.query(
        "SELECT operation,quantity FROM synthetic_entitlement_events ORDER BY id",
      );
      const inspected = value(
        await enabled.inspect(actor, key, operation, checked),
      );
      if (boundary === "before-commit") expect(inspected).toBeNull();
      else expect(inspected?.id).toBe(persisted.rows[0].request_id);
      // Inspection itself cannot dispatch, grant, expire, or alter an original window.
      expect(
        (
          await pool.query(
            "SELECT operation,quantity FROM synthetic_entitlement_events ORDER BY id",
          )
        ).rows,
      ).toEqual(facts.rows);
      const recovered = value(await act(enabled));
      if (inspected) {
        expect(recovered.id).toBe(inspected.id);
        expect(recovered.grantExpiresAt).toEqual(inspected.grantExpiresAt);
        expect(recovered.withdrawnAt).toEqual(inspected.withdrawnAt);
      }
      value(await act(enabled));
      expect(
        (
          await pool.query(
            "SELECT request_id FROM browser_study_fixture_operations WHERE operation_id=$1",
            [key],
          )
        ).rows,
      ).toHaveLength(1);
      const events = (
        await pool.query(
          "SELECT operation,quantity FROM synthetic_entitlement_events",
        )
      ).rows;
      expect(events.filter((row) => row.operation === "grant")).toHaveLength(
        operation === "request" ? 0 : 1,
      );
      expect(events.filter((row) => row.operation === "expire")).toHaveLength(
        operation === "withdraw" ? 1 : 0,
      );
    });

for (const operation of ["issue", "withdraw"] as const)
  it(`TESTISSUE-04/06 ${operation} event-and-link changes roll back together when operation audit fails`, async () => {
    const f = operation === "issue" ? await fixture() : await issued();
    const key = randomUUID();
    const originalReceipt = value(await enabled.member(f.owner)).receipt!;
    const checked =
      operation === "issue"
        ? value(await enabled.checkIssue(f.admin, f.request.id))
        : f.request.id;
    let failedWrites = 0;
    const faulted = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (sql: string, values: unknown[] = []) => {
                if (
                  sql.includes("INSERT INTO browser_study_fixture_operations")
                ) {
                  failedWrites++;
                  throw Error(
                    "Invented audit write failure after ledger mutation",
                  );
                }
                return target.query(sql, values);
              };
            const entry = Reflect.get(target, property);
            return typeof entry === "function" ? entry.bind(target) : entry;
          },
        });
      },
    } as unknown as Pool;
    const unavailable = studyUnitFixtureStore(faulted, {
      mode: "test",
      enabled: true,
    });
    const invoke = (service: typeof enabled) =>
      operation === "issue"
        ? service.issue(f.admin, key, checked)
        : service.withdraw(f.owner, key, checked as string);
    expect(await invoke(unavailable)).toMatchObject({ kind: "unavailable" });
    expect(failedWrites).toBe(1);
    const unchanged = value(await enabled.member(f.owner)).receipt!;
    expect(unchanged.grantId).toBe(originalReceipt.grantId);
    expect(unchanged.withdrawnAt).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT * FROM browser_study_fixture_operations WHERE operation_id=$1",
          [key],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT operation,quantity FROM synthetic_entitlement_events",
        )
      ).rows,
    ).toEqual(
      operation === "issue" ? [] : [{ operation: "grant", quantity: 3 }],
    );
    if (operation === "withdraw")
      expect(
        (
          await pool.query(
            "SELECT available,expired FROM synthetic_entitlement_grants",
          )
        ).rows,
      ).toEqual([{ available: 3, expired: 0 }]);
    const recovered = value(await invoke(enabled));
    expect(recovered.id).toBe(f.request.id);
    expect(
      (
        await pool.query(
          "SELECT operation,quantity FROM synthetic_entitlement_events WHERE operation=$1",
          [operation === "issue" ? "grant" : "expire"],
        )
      ).rows,
    ).toEqual([
      { operation: operation === "issue" ? "grant" : "expire", quantity: 3 },
    ]);
  });
it("TESTISSUE-03 original selected administrator role and revocation remain necessary after a form has been reviewed", async () => {
  const f = await fixture();
  const checked = value(await enabled.checkIssue(f.admin, f.request.id));
  await pool.query(
    "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    [f.administratorId],
  );
  expect(await enabled.issue(f.admin, randomUUID(), checked)).toMatchObject({
    kind: "denied",
  });
  await pool.query(
    "UPDATE staff_profiles SET role='platform_admin' WHERE principal_id=$1",
    [f.administratorId],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.administratorId],
  );
  expect(await enabled.issue(f.admin, randomUUID(), checked)).toMatchObject({
    kind: "denied",
  });
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT operation_id FROM browser_study_fixture_operations WHERE kind='issue'",
      )
    ).rows,
  ).toEqual([]);
});

it("TESTISSUE-05 original authority expiry cannot be renewed into another issuance window", async () => {
  const owner = token(),
    admin = token();
  await members.create(owner, { background: "explorer", goal: "everyday" });
  const administratorId = await authority.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 1500),
  );
  const checked = value(await enabled.checkRequest(owner, administratorId));
  const source = value(await enabled.request(owner, randomUUID(), checked));
  const issueChecked = value(await enabled.checkIssue(admin, source.id));
  // Wait for the database's original recorded bound, rather than changing its
  // immutable fixture dates or relying on a speculative wall-clock sleep.
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))))",
    [source.expiresAt],
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [administratorId],
  );
  expect(await enabled.issue(admin, randomUUID(), issueChecked)).toMatchObject({
    kind: "denied",
  });
  expect(await enabled.checkIssue(admin, source.id)).toMatchObject({
    kind: "denied",
  });
  expect(await enabled.permission(admin, source.id)).toMatchObject({
    kind: "denied",
  });
  expect(value(await enabled.member(owner)).receipt?.expiresAt).toEqual(
    source.expiresAt,
  );
  expect(
    (await pool.query("SELECT * FROM synthetic_entitlement_grants")).rows,
  ).toEqual([]);
});
it("TESTISSUE-07 populated legacy grants survive migration without inventing a fixture or new issuer", async () => {
  const owner = token();
  await members.create(owner, { background: "technical", goal: "build" });
  const session = await members.session(owner);
  if (session.kind !== "active") throw Error("Expected invented legacy owner");
  const id = await ledger.grant(
    session.learner.id,
    "study_requests",
    5,
    "invented-legacy-grant",
    {
      startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  const before = (
    await pool.query("SELECT * FROM synthetic_entitlement_grants WHERE id=$1", [
      id,
    ])
  ).rows;
  const events = (
    await pool.query(
      "SELECT * FROM synthetic_entitlement_events WHERE grant_id=$1",
      [id],
    )
  ).rows;
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_grants WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT * FROM synthetic_entitlement_events WHERE grant_id=$1",
        [id],
      )
    ).rows,
  ).toEqual(events);
  expect(
    (await pool.query("SELECT * FROM browser_study_fixture_requests")).rows,
  ).toEqual([]);
  expect(value(await enabled.member(owner)).receipt).toBeNull();
});
it("TESTISSUE-07 append-only owned fixture export discloses no administrator identity, operation key or other member receipt", async () => {
  const f = await issued();
  const foreign = await issued();
  value(await enabled.withdraw(f.owner, randomUUID(), f.request.id));
  const exporter = memberExportStore(pool);
  const result = await exporter.exportOwned(f.owner);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected owned export");
  const owned = result.payload.records.studyFixtureRequests;
  expect(owned).toHaveLength(1);
  expect(owned![0]).toMatchObject({
    requestId: f.request.id,
    policy: "browser-study-fixture-v1",
    category: "study_requests",
    quantity: 3,
    grantId: f.receipt.grantId,
    attribution: "Local platform administrator",
  });
  expect(owned![0]!.withdrawnAt).toBeInstanceOf(Date);
  expect(Object.keys(result.payload.records).at(-1)).toBe(
    "studyFixtureRequests",
  );
  expect(JSON.stringify(result.payload)).not.toContain(f.administratorId);
  expect(JSON.stringify(result.payload)).not.toContain(f.issueKey);
  expect(JSON.stringify(result.payload)).not.toContain(f.requestKey);
  expect(JSON.stringify(result.payload)).not.toContain(foreign.request.id);
  expect(JSON.stringify(result.payload)).not.toContain(f.owner);
  await members.remove(f.memberId);
  expect(await exporter.exportOwned(f.owner)).toMatchObject({ kind: "denied" });
});
for (const order of ["issue-first", "erase-first"] as const)
  it(`TESTISSUE-04/07 observed PostgreSQL ${order} orders member erasure and issuance without orphaned owned facts or revived operation authority`, async () => {
    const f = await fixture();
    const checked = value(await enabled.checkIssue(f.admin, f.request.id));
    const issueKey = randomUUID();
    const holder = await pool.connect();
    let issue: ReturnType<typeof enabled.issue> | undefined,
      erase: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        f.memberId,
      ]);
      if (order === "issue-first") {
        issue = enabled.issue(f.admin, issueKey, checked);
        await observedWaiters("principals", 1);
        erase = members.remove(f.memberId);
      } else {
        erase = members.remove(f.memberId);
        await observedWaiters("principals", 1);
        issue = enabled.issue(f.admin, issueKey, checked);
      }
      await observedWaiters("principals", 2);
      await holder.query("COMMIT");
      const result = await issue;
      await erase;
      expect(result.kind).toBe(order === "issue-first" ? "ready" : "denied");
      for (const table of [
        "browser_study_fixture_requests",
        "synthetic_entitlement_grants",
        "synthetic_entitlement_events",
      ])
        expect((await pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      expect(
        await enabled.inspect(f.admin, issueKey, "issue", checked),
      ).toMatchObject({ kind: "denied" });
      expect(await enabled.member(f.owner)).toMatchObject({ kind: "denied" });
      expect(
        (
          await pool.query(
            "SELECT actor_id,workspace_id,request_id,kind,instruction_hash FROM browser_study_fixture_operations WHERE operation_id=$1",
            [issueKey],
          )
        ).rows,
      ).toEqual(
        order === "issue-first"
          ? [
              {
                actor_id: null,
                workspace_id: null,
                request_id: null,
                kind: null,
                instruction_hash: null,
              },
            ]
          : [],
      );
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([
        ...(issue ? [issue] : []),
        ...(erase ? [erase] : []),
      ]);
    }
  });

it("TESTISSUE-04/07 database guards retain original policy/link/operation facts against direct resets", async () => {
  const f = await issued();
  for (const sql of [
    "UPDATE browser_study_fixture_requests SET expires_at=expires_at+interval '1 second' WHERE id=$1",
    "UPDATE browser_study_fixture_requests SET grant_id=NULL,issued_at=NULL,grant_expires_at=NULL WHERE id=$1",
    "UPDATE browser_study_fixture_requests SET administrator_id=NULL WHERE id=$1",
  ])
    await expect(pool.query(sql, [f.request.id])).rejects.toThrow(
      "Study fixture instruction is immutable",
    );
  await expect(
    pool.query("DELETE FROM browser_study_fixture_requests WHERE id=$1", [
      f.request.id,
    ]),
  ).rejects.toThrow("Study fixture policy slot is retained");
  await expect(
    pool.query(
      "UPDATE browser_study_fixture_operations SET instruction_hash='changed' WHERE operation_id=$1",
      [f.issueKey],
    ),
  ).rejects.toThrow("Study fixture operation is immutable");
  await expect(
    pool.query(
      "DELETE FROM browser_study_fixture_operations WHERE operation_id=$1",
      [f.issueKey],
    ),
  ).rejects.toThrow("Study fixture operation key is reserved");
  value(await enabled.withdraw(f.owner, randomUUID(), f.request.id));
  await expect(
    pool.query(
      "UPDATE browser_study_fixture_requests SET withdrawn_at=NULL WHERE id=$1",
      [f.request.id],
    ),
  ).rejects.toThrow("Study fixture instruction is immutable");
});
it("TESTISSUE-06/07 a newly created account cannot revive an erased account's anonymous original operation key", async () => {
  const f = await issued();
  await members.remove(f.memberId);
  const newOwner = token();
  await members.create(newOwner, { background: "professional", goal: "work" });
  const checked = value(
    await enabled.checkRequest(newOwner, f.administratorId),
  );
  expect(await enabled.request(newOwner, f.requestKey, checked)).toMatchObject({
    kind: "conflict",
  });
  expect(
    await enabled.issue(f.admin, f.issueKey, f.issueChecked),
  ).toMatchObject({ kind: "denied" });
  expect(value(await enabled.member(newOwner)).receipt).toBeNull();
  // An independent fresh account has no cross-account identity tracker. It can
  // make its own new explicit request, but cannot reuse old keys or sources.
  const independent = value(
    await enabled.request(newOwner, randomUUID(), checked),
  );
  expect(independent.id).not.toBe(f.request.id);
  expect(independent.grantId).toBeNull();
});
it("TESTISSUE-07 real bounded export continuation includes the appended fixture once and rejects foreign, forged and erased-owner cursors", async () => {
  const f = await issued();
  const expected = [f.receipt.grantId!];
  for (
    let number = 0;
    number < Math.ceil(MAX_MEMBER_EXPORT_RECORDS / 2) + 2;
    number++
  )
    expected.push(
      await ledger.grant(
        f.memberId,
        "study_requests",
        5,
        `invented-legacy-page-${number}`,
        {
          startsAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ),
    );
  const exporter = memberExportStore(pool);
  const first = await exporter.exportOwned(f.owner);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready" || !first.payload.page.nextCursor)
    throw Error("Expected bounded continuation");
  const originalCursor = first.payload.page.nextCursor;
  expect(first.payload.page.recordCount).toBe(MAX_MEMBER_EXPORT_RECORDS);
  const other = token();
  await members.create(other, { background: "technical", goal: "build" });
  expect(await exporter.exportOwned(other, originalCursor)).toMatchObject({
    kind: "denied",
  });
  const forged = `${originalCursor.slice(0, -1)}${originalCursor.endsWith("a") ? "b" : "a"}`;
  expect(await exporter.exportOwned(f.owner, forged)).toMatchObject({
    kind: "denied",
  });
  const grants: unknown[] = [],
    receipts: unknown[] = [];
  let result: Awaited<ReturnType<typeof exporter.exportOwned>> = first;
  let pages = 0;
  for (;;) {
    if (result.kind !== "ready") throw Error("Expected owner continuation");
    pages++;
    expect(pages).toBeLessThanOrEqual(4);
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_RECORDS,
    );
    grants.push(...result.payload.records.testUnitGrants!.map((row) => row.id));
    receipts.push(
      ...result.payload.records.studyFixtureRequests!.map(
        (row) => row.requestId,
      ),
    );
    if (!result.payload.page.nextCursor) break;
    result = await exporter.exportOwned(
      f.owner,
      result.payload.page.nextCursor,
    );
  }
  expect([...grants].sort()).toEqual(expected.sort());
  expect(new Set(grants).size).toBe(grants.length);
  expect(receipts).toEqual([f.request.id]);
  await members.remove(f.memberId);
  expect(await exporter.exportOwned(f.owner, originalCursor)).toMatchObject({
    kind: "denied",
  });
}, 15000);
