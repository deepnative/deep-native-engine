import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attendanceExportObservation } from "../support/attendance-export-observation.ts";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "dne-attendance-observation-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true });
});
function reports(path: string) {
  return readdirSync(path).map((name) => join(path, name));
}
function report(path: string, name: string) {
  return JSON.parse(readFileSync(join(path, name + ".json"), "utf8"));
}

it("CI-ATTEND-01/03 retains disposition without serializing action values or errors", async () => {
  const path = root(),
    observation = attendanceExportObservation(path);
  const privateValue = {
    token: "invented-secret-token",
    cursor: "invented-secret-cursor",
  };
  expect(await observation.phase("check", 0, async () => privateValue)).toBe(
    privateValue,
  );
  const failure = new Error("invented-private-query-parameter");
  await expect(
    observation.phase("permit", 0, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  observation.finishBody("rejected");
  observation.snapshot("body-finalization");
  const directory = reports(path)[0]!,
    text = readFileSync(join(directory, "body-finalization.json"), "utf8");
  for (const secret of [
    privateValue.token,
    privateValue.cursor,
    failure.message,
  ])
    expect(text).not.toContain(secret);
  const saved = report(directory, "body-finalization");
  expect(saved.body).toBe("rejected");
  expect(
    saved.events.map((event: { boundary: string }) => event.boundary),
  ).toEqual(["start", "fulfilled", "start", "rejected"]);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, "body-finalization.json")).mode & 0o777).toBe(
    0o600,
  );
});

it.each(["fulfilled", "rejected"] as const)(
  "CI-ATTEND-02 preserves runner checkpoint when an old callback later %s beside another task",
  async (disposition) => {
    const path = root();
    let clock = 0;
    const old = attendanceExportObservation(path, { now: () => ++clock });
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("private-late-failure");
    const action = old.phase("permit", 104, async () => {
      await deferred;
      if (disposition === "rejected") throw failure;
      return 7;
    });
    const settled = action
      .then(
        (value) => {
          old.finishBody("fulfilled");
          return value;
        },
        (error) => {
          old.finishBody("rejected");
          return error;
        },
      )
      .finally(() => old.snapshot("body-finalization"));
    old.snapshot("runner-checkpoint");
    const directory = reports(path)[0]!,
      original = readFileSync(
        join(directory, "runner-checkpoint.json"),
        "utf8",
      );
    const unrelated = attendanceExportObservation(path);
    await unrelated.phase("fixture", 0, async () => 1);
    unrelated.finishBody("fulfilled");
    unrelated.snapshot("body-finalization");
    release();
    expect(await settled).toBe(disposition === "fulfilled" ? 7 : failure);
    expect(
      readFileSync(join(directory, "runner-checkpoint.json"), "utf8"),
    ).toBe(original);
    expect(report(directory, "runner-checkpoint").body).toBe("running");
    expect(report(directory, "body-finalization").body).toBe(disposition);
    expect(report(directory, "body-finalization").events).toHaveLength(2);
    expect(reports(path)).toHaveLength(2);
  },
);

it("CI-ATTEND-03 recording construction failure preserves fulfillment and rejection", async () => {
  const path = join(root(), "occupied");
  writeFileSync(path, "occupied");
  const observation = attendanceExportObservation(path);
  observation.snapshot("callback-start");
  expect(await observation.phase("fixture", 0, async () => 9)).toBe(9);
  const failure = new Error("private original failure");
  await expect(
    observation.phase("erase", 0, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  observation.finishBody("rejected");
  observation.snapshot("body-finalization");
  expect(observation.status().recordingFailed).toBe(true);
});

it("CI-ATTEND-03 records safe failure after persistence recovers without masking the action", async () => {
  const path = root();
  let writes = 0;
  const observation = attendanceExportObservation(path, {
    write: (file, bytes) => {
      if (++writes === 1) throw Error("private filesystem detail");
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    },
  });
  observation.snapshot("callback-start");
  expect(await observation.phase("export", 0, async () => 6)).toBe(6);
  observation.finishBody("fulfilled");
  observation.snapshot("body-finalization");
  const saved = report(reports(path)[0]!, "body-finalization");
  expect(saved.recordingFailed).toBe(true);
  expect(saved.body).toBe("fulfilled");
  expect(JSON.stringify(saved)).not.toContain("private filesystem detail");
});

it("CI-ATTEND-03 bounds events and omits malformed metadata while actions still execute", async () => {
  const path = root(),
    observation = attendanceExportObservation(path);
  expect(
    await observation.phase(
      "invented-secret-phase" as "fixture",
      0,
      async () => 3,
    ),
  ).toBe(3);
  expect(await observation.phase("check", Number.NaN, async () => 4)).toBe(4);
  for (let index = 0; index < 401; index++)
    await observation.phase("check", index, async () => index);
  observation.finishBody("fulfilled");
  observation.snapshot("body-finalization");
  const directory = reports(path)[0]!,
    saved = report(directory, "body-finalization");
  expect(saved.metadataRejected).toBe(true);
  expect(saved.truncated).toBe(true);
  expect(saved.events).toHaveLength(800);
  expect(JSON.stringify(saved)).not.toContain("invented-secret-phase");
  expect(
    statSync(join(directory, "body-finalization.json")).size,
  ).toBeLessThanOrEqual(128 * 1024);
});

it("CI-ATTEND-03 omits invalid clock values and snapshot names without replacing results", async () => {
  const path = root(),
    observation = attendanceExportObservation(path, { now: () => Number.NaN });
  expect(await observation.phase("check", 0, async () => 2)).toBe(2);
  observation.snapshot("private-path" as "callback-start");
  observation.finishBody("fulfilled");
  observation.snapshot("body-finalization");
  const directory = reports(path)[0]!,
    saved = report(directory, "body-finalization");
  expect(saved.events).toEqual([]);
  expect(saved.metadataRejected).toBe(true);
  expect(saved.bodyFinishedMs).toBeNull();
  expect(readdirSync(directory)).toEqual(["body-finalization.json"]);
});

it("CI-ATTEND-02/03 retains immutable body timing and a separate teardown rejection", async () => {
  const path = root();
  let clock = 0;
  const observation = attendanceExportObservation(path, { now: () => ++clock });
  await observation.phase("absence", 0, async () => undefined);
  observation.finishBody("fulfilled");
  observation.snapshot("body-finalization");
  const directory = reports(path)[0]!,
    original = readFileSync(join(directory, "body-finalization.json"), "utf8");
  const finished = report(directory, "body-finalization").bodyFinishedMs;
  observation.teardown("running");
  observation.snapshot("teardown-start");
  observation.teardown("rejected");
  observation.snapshot("teardown-finalization");
  expect(report(directory, "teardown-finalization").bodyFinishedMs).toBe(
    finished,
  );
  expect(report(directory, "teardown-finalization").teardown).toBe("rejected");
  observation.snapshot("body-finalization");
  expect(readFileSync(join(directory, "body-finalization.json"), "utf8")).toBe(
    original,
  );
  expect(observation.status().recordingFailed).toBe(true);
});
