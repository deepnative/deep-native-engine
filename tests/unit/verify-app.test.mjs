import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the runner's failure boundary with deterministic external services.
// Application assertions and the real PostgreSQL/browser gates run separately.
const doubles = vi.hoisted(() => ({
  spawn: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  pool: undefined,
}));
vi.mock("node:child_process", () => ({ spawnSync: doubles.spawn }));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: doubles.read,
  writeFileSync: doubles.write,
  readdirSync: () => [{ name: "app.ts", isDirectory: () => false }],
  rmSync: doubles.remove,
  mkdtempSync: () => "/synthetic/private-evidence",
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Pool: class extends EventEmitter {
      constructor() {
        super();
        doubles.pool = this;
      }
      query = doubles.query;
      end = doubles.end;
    },
  };
});
vi.mock("../../scripts/quality-gates.mjs", async (original) => ({
  ...(await original()),
  assertUnitResults: () => ({ passed: 1, total: 1 }),
  assertCoverage: () => ({}),
  assertJourneys: () => ({ passed: 1, total: 1 }),
}));
const marker = "synthetic-private-member-note";
let output;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("DNE_DATABASE_URL", "postgresql://localhost/synthetic");
  doubles.spawn.mockImplementation((command, args) => ({
    status: 0,
    stdout: command === "git" && args[0] !== "status" ? "a".repeat(40) : "",
  }));
  doubles.read.mockReturnValue("{}");
  doubles.query.mockResolvedValue({});
  doubles.end.mockResolvedValue(undefined);
  output = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});
async function run() {
  await import("../../scripts/verify-app.mjs");
  const report = JSON.parse(doubles.write.mock.calls.at(-1)[1]);
  expect(JSON.stringify(report)).not.toContain(marker);
  expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
  expect(report.finishedAt).toBeTruthy();
  expect(process.exitCode).toBe(report.exitStatus);
  return report;
}
it.each([new Error(marker), marker, null])(
  "fails database setup safely even for non-Error rejections (%s)",
  async (rejection) => {
    doubles.query.mockRejectedValueOnce(rejection);
    const report = await run();
    expect(report.exitStatus).toBe(1);
    expect(report.error).toBe(
      "Verification failed during test database setup.",
    );
    expect(doubles.query).toHaveBeenCalledOnce();
    expect(doubles.end).toHaveBeenCalledOnce();
  },
);
it("withholds malformed report content while identifying the evidence stage", async () => {
  doubles.read.mockReturnValueOnce(`{"private":"${marker}`);
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toBe("Verification failed during unit test evidence.");
  expect(doubles.query).not.toHaveBeenCalled();
});
it("retains a safe failed command and its exit status", async () => {
  doubles.spawn.mockImplementation((command) => ({
    status: command === "npm" ? 7 : 0,
    stdout: "",
  }));
  const report = await run();
  expect(report.error).toBe("Verification failed during npm run format:check.");
  expect(report.commands).toEqual([
    expect.objectContaining({ command: "npm run format:check", exitStatus: 7 }),
  ]);
  expect(report.exitStatus).toBe(1);
});
it("attempts every cleanup and writes a failed report after cleanup errors", async () => {
  doubles.query
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error(marker));
  doubles.end.mockRejectedValueOnce(new Error(marker));
  doubles.remove.mockImplementation((target) => {
    if (target === "/synthetic/private-evidence") throw new Error(marker);
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.cleanupErrors).toEqual([
    "Test database cleanup failed.",
    "Test database connection cleanup failed.",
    "Private test storage cleanup failed.",
  ]);
  expect(doubles.query).toHaveBeenCalledTimes(2);
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(doubles.remove).toHaveBeenCalledWith("/synthetic/private-evidence", {
    recursive: true,
    force: true,
  });
});
it("treats an idle database error as failure without leaking or losing cleanup", async () => {
  doubles.query.mockImplementationOnce(async () => {
    doubles.pool.emit("error", new Error(marker));
    return {};
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.databaseError).toBe("Test database connection interrupted.");
  expect(doubles.end).toHaveBeenCalledOnce();
});
it("withholds artifact setup errors and still records a failed run", async () => {
  doubles.remove.mockImplementationOnce(() => {
    throw new Error(marker);
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toBe(
    "Verification failed during verification artifacts.",
  );
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it("fails safely when the final report cannot be written", async () => {
  doubles.write.mockImplementationOnce(() => {
    throw new Error(marker);
  });
  await import("../../scripts/verify-app.mjs");
  expect(process.exitCode).toBe(1);
  expect(output.mock.calls).toEqual([
    ["Application verification report could not be written."],
  ]);
  expect(doubles.end).toHaveBeenCalledOnce();
});
it("still passes a successful run and cleans its isolated resources", async () => {
  const report = await run();
  expect(report.exitStatus).toBe(0);
  expect(report.error).toBeUndefined();
  expect(report.cleanupErrors).toBeUndefined();
  expect(doubles.query).toHaveBeenCalledTimes(2);
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(output).not.toHaveBeenCalled();
});
