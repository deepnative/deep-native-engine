/** Public projections deliberately omit source content, member/administrator
 * identity, workspace/submission/assignment IDs, credentials and operation keys. */
export const SAMPLE_ASSIGNMENT_PATH = "/operator/sample-assignments";
export const SAMPLE_ASSIGNMENT_REFERENCE_PATH =
  "/review/sample-assignment-reference";
export const SAMPLE_ASSIGNMENT_PAGE_SIZE = 20;

/** Canonical finite UTC values are shared by assignment input boundaries. */
export function sampleAssignmentUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export interface SampleAssignmentSource {
  evidenceId: string;
  sourceRevision: number;
}
export interface SampleAssignmentReferences extends SampleAssignmentSource {
  reviewerId: string;
}
/** Only this explicitly attempted write projection carries its original key.
 * It is retained in the original form, never placed in a URL or browser store. */
export interface SampleAssignmentInput extends SampleAssignmentReferences {
  operationId: string;
  startsAt: string;
  expiresAt: string;
}
export interface SampleAssignmentCheck extends SampleAssignmentReferences {
  sourceStatus: "eligible";
  reviewerExpiresAt: string;
}
export type SampleAssignmentState =
  "active" | "scheduled" | "expired" | "revoked" | "ineffective" | "removed";
export interface SampleAssignmentRow extends SampleAssignmentReferences {
  exactGrantId: string;
  receiptId: string | null;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  state: SampleAssignmentState;
  canRevoke: boolean;
}
export interface SampleAssignmentHistory extends SampleAssignmentSource {
  rows: SampleAssignmentRow[];
  next: string | null;
}
export interface SampleReviewerReference {
  reviewerId: string;
  expiresAt: string;
}
export type SampleAssignmentFailure = {
  kind: "denied" | "invalid" | "conflict" | "unavailable";
};
/** These envelopes are server-only. Views receive only their safe projection;
 * deadline is monotonic request/authority lifetime, never an input or renewal. */
export type SampleAssignmentOpenResult =
  { kind: "ready"; deadline: number } | SampleAssignmentFailure;
export type SampleReviewerReferenceResult =
  | { kind: "ready"; reference: SampleReviewerReference; deadline: number }
  | SampleAssignmentFailure;
export type SampleAssignmentCheckResult =
  | { kind: "ready"; check: SampleAssignmentCheck; deadline: number }
  | SampleAssignmentFailure;
export type SampleAssignmentWriteResult =
  | { kind: "applied" | "replayed"; row: SampleAssignmentRow; deadline: number }
  | SampleAssignmentFailure;
export type SampleAssignmentHistoryResult =
  | { kind: "ready"; history: SampleAssignmentHistory; deadline: number }
  | SampleAssignmentFailure;
export type SampleAssignmentRecoveryResult =
  | { kind: "ready"; row: SampleAssignmentRow; deadline: number }
  | { kind: "absent"; deadline: number }
  | SampleAssignmentFailure;
export type SampleAssignmentRevokeResult =
  | {
      kind: "revoked" | "unchanged";
      row: SampleAssignmentRow;
      deadline: number;
    }
  | SampleAssignmentFailure;
export interface SampleAssignmentStore {
  open(token: string): Promise<SampleAssignmentOpenResult>;
  selfReference(token: string): Promise<SampleReviewerReferenceResult>;
  check(
    token: string,
    references: SampleAssignmentReferences,
  ): Promise<SampleAssignmentCheckResult>;
  assign(
    token: string,
    input: SampleAssignmentInput,
  ): Promise<SampleAssignmentWriteResult>;
  history(
    token: string,
    source: SampleAssignmentSource,
    after?: string,
  ): Promise<SampleAssignmentHistoryResult>;
  recover(
    token: string,
    operationId: string,
  ): Promise<SampleAssignmentRecoveryResult>;
  revoke(
    token: string,
    source: SampleAssignmentSource,
    exactGrantId: string,
  ): Promise<SampleAssignmentRevokeResult>;
}
