import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { workflowReviewFixture } from "../support/workflow-review.ts";

// WFKEY-01..06 (#42): a private workflow review operation key is unique only
// within the actor who used it, so another member's or administrator's key
// inspects and acts exactly like an unused one, and never blocks their own write.
const pool = testPool();
beforeAll(() => migrate(pool));
afterAll(() => pool.end());

// A member whose earlier request is withdrawn, so a fresh request can be made.
async function requester() {
  const f = await workflowReviewFixture(pool);
  expect(
    (await f.reviews.withdraw(f.member, f.requestId, randomUUID(), "yes")).kind,
  ).toBe("applied");
  const preview = await f.reviews.preview(f.member, "WF-001");
  if (preview.kind !== "ready") throw Error("Exact private preview required");
  const request = (operationId: string) =>
    f.reviews.request(f.member, {
      checked: preview.preview.checked,
      operationId,
      confirm: "yes",
    });
  return { ...f, request };
}
function requestId(result: { kind: string; receipt?: unknown }) {
  const receipt = result.receipt as { requestId?: string } | null | undefined;
  if (
    !["applied", "replayed", "ready"].includes(result.kind) ||
    !receipt?.requestId
  )
    throw Error(`Saved request, got ${result.kind}`);
  return receipt.requestId;
}
// The answer without its per-call deadline, so two answers compare exactly.
function answer({ deadline, ...rest }: { deadline?: number; kind: string }) {
  void deadline;
  return rest;
}

it("WFKEY-01 another member's request key inspects exactly like an unused key", async () => {
  const a = await requester(),
    b = await requester(),
    key = randomUUID();
  requestId(await a.request(key));
  expect(answer(await b.reviews.inspect(b.member, randomUUID()))).toEqual({
    kind: "ready",
    receipt: null,
  });
  expect(answer(await b.reviews.inspect(b.member, key))).toEqual({
    kind: "ready",
    receipt: null,
  });
});

it("WFKEY-02 a member's own request is saved under another member's key and each sees only their own", async () => {
  const a = await requester(),
    b = await requester(),
    key = randomUUID();
  const mine = requestId(await a.request(key));
  const applied = await b.request(key);
  expect(applied.kind).toBe("applied");
  const theirs = requestId(applied);
  expect(theirs).not.toBe(mine);
  expect(requestId(await a.reviews.inspect(a.member, key))).toBe(mine);
  expect(requestId(await b.reviews.inspect(b.member, key))).toBe(theirs);
  // A member's own replay still returns their own receipt, unchanged.
  const replay = await b.request(key);
  expect(replay.kind).toBe("replayed");
  expect(requestId(replay)).toBe(theirs);
});

it("WFKEY-03 a member withdraws their own request under another member's key", async () => {
  const a = await requester(),
    b = await requester(),
    key = randomUUID();
  const own = requestId(await b.request(randomUUID()));
  const mine = requestId(await a.request(key));
  const withdrawn = await b.reviews.withdraw(b.member, own, key, "yes");
  expect(withdrawn.kind).toBe("applied");
  // A's receipt under the same key is untouched and still pending.
  const kept = await a.reviews.inspect(a.member, key);
  expect(kept).toMatchObject({
    kind: "ready",
    receipt: { requestId: mine, withdrawnAt: null },
  });
});

it("WFKEY-04 another administrator's assign and revoke keys inspect and act like unused keys", async () => {
  const a = await workflowReviewFixture(pool),
    b = await workflowReviewFixture(pool),
    assignKey = randomUUID(),
    revokeKey = randomUUID();
  // Administrator A assigns and revokes on A's request under two keys.
  expect(
    (await a.staff.revoke(a.admin, a.grantId, revokeKey, "yes")).kind,
  ).toBe("applied");
  const checkedA = await a.staff.check(a.admin, a.requestId, a.moderatorId);
  if (checkedA.kind !== "ready") throw Error("Checked assignment required");
  expect(
    (await a.staff.assign(a.admin, checkedA.checked, assignKey, "yes")).kind,
  ).toBe("applied");
  // Administrator B, on B's own request, sees nothing under A's keys.
  for (const key of [assignKey, revokeKey])
    expect(answer(await b.staff.inspect(b.admin, key))).toEqual({
      kind: "ready",
      grant: null,
    });
  // B revokes and reassigns B's own request under A's keys.
  const revoked = await b.staff.revoke(b.admin, b.grantId, revokeKey, "yes");
  expect(revoked).toMatchObject({
    kind: "applied",
    grant: { grantId: b.grantId },
  });
  const checkedB = await b.staff.check(b.admin, b.requestId, b.moderatorId);
  if (checkedB.kind !== "ready") throw Error("Checked assignment required");
  const assigned = await b.staff.assign(
    b.admin,
    checkedB.checked,
    assignKey,
    "yes",
  );
  expect(assigned).toMatchObject({
    kind: "applied",
    grant: { requestId: b.requestId },
  });
  // Each administrator inspects only their own receipt under each key.
  expect(await a.staff.inspect(a.admin, revokeKey)).toMatchObject({
    kind: "ready",
    grant: { grantId: a.grantId },
  });
  expect(await b.staff.inspect(b.admin, revokeKey)).toMatchObject({
    kind: "ready",
    grant: { grantId: b.grantId },
  });
  expect(await a.staff.inspect(a.admin, assignKey)).toMatchObject({
    kind: "ready",
    grant: { requestId: a.requestId },
  });
});

it("WFKEY-05 a member's own key reused for a different instruction still conflicts", async () => {
  const a = await requester(),
    b = await requester(),
    key = randomUUID();
  const own = requestId(await a.request(key));
  expect((await b.request(key)).kind).toBe("applied");
  expect(answer(await a.reviews.withdraw(a.member, own, key, "yes"))).toEqual({
    kind: "conflict",
  });
  // An administrator's own revoke key reused for an assignment conflicts too.
  const staffKey = randomUUID();
  expect((await a.staff.revoke(a.admin, a.grantId, staffKey, "yes")).kind).toBe(
    "applied",
  );
  const checked = await a.staff.check(a.admin, own, a.moderatorId);
  if (checked.kind !== "ready") throw Error("Checked assignment required");
  expect(
    answer(await a.staff.assign(a.admin, checked.checked, staffKey, "yes")),
  ).toEqual({ kind: "conflict" });
});

it("WFKEY-06 re-running every migration keeps workflow review keys unique per actor only", async () => {
  await migrate(pool);
  const unique = (
    await pool.query<{ columns: string[]; primary: boolean }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns, bool_or(i.indisprimary) AS primary
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid='workflow_review_operations'::regclass AND i.indisunique
        GROUP BY i.indexrelid`,
    )
  ).rows;
  expect(unique).toEqual([
    { columns: ["actor_id", "operation_id"], primary: false },
  ]);
  expect(
    (
      await pool.query<{ notnull: boolean }>(
        `SELECT attnotnull AS notnull FROM pg_attribute
          WHERE attrelid='workflow_review_operations'::regclass AND attname='operation_id'`,
      )
    ).rows[0]!.notnull,
  ).toBe(true);
});
