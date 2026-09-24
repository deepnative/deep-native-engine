import { afterEach, beforeEach, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  spawn: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  approval: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: doubles.spawn }));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  mkdtempSync: () => "/tmp/dne-synthetic-release-fixture",
  readFileSync: doubles.read,
  rmSync: doubles.remove,
  writeFileSync: doubles.write,
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Pool: class extends EventEmitter {
      query = doubles.query;
      end = doubles.end;
    },
  };
});
vi.mock("../../scripts/full-release-evidence.mjs", () => ({
  assertMappingApproval: doubles.approval,
  assertReleaseEvidence: doubles.evidence,
}));

const originalArgv = [...process.argv];
let output;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ["node", "scripts/verify-full-release.mjs"];
  vi.stubEnv("DNE_DATABASE_URL", "postgresql://localhost/synthetic");
  doubles.spawn.mockImplementation((command, args) => ({
    status: 0,
    stdout:
      command !== "git"
        ? ""
        : args[0] === "status"
          ? ""
          : args[1] === "HEAD"
            ? "a".repeat(40)
            : "b".repeat(40),
  }));
  doubles.read.mockImplementation((file) => {
    if (file === "tests/e2e/scenarios.json")
      return JSON.stringify({ fullMvpVersion: "full-mvp-v1" });
    if (file === "tests/e2e/full-mvp-approval.json")
      return JSON.stringify({ status: "approved" });
    return Buffer.from("{}");
  });
  doubles.approval.mockReturnValue("d".repeat(64));
  doubles.evidence.mockReturnValue({
    passed: 100,
    total: 100,
    executions: 200,
  });
  doubles.query.mockImplementation(async (sql) =>
    sql === "SHOW server_version"
      ? { rows: [{ server_version: "synthetic-fixture" }] }
      : { rows: [] },
  );
  doubles.end.mockResolvedValue(undefined);
  output = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = [...originalArgv];
  process.exitCode = 0;
});
async function run() {
  await import("../../scripts/verify-full-release.mjs");
  const report = JSON.parse(doubles.write.mock.calls.at(-1)[1]);
  expect(process.exitCode).toBe(report.exitStatus);
  return report;
}

it("rejects a supplied report before any browser or database execution", async () => {
  process.argv.push("artifacts/forged-report.json");
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toMatch(/input contract/);
  expect(doubles.remove.mock.calls.map(([file]) => file)).toEqual([
    "artifacts/full-release-verification.json",
    "artifacts/e2e-full-results.json",
    "artifacts/browser-full-results",
  ]);
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(doubles.query).not.toHaveBeenCalled();
});

it("rejects pending approval before reading an old browser report", async () => {
  doubles.approval.mockImplementation(() => {
    throw new Error("pending approval");
  });
  const report = await run();
  expect(report.error).toMatch(/mapping approval/);
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(doubles.query).not.toHaveBeenCalled();
  expect(doubles.read.mock.calls.map(([file]) => file)).not.toContain(
    "artifacts/e2e-full-results.json",
  );
});

it("refuses a dirty source revision before setting up a release run", async () => {
  doubles.spawn.mockImplementation((command, args) => ({
    status: 0,
    stdout:
      command === "git" && args[0] === "status"
        ? " M scripts/verify-full-release.mjs"
        : "a".repeat(40),
  }));
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toMatch(/clean revision/);
  expect(doubles.query).not.toHaveBeenCalled();
});

it("builds and runs its own browser suite, binds evidence, and cleans its resources", async () => {
  const report = await run();
  expect(report.exitStatus).toBe(0);
  expect(report).toMatchObject({
    revision: { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false },
    postgresVersion: "synthetic-fixture",
    passed: 100,
    executions: 200,
  });
  expect(report.runId).toMatch(/^[a-f0-9-]{36}$/);
  expect(doubles.spawn).toHaveBeenCalledWith(
    "node",
    ["scripts/check-installed-deps.mjs"],
    expect.any(Object),
  );
  expect(
    doubles.spawn.mock.calls
      .filter(([command]) => command === "npm")
      .map(([, args]) => args),
  ).toEqual([
    ["run", "build"],
    ["run", "test:e2e:full"],
  ]);
  expect(doubles.evidence).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: report.runId,
      revision: report.revision,
      traceRoot: "artifacts/browser-full-results",
    }),
  );
  expect(doubles.query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringMatching(/^CREATE DATABASE/),
    "SHOW server_version",
    expect.stringMatching(/^DROP DATABASE/),
  ]);
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(doubles.remove).toHaveBeenCalledWith(
    "/tmp/dne-synthetic-release-fixture",
    { recursive: true, force: true },
  );
  expect(output).not.toHaveBeenCalled();
});

it("fails when the browser command fails and still removes the generated database", async () => {
  doubles.spawn.mockImplementation((command, args) => ({
    status: command === "npm" && args[1] === "test:e2e:full" ? 7 : 0,
    stdout: command === "git" && args[0] !== "status" ? "a".repeat(40) : "",
  }));
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toMatch(/test:e2e:full/);
  expect(doubles.evidence).not.toHaveBeenCalled();
  expect(doubles.query.mock.calls.at(-1)[0]).toMatch(/^DROP DATABASE/);
  expect(doubles.end).toHaveBeenCalledOnce();
});

it("fails after a complete browser command if the generated report is absent", async () => {
  doubles.read.mockImplementation((file) => {
    if (file === "artifacts/e2e-full-results.json") throw new Error("missing");
    return file === "tests/e2e/scenarios.json"
      ? JSON.stringify({ fullMvpVersion: "full-mvp-v1" })
      : "{}";
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toMatch(/full browser evidence/);
  expect(doubles.query.mock.calls.at(-1)[0]).toMatch(/^DROP DATABASE/);
});

it("treats failed cleanup as a failed release despite passing synthetic evidence", async () => {
  doubles.end.mockRejectedValue(new Error("synthetic-private-details"));
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.cleanupErrors).toEqual([
    "Release database connection cleanup failed.",
  ]);
  expect(JSON.stringify(report)).not.toContain("synthetic-private-details");
});
