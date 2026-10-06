import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { reviewerWorklistStore } from "../../src/reviewer-worklist.ts";

export const sampleAssignmentToken = () => randomBytes(32).toString("hex");
export async function sampleAssignmentFixture(pool: Pool, root: string) {
  const members = store(pool),
    auth = authorizationStore(pool),
    ownerToken = sampleAssignmentToken(),
    administratorToken = sampleAssignmentToken(),
    reviewerToken = sampleAssignmentToken();
  await members.create(ownerToken, {
    background: "explorer",
    goal: "everyday",
  });
  const owner = await members.session(ownerToken);
  if (owner.kind !== "active") throw Error("Invented member unavailable");
  const end = new Date(Date.now() + 3600000);
  const administratorId = await auth.provisionStaff(
      administratorToken,
      "platform_admin",
      end,
    ),
    reviewerId = await auth.provisionStaff(reviewerToken, "reviewer", end);
  const objects = fileObjectStorage(root),
    evidence = evidenceStore(
      pool,
      objects,
      "invented-sample-assignment-secret",
    );
  const uploaded = await evidence.upload(ownerToken, {
    name: "Invented private sample",
    mediaType: "text/plain",
    data: Buffer.from("Invented source for exact private feedback."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Invented source unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  if (!(await evidence.submitForReview(ownerToken, uploaded.id)))
    throw Error("Invented queue unavailable");
  const input = {
    evidenceId: uploaded.id,
    sourceRevision: 1,
    reviewerId,
    operationId: randomUUID(),
    startsAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(+end - 1000).toISOString(),
  };
  const assignments = sampleAssignmentStore(pool, {
    enabled: true,
    mode: "test",
  });
  return {
    members,
    auth,
    ownerToken,
    ownerId: owner.learner.id,
    administratorToken,
    administratorId,
    reviewerToken,
    reviewerId,
    end,
    objects,
    evidence,
    input,
    assignments,
    feedback: sampleFeedbackStore(pool, objects),
    worklist: reviewerWorklistStore(pool),
  };
}
export async function waitForSampleAssignmentBlock(
  pool: Pool,
  blocker: number,
  minimum = 1,
) {
  const until = performance.now() + 2000;
  while (performance.now() < until) {
    const rows = (
      await pool.query(
        `WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity
           WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN waiting ON waiting.pid=ANY(pg_blocking_pids(activity.pid))
           WHERE activity.datname=current_database()
        ) SELECT pid FROM waiting`,
        [blocker],
      )
    ).rows;
    if (rows.length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected real PostgreSQL assignment lock wait");
}
