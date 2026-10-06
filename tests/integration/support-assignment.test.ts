import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore, STAFF_ROLES } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import {
  supportAssignmentStore,
  type AssignmentResult,
  type AssignmentInput,
} from "../../src/support-assignment.ts";
import { testPool } from "../support/database.ts";
import { syntheticLedger } from "../../src/ledger.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  adminStore = supportAssignmentStore(pool, "invented-assignment-cursor");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
function value<T>(result: AssignmentResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready")
    throw Error("Expected current assignment result");
  expect(result.deadline).toBeGreaterThan(performance.now());
  return result.value;
}
async function fixture() {
  const owner = fresh(),
    admin = fresh(),
    operator = fresh(),
    expires = new Date(Date.now() + 3600000);
  await members.create(owner, { background: "professional", goal: "work" });
  const member = await members.session(owner);
  if (member.kind !== "active") throw Error("Missing invented member");
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires),
    staffId = await auth.provisionStaff(operator, "operator", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "PRIVATE-SUBJECT",
    body: "PRIVATE-MEMBER-CONTENT",
  });
  if (!("receipt" in created)) throw Error("Missing invented request");
  const input: AssignmentInput = {
    requestId: created.receipt.requestId,
    staffId,
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() - 60000),
    expiresAt: new Date(+expires - 1000),
  };
  return {
    owner,
    admin,
    operator,
    adminId,
    staffId,
    memberId: member.learner.id,
    expires,
    input,
  };
}
const count = async (action: string) =>
  (
    await pool.query(
      "SELECT count(*)::int n FROM support_request_events WHERE action=$1",
      [action],
    )
  ).rows[0].n;
it("SUPADM-02-ASSIGN fixes the purpose and operator, commits one grant/event and enables exact discovery without leaking content", async () => {
  const f = await fixture();
  expect(value(await adminStore.reference(f.operator))).toEqual({
    staffId: f.staffId,
    expiresAt: f.expires,
  });
  expect(
    value(await adminStore.check(f.admin, f.input.requestId, f.staffId)),
  ).toEqual({
    staffId: f.staffId,
    expiresAt: f.expires,
    requestId: f.input.requestId,
  });
  const saved = value(await adminStore.assign(f.admin, f.input));
  expect(saved.disposition).toBe("created");
  expect(await count("grant-created")).toBe(1);
  const row = (
    await pool.query(
      "SELECT staff_role,purpose,starts_at,expires_at FROM support_request_grants WHERE id=$1",
      [saved.grantId],
    )
  ).rows[0];
  expect(row).toEqual({
    staff_role: "operator",
    purpose: "support-request-local-v1",
    starts_at: f.input.startsAt,
    expires_at: f.input.expiresAt,
  });
  const list = await support.operatorWorklist(f.operator);
  expect(list.kind).toBe("ready");
  if (list.kind !== "ready") throw Error("No worklist");
  expect(list.value.items.map((r) => r.requestId)).toEqual([f.input.requestId]);
  const detail = await support.operatorDetail(f.operator, {
    requestId: f.input.requestId,
    grantId: saved.grantId,
  });
  expect(detail.kind).toBe("ready");
  const history = value(await adminStore.history(f.admin, f.input.requestId));
  expect(history.items).toHaveLength(1);
  expect(history.items[0]!.state).toBe("current");
  for (const forbidden of [
    f.owner,
    f.admin,
    f.operator,
    f.memberId,
    "PRIVATE-SUBJECT",
    "PRIVATE-MEMBER-CONTENT",
  ])
    expect(JSON.stringify(history).includes(forbidden)).toBe(false);
});
it("SUPADM-02-ASSIGN rejects overlong expiry without rewriting payload; old CLI admin targets retain compatibility", async () => {
  const f = await fixture();
  expect(
    await adminStore.assign(f.admin, {
      ...f.input,
      expiresAt: new Date(+f.expires + 1),
    }),
  ).toEqual({ kind: "invalid" });
  expect(await count("grant-created")).toBe(0);
  expect(
    await adminStore.assign(f.admin, { ...f.input, staffId: f.adminId }),
  ).toEqual({ kind: "denied" });
  const cli = await support.grant(f.admin, {
    ...f.input,
    staffId: f.adminId,
    role: "platform_admin",
    expiresAt: new Date(+f.expires + 60000),
  });
  expect(cli.kind).toBe("created");
  const history = value(await adminStore.history(f.admin, f.input.requestId));
  expect(history.items[0]!.role).toBe("platform_admin");
  expect(history.items[0]!.state).toBe("current");
});
it("SUPADM-03-IDEMPOTENCY serializes concurrent identical keys, conflicts on changed payload and never restores revoked key", async () => {
  const f = await fixture(),
    results = await Promise.all([
      adminStore.assign(f.admin, f.input),
      adminStore.assign(f.admin, f.input),
    ]),
    saved = results.map(value);
  expect(saved.map((s) => s.disposition).sort()).toEqual([
    "created",
    "replayed",
  ]);
  expect(saved[0]!.grantId).toBe(saved[1]!.grantId);
  expect(await count("grant-created")).toBe(1);
  const other = await auth.provisionStaff(fresh(), "operator", f.expires);
  const second = await support.create(f.owner, {
    idempotencyKey: randomUUID(),
    subject: "OTHER-PRIVATE",
    body: "OTHER-BODY",
  });
  if (!("receipt" in second)) throw Error("Missing second request");
  for (const changed of [
    { staffId: other },
    { requestId: second.receipt.requestId },
    { startsAt: new Date(+f.input.startsAt + 1) },
    { expiresAt: new Date(+f.input.expiresAt - 1) },
  ])
    expect(
      await adminStore.assign(f.admin, { ...f.input, ...changed }),
    ).toEqual({ kind: "conflict" });
  expect(
    value(
      await adminStore.revoke(f.admin, f.input.requestId, saved[0]!.grantId),
    ).disposition,
  ).toBe("revoked");
  expect(await adminStore.assign(f.admin, f.input)).toEqual({
    kind: "conflict",
  });
  expect(await count("grant-created")).toBe(1);
  expect(await count("grant-revoked")).toBe(1);
});
it("SUPADM-03-IDEMPOTENCY one admin key across different requests has exactly one winner", async () => {
  const f = await fixture(),
    second = await support.create(f.owner, {
      idempotencyKey: randomUUID(),
      subject: "OTHER-PRIVATE",
      body: "OTHER-BODY",
    });
  if (!("receipt" in second)) throw Error("Missing second request");
  const results = await Promise.all([
    adminStore.assign(f.admin, f.input),
    adminStore.assign(f.admin, {
      ...f.input,
      requestId: second.receipt.requestId,
    }),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  expect(await count("grant-created")).toBe(1);
});
it("SUPADM-04-REVOKE preserves overlapping grants and request data, repeats once, and fresh access requires a remaining current grant", async () => {
  const f = await fixture(),
    first = value(await adminStore.assign(f.admin, f.input)),
    second = value(
      await adminStore.assign(f.admin, {
        ...f.input,
        idempotencyKey: randomUUID(),
      }),
    );
  const before = (
    await pool.query("SELECT * FROM support_requests WHERE id=$1", [
      f.input.requestId,
    ])
  ).rows;
  expect(
    value(await adminStore.revoke(f.admin, f.input.requestId, first.grantId))
      .disposition,
  ).toBe("revoked");
  expect(
    value(await adminStore.revoke(f.admin, f.input.requestId, first.grantId))
      .disposition,
  ).toBe("already-revoked");
  expect(await count("grant-revoked")).toBe(1);
  expect(
    (
      await support.operatorDetail(f.operator, {
        requestId: f.input.requestId,
        grantId: first.grantId,
      })
    ).kind,
  ).toBe("denied");
  expect(
    (
      await support.operatorDetail(f.operator, {
        requestId: f.input.requestId,
        grantId: second.grantId,
      })
    ).kind,
  ).toBe("ready");
  const history = value(await adminStore.history(f.admin, f.input.requestId));
  expect(history.items.map((g) => g.state).sort()).toEqual([
    "current",
    "revoked",
  ]);
  value(await adminStore.revoke(f.admin, f.input.requestId, second.grantId));
  expect((await support.operatorWorklist(f.operator)).kind).toBe("ready");
  const list = await support.operatorWorklist(f.operator);
  if (list.kind !== "ready") throw Error("No list");
  expect(list.value.items).toEqual([]);
  expect(
    (
      await pool.query("SELECT * FROM support_requests WHERE id=$1", [
        f.input.requestId,
      ])
    ).rows,
  ).toEqual(before);
});
it.each(["expired", "revoked", "role-changed"])(
  "SUPADM-07-RECOVERY historical %s targets remain inspectable and revocable without restoring authority",
  async (kind) => {
    const f = await fixture(),
      saved = value(await adminStore.assign(f.admin, f.input));
    if (kind === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [f.staffId],
      );
    else if (kind === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.staffId],
      );
    else
      await pool.query(
        "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
        [f.staffId],
      );
    const history = value(
      await adminStore.history(
        f.admin,
        f.input.requestId,
        undefined,
        f.input.idempotencyKey,
      ),
    );
    expect(history.items[0]!.state).toBe("ineffective");
    expect(history.items[0]!.grantId).toBe(saved.grantId);
    expect(value(await adminStore.assign(f.admin, f.input)).disposition).toBe(
      "replayed",
    );
    expect(await count("grant-created")).toBe(1);
    expect(
      await adminStore.check(f.admin, f.input.requestId, f.staffId),
    ).toEqual({ kind: "denied" });
    expect(
      value(await adminStore.revoke(f.admin, f.input.requestId, saved.grantId))
        .disposition,
    ).toBe("revoked");
  },
);
it("SUPADM-08-READS-ROLLBACK paginates more than100 exact grants with no duplicates or read events and only own-key recovery", async () => {
  const f = await fixture(),
    ids = new Set<string>();
  for (let n = 0; n < 105; n++)
    ids.add(
      value(
        await adminStore.assign(f.admin, {
          ...f.input,
          idempotencyKey: randomUUID(),
        }),
      ).grantId,
    );
  const before = (
    await pool.query("SELECT count(*)::int n FROM support_request_events")
  ).rows[0].n;
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = value(
      await adminStore.history(f.admin, f.input.requestId, cursor),
    );
    expect(page.items.length).toBeLessThanOrEqual(20);
    seen.push(...page.items.map((i) => i.grantId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toHaveLength(105);
  expect(new Set(seen)).toEqual(ids);
  expect(
    (await pool.query("SELECT count(*)::int n FROM support_request_events"))
      .rows[0].n,
  ).toBe(before);
  const own = value(await adminStore.assign(f.admin, f.input)),
    foreign = fresh();
  await auth.provisionStaff(foreign, "platform_admin", f.expires);
  expect(
    value(
      await adminStore.history(
        foreign,
        f.input.requestId,
        undefined,
        f.input.idempotencyKey,
      ),
    ).items,
  ).toEqual([]);
  expect(
    value(
      await adminStore.history(
        f.admin,
        f.input.requestId,
        undefined,
        f.input.idempotencyKey,
      ),
    ).items[0]!.grantId,
  ).toBe(own.grantId);
  const first = value(await adminStore.history(f.admin, f.input.requestId));
  expect(
    await adminStore.history(foreign, f.input.requestId, first.nextCursor!),
  ).toEqual({ kind: "denied" });
}, 15000);
it("SUPADM-08-READS-ROLLBACK scheduled expired revoked and withdrawn grants remain truthful metadata and retained grants can be revoked by the protected API used by CLI", async () => {
  const f = await fixture(),
    scheduled = value(
      await adminStore.assign(f.admin, {
        ...f.input,
        startsAt: new Date(Date.now() + 60000),
      }),
    );
  expect(
    value(await adminStore.history(f.admin, f.input.requestId)).items[0]!.state,
  ).toBe("scheduled");
  expect(
    (
      await support.operatorDetail(f.operator, {
        requestId: f.input.requestId,
        grantId: scheduled.grantId,
      })
    ).kind,
  ).toBe("denied");
  expect((await support.revoke(f.admin, scheduled.grantId)).kind).toBe(
    "revoked",
  );
  const current = value(
    await adminStore.assign(f.admin, {
      ...f.input,
      idempotencyKey: randomUUID(),
    }),
  );
  await support.withdraw(f.owner, f.input.requestId);
  const history = value(await adminStore.history(f.admin, f.input.requestId));
  expect(history.withdrawn).toBe(true);
  expect(history.items.map((i) => i.state).sort()).toEqual([
    "ineffective",
    "revoked",
  ]);
  expect(
    value(await adminStore.revoke(f.admin, f.input.requestId, current.grantId))
      .disposition,
  ).toBe("revoked");
});
it("SUPADM-05-BOUNDARIES only current admin and operator roles get their exact surfaces; absent wrong-kind and deleting references deny", async () => {
  const f = await fixture();
  for (const role of STAFF_ROLES) {
    const token = fresh();
    await auth.provisionStaff(token, role, f.expires);
    expect((await adminStore.admin(token)).kind).toBe(
      role === "platform_admin" ? "ready" : "denied",
    );
    expect((await adminStore.reference(token)).kind).toBe(
      role === "operator" ? "ready" : "denied",
    );
  }
  for (const token of [f.owner, fresh(), "invalid"])
    expect(await adminStore.admin(token)).toEqual({ kind: "denied" });
  expect(
    await adminStore.check(f.admin, f.input.requestId, f.memberId),
  ).toEqual({ kind: "denied" });
  expect(await adminStore.check(f.admin, randomUUID(), f.staffId)).toEqual({
    kind: "denied",
  });
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    [f.memberId],
  );
  expect(await adminStore.check(f.admin, f.input.requestId, f.staffId)).toEqual(
    { kind: "denied" },
  );
  expect(await adminStore.history(f.admin, f.input.requestId)).toEqual({
    kind: "denied",
  });
});
it.each(["begun", "completed"])(
  "SUPADM-04-REVOKE leaves %s independent effort, reserved/settled units, messages and request lifecycle untouched",
  async (state) => {
    const f = await fixture(),
      saved = value(await adminStore.assign(f.admin, f.input)),
      time = support.time!;
    await syntheticLedger(pool).grant(
      f.memberId,
      "support_minutes",
      20,
      randomUUID(),
      {
        startsAt: f.input.startsAt.toISOString(),
        expiresAt: f.input.expiresAt.toISOString(),
      },
    );
    const allocation = await time.allocate(
      f.owner,
      f.input.requestId,
      randomUUID(),
      5,
    );
    if (!("receipt" in allocation)) throw Error("Missing invented allocation");
    const granted = await time.grant(f.admin, {
      ...f.input,
      role: "operator",
      idempotencyKey: randomUUID(),
      allocationId: allocation.receipt.allocationId,
    });
    if (!("grantId" in granted)) throw Error("Missing distinct effort grant");
    const scope = {
      requestId: f.input.requestId,
      allocationId: allocation.receipt.allocationId,
      grantId: granted.grantId,
    };
    expect((await time.begin(f.operator, scope, randomUUID())).kind).toBe(
      "applied",
    );
    if (state === "completed") {
      const start = new Date(Date.now() - 600000);
      expect(
        await time.record(f.operator, scope, randomUUID(), {
          supportStart: start,
          supportEnd: new Date(+start + 120000),
          preparationStart: new Date(+start + 180000),
          preparationEnd: new Date(+start + 240000),
        }),
      ).toMatchObject({
        kind: "applied",
        receipt: { state: "completed", consumed: 3, released: 2 },
      });
    }
    expect(
      (
        await support.note(
          f.operator,
          { requestId: f.input.requestId, grantId: saved.grantId },
          randomUUID(),
          "PRIVATE-INTERNAL-NOTE",
        )
      ).kind,
    ).toBe("applied");
    expect(
      (
        await support.reply(
          f.operator,
          { requestId: f.input.requestId, grantId: saved.grantId },
          randomUUID(),
          "PRIVATE-REPLY",
        )
      ).kind,
    ).toBe("applied");
    const tables = [
      "support_requests",
      "support_request_replies",
      "support_request_notes",
      "support_request_mutations",
      "support_time_allocations",
      "support_time_grants",
      "support_time_units",
      "support_time_entries",
      "support_time_events",
      "synthetic_entitlement_grants",
      "synthetic_entitlement_reservations",
      "synthetic_entitlement_events",
    ];
    const snapshot = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await pool.query(
                `SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`,
              )
            ).rows,
        ),
      );
    const before = await snapshot();
    value(await adminStore.history(f.admin, f.input.requestId));
    value(await adminStore.revoke(f.admin, f.input.requestId, saved.grantId));
    value(await adminStore.revoke(f.admin, f.input.requestId, saved.grantId));
    expect(await snapshot()).toEqual(before);
    expect((await time.operatorDetail(f.operator, scope)).kind).toBe("ready");
    expect(
      (
        await support.operatorDetail(f.operator, {
          requestId: f.input.requestId,
          grantId: saved.grantId,
        })
      ).kind,
    ).toBe("denied");
  },
);
