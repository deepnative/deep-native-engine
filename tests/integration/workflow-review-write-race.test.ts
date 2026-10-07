import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
import { waitForSampleAssignmentBlock } from "../support/sample-assignment.ts";
import {
  workflowReviewFixture,
  WORKFLOW_REVIEW_TEST_SECRET,
} from "../support/workflow-review.ts";
const pool = testPool(),
  options = { enabled: true, mode: "test" as const };
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function heldWrite(sqlPrefix: string) {
  const entered = gate(),
    resume = gate();
  let pid = 0;
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.trimStart().startsWith(sqlPrefix)) {
            entered.release();
            await resume.wait;
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { scoped, entered, resume, pid: () => pid };
}
it.each([true, false])(
  "WFREV-06 same-source competing requests with same original key=%s have one canonical active intent",
  async (sameKey) => {
    const f = await workflowReviewFixture(pool);
    expect(
      await f.reviews.withdraw(f.member, f.requestId, randomUUID(), "yes"),
    ).toMatchObject({ kind: "applied" });
    const preview = await f.reviews.preview(f.member, "WF-001");
    if (preview.kind !== "ready") throw Error("Exact source required");
    const operationId = randomUUID(),
      instruction = {
        checked: preview.preview.checked,
        operationId,
        confirm: "yes",
      };
    const h = heldWrite("INSERT INTO workflow_review_requests"),
      writer = workflowReviewStore(
        h.scoped,
        options,
        WORKFLOW_REVIEW_TEST_SECRET,
      ),
      first = writer.request(f.member, instruction);
    let second: ReturnType<typeof writer.request> | undefined;
    try {
      await h.entered.wait;
      second = f.reviews.request(f.member, {
        ...instruction,
        operationId: sameKey ? operationId : randomUUID(),
      });
      await waitForSampleAssignmentBlock(pool, h.pid());
      h.resume.release();
      const committed = await first;
      expect(committed.kind).toBe("applied");
      const contended = await second;
      expect(contended.kind).toBe(sameKey ? "replayed" : "conflict");
      if (committed.kind === "applied" && contended.kind === "replayed")
        expect(contended.receipt.requestId).toBe(committed.receipt.requestId);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workflow_review_requests WHERE withdrawn_at IS NULL",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      h.resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
it.each([true, false])(
  "WFREV-06 same-request competing assignments with same original key=%s have one exact unrevoked grant",
  async (sameKey) => {
    const f = await workflowReviewFixture(pool);
    expect(
      await f.staff.revoke(f.admin, f.grantId, randomUUID(), "yes"),
    ).toMatchObject({ kind: "applied" });
    const checked = await f.staff.check(f.admin, f.requestId, f.moderatorId);
    if (checked.kind !== "ready")
      throw Error("Exact current assignment required");
    const operationId = randomUUID(),
      h = heldWrite("INSERT INTO workflow_review_grants"),
      writer = workflowReviewStaffStore(
        h.scoped,
        options,
        WORKFLOW_REVIEW_TEST_SECRET,
      ),
      first = writer.assign(f.admin, checked.checked, operationId, "yes");
    let second: ReturnType<typeof writer.assign> | undefined;
    try {
      await h.entered.wait;
      second = f.staff.assign(
        f.admin,
        checked.checked,
        sameKey ? operationId : randomUUID(),
        "yes",
      );
      await waitForSampleAssignmentBlock(pool, h.pid());
      h.resume.release();
      const committed = await first,
        contended = await second;
      expect(committed.kind).toBe("applied");
      expect(contended.kind).toBe(sameKey ? "replayed" : "conflict");
      if (committed.kind === "applied" && contended.kind === "replayed")
        expect(contended.grant.grantId).toBe(committed.grant.grantId);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workflow_review_grants WHERE revoked_at IS NULL",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      h.resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
it.each([true, false])(
  "WFREV-06 competing revocations with same original key=%s preserve one fixed revocation timestamp",
  async (sameKey) => {
    const f = await workflowReviewFixture(pool),
      operationId = randomUUID(),
      h = heldWrite("UPDATE workflow_review_grants SET revoked_at"),
      writer = workflowReviewStaffStore(
        h.scoped,
        options,
        WORKFLOW_REVIEW_TEST_SECRET,
      ),
      first = writer.revoke(f.admin, f.grantId, operationId, "yes");
    let second: ReturnType<typeof writer.revoke> | undefined;
    try {
      await h.entered.wait;
      second = f.staff.revoke(
        f.admin,
        f.grantId,
        sameKey ? operationId : randomUUID(),
        "yes",
      );
      await waitForSampleAssignmentBlock(pool, h.pid());
      h.resume.release();
      const committed = await first,
        contended = await second;
      expect(committed.kind).toBe("applied");
      expect(contended.kind).toBe(sameKey ? "replayed" : "applied");
      if (
        committed.kind === "applied" &&
        (contended.kind === "replayed" || contended.kind === "applied")
      )
        expect(contended.grant.revokedAt).toBe(committed.grant.revokedAt);
      expect(await f.staff.read(f.moderator, f.grantId)).toEqual({
        kind: "denied",
      });
    } finally {
      h.resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
it("WFREV-06 globally competing same-key requests by different members reserve the key for only the first exact actor", async () => {
  const a = await workflowReviewFixture(pool),
    b = await workflowReviewFixture(pool);
  for (const f of [a, b])
    expect(
      await f.reviews.withdraw(f.member, f.requestId, randomUUID(), "yes"),
    ).toMatchObject({ kind: "applied" });
  const pa = await a.reviews.preview(a.member, "WF-001"),
    pb = await b.reviews.preview(b.member, "WF-001");
  if (pa.kind !== "ready" || pb.kind !== "ready")
    throw Error("Independent exact sources required");
  const operationId = randomUUID(),
    h = heldWrite("INSERT INTO workflow_review_requests"),
    writer = workflowReviewStore(
      h.scoped,
      options,
      WORKFLOW_REVIEW_TEST_SECRET,
    ),
    first = writer.request(a.member, {
      checked: pa.preview.checked,
      operationId,
      confirm: "yes",
    });
  let second: ReturnType<typeof writer.request> | undefined;
  try {
    await h.entered.wait;
    second = b.reviews.request(b.member, {
      checked: pb.preview.checked,
      operationId,
      confirm: "yes",
    });
    await waitForSampleAssignmentBlock(pool, h.pid());
    h.resume.release();
    expect(await first).toMatchObject({ kind: "applied" });
    expect(await second).toMatchObject({ kind: "conflict" });
    expect(await b.reviews.inspect(b.member, operationId)).toEqual({
      kind: "denied",
    });
    const reserved = await pool.query(
      "SELECT actor_id AS actor FROM workflow_review_operations WHERE operation_id=$1",
      [operationId],
    );
    expect(reserved.rows).toEqual([{ actor: a.memberId }]);
  } finally {
    h.resume.release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});
it.each([true, false])(
  "WFREV-06 competing member withdrawals with same original key=%s preserve canonical withdrawal",
  async (sameKey) => {
    const f = await workflowReviewFixture(pool),
      operationId = randomUUID(),
      h = heldWrite("UPDATE workflow_review_requests SET withdrawn_at"),
      writer = workflowReviewStore(
        h.scoped,
        options,
        WORKFLOW_REVIEW_TEST_SECRET,
      ),
      first = writer.withdraw(f.member, f.requestId, operationId, "yes");
    let second: ReturnType<typeof writer.withdraw> | undefined;
    try {
      await h.entered.wait;
      second = f.reviews.withdraw(
        f.member,
        f.requestId,
        sameKey ? operationId : randomUUID(),
        "yes",
      );
      await waitForSampleAssignmentBlock(pool, h.pid());
      h.resume.release();
      const committed = await first,
        contended = await second;
      expect(committed.kind).toBe("applied");
      expect(contended.kind).toBe(sameKey ? "replayed" : "applied");
      if (
        committed.kind === "applied" &&
        (contended.kind === "applied" || contended.kind === "replayed")
      )
        expect(contended.receipt.withdrawnAt).toBe(
          committed.receipt.withdrawnAt,
        );
    } finally {
      h.resume.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  },
);
