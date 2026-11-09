import type { MemberHoldSnapshot, SampleHoldReceipt } from "./slot-holds.ts";

export type CoachPracticeState =
  | { kind: "failed" }
  | { kind: "ready"; coachMinutes: boolean; holds: SampleHoldReceipt[] };

// Red placeholder for COACHMOCK-01..05; replaced by the implementation.
export function coachPracticeState(
  _snapshot: MemberHoldSnapshot,
): CoachPracticeState {
  return { kind: "failed" };
}
export function coachPracticeSection(_state: CoachPracticeState): string {
  return "";
}
