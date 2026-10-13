import { sampleUuid } from "./sample-feedback-values.ts";
import { sampleAssignmentUtc } from "./sample-assignment-values.ts";
import { reviewGrantFields } from "./review-time-grant-values.ts";
export const SUPPORT_GRANT_PATH = "/operator/support-time-grants";
export const SUPPORT_GRANT_PAGE_SIZE = 20;
export type SupportGrantAdministration =
  "disabled" | "enabled" | "recovery-only";
export interface SupportMinuteReferences {
  requestId: string;
  allocationId: string;
  operatorId: string;
}
export interface SupportMinuteInput extends SupportMinuteReferences {
  operationId: string;
  startsAt: string;
  expiresAt: string;
}
export interface SupportMinuteRevokeInput {
  grantId: string;
  operationId: string;
}
export interface SupportMinuteCheck extends SupportMinuteReferences {
  ceiling: number;
  allocationState: string;
  authorityExpiresAt: string;
}
/** Content-free grant metadata only; operation keys remain in private forms. */
export interface SupportMinuteRow extends SupportMinuteReferences {
  grantId: string;
  role: "operator" | "platform_admin";
  ceiling: number;
  allocationState: string;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  state: "active" | "scheduled" | "expired" | "revoked" | "ineffective";
  sourceAvailable: boolean;
  canRevoke: boolean;
}
export interface SupportMinuteRevocation {
  revocationReceiptId: string;
  outcome: "revoked" | "unchanged";
}
export function supportMinuteReferences(
  value: unknown,
): SupportMinuteReferences | null {
  if (
    !reviewGrantFields(value, ["requestId", "allocationId", "operatorId"]) ||
    !sampleUuid(value.requestId) ||
    !sampleUuid(value.allocationId) ||
    !sampleUuid(value.operatorId)
  )
    return null;
  return {
    requestId: value.requestId.toLowerCase(),
    allocationId: value.allocationId.toLowerCase(),
    operatorId: value.operatorId.toLowerCase(),
  };
}
export function supportMinuteInput(value: unknown): SupportMinuteInput | null {
  if (
    !reviewGrantFields(value, [
      "requestId",
      "allocationId",
      "operatorId",
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
  const refs = supportMinuteReferences({
    requestId: value.requestId,
    allocationId: value.allocationId,
    operatorId: value.operatorId,
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
export function supportMinuteRevokeInput(
  value: unknown,
): SupportMinuteRevokeInput | null {
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

export { reviewGrantFields as supportMinuteFields };
