import { sampleUuid } from "./sample-feedback-values.ts";
import { sampleAssignmentUtc } from "./sample-assignment-values.ts";
export const REVIEW_GRANT_PATH = "/operator/review-time-grants";
export const REVIEW_GRANT_REFERENCE_PATH = "/review/review-time-reference";
export const REVIEW_GRANT_PAGE_SIZE = 20;
export type ReviewGrantAdministration =
  "disabled" | "enabled" | "recovery-only";
export interface ReviewGrantReferences {
  allocationId: string;
  reviewerId: string;
}
export interface ReviewGrantInput extends ReviewGrantReferences {
  operationId: string;
  startsAt: string;
  expiresAt: string;
}
export interface ReviewGrantRevokeInput {
  grantId: string;
  operationId: string;
}
export interface ReviewGrantCheck extends ReviewGrantReferences {
  sourceRevision: number;
  ceiling: number;
  allocationState: string;
  authorityExpiresAt: string;
}
/** Retained allocation/permission metadata only. No member, workspace, source,
 * credential, digest, private bytes or replay identity enters this projection. */
export interface ReviewGrantRow extends ReviewGrantReferences {
  grantId: string;
  sourceRevision: number;
  allocationState: string;
  ceiling: number;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  state: "active" | "scheduled" | "expired" | "revoked" | "ineffective";
  sourceAvailable: boolean;
  canRevoke: boolean;
}
export interface ReviewGrantRevocation {
  revocationReceiptId: string;
  outcome: "revoked" | "unchanged";
}
export function reviewGrantFields(
  value: unknown,
  names: string[],
): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every(
      (name) =>
        Object.hasOwn(value, name) &&
        typeof (value as Record<string, unknown>)[name] === "string",
    )
  );
}
export function reviewGrantReferences(
  value: unknown,
): ReviewGrantReferences | null {
  if (
    !reviewGrantFields(value, ["allocationId", "reviewerId"]) ||
    !sampleUuid(value.allocationId) ||
    !sampleUuid(value.reviewerId)
  )
    return null;
  return {
    allocationId: value.allocationId.toLowerCase(),
    reviewerId: value.reviewerId.toLowerCase(),
  };
}
export function reviewGrantInput(value: unknown): ReviewGrantInput | null {
  if (
    !reviewGrantFields(value, [
      "allocationId",
      "reviewerId",
      "operationId",
      "startsAt",
      "expiresAt",
    ]) ||
    !sampleUuid(value.operationId) ||
    !sampleAssignmentUtc(value.startsAt) ||
    !sampleAssignmentUtc(value.expiresAt) ||
    value.startsAt >= value.expiresAt
  )
    return null;
  const refs = reviewGrantReferences({
    allocationId: value.allocationId,
    reviewerId: value.reviewerId,
  });
  return refs
    ? {
        ...refs,
        operationId: value.operationId.toLowerCase(),
        startsAt: value.startsAt,
        expiresAt: value.expiresAt,
      }
    : null;
}
export function reviewGrantRevokeInput(
  value: unknown,
): ReviewGrantRevokeInput | null {
  if (
    !reviewGrantFields(value, ["grantId", "operationId"]) ||
    !sampleUuid(value.grantId) ||
    !sampleUuid(value.operationId)
  )
    return null;
  return {
    grantId: value.grantId.toLowerCase(),
    operationId: value.operationId.toLowerCase(),
  };
}
