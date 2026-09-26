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
  assertProvisionalReleaseJourneys: () => ({
    approved: false,
    passed: 3,
    total: 3,
  }),
}));
const marker = "synthetic-private-member-note";
let output;
let logOutput;
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
  logOutput = vi.spyOn(console, "log").mockImplementation(() => {});
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
  expect(JSON.stringify(logOutput.mock.calls)).not.toContain(marker);
  expect(report.finishedAt).toBeTruthy();
  expect(process.exitCode).toBe(report.exitStatus);
  return report;
}
it.each([0, 7])(
  "keeps child stdout and stderr private while preserving command status %i",
  async (status) => {
    doubles.spawn.mockImplementation((command, args, options) => {
      if (command === "git")
        return {
          status: 0,
          stdout: args[0] !== "status" ? "a".repeat(40) : "",
        };
      if (options.stdio === "inherit") {
        console.log(marker);
        console.error(marker);
      }
      return {
        status: command === "npm" && args[1] === "format:check" ? status : 0,
        stdout: marker,
        stderr: marker,
      };
    });
    const report = await run();
    expect(report.exitStatus).toBe(status === 0 ? 0 : 1);
    if (status !== 0)
      expect(report.error).toBe(
        "Verification failed during npm run format:check.",
      );
    expect(
      doubles.spawn.mock.calls.find(([command]) => command === "npm")?.[2],
    ).not.toHaveProperty("stdio", "inherit");
    expect(report.commands[0].child).toEqual(
      expect.objectContaining({
        stdin: "ignored",
        output: "captured-private",
        maxBufferBytes: 1024 * 1024,
        processError: "none",
        signal: "none",
      }),
    );
  },
);
it("fails safely when a child output buffer or launcher fails", async () => {
  doubles.spawn.mockImplementation((command, args) => {
    if (command === "git")
      return {
        status: 0,
        stdout: args[0] !== "status" ? "a".repeat(40) : "",
      };
    return args[0] === "run" && args[1] === "format:check"
      ? {
          status: null,
          error: new Error(marker),
          stdout: marker,
          stderr: marker,
        }
      : { status: 0, stdout: marker, stderr: marker };
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.error).toBe("Verification failed during npm run format:check.");
  expect(report.commands.at(-1)).toEqual(
    expect.objectContaining({
      command: "npm run format:check",
      exitStatus: null,
      child: expect.objectContaining({ processError: "launcher-error" }),
    }),
  );
});
it("classifies an integration process failure without exposing output", async () => {
  doubles.spawn.mockImplementation((command, args) => {
    if (command === "git")
      return {
        status: 0,
        stdout: args[0] !== "status" ? "a".repeat(40) : "",
      };
    if (command === "npm" && args[1] === "test:integration")
      return {
        status: 1,
        signal: null,
        stdout: `Vitest caught 1 unhandled error during the test run.\n${marker}`,
        stderr: `EnvironmentTeardownError\nnpm error command failed\n${marker}`,
      };
    return { status: 0, stdout: "", stderr: "" };
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.integrationTests).toBeUndefined();
  expect(report.commands.at(-1)).toEqual(
    expect.objectContaining({
      command: "npm run test:integration",
      exitStatus: 1,
      child: expect.objectContaining({
        processError: "none",
        signal: "none",
        vitestUnhandledErrors: true,
        vitestTeardownError: true,
        npmErrorBanner: true,
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number),
      }),
    }),
  );
});
it("labels buffer overflow and signals without trusting error text", async () => {
  doubles.spawn.mockImplementation((command, args) => {
    if (command === "git")
      return {
        status: 0,
        stdout: args[0] !== "status" ? "a".repeat(40) : "",
      };
    return args[0] === "run" && args[1] === "format:check"
      ? {
          status: null,
          signal: "SIGTERM",
          error: Object.assign(new Error(marker), { code: "ENOBUFS" }),
          stdout: marker,
          stderr: marker,
        }
      : { status: 0, stdout: "", stderr: "" };
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.commands.at(-1).child).toEqual(
    expect.objectContaining({
      processError: "output-buffer-limit",
      signal: "SIGTERM",
    }),
  );
});
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
    expect.objectContaining({
      command: "node scripts/check-installed-deps.mjs",
      exitStatus: 0,
    }),
    expect.objectContaining({ command: "npm run format:check", exitStatus: 7 }),
  ]);
  expect(report.exitStatus).toBe(1);
});
it("rejects dependency drift before any application command", async () => {
  doubles.spawn.mockImplementation((command, args) => ({
    status:
      command === "node" && args[0] === "scripts/check-installed-deps.mjs"
        ? 1
        : 0,
    stdout: command === "git" && args[0] !== "status" ? "a".repeat(40) : "",
  }));
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.commands).toEqual([
    expect.objectContaining({
      command: "node scripts/check-installed-deps.mjs",
      exitStatus: 1,
    }),
  ]);
  expect(report.unitTests).toBeUndefined();
  expect(
    doubles.spawn.mock.calls.filter(([command]) => command === "npm"),
  ).toEqual([]);
});
it("attempts every cleanup and writes a failed report after cleanup errors", async () => {
  doubles.query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error(marker))
    .mockRejectedValueOnce(new Error(marker));
  doubles.end.mockRejectedValueOnce(new Error(marker));
  doubles.remove.mockImplementation((target) => {
    if (target === "/synthetic/private-evidence") throw new Error(marker);
  });
  const report = await run();
  expect(report.exitStatus).toBe(1);
  expect(report.cleanupErrors).toEqual([
    "Provisional test database cleanup failed.",
    "Test database cleanup failed.",
    "Test database connection cleanup failed.",
    "Private test storage cleanup failed.",
  ]);
  expect(doubles.query).toHaveBeenCalledTimes(4);
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(doubles.remove).toHaveBeenCalledWith("/synthetic/private-evidence", {
    recursive: true,
    force: true,
  });
});
it("keeps a failed provisional database setup from passing or leaking", async () => {
  doubles.query
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error(marker));
  const report = await run();
  expect(report.error).toBe(
    "Verification failed during provisional test database setup.",
  );
  expect(report.exitStatus).toBe(1);
  expect(doubles.query).toHaveBeenCalledTimes(3);
  expect(
    doubles.spawn.mock.calls.some(
      ([command, args]) =>
        command === "npm" && args[1] === "test:e2e:provisional",
    ),
  ).toBe(false);
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
  expect(doubles.query).toHaveBeenCalledTimes(4);
  const mainBrowser = doubles.spawn.mock.calls.find(
    ([command, args]) => command === "npm" && args[1] === "test:e2e",
  );
  const provisionalBrowser = doubles.spawn.mock.calls.find(
    ([command, args]) =>
      command === "npm" && args[1] === "test:e2e:provisional",
  );
  const mainDatabase = new URL(mainBrowser[2].env.DNE_TEST_DATABASE_URL)
    .pathname;
  const provisionalDatabase = new URL(
    provisionalBrowser[2].env.DNE_TEST_DATABASE_URL,
  ).pathname;
  expect(mainDatabase).toMatch(/^\/dne_test_[0-9a-f]{32}$/);
  expect(provisionalDatabase).toMatch(/^\/dne_test_[0-9a-f]{32}$/);
  expect(provisionalDatabase).not.toBe(mainDatabase);
  expect(doubles.end).toHaveBeenCalledOnce();
  expect(output).not.toHaveBeenCalled();
});
