import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import {
  supportAssignmentStore,
  type AssignmentResult,
} from "../../src/support-assignment.ts";
import { testPool } from "../support/database.ts";

// ADMSUP-01–04 (#39): a hosted administrator answers one support request
// themselves, through an ordinary audited grant bounded by their own session.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  admin = supportAssignmentStore(pool, "invented-admin-answer-cursor");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
function value<T>(result: AssignmentResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected a ready result");
  return result.value;
}
async function fixture() {
  const owner = fresh(),
    adminToken = fresh(),
    operator = fresh(),
    expires = new Date(Date.now() + 3600000);
  await members.create(owner, { background: "professional", goal: "work" });
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expires,
  );
  await auth.provisionStaff(operator, "operator", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "Invented: cannot open lesson",
    body: "Invented member request text",
  });
  if (!("receipt" in created)) throw Error("Missing invented request");
  return {
    owner,
    adminToken,
    adminId,
    operator,
    expires,
    requestId: created.receipt.requestId,
  };
}
const grants = async () =>
  (
    await pool.query(
      "SELECT id,staff_id,staff_role,starts_at,expires_at,granted_by FROM support_request_grants ORDER BY created_at",
    )
  ).rows;
const events = async (action: string) =>
  (
    await pool.query(
      "SELECT count(*)::int n FROM support_request_events WHERE action=$1",
      [action],
    )
  ).rows[0].n;

it("ADMSUP-01 an administrator takes one open request until their own session ends, and it appears in their granted requests", async () => {
  const f = await fixture(),
    before = Date.now();
  const taken = value(
    await admin.take(f.adminToken, f.requestId, randomUUID()),
  );
  expect(taken.disposition).toBe("created");
  expect(taken.requestId).toBe(f.requestId);
  const [row, ...rest] = await grants();
  expect(rest).toEqual([]);
  expect(row).toMatchObject({
    id: taken.grantId,
    staff_id: f.adminId,
    staff_role: "platform_admin",
    granted_by: f.adminId,
    expires_at: f.expires,
  });
  expect(+row.starts_at).toBeGreaterThanOrEqual(before - 5000);
  expect(+row.starts_at).toBeLessThanOrEqual(Date.now());
  expect(await events("grant-created")).toBe(1);
  const list = await support.operatorWorklist(f.adminToken);
  expect(list.kind).toBe("ready");
  if (list.kind !== "ready") throw Error("No worklist");
  expect(list.value.items.map((r) => [r.requestId, r.grantId])).toEqual([
    [f.requestId, taken.grantId],
  ]);
  const history = value(await admin.history(f.adminToken, f.requestId));
  expect(history.items.map((g) => [g.staffId, g.role, g.state])).toEqual([
    [f.adminId, "platform_admin", "current"],
  ]);
  // An operator still sees nothing they were not assigned.
  const other = await support.operatorWorklist(f.operator);
  expect(other.kind === "ready" && other.value.items).toEqual([]);
});

it("ADMSUP-02 the administrator notes, acknowledges, replies and resolves; the member sees only the reply and the facts", async () => {
  const f = await fixture();
  const { grantId } = value(
    await admin.take(f.adminToken, f.requestId, randomUUID()),
  );
  const scope = { requestId: f.requestId, grantId };
  expect(
    (
      await support.note(
        f.adminToken,
        scope,
        randomUUID(),
        "Invented internal note",
      )
    ).kind,
  ).toBe("applied");
  expect(
    (await support.acknowledge(f.adminToken, scope, randomUUID())).kind,
  ).toBe("applied");
  expect(
    (await support.reply(f.adminToken, scope, randomUUID(), "Invented reply"))
      .kind,
  ).toBe("applied");
  expect((await support.resolve(f.adminToken, scope, randomUUID())).kind).toBe(
    "applied",
  );
  const seen = await support.memberDetail(f.owner, f.requestId);
  expect(seen.kind).toBe("ready");
  if (seen.kind !== "ready") throw Error("No member detail");
  expect(seen.value.replies.items.map((r) => r.body)).toEqual([
    "Invented reply",
  ]);
  expect(seen.value.acknowledgedAt).toBeInstanceOf(Date);
  expect(seen.value.resolvedAt).toBeInstanceOf(Date);
  expect(JSON.stringify(seen)).not.toContain("Invented internal note");
});

it("ADMSUP-03 replay creates nothing new and every refused case writes nothing", async () => {
  const f = await fixture(),
    key = randomUUID();
  const first = value(await admin.take(f.adminToken, f.requestId, key));
  expect(value(await admin.take(f.adminToken, f.requestId, key))).toEqual({
    requestId: f.requestId,
    grantId: first.grantId,
    disposition: "replayed",
  });
  const second = await support.create(f.owner, {
    idempotencyKey: randomUUID(),
    subject: "Invented second",
    body: "Invented second text",
  });
  if (!("receipt" in second)) throw Error("Missing second request");
  // The same key for a different request is a conflict, not a second grant.
  expect(await admin.take(f.adminToken, second.receipt.requestId, key)).toEqual(
    { kind: "conflict" },
  );
  // Not an administrator: operator, member, unknown and malformed credentials.
  for (const token of [f.operator, f.owner, fresh(), "not-a-credential"])
    expect(await admin.take(token, f.requestId, randomUUID())).toEqual({
      kind: "denied",
    });
  // Malformed references and an unknown request.
  expect(await admin.take(f.adminToken, "nope", randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await admin.take(f.adminToken, f.requestId, "nope")).toEqual({
    kind: "denied",
  });
  expect(await admin.take(f.adminToken, randomUUID(), randomUUID())).toEqual({
    kind: "denied",
  });
  // A withdrawn request.
  expect((await support.withdraw(f.owner, second.receipt.requestId)).kind).toBe(
    "withdrawn",
  );
  expect(
    await admin.take(f.adminToken, second.receipt.requestId, randomUUID()),
  ).toEqual({ kind: "denied" });
  // A resolved request.
  const scope = { requestId: f.requestId, grantId: first.grantId };
  expect((await support.resolve(f.adminToken, scope, randomUUID())).kind).toBe(
    "applied",
  );
  expect(await admin.take(f.adminToken, f.requestId, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await grants()).toHaveLength(1);
  expect(await events("grant-created")).toBe(1);
});

it("ADMSUP-03 a request whose member is leaving is refused", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=(SELECT member_id FROM support_requests WHERE id=$1)",
    [f.requestId],
  );
  expect(await admin.take(f.adminToken, f.requestId, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await grants()).toEqual([]);
});

it("ADMSUP-04 revoking the grant or ending the session refuses fresh reads and actions; the member keeps their history", async () => {
  const f = await fixture();
  const taken = value(
    await admin.take(f.adminToken, f.requestId, randomUUID()),
  );
  const scope = { requestId: f.requestId, grantId: taken.grantId };
  expect(
    (await support.reply(f.adminToken, scope, randomUUID(), "Invented reply"))
      .kind,
  ).toBe("applied");
  expect(
    value(await admin.revoke(f.adminToken, f.requestId, taken.grantId))
      .disposition,
  ).toBe("revoked");
  expect((await support.operatorDetail(f.adminToken, scope)).kind).toBe(
    "denied",
  );
  expect(
    (await support.note(f.adminToken, scope, randomUUID(), "Too late")).kind,
  ).toBe("denied");
  const list = await support.operatorWorklist(f.adminToken);
  expect(list.kind === "ready" && list.value.items).toEqual([]);
  const seen = await support.memberDetail(f.owner, f.requestId);
  expect(
    seen.kind === "ready" && seen.value.replies.items.map((r) => r.body),
  ).toEqual(["Invented reply"]);

  // Take it again, then end the administrator session.
  const again = value(
    await admin.take(f.adminToken, f.requestId, randomUUID()),
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.adminId],
  );
  expect(
    (
      await support.operatorDetail(f.adminToken, {
        requestId: f.requestId,
        grantId: again.grantId,
      })
    ).kind,
  ).toBe("denied");
  expect(await admin.take(f.adminToken, f.requestId, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await grants()).toHaveLength(2);
});
