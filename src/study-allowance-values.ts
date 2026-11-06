import { sampleUuid } from "./sample-feedback-values.ts";

export const STUDY_ALLOWANCE_PATH = "/member/study-allowance";
const versionPattern = /^(study|mock)-allowance-test-v[1-9][0-9]*$/;
const instantPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export type StudyAllowanceCategory = "study_requests" | "mock_sessions";
export interface StudyAllowancePolicy {
  version: string;
  category: StudyAllowanceCategory;
  periodLimit: number;
  period: "utc_calendar_month";
  eligibility: "current_member_explicit_claim";
  grantSource: "test_configuration";
  rateEstimateVersion: null;
  spendState: "test";
}
export interface StudyAllowancePeriod {
  start: Date;
  end: Date;
}
export interface StudyAllowanceClaim {
  id: string;
  policyVersion: string;
  quantity: number;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  available: number;
  reserved: number;
  consumed: number;
  expired: number;
}
export interface StudyAllowanceInstruction {
  policyVersion: string;
  periodStart: string;
}
export interface StudyAllowanceView {
  policy: StudyAllowancePolicy | null;
  period: StudyAllowancePeriod;
  claim: StudyAllowanceClaim | null;
  creationEnabled: boolean;
  /** Present only while practice sessions use units, or a claim is retained. */
  practice?: {
    policy: StudyAllowancePolicy | null;
    claim: StudyAllowanceClaim | null;
  } | null;
}

/** The one UTC calendar month containing an instant observed by PostgreSQL. */
export function studyAllowancePeriod(observed: Date): StudyAllowancePeriod {
  const year = observed.getUTCFullYear(),
    month = observed.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}
export const studyAllowanceCategory = (
  version: string,
): StudyAllowanceCategory =>
  version.startsWith("mock-") ? "mock_sessions" : "study_requests";
export const studyAllowanceLedgerKey = (
  memberId: string,
  start: Date,
  category: StudyAllowanceCategory = "study_requests",
) =>
  `${category === "mock_sessions" ? "mock" : "study"}-allowance:${memberId}:${start.toISOString().slice(0, 7)}`;
export const studyAllowanceKey = sampleUuid;

export function studyAllowanceInstruction(
  value: unknown,
): StudyAllowanceInstruction | null {
  if (value === null || typeof value !== "object") return null;
  const { policyVersion, periodStart } = value as Record<string, unknown>;
  if (
    typeof policyVersion !== "string" ||
    !versionPattern.test(policyVersion) ||
    typeof periodStart !== "string" ||
    !instantPattern.test(periodStart)
  )
    return null;
  const start = new Date(periodStart);
  if (
    !Number.isFinite(+start) ||
    start.toISOString() !== periodStart ||
    +studyAllowancePeriod(start).start !== +start
  )
    return null;
  return { policyVersion, periodStart };
}
