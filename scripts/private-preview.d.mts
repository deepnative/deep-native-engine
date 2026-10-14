export interface CleanupDiagnostic {
  record: "present" | "missing";
  stage:
    | "runtime-close"
    | "fixture-pool-close"
    | "creation-observation"
    | "session-observation"
    | "session-refusal"
    | "owned-drop"
    | "control-pool-close"
    | "directory-removal"
    | "recovery-record-write"
    | "unknown";
  kind: "absent" | "owned-session-present" | "unknown";
  code: string;
  elapsedMs: number | "unknown";
}
export function cleanupDiagnostic(record: unknown): CleanupDiagnostic;
export function recordCleanupFailure(
  record: Record<string, unknown>,
  stage: string,
  error: unknown,
  elapsedMs: number,
): void;
