import type { ApplicationMode } from "./adapters.ts";
import { sampleUuid } from "./sample-feedback-values.ts";

export const STUDY_FIXTURE_POLICY = "browser-study-fixture-v1";
export const STUDY_FIXTURE_QUANTITY = 3;
export const STUDY_FIXTURE_CATEGORY = "study_requests";
export const STUDY_REQUEST_WINDOW = 30 * 60 * 1000;
export const STUDY_GRANT_WINDOW = 15 * 60 * 1000;
export interface StudyFixtureOptions {
  mode: ApplicationMode;
  enabled: boolean;
}
export const studyFixtureLocal = (options: StudyFixtureOptions) =>
  options.mode === "demo" || options.mode === "test";
export const studyFixtureCreation = (options: StudyFixtureOptions) =>
  studyFixtureLocal(options) && options.enabled;
export const studyFixtureId = sampleUuid;

export interface StudyRequestInstruction {
  policy: typeof STUDY_FIXTURE_POLICY;
  administratorId: string;
  memberExpiresAt: string;
  administratorExpiresAt: string;
  checkedAt: string;
  expiresAt: string;
}
export interface StudyIssueInstruction {
  policy: typeof STUDY_FIXTURE_POLICY;
  requestId: string;
  requestExpiresAt: string;
  checkedAt: string;
  expiresAt: string;
}
export interface StudyFixtureReceipt {
  id: string;
  policy: typeof STUDY_FIXTURE_POLICY;
  administratorId: string | null;
  createdAt: Date;
  expiresAt: Date;
  grantId: string | null;
  issuedAt: Date | null;
  grantExpiresAt: Date | null;
  withdrawnAt: Date | null;
}
export function studyFixtureFields(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function studyRequestInstruction(
  value: unknown,
): StudyRequestInstruction | null {
  if (
    !studyFixtureFields(value, [
      "policy",
      "administratorId",
      "memberExpiresAt",
      "administratorExpiresAt",
      "checkedAt",
      "expiresAt",
    ]) ||
    value.policy !== STUDY_FIXTURE_POLICY ||
    !studyFixtureId(value.administratorId) ||
    !instant(value.memberExpiresAt) ||
    !instant(value.administratorExpiresAt) ||
    !instant(value.checkedAt) ||
    !instant(value.expiresAt)
  )
    return null;
  const end = Date.parse(value.expiresAt);
  if (
    end <= Date.parse(value.checkedAt) ||
    end > Date.parse(value.checkedAt) + STUDY_REQUEST_WINDOW ||
    end > Date.parse(value.memberExpiresAt) ||
    end > Date.parse(value.administratorExpiresAt)
  )
    return null;
  return {
    policy: STUDY_FIXTURE_POLICY,
    administratorId: value.administratorId,
    memberExpiresAt: value.memberExpiresAt,
    administratorExpiresAt: value.administratorExpiresAt,
    checkedAt: value.checkedAt,
    expiresAt: value.expiresAt,
  };
}
export function studyIssueInstruction(
  value: unknown,
): StudyIssueInstruction | null {
  if (
    !studyFixtureFields(value, [
      "policy",
      "requestId",
      "requestExpiresAt",
      "checkedAt",
      "expiresAt",
    ]) ||
    value.policy !== STUDY_FIXTURE_POLICY ||
    !studyFixtureId(value.requestId) ||
    !instant(value.requestExpiresAt) ||
    !instant(value.checkedAt) ||
    !instant(value.expiresAt)
  )
    return null;
  const end = Date.parse(value.expiresAt);
  if (
    end <= Date.parse(value.checkedAt) ||
    end > Date.parse(value.checkedAt) + STUDY_GRANT_WINDOW ||
    end > Date.parse(value.requestExpiresAt)
  )
    return null;
  return {
    policy: STUDY_FIXTURE_POLICY,
    requestId: value.requestId,
    requestExpiresAt: value.requestExpiresAt,
    checkedAt: value.checkedAt,
    expiresAt: value.expiresAt,
  };
}
export function studyFixtureState(
  receipt: StudyFixtureReceipt,
  observedAt: Date,
): "pending" | "cancelled" | "issued" | "expired" | "withdrawn" {
  if (receipt.withdrawnAt) return receipt.grantId ? "withdrawn" : "cancelled";
  if (+observedAt >= +(receipt.grantExpiresAt ?? receipt.expiresAt))
    return "expired";
  return receipt.grantId ? "issued" : "pending";
}
