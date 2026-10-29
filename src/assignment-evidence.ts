import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
  type SampleFailureKind,
} from "./sample-feedback-lifetime.ts";
import {
  assignmentEvidenceInstruction,
  assignmentPayloadDigest,
  assignmentSequence,
  assignmentEvidenceName,
  ASSIGNMENT_ORIGIN_JOIN,
  ASSIGNMENT_ORIGIN_SQL,
  type AssignmentEvidenceOrigin,
  type AssignmentEvidenceSource,
} from "./assignment-evidence-values.ts";

export interface AssignmentEvidenceReceipt {
  receiptId: string;
  evidenceId: string | null;
  createdAt: Date;
  state: "available" | "withdrawn" | "removed";
  assignmentOrigin: AssignmentEvidenceOrigin | null;
}
export type AssignmentEvidenceFailure = {
  kind: SampleFailureKind | "disabled";
};
export type AssignmentEvidenceOpen =
  | AssignmentEvidenceFailure
  | { kind: "ready"; source: AssignmentEvidenceSource; deadline: number };
export type AssignmentEvidenceCreate =
  | AssignmentEvidenceFailure
  | {
      kind: "created" | "replayed";
      receipt: AssignmentEvidenceReceipt;
      deadline: number;
    };
export type AssignmentEvidenceInspect =
  | AssignmentEvidenceFailure
  | { kind: "ready"; receipt: AssignmentEvidenceReceipt; deadline: number }
  | { kind: "absent"; deadline: number };
export interface AssignmentEvidenceStore {
  open(
    token: string,
    attemptId: string,
    sequence: number,
  ): Promise<AssignmentEvidenceOpen>;
  create(token: string, input: unknown): Promise<AssignmentEvidenceCreate>;
  inspect(
    token: string,
    operationId: string,
  ): Promise<AssignmentEvidenceInspect>;
}
interface Context {
  tx: SampleTransaction;
  memberId: string;
  workspaceId: string;
  expires: Date;
}
const fail = (kind: SampleFailureKind): never => {
  throw new SampleFeedbackFailure(kind);
};
export function assignmentEvidenceStore(
  pool: Pool,
  options: { enabled: boolean },
): AssignmentEvidenceStore {
  async function execute<T extends object>(
    token: string,
    writing: boolean,
    use: (context: Context) => Promise<T>,
  ): Promise<AssignmentEvidenceFailure | (T & { deadline: number })> {
    if (!sampleToken(token)) return { kind: "denied" };
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const principal = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='member'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) return fail("denied");
        await tx.observe([principal.expires]);
        const workspace = (
          await tx.query<{ id: string }>(
            `SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR ${writing ? "UPDATE" : "SHARE"}`,
            [principal.id],
          )
        ).rows[0];
        if (!workspace) return fail("denied");
        await tx.observe([principal.expires]);
        const result = await use({
          tx,
          memberId: principal.id,
          workspaceId: workspace.id,
          expires: principal.expires,
        });
        await tx.observe([principal.expires]);
        return { ...result, deadline: tx.deadline() };
      });
    } catch (error) {
      return { kind: (error as SampleFeedbackFailure).kind };
    }
  }
  async function source(context: Context, attemptId: string, sequence: number) {
    const { tx, memberId, expires } = context;
    // Parent before snapshot, matching attempt/source deletion. Retirement,
    // current goal and a newer private draft never replace the pinned source.
    const attempt = (
      await tx.query<{ id: string }>(
        "SELECT id FROM assignment_attempts WHERE id=$1 AND member_id=$2 FOR SHARE",
        [attemptId, memberId],
      )
    ).rows[0];
    if (!attempt) return fail("denied");
    const snapshot = (
      await tx.query<AssignmentEvidenceSource>(
        `SELECT a.id AS "attemptId",s.sequence,a.content_id AS "contentId",a.content_version AS "contentVersion",
       cv.title,cv.rubric,cv.rubric_version AS "rubricVersion",s.response,s.submitted_at AS "submittedAt",
       encode(sha256(convert_to(s.response,'UTF8')),'hex') AS "sourceSha256"
       FROM assignment_submission_snapshots s JOIN assignment_attempts a ON a.id=s.attempt_id
       JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
       WHERE a.id=$1 AND a.member_id=$2 AND s.sequence=$3 AND cv.kind='assignment'
       AND cv.rubric IS NOT NULL AND cv.rubric_version IS NOT NULL FOR SHARE OF s`,
        [attemptId, memberId, sequence],
      )
    ).rows[0];
    if (!snapshot) return fail("denied");
    await tx.observe([expires]);
    return snapshot;
  }
  async function receipt(context: Context, operationId: string) {
    const { tx, memberId, workspaceId } = context;
    type Operation = {
      receiptId: string;
      evidenceId: string | null;
      createdAt: Date;
      digest: string;
      memberId: string;
      workspaceId: string;
    };
    const sql = `SELECT id AS "receiptId",evidence_id AS "evidenceId",created_at AS "createdAt",payload_digest AS digest,
     member_id AS "memberId",workspace_id AS "workspaceId" FROM assignment_evidence_operations WHERE operation_id=$1`;
    const discovered = (await tx.query<Operation>(sql, [operationId])).rows[0];
    if (!discovered) return undefined;
    if (
      discovered.memberId !== memberId ||
      discovered.workspaceId !== workspaceId
    )
      return fail("denied");
    type Retained = {
      state: string;
      consent: boolean;
      assignmentOrigin: AssignmentEvidenceOrigin | null;
    };
    let retained: Retained | undefined;
    if (discovered.evidenceId !== null) {
      // No attempt lock after the evidence lock: native deletion acquires the
      // attempt/snapshot first. Immutable rows can be validated through MVCC.
      retained = (
        await tx.query<Retained>(
          `SELECT e.quarantine_state AS state,e.private_review_allowed AS consent,${ASSIGNMENT_ORIGIN_SQL}
         FROM evidence_objects e ${ASSIGNMENT_ORIGIN_JOIN}
         WHERE e.id=$1 AND e.workspace_id=$2 AND e.owner_principal_id=$3 FOR SHARE OF e`,
          [discovered.evidenceId, workspaceId, memberId],
        )
      ).rows[0];
    }
    const operation = (
      await tx.query<Operation>(`${sql} FOR SHARE`, [operationId])
    ).rows[0];
    if (!operation) return undefined;
    if (
      operation.memberId !== memberId ||
      operation.workspaceId !== workspaceId
    )
      return fail("denied");
    let state: AssignmentEvidenceReceipt["state"] = "removed",
      assignmentOrigin: AssignmentEvidenceOrigin | null = null;
    if (operation.evidenceId !== null) {
      if (
        !retained ||
        operation.evidenceId !== discovered.evidenceId ||
        !retained.assignmentOrigin
      )
        return fail("unavailable");
      if (retained.state !== "deleting") {
        if (retained.state !== "clean") return fail("unavailable");
        assignmentOrigin = retained.assignmentOrigin;
        state = retained.consent ? "available" : "withdrawn";
      }
    }
    return {
      digest: operation.digest,
      value: {
        receiptId: operation.receiptId,
        evidenceId: state === "removed" ? null : operation.evidenceId,
        createdAt: operation.createdAt,
        state,
        assignmentOrigin,
      } satisfies AssignmentEvidenceReceipt,
    };
  }
  return {
    async open(token, attemptId, sequence) {
      if (!options.enabled) return { kind: "disabled" };
      if (!sampleUuid(attemptId) || !assignmentSequence(sequence))
        return { kind: "invalid" };
      return execute(token, false, async (context) => ({
        kind: "ready" as const,
        source: await source(context, attemptId, sequence),
      }));
    },
    async create(token, value) {
      if (!options.enabled) return { kind: "disabled" };
      const input = assignmentEvidenceInstruction(value);
      if (!input) return { kind: "invalid" };
      return execute(token, true, async (context) => {
        const { tx, memberId, workspaceId, expires } = context;
        await tx.query("SELECT pg_advisory_xact_lock(54501,hashtext($1))", [
          input.operationId,
        ]);
        await tx.observe([expires]);
        const previous = await receipt(context, input.operationId),
          payload = assignmentPayloadDigest(input);
        if (previous) {
          if (previous.digest !== payload) return fail("conflict");
          return { kind: "replayed" as const, receipt: previous.value };
        }
        const selected = await source(context, input.attemptId, input.sequence);
        if (
          selected.contentId !== input.contentId ||
          selected.contentVersion !== input.contentVersion ||
          selected.rubricVersion !== input.rubricVersion ||
          selected.sourceSha256 !== input.sourceSha256
        )
          return fail("conflict");
        const id = randomUUID(),
          key = randomUUID();
        await tx.query(
          `INSERT INTO evidence_objects(id,workspace_id,owner_principal_id,original_name,media_type,byte_size,sha256,storage_key,
           quarantine_state,private_review_allowed,community_publication_allowed,rights_attested_at,assignment_bound)
           VALUES($1,$2,$3,$4,'text/plain',$5,$6,$7,'clean',true,false,clock_timestamp(),true)`,
          [
            id,
            workspaceId,
            memberId,
            assignmentEvidenceName(selected.sequence),
            Buffer.byteLength(selected.response),
            selected.sourceSha256,
            key,
          ],
        );
        await tx.query(
          `INSERT INTO assignment_evidence_origins(evidence_id,workspace_id,member_id,storage_key,attempt_id,sequence,content_id,content_version,rubric_version,submitted_at,source_sha256)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,s.submitted_at,$10 FROM assignment_submission_snapshots s WHERE s.attempt_id=$5 AND s.sequence=$6`,
          [
            id,
            workspaceId,
            memberId,
            key,
            selected.attemptId,
            selected.sequence,
            selected.contentId,
            selected.contentVersion,
            selected.rubricVersion,
            selected.sourceSha256,
          ],
        );
        await tx.query(
          `INSERT INTO assignment_evidence_operations(id,operation_id,workspace_id,member_id,payload_digest,evidence_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), input.operationId, workspaceId, memberId, payload, id],
        );
        const saved = await receipt(context, input.operationId);
        if (!saved) return fail("unavailable");
        return { kind: "created" as const, receipt: saved.value };
      });
    },
    async inspect(token, operationId) {
      if (!sampleUuid(operationId)) return { kind: "invalid" };
      return execute(token, false, async (context) => {
        const retained = await receipt(context, operationId);
        return retained
          ? { kind: "ready" as const, receipt: retained.value }
          : { kind: "absent" as const };
      });
    },
  };
}
