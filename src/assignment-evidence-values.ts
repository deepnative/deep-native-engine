import { createHash } from "node:crypto";
import { sampleUuid } from "./sample-feedback-values.ts";

export const ASSIGNMENT_ORIGIN_LABEL =
  "Member assignment submission · private · unreviewed";
/**
 * CONSENT125-01: the wording a member agrees to before a submitted assignment
 * version is copied for private feedback. Change the text only together with
 * the version; earlier copies keep the version they were made under.
 */
export const ASSIGNMENT_CONSENT_VERSION = "assignment-feedback-v1";
export const ASSIGNMENT_CONSENT_TEXT =
  "Create a private feedback copy of this submitted version. I will request review separately. The copy is used only for private feedback from one reviewer an administrator assigns. It is kept until I delete it, delete the original attempt or delete my account; deleting the original attempt also deletes its copies and feedback. Withdrawing consent stops further reviewer access and keeps feedback I already received. Feedback is not a formal assessment, and there is no appeal.";
/** Owner decision of 10 November 2026, in the member's words. */
export const ASSIGNMENT_COPY_RETENTION =
  "A private feedback copy of a submitted assignment is kept until you delete the copy, delete the original attempt or delete your account. Feedback on it is not a formal assessment, and there is no appeal process.";
const consentVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^assignment-feedback-v[1-9][0-9]{0,3}$/.test(value);
export interface AssignmentEvidenceSource {
  attemptId: string;
  sequence: number;
  contentId: string;
  contentVersion: number;
  title: string;
  rubric: string;
  rubricVersion: number;
  response: string;
  submittedAt: Date;
  sourceSha256: string;
}
export interface AssignmentEvidenceInstruction {
  operationId: string;
  attemptId: string;
  sequence: number;
  contentId: string;
  contentVersion: number;
  rubricVersion: number;
  sourceSha256: string;
  privateReview: true;
  /** The wording version shown on the form that was submitted. */
  consentVersion: string;
}
export interface AssignmentEvidenceOrigin {
  kind: "member-assignment-submission";
  attemptId: string;
  sequence: number;
  contentId: string;
  contentVersion: number;
  rubricVersion: number;
  submittedAt: Date | string;
  sourceSha256: string;
  acknowledgedAt: Date | string;
  /** Null for copies made before wording versions were recorded. */
  consentVersion?: string | null;
  label: typeof ASSIGNMENT_ORIGIN_LABEL;
}
export function assignmentSequence(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10
  );
}
export function assignmentEvidenceInstruction(
  value: unknown,
): AssignmentEvidenceInstruction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const names = [
    "operationId",
    "attemptId",
    "sequence",
    "contentId",
    "contentVersion",
    "rubricVersion",
    "sourceSha256",
    "privateReview",
    "consentVersion",
  ];
  if (
    Object.keys(row).length !== names.length ||
    !names.every((name) => Object.hasOwn(row, name)) ||
    !sampleUuid(row.operationId) ||
    !sampleUuid(row.attemptId) ||
    !assignmentSequence(row.sequence) ||
    typeof row.contentId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(row.contentId) ||
    !Number.isSafeInteger(row.contentVersion) ||
    Number(row.contentVersion) < 1 ||
    Number(row.contentVersion) > 2147483647 ||
    !Number.isSafeInteger(row.rubricVersion) ||
    Number(row.rubricVersion) < 1 ||
    Number(row.rubricVersion) > 2147483647 ||
    typeof row.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sourceSha256) ||
    row.privateReview !== true ||
    !consentVersion(row.consentVersion)
  )
    return null;
  return {
    ...(row as unknown as AssignmentEvidenceInstruction),
    operationId: (row.operationId as string).toLowerCase(),
    attemptId: (row.attemptId as string).toLowerCase(),
  };
}
export function assignmentPayloadDigest(input: AssignmentEvidenceInstruction) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.attemptId,
        input.sequence,
        input.contentId,
        input.contentVersion,
        input.rubricVersion,
        input.sourceSha256,
        true,
      ]),
    )
    .digest("hex");
}
export function assignmentEvidenceName(sequence: number) {
  return `Assignment submission ${sequence}.txt`;
}

// Kept separate from platform-provided examples. Only exact retained bindings
// carry member attribution; a missing origin never reclassifies the source.
export const ASSIGNMENT_ORIGIN_JOIN = `LEFT JOIN assignment_evidence_origins ao
 ON ao.evidence_id=e.id AND ao.workspace_id=e.workspace_id
 AND ao.member_id=e.owner_principal_id AND ao.storage_key=e.storage_key
 AND e.assignment_bound AND ao.source_sha256=e.sha256
 AND e.media_type='text/plain' AND e.original_name='Assignment submission '||ao.sequence||'.txt'
 AND EXISTS(SELECT 1 FROM assignment_attempts aa
  JOIN assignment_submission_snapshots ss ON ss.attempt_id=aa.id AND ss.sequence=ao.sequence
  JOIN content_versions ac ON ac.id=aa.content_id AND ac.version=aa.content_version
  WHERE aa.id=ao.attempt_id AND aa.member_id=ao.member_id AND aa.content_id=ao.content_id
   AND aa.content_version=ao.content_version AND ac.rubric_version=ao.rubric_version
   AND ss.submitted_at=ao.submitted_at AND octet_length(convert_to(ss.response,'UTF8'))=e.byte_size
   AND encode(sha256(convert_to(ss.response,'UTF8')),'hex')=ao.source_sha256)`;
export const ASSIGNMENT_ORIGIN_SQL = `CASE WHEN ao.evidence_id IS NULL THEN NULL ELSE
 jsonb_build_object('kind','member-assignment-submission','attemptId',ao.attempt_id,
 'sequence',ao.sequence,'contentId',ao.content_id,'contentVersion',ao.content_version,
 'rubricVersion',ao.rubric_version,'submittedAt',ao.submitted_at,
 'sourceSha256',ao.source_sha256,'acknowledgedAt',ao.acknowledged_at,
 'consentVersion',ao.consent_version,
 'label','Member assignment submission · private · unreviewed') END AS "assignmentOrigin"`;
