import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
import {
  workflowReviewFixture,
  WORKFLOW_REVIEW_TEST_SECRET,
} from "../support/workflow-review.ts";
const pool = testPool();
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
type Fixture = Awaited<ReturnType<typeof workflowReviewFixture>>;
type Authority = "member" | "moderator" | "administrator" | "request" | "grant";
type Boundary = "acquisition" | "query" | "commit" | "native";
async function expiresSoon(f: Fixture, authority: Authority) {
  const table =
    authority === "request"
      ? "workflow_review_requests"
      : authority === "grant"
        ? "workflow_review_grants"
        : "principals";
  const id =
    authority === "request"
      ? f.requestId
      : authority === "grant"
        ? f.grantId
        : authority === "member"
          ? f.memberId
          : authority === "moderator"
            ? f.moderatorId
            : f.adminId;
  const row = (
    await pool.query<{ expires: Date; remaining: string }>(
      `UPDATE ${table} SET expires_at=clock_timestamp()+interval '900 milliseconds' WHERE id=$1 RETURNING expires_at AS expires,EXTRACT(EPOCH FROM(expires_at-clock_timestamp()))*1000 AS remaining`,
      [id],
    )
  ).rows[0]!;
  return {
    table,
    id,
    expires: row.expires,
    mono: performance.now() + Number(row.remaining),
  };
}
function delayedReturn(
  boundary: Boundary,
  expiry: Awaited<ReturnType<typeof expiresSoon>>,
) {
  const statements: string[] = [];
  let delay: Promise<unknown> | undefined,
    reached = false;
  async function pause() {
    reached = true;
    delay = pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())))+0.05)",
      [expiry.expires],
    );
    await delay;
  }
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      if (boundary === "acquisition") await pause();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (
            (boundary === "query" &&
              sql.startsWith("SELECT note FROM workflow_feedback")) ||
            (boundary === "commit" && sql === "COMMIT")
          )
            await pause();
          return result;
        }) as PoolClient["query"],
        release: (error?: Error) => {
          client.release(error);
          if (boundary === "native") {
            reached = true;
            Atomics.wait(
              new Int32Array(new SharedArrayBuffer(4)),
              0,
              0,
              Math.max(0, expiry.mono - performance.now()) + 75,
            );
          }
        },
      };
    },
  } as unknown as Pool;
  return {
    scoped,
    statements,
    settle: async () => {
      if (delay) await delay;
    },
    reached: () => reached,
  };
}
const cases = (
  ["member", "moderator", "administrator", "request", "grant"] as const
).flatMap((authority) =>
  (["acquisition", "query", "commit", "native"] as const).map((boundary) => ({
    authority,
    boundary,
  })),
);
it.each(cases)(
  "WFREV-05 $authority expiry during $boundary withholds protected note handback",
  async ({ authority, boundary }) => {
    const f = await workflowReviewFixture(pool),
      expiry = await expiresSoon(f, authority),
      delayed = delayedReturn(boundary, expiry);
    try {
      const result = await workflowReviewStaffStore(
        delayed.scoped,
        { enabled: true, mode: "test" },
        WORKFLOW_REVIEW_TEST_SECRET,
      ).read(f.moderator, f.grantId);
      expect(result).toEqual({ kind: "denied" });
      await delayed.settle();
      expect(delayed.reached()).toBe(true);
      expect(delayed.statements.filter((sql) => sql === "COMMIT")).toHaveLength(
        boundary === "commit" || boundary === "native" ? 1 : 0,
      );
      if (boundary === "commit" || boundary === "native")
        expect(delayed.statements).not.toContain("ROLLBACK");
      expect(
        (
          await pool.query(
            `SELECT expires_at<=clock_timestamp() AS expired FROM ${expiry.table} WHERE id=$1`,
            [expiry.id],
          )
        ).rows[0].expired,
      ).toBe(true);
    } finally {
      await delayed.settle();
    }
  },
);
it.each([
  { action: "withdraw", boundary: "commit" },
  { action: "withdraw", boundary: "native" },
  { action: "revoke", boundary: "commit" },
  { action: "revoke", boundary: "native" },
] as const)(
  "WFREV-05 actual $action commit crossing actor expiry during $boundary returns unavailable with durable exact operation",
  async ({ action, boundary }) => {
    const f = await workflowReviewFixture(pool),
      expiry = await expiresSoon(
        f,
        action === "withdraw" ? "member" : "administrator",
      ),
      delayed = delayedReturn(boundary, expiry),
      operationId = randomUUID();
    try {
      const result =
        action === "withdraw"
          ? await workflowReviewStore(
              delayed.scoped,
              { enabled: true, mode: "test" },
              WORKFLOW_REVIEW_TEST_SECRET,
            ).withdraw(f.member, f.requestId, operationId, "yes")
          : await workflowReviewStaffStore(
              delayed.scoped,
              { enabled: true, mode: "test" },
              WORKFLOW_REVIEW_TEST_SECRET,
            ).revoke(f.admin, f.grantId, operationId, "yes");
      expect(result).toEqual({ kind: "unavailable" });
      await delayed.settle();
      expect(delayed.reached()).toBe(true);
      expect(delayed.statements.filter((sql) => sql === "COMMIT")).toHaveLength(
        1,
      );
      expect(delayed.statements).not.toContain("ROLLBACK");
      expect(
        (
          await pool.query(
            "SELECT receipt_id FROM workflow_review_operations WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0].receipt_id,
      ).toBe(action === "withdraw" ? f.requestId : f.grantId);
      const row = (
        await pool.query(
          action === "withdraw"
            ? "SELECT withdrawn_at AS ended FROM workflow_review_requests WHERE id=$1"
            : "SELECT revoked_at AS ended FROM workflow_review_grants WHERE id=$1",
          [action === "withdraw" ? f.requestId : f.grantId],
        )
      ).rows[0];
      expect(row.ended).toBeInstanceOf(Date);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [expiry.id],
      );
      if (action === "withdraw")
        expect(await f.reviews.inspect(f.member, operationId)).toMatchObject({
          kind: "ready",
          receipt: { state: "withdrawn" },
        });
      else
        expect(await f.staff.inspect(f.admin, operationId)).toMatchObject({
          kind: "ready",
          grant: { state: "revoked" },
        });
      expect(await f.staff.read(f.moderator, f.grantId)).toEqual({
        kind: "denied",
      });
    } finally {
      await delayed.settle();
    }
  },
);
