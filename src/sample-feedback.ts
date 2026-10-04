import type { ApplicationMode } from "./adapters.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ObjectStorage } from "./evidence.ts";
import { hash } from "./store.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
  type SampleFailureKind,
} from "./sample-feedback-lifetime.ts";
import {
  SAMPLE_FEEDBACK_PURPOSE,
  SAMPLE_FEEDBACK_PAGE_SIZE,
  sampleUuid,
  sampleToken,
  sampleText,
  sampleDraftValid,
  sampleDraftDigest,
  type SampleCriterion,
} from "./sample-feedback-values.ts";
import {
  recordReviewTime,
  beginReviewTime,
  reviewTimeReceipt,
  type ReviewTimeReceipt,
  type ReviewTimeResult,
  reviewIntervalMinutes,
  type ReviewTimeIntervals,
} from "./review-time.ts";
export interface AllocatedFeedbackInput {
  allocationId: string;
  grantId: string;
  intervals: ReviewTimeIntervals;
}
export interface SampleFeedbackRecord extends QueryResultRow {
  id: string;
  submissionId: string;
  authorId: string;
  sourceSha256: string;
  sourceRevision: number;
  criteria: SampleCriterion[];
  preparationMinutes: number | null;
  reviewMinutes: number | null;
  revision: number;
  draftOperationId: string;
  publicationOperationId: string | null;
  publishedAt: Date | null;
  clarification: string | null;
  clarificationOperationId: string | null;
  clarifiedAt: Date | null;
  answer: string | null;
  answerOperationId: string | null;
  answeredAt: Date | null;
}
export interface SampleFeedbackView {
  reviewAllocation?: {
    receipt: ReviewTimeReceipt;
    grantId: string;
    writesEnabled: boolean;
  };
  kind: "ready";
  evidenceId: string;
  submissionId: string;
  title: string;
  source: string;
  sourceSha256: string;
  sourceRevision: number;
  consent: boolean;
  records: SampleFeedbackRecord[];
  next: string | null;
}
export type SampleFeedbackResult =
  | SampleFeedbackView
  | { kind: "saved"; id: string; revision: number }
  | { kind: SampleFailureKind };
export interface SampleFeedbackStore {
  beginReview(
    token: string,
    evidenceId: string,
    allocationId: string,
    grantId: string,
    operationId: string,
  ): Promise<ReviewTimeResult | { kind: SampleFailureKind }>;
  reviewer(token: string, evidenceId: string): Promise<SampleFeedbackResult>;
  owner(
    token: string,
    evidenceId: string,
    after?: string,
  ): Promise<SampleFeedbackResult>;
  save(
    token: string,
    evidenceId: string,
    input: unknown,
  ): Promise<SampleFeedbackResult>;
  publish(
    token: string,
    evidenceId: string,
    revision: number,
    operationId: string,
    allocated?: AllocatedFeedbackInput,
  ): Promise<SampleFeedbackResult>;
  clarify(
    token: string,
    evidenceId: string,
    feedbackId: string,
    text: string,
    operationId: string,
  ): Promise<SampleFeedbackResult>;
  answer(
    token: string,
    evidenceId: string,
    feedbackId: string,
    text: string,
    operationId: string,
  ): Promise<SampleFeedbackResult>;
}
const projection = `id,submission_id AS "submissionId",reviewer_id AS "authorId",
 source_sha256 AS "sourceSha256",source_revision AS "sourceRevision",criteria,
 preparation_minutes AS "preparationMinutes",review_minutes AS "reviewMinutes",draft_revision AS revision,
 draft_operation_id AS "draftOperationId",publication_operation_id AS "publicationOperationId",published_at AS "publishedAt",
 clarification,clarification_operation_id AS "clarificationOperationId",clarified_at AS "clarifiedAt",
 answer,answer_operation_id AS "answerOperationId",answered_at AS "answeredAt"`;
interface Scope {
  tx: SampleTransaction;
  actorId: string;
  workspaceId: string;
  evidenceId: string;
  submissionId: string;
  status: string;
  title: string;
  source: string;
  digest: string;
  sourceRevision: number;
  consent: boolean;
  assignmentId?: string;
  exactId?: string;
  expires: Date[];
}
const fail = (kind: SampleFailureKind): never => {
  throw new SampleFeedbackFailure(kind);
};
export function sampleFeedbackStore(
  pool: Pool,
  objects: ObjectStorage,
  options: { reviewTimeWrites: boolean; mode: ApplicationMode } = {
    reviewTimeWrites: false,
    mode: "demo",
  },
): SampleFeedbackStore {
  async function execute<T = SampleFeedbackResult>(
    token: string,
    evidenceId: string,
    staff: boolean,
    writing: boolean,
    use: (scope: Scope) => Promise<T>,
    actorExclusion = false,
  ): Promise<T | { kind: SampleFailureKind }> {
    if (!sampleToken(token) || !sampleUuid(evidenceId))
      return { kind: "denied" };
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const identity = (
          await tx.query<{
            id: string;
            kind: string;
            role: string | null;
            expires: Date;
          }>(
            `SELECT p.id,p.kind,s.role,p.expires_at AS expires FROM principals p LEFT JOIN staff_profiles s ON s.principal_id=p.id
     WHERE p.token_hash=$1 AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() FOR SHARE OF p`,
            [hash(token)],
          )
        ).rows[0];
        if (
          !identity ||
          (staff
            ? identity.kind !== "staff" || identity.role !== "reviewer"
            : identity.kind !== "member")
        )
          return fail("denied");
        const expires = [identity.expires];
        await tx.observe(expires);
        if (actorExclusion) {
          const profile = (
            await tx.query(
              "SELECT 1 FROM staff_profiles WHERE principal_id=$1 AND role='reviewer' FOR SHARE",
              [identity.id],
            )
          ).rows[0];
          if (!profile) return fail("denied");
          await tx.query("SELECT pg_advisory_xact_lock(44154,hashtext($1))", [
            identity.id,
          ]);
          await tx.observe(expires);
        }
        const workspace = (
          await tx.query<{ id: string }>(
            `SELECT w.id FROM workspaces w JOIN evidence_objects e ON e.workspace_id=w.id
    WHERE e.id=$1 AND w.deleting_at IS NULL FOR SHARE OF w`,
            [evidenceId],
          )
        ).rows[0];
        if (!workspace) return fail("denied");
        const evidence = (
          await tx.query<{
            owner: string;
            consent: boolean;
            state: string;
            name: string;
            media: string;
            key: string;
            bytes: number;
            digest: string;
            revision: number;
          }>(
            `SELECT owner_principal_id AS owner,private_review_allowed AS consent,quarantine_state AS state,
     original_name AS name,media_type AS media,storage_key AS key,byte_size AS bytes,sha256 AS digest,revision_number AS revision
     FROM evidence_objects WHERE id=$1 AND workspace_id=$2 AND quarantine_state<>'deleting' FOR ${writing ? "UPDATE" : "SHARE"}`,
            [evidenceId, workspace.id],
          )
        ).rows[0];
        if (
          !evidence ||
          evidence.media !== "text/plain" ||
          (!staff && evidence.owner !== identity.id) ||
          (staff && (!evidence.consent || evidence.state !== "clean"))
        )
          return fail("denied");
        const submission = (
          await tx.query<{ id: string; status: string }>(
            `SELECT id,status FROM evidence_review_submissions
    WHERE evidence_id=$1 AND submitted_by=$2 FOR ${writing ? "UPDATE" : "SHARE"}`,
            [evidenceId, evidence.owner],
          )
        ).rows[0];
        if (
          !submission ||
          (staff && !["queued", "reviewed"].includes(submission.status))
        )
          return fail("denied");
        let assignmentId: string | undefined, exactId: string | undefined;
        if (staff) {
          const assignment = (
            await tx.query<{ id: string; expires: Date }>(
              `SELECT a.id,a.expires_at AS expires FROM assignment_grants a
     WHERE a.staff_id=$1 AND a.staff_role='reviewer' AND a.workspace_id=$2 AND a.revoked_at IS NULL
      AND a.starts_at<=clock_timestamp() AND a.expires_at>clock_timestamp() AND EXISTS(
       SELECT 1 FROM reviewer_evidence_grants g WHERE g.assignment_id=a.id AND g.submission_id=$3 AND g.reviewer_id=$1
       AND g.purpose=$4 AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp())
     ORDER BY a.id LIMIT 1 FOR SHARE OF a`,
              [
                identity.id,
                workspace.id,
                submission.id,
                SAMPLE_FEEDBACK_PURPOSE,
              ],
            )
          ).rows[0];
          if (!assignment) return fail("denied");
          expires.push(assignment.expires);
          await tx.observe(expires);
          const exact = (
            await tx.query<{ id: string; expires: Date }>(
              `SELECT id,expires_at AS expires FROM reviewer_evidence_grants
     WHERE assignment_id=$1 AND submission_id=$2 AND reviewer_id=$3 AND purpose=$4 AND revoked_at IS NULL
      AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE`,
              [
                assignment.id,
                submission.id,
                identity.id,
                SAMPLE_FEEDBACK_PURPOSE,
              ],
            )
          ).rows[0];
          if (!exact) return fail("denied");
          expires.push(exact.expires);
          await tx.observe(expires);
          assignmentId = assignment.id;
          exactId = exact.id;
        }
        if (
          !Number.isSafeInteger(evidence.bytes) ||
          evidence.bytes < 1 ||
          evidence.bytes > 1048576
        )
          return fail("unavailable");
        const bytes = await tx.bounded(() => objects.get(evidence.key));
        if (
          bytes.length !== evidence.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== evidence.digest
        )
          return fail("unavailable");
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const scope: Scope = {
          tx,
          actorId: identity.id,
          workspaceId: workspace.id,
          evidenceId,
          submissionId: submission.id,
          status: submission.status,
          title: evidence.name,
          source,
          digest: evidence.digest,
          sourceRevision: evidence.revision,
          consent: evidence.consent,
          assignmentId,
          exactId,
          expires,
        };
        const result = await use(scope);
        await tx.observe(expires);
        return result;
      });
    } catch (error) {
      return {
        kind:
          error instanceof SampleFeedbackFailure ? error.kind : "unavailable",
      };
    }
  }
  async function allocationGrant(
    s: Scope,
    allocationId: string,
    grantId: string,
  ) {
    const grant = (
      await s.tx.query<{ expires: Date }>(
        `SELECT g.expires_at AS expires FROM review_time_grants g JOIN review_time_allocations a ON a.id=g.allocation_id
       WHERE g.id=$1 AND g.allocation_id=$2 AND g.staff_id=$3 AND g.purpose='review-time-local-v1'
        AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
        AND a.submission_id=$4 AND a.workspace_id=$5 AND a.source_unavailable_at IS NULL FOR SHARE OF g`,
        [grantId, allocationId, s.actorId, s.submissionId, s.workspaceId],
      )
    ).rows[0];
    if (!grant) return fail("denied");
    s.expires.push(grant.expires);
    await s.tx.observe(s.expires);
  }
  async function audit(s: Scope, action: string) {
    await s.tx.query(
      `INSERT INTO private_sample_feedback_audit(id,workspace_id,evidence_id,submission_id,actor_id,assignment_id,exact_grant_id,action)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        s.workspaceId,
        s.evidenceId,
        s.submissionId,
        s.actorId,
        s.assignmentId,
        s.exactId,
        action,
      ],
    );
  }
  async function own(s: Scope) {
    const row = (
      await s.tx.query<SampleFeedbackRecord>(
        `SELECT ${projection} FROM private_sample_feedback
  WHERE submission_id=$1 AND reviewer_id=$2 FOR UPDATE`,
        [s.submissionId, s.actorId],
      )
    ).rows[0];
    if (
      row &&
      (row.sourceSha256 !== s.digest || row.sourceRevision !== s.sourceRevision)
    )
      return fail("unavailable");
    return row;
  }
  const view = (
    s: Scope,
    records: SampleFeedbackRecord[],
    next: string | null = null,
  ): SampleFeedbackView => ({
    kind: "ready",
    evidenceId: s.evidenceId,
    submissionId: s.submissionId,
    title: s.title,
    source: s.source,
    sourceSha256: s.digest,
    sourceRevision: s.sourceRevision,
    consent: s.consent,
    records,
    next,
  });
  async function exchange(
    token: string,
    evidenceId: string,
    id: string,
    text: string,
    operationId: string,
    staff: boolean,
  ) {
    if (!sampleUuid(id) || !sampleUuid(operationId) || !sampleText(text, 2000))
      return { kind: "invalid" as const };
    return execute<SampleFeedbackResult>(
      token,
      evidenceId,
      staff,
      true,
      async (s) => {
        if (!s.consent) return fail("denied");
        const row = (
          await s.tx.query<SampleFeedbackRecord>(
            `SELECT ${projection} FROM private_sample_feedback
    WHERE id=$1 AND submission_id=$2 AND published_at IS NOT NULL FOR UPDATE`,
            [id, s.submissionId],
          )
        ).rows[0];
        if (!row || (staff && row.authorId !== s.actorId))
          return fail("denied");
        if (staff && row.clarification === null) return fail("conflict");
        const prior = staff ? row.answer : row.clarification,
          priorOp = staff
            ? row.answerOperationId
            : row.clarificationOperationId;
        if (prior !== null) {
          if (prior !== text || priorOp !== operationId)
            return fail("conflict");
        } else
          await s.tx.query(
            staff
              ? `UPDATE private_sample_feedback SET answer=$2,answer_operation_id=$3,answered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`
              : `UPDATE private_sample_feedback SET clarification=$2,clarification_operation_id=$3,clarified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
            [id, text, operationId],
          );
        if (staff) await audit(s, "answered");
        return { kind: "saved", id: row.id, revision: row.revision };
      },
    );
  }
  return {
    reviewer(token, evidenceId) {
      return execute<SampleFeedbackResult>(
        token,
        evidenceId,
        true,
        false,
        async (s) => {
          const rows = (
            await s.tx.query<SampleFeedbackRecord>(
              `SELECT ${projection} FROM private_sample_feedback WHERE submission_id=$1 AND reviewer_id=$2 FOR SHARE`,
              [s.submissionId, s.actorId],
            )
          ).rows;
          await audit(s, "read");
          const result = view(s, rows);
          const current = (
            await s.tx.query<{ allocationId: string; grantId: string }>(
              `SELECT a.id AS "allocationId",g.id AS "grantId" FROM review_time_allocations a JOIN review_time_grants g ON g.allocation_id=a.id
             WHERE a.submission_id=$1 AND g.staff_id=$2 AND a.source_unavailable_at IS NULL AND g.revoked_at IS NULL
              AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
              AND (a.begun_grant_id IS NULL OR a.begun_grant_id=g.id)
             ORDER BY CASE WHEN a.state IN ('allocated','begun','needs_reconciliation') THEN 0 ELSE 1 END,
              a.created_at DESC,a.id DESC,g.id LIMIT 1 FOR SHARE OF a,g`,
              [s.submissionId, s.actorId],
            )
          ).rows[0];
          if (current) {
            await allocationGrant(s, current.allocationId, current.grantId);
            result.reviewAllocation = {
              receipt: await reviewTimeReceipt(s.tx, current.allocationId),
              grantId: current.grantId,
              writesEnabled:
                options.reviewTimeWrites && options.mode !== "live",
            };
          }
          return result;
        },
      );
    },
    owner(token, evidenceId, after) {
      if (after !== undefined && !sampleUuid(after))
        return Promise.resolve({ kind: "denied" });
      return execute<SampleFeedbackResult>(
        token,
        evidenceId,
        false,
        false,
        async (s) => {
          const rows = (
            await s.tx.query<SampleFeedbackRecord>(
              `SELECT ${projection} FROM private_sample_feedback
     WHERE submission_id=$1 AND published_at IS NOT NULL AND ($2::uuid IS NULL OR id>$2)
     ORDER BY id LIMIT $3 FOR SHARE`,
              [s.submissionId, after ?? null, SAMPLE_FEEDBACK_PAGE_SIZE + 1],
            )
          ).rows;
          const more = rows.length > SAMPLE_FEEDBACK_PAGE_SIZE;
          const items = rows.slice(0, SAMPLE_FEEDBACK_PAGE_SIZE);
          return view(s, items, more ? items.at(-1)!.id : null);
        },
      );
    },
    save(token, evidenceId, input) {
      return execute<SampleFeedbackResult>(
        token,
        evidenceId,
        true,
        true,
        async (s) => {
          if (!sampleDraftValid(input, s.source)) return fail("invalid");
          const row = await own(s),
            digest = sampleDraftDigest(input);
          if (row?.publishedAt) return fail("conflict");
          if (row) {
            const replay = (
              await s.tx.query<{ digest: string; revision: number }>(
                `SELECT request_sha256 AS digest,resulting_revision AS revision
      FROM private_sample_feedback_draft_operations WHERE feedback_id=$1 AND operation_id=$2`,
                [row.id, input.operationId],
              )
            ).rows[0];
            if (replay) {
              if (replay.digest !== digest || replay.revision !== row.revision)
                return fail("conflict");
              return { kind: "saved", id: row.id, revision: row.revision };
            }
          }
          if ((row?.revision ?? 0) !== input.revision) return fail("conflict");
          const id = row?.id ?? randomUUID(),
            revision = input.revision + 1;
          if (row)
            await s.tx.query(
              `UPDATE private_sample_feedback SET criteria=$2,preparation_minutes=$3,review_minutes=$4,
     draft_revision=$5,draft_operation_id=$6,updated_at=clock_timestamp() WHERE id=$1`,
              [
                id,
                JSON.stringify(input.criteria),
                input.preparationMinutes,
                input.reviewMinutes,
                revision,
                input.operationId,
              ],
            );
          else
            await s.tx.query(
              `INSERT INTO private_sample_feedback(id,submission_id,reviewer_id,source_sha256,source_revision,criteria,
     preparation_minutes,review_minutes,draft_revision,draft_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                id,
                s.submissionId,
                s.actorId,
                s.digest,
                s.sourceRevision,
                JSON.stringify(input.criteria),
                input.preparationMinutes,
                input.reviewMinutes,
                revision,
                input.operationId,
              ],
            );
          await s.tx.query(
            `INSERT INTO private_sample_feedback_draft_operations(feedback_id,operation_id,request_sha256,resulting_revision)
    VALUES($1,$2,$3,$4)`,
            [id, input.operationId, digest, revision],
          );
          await audit(s, "draft-saved");
          return { kind: "saved", id, revision };
        },
      );
    },
    beginReview(token, evidenceId, allocationId, grantId, operationId) {
      if (!options.reviewTimeWrites || options.mode === "live")
        return Promise.resolve({ kind: "unavailable" });
      if (![allocationId, grantId, operationId].every(sampleUuid))
        return Promise.resolve({ kind: "invalid" });
      return execute<ReviewTimeResult>(
        token,
        evidenceId,
        true,
        true,
        async (s) => {
          await allocationGrant(s, allocationId, grantId);
          return beginReviewTime(
            s.tx,
            s.actorId,
            { sourceKey: s.submissionId, allocationId, grantId },
            {
              withdrawnAt: null,
              resolvedAt: s.status === "queued" ? null : new Date(0),
            },
            operationId,
            s.expires,
          );
        },
        true,
      );
    },
    publish(token, evidenceId, revision, operationId, allocated) {
      if (allocated && (!options.reviewTimeWrites || options.mode === "live"))
        return Promise.resolve({ kind: "unavailable" });
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !sampleUuid(operationId)
      )
        return Promise.resolve({ kind: "invalid" });
      if (
        allocated &&
        (!sampleUuid(allocated.allocationId) ||
          !sampleUuid(allocated.grantId) ||
          !reviewIntervalMinutes(allocated.intervals))
      )
        return Promise.resolve({ kind: "invalid" });
      // Snapshot caller-owned mutable Dates before the first authority wait.
      const input = allocated
        ? {
            allocationId: allocated.allocationId,
            grantId: allocated.grantId,
            intervals: {
              reviewStart: new Date(+allocated.intervals.reviewStart),
              reviewEnd: new Date(+allocated.intervals.reviewEnd),
              preparationStart: allocated.intervals.preparationStart
                ? new Date(+allocated.intervals.preparationStart)
                : null,
              preparationEnd: allocated.intervals.preparationEnd
                ? new Date(+allocated.intervals.preparationEnd)
                : null,
            },
          }
        : undefined;
      return execute<SampleFeedbackResult>(
        token,
        evidenceId,
        true,
        true,
        async (s) => {
          const row = await own(s);
          if (!row || row.revision !== revision) return fail("conflict");
          const publish = async () => {
            if (row.publishedAt) {
              if (row.publicationOperationId !== operationId)
                return fail("conflict");
            } else {
              await s.tx.query(
                "UPDATE private_sample_feedback SET publication_operation_id=$2,published_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
                [row.id, operationId],
              );
              await s.tx.query(
                "UPDATE evidence_review_submissions SET status='reviewed' WHERE id=$1 AND status='queued'",
                [s.submissionId],
              );
            }
          };
          if (input) {
            await allocationGrant(s, input.allocationId, input.grantId);
            const settled = await recordReviewTime(
              s.tx,
              s.actorId,
              {
                sourceKey: s.submissionId,
                allocationId: input.allocationId,
                grantId: input.grantId,
              },
              operationId,
              input.intervals,
              s.expires,
              { feedbackId: row.id, draftRevision: revision, operationId },
              publish,
            );
            if (settled.kind !== "applied" && settled.kind !== "replayed")
              return fail(settled.kind === "conflict" ? "conflict" : "denied");
          } else {
            const held = (
              await s.tx.query(
                "SELECT 1 FROM review_time_allocations WHERE source_key=$1 AND state IN ('allocated','begun','needs_reconciliation')",
                [s.submissionId],
              )
            ).rows[0];
            if (held) return fail("conflict");
            await publish();
          }
          await audit(s, "published");
          return { kind: "saved", id: row.id, revision: row.revision };
        },
        !!input,
      );
    },
    clarify(token, evidenceId, id, text, operationId) {
      return exchange(token, evidenceId, id, text, operationId, false);
    },
    answer(token, evidenceId, id, text, operationId) {
      return exchange(token, evidenceId, id, text, operationId, true);
    },
  };
}
