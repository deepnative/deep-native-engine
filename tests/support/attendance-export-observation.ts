import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const phases = [
  "fixture",
  "check",
  "permit",
  "withdraw",
  "export",
  "foreign-token",
  "foreign-denial",
  "forged-denial",
  "erase",
  "erased-denial",
  "absence",
] as const;
const snapshots = [
  "callback-start",
  "runner-checkpoint",
  "body-finalization",
  "teardown-start",
  "teardown-finalization",
] as const;
type Phase = (typeof phases)[number];
type Snapshot = (typeof snapshots)[number];
type Disposition = "fulfilled" | "rejected";

/** Test-only, task-owned attribution. It never captures an action's input,
 * result or exception, and recording failure must not change that action. */
export function attendanceExportObservation(
  root: string,
  options: {
    now?: () => number;
    write?: (path: string, bytes: string) => void;
  } = {},
) {
  let recordingFailed = false,
    metadataRejected = false,
    truncated = false;
  const now = () => {
    try {
      const value = (options.now ?? (() => performance.now()))();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* Never serialize a clock failure. */
    }
    metadataRejected = true;
    return undefined;
  };
  const started = now();
  const elapsed = () => {
    const value = now();
    if (value !== undefined && started !== undefined && value >= started)
      return value - started;
    metadataRejected = true;
    return undefined;
  };
  let directory: string | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(root, "attendance-export-observation-"));
  } catch {
    recordingFailed = true;
  }
  const events: {
    phase: Phase;
    index: number;
    boundary: "start" | Disposition;
    elapsedMs: number;
  }[] = [];
  let body: "running" | Disposition = "running",
    bodyFinishedMs: number | undefined;
  let teardown: "not-started" | "running" | Disposition = "not-started";
  function record(
    phase: Phase,
    index: number,
    boundary: "start" | Disposition,
  ) {
    if (
      !phases.includes(phase) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 10000
    ) {
      metadataRejected = true;
      return;
    }
    const elapsedMs = elapsed();
    if (elapsedMs === undefined) return;
    if (events.length >= 800) {
      truncated = true;
      return;
    }
    events.push({ phase, index, boundary, elapsedMs });
  }
  const status = () => ({
    recordingFailed,
    metadataRejected,
    truncated,
    eventCount: events.length,
  });
  return {
    status,
    async phase<T>(
      phase: Phase,
      index: number,
      action: () => Promise<T>,
    ): Promise<T> {
      record(phase, index, "start");
      let fulfilled = false;
      try {
        const value = await action();
        fulfilled = true;
        return value;
      } finally {
        record(phase, index, fulfilled ? "fulfilled" : "rejected");
      }
    },
    finishBody(disposition: Disposition) {
      if (
        (disposition !== "fulfilled" && disposition !== "rejected") ||
        body !== "running"
      ) {
        metadataRejected = true;
        return;
      }
      bodyFinishedMs = elapsed();
      body = disposition;
    },
    teardown(disposition: "running" | Disposition) {
      if (
        !(["running", "fulfilled", "rejected"] as const).includes(disposition)
      ) {
        metadataRejected = true;
        return;
      }
      teardown = disposition;
    },
    snapshot(name: Snapshot) {
      if (!snapshots.includes(name)) {
        metadataRejected = true;
        return;
      }
      const snapshotElapsedMs = elapsed();
      try {
        if (!directory) {
          recordingFailed = true;
          return;
        }
        const bytes =
          JSON.stringify({
            schema: "attendance-export-observation-v1",
            ...status(),
            body,
            bodyFinishedMs: bodyFinishedMs ?? null,
            teardown,
            snapshotElapsedMs: snapshotElapsedMs ?? null,
            events,
          }) + "\n";
        if (Buffer.byteLength(bytes) > 128 * 1024) {
          recordingFailed = true;
          return;
        }
        const path = join(directory, name + ".json");
        if (options.write) options.write(path, bytes);
        else writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
      } catch {
        recordingFailed = true;
      }
    },
  };
}
