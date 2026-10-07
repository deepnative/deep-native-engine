import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";

/** Test-owned listener: lose one reply only after the real PostgreSQL operation
 * COMMIT succeeds. No production fault flag or automatic replay. */
export async function startWorkflowReviewRecoveryServer(
  pool: Pool,
  fault: "request" | "assign",
) {
  await migrate(pool);
  const observation = {
    operationCommits: 0,
    lostReplies: 0,
    rollbacksAfterCommit: 0,
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let selectedOperation = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (
            sql.includes("INSERT INTO workflow_review_operations") &&
            (fault === "assign"
              ? sql.includes("'assign'")
              : values?.[3] === "request")
          )
            selectedOperation = true;
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && selectedOperation) {
            committed = true;
            observation.operationCommits++;
            if (observation.lostReplies === 0) {
              observation.lostReplies++;
              throw Error("Invented lost workflow review COMMIT response");
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const secret = randomBytes(32).toString("hex");
  const options = {
    origin: "http://127.0.0.1:0",
    secret,
    mode: "test" as const,
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    authorization: authorizationStore(pool),
    workflowReviewRequests: true,
    workflowReviews: workflowReviewStore(
      scoped,
      { enabled: true, mode: "test" },
      secret,
    ),
    workflowReviewStaff: workflowReviewStaffStore(
      scoped,
      { enabled: true, mode: "test" },
      secret,
    ),
    workflowFeedback: workflowFeedbackStore(pool),
    memberExport: memberExportStore(pool),
  };
  let server: Server | undefined;
  try {
    server = app(store(pool), options).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned recovery listener unavailable");
    options.origin = `http://127.0.0.1:${address.port}`;
    const owned = server;
    return {
      origin: options.origin,
      observation,
      close: () =>
        new Promise<void>((resolve, reject) =>
          owned.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  } catch (error) {
    server?.close();
    throw error;
  }
}
