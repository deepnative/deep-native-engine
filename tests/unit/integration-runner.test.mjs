import { afterEach, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers";
import { Pool } from "pg";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import {
  controlUrl,
  createLaneDatabase,
  dropLaneDatabase,
  integrationFiles,
  mergeIntegrationReports,
  mergeUnhandled,
  testLaneCount,
  runIntegration,
} from "../../scripts/integration-runner.mjs";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal()),
  availableParallelism: () => 8,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));
vi.mock("pg", () => ({ Pool: vi.fn(function () {}) }));
vi.mock("../support/attendance-browser-database.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dropAttendanceBrowserDatabase: vi.fn(actual.dropAttendanceBrowserDatabase),
  };
});

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs");
});
const directory = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dne-lane-unit-"));
  directories.push(root);
  return root;
};
const zero = () => ({
  schema: "integration-unhandled-v1",
  count: 0,
  truncated: false,
  signatures: [],
});
const snapshot = () => ({
  added: 0,
  failure: false,
  filesAdded: 0,
  filesRemoved: 0,
  filesRemovedList: [],
  filesUnmatched: 0,
  filesUpdated: 0,
  matched: 0,
  total: 0,
  unchecked: 0,
  uncheckedKeysByFile: [],
  unmatched: 0,
  updated: 0,
  didUpdate: false,
});
function fixture() {
  const expected = [
    path.resolve("tests/integration/first.test.ts"),
    path.resolve("tests/integration/second.test.ts"),
    path.resolve("tests/integration/third.test.ts"),
    path.resolve("tests/integration/fourth.test.ts"),
  ];
  const lanes = expected.map((name, position) => ({
    index: position + 1,
    child: {
      exitStatus: 0,
      signal: "none",
      processError: "none",
      outputBufferExceeded: false,
      vitestUnhandledErrors: false,
      vitestTeardownError: false,
      npmErrorBanner: false,
    },
    unhandled: zero(),
    report: {
      success: true,
      startTime: 100 + position,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      snapshot: snapshot(),
      testResults: [
        {
          name,
          status: "passed",
          startTime: 100,
          endTime: 200,
          assertionResults: [
            {
              fullName: "required behavior",
              status: "passed",
              failureMessages: [],
              meta: {},
            },
          ],
        },
      ],
    },
  }));
  return { expected, lanes };
}
it("LAND-SCHED-04 merges all four original lane reports while retaining every file, assertion and raw count", () => {
  const { expected, lanes } = fixture();
  const original = JSON.stringify(lanes);
  const result = mergeIntegrationReports(expected, lanes);
  expect(result).toMatchObject({
    success: true,
    numTotalTests: 4,
    numPassedTests: 4,
    numTotalTestSuites: 4,
    numPassedTestSuites: 4,
    numPendingTests: 0,
    startTime: 100,
  });
  expect(result.testResults.map((file) => file.name)).toEqual(
    [...expected].sort(),
  );
  expect(result.testResults.map((file) => file.assertionResults)).toEqual(
    lanes.map((lane) => lane.report.testResults[0].assertionResults),
  );
  expect(JSON.stringify(lanes)).toBe(original);
});
it.each([
  ["missing lane", (x) => x.lanes.pop()],
  [
    "duplicate lane",
    (x) => {
      x.lanes[1].index = 1;
    },
  ],
  [
    "foreign lane",
    (x) => {
      x.lanes[1].index = 9;
    },
  ],
  [
    "duplicate file",
    (x) => {
      x.lanes[1].report.testResults[0].name = x.expected[0];
    },
  ],
  [
    "missing file",
    (x) => x.expected.push(path.resolve("tests/integration/missing.test.ts")),
  ],
  [
    "foreign file",
    (x) => {
      x.lanes[1].report.testResults[0].name = path.resolve("foreign.test.ts");
    },
  ],
  [
    "empty file",
    (x) => {
      x.lanes[1].report.testResults[0].assertionResults = [];
    },
  ],
  [
    "count mismatch",
    (x) => {
      x.lanes[1].report.numTotalTests = x.lanes[1].report.numPassedTests = 2;
    },
  ],
  [
    "failed assertion",
    (x) => {
      x.lanes[1].report.testResults[0].assertionResults[0].status = "failed";
    },
  ],
  [
    "skipped assertion",
    (x) => {
      x.lanes[1].report.testResults[0].assertionResults[0].status = "pending";
    },
  ],
  [
    "retry-only assertion",
    (x) => {
      x.lanes[1].report.testResults[0].assertionResults[0].meta.retryCount = 1;
    },
  ],
  [
    "pending count",
    (x) => {
      x.lanes[1].report.numPendingTests = 1;
    },
  ],
  [
    "todo count",
    (x) => {
      x.lanes[1].report.numTodoTests = 1;
    },
  ],
  [
    "snapshot failure",
    (x) => {
      x.lanes[1].report.snapshot.failure = true;
    },
  ],
])(
  "refuses %s rather than accepting a partial or duplicate union",
  (_name, change) => {
    const value = fixture();
    change(value);
    expect(() =>
      mergeIntegrationReports(value.expected, value.lanes),
    ).toThrow();
  },
);
it.each([
  ["nonzero exit with passing JSON", { exitStatus: 1 }],
  ["signalled child", { exitStatus: null, signal: "SIGTERM" }],
  ["launcher failure", { processError: "launcher-error" }],
  ["output overflow", { outputBufferExceeded: true }],
  ["global unhandled output", { vitestUnhandledErrors: true }],
  ["teardown output", { vitestTeardownError: true }],
  ["npm failure output", { npmErrorBanner: true }],
])("refuses %s even when every reported test passed", (_name, changes) => {
  const { expected, lanes } = fixture();
  Object.assign(lanes[1].child, changes);
  expect(() => mergeIntegrationReports(expected, lanes)).toThrow(
    "process failed",
  );
});
it("requires valid original diagnostics from both lanes and retains only fixed signatures", () => {
  expect(mergeUnhandled([zero(), zero(), zero(), zero()])).toEqual(zero());
  expect(() => mergeUnhandled([zero()])).toThrow();
  expect(() => mergeUnhandled([zero(), undefined])).toThrow();
  const signature = {
    kind: "unhandled-error",
    name: "error",
    code: "other",
    testFile: "other",
    firstFrame: "other",
    message: "invented private output",
  };
  const report = {
    schema: "integration-unhandled-v1",
    count: 1,
    truncated: false,
    signatures: [signature],
  };
  const merged = mergeUnhandled([report, report, zero(), zero()]);
  expect(merged.count).toBe(2);
  expect(JSON.stringify(merged)).not.toContain("invented private output");
  const { expected, lanes } = fixture();
  lanes[1].unhandled = report;
  expect(() => mergeIntegrationReports(expected, lanes)).toThrow(
    "unhandled errors",
  );
  expect(() =>
    mergeUnhandled([
      zero(),
      {
        ...report,
        signatures: [{ ...signature, code: "invented-private-code" }],
      },
    ]),
  ).toThrow();
});
it("collects the complete recursive native-file inventory and refuses symlinked sources", () => {
  const root = directory();
  mkdirSync(path.join(root, "tests/integration/nested"), { recursive: true });
  writeFileSync(path.join(root, "tests/integration/first.test.ts"), "");
  writeFileSync(path.join(root, "tests/integration/nested/second.test.ts"), "");
  writeFileSync(path.join(root, "tests/integration/ignored.txt"), "");
  expect(integrationFiles(root)).toHaveLength(2);
  symlinkSync(
    path.join(root, "tests/integration/first.test.ts"),
    path.join(root, "tests/integration/link.test.ts"),
  );
  expect(() => integrationFiles(root)).toThrow("Unsafe");
});
it("only derives administrative access from a generated loopback test database", () => {
  expect(
    controlUrl(
      "postgresql://invented:private@127.0.0.1:54329/dne_test_" +
        "a".repeat(32),
    ).pathname,
  ).toBe("/postgres");
  for (const value of [
    undefined,
    "invalid",
    "postgresql://host.invalid/dne_test_" + "a".repeat(32),
    "postgresql://localhost/dne_dev",
    "postgresql://localhost/dne_test_" + "a".repeat(32) + "?sslmode=disable",
    "postgresql://localhost/dne_test_" + "a".repeat(32) + "#override",
  ])
    expect(() => controlUrl(value)).toThrow("Generated loopback");
});
function databaseAdmin() {
  let existing = false,
    marker,
    name;
  const query = vi.fn(async (statement, parameters) => {
    const sql = typeof statement === "string" ? statement : statement.text;
    const values =
      typeof statement === "string" ? parameters : statement.values;
    if (sql.startsWith("CREATE DATABASE")) {
      existing = true;
      name = sql.match(/"([^"]+)"/)[1];
    }
    if (sql.startsWith("COMMENT")) marker = sql.match(/'([^']+)'/)[1];
    if (sql.startsWith("DROP DATABASE")) existing = false;
    if (sql.includes("count(*)") && sql.includes("pg_database"))
      return { rows: [{ n: existing ? 1 : 0 }] };
    if (sql.includes("pg_stat_activity")) return { rows: [{ count: 0 }] };
    if (sql.includes("SELECT oid"))
      return {
        rows:
          existing && (!values || values[0] === name)
            ? [{ oid: "42", marker }]
            : [],
      };
    return { rows: [] };
  });
  return { query };
}
it("creates an absent marked database and confirms zero-session exact-identity removal", async () => {
  const admin = databaseAdmin();
  const record = await createLaneDatabase(admin);
  expect(record).toMatchObject({ oid: "42", marked: true });
  expect(record.name).toMatch(/^dne_test_[a-f0-9]{32}$/);
  await dropLaneDatabase(admin, record);
  expect(
    admin.query.mock.calls.some(
      ([sql]) =>
        typeof sql === "string" &&
        sql.startsWith("DROP DATABASE") &&
        !sql.includes("FORCE"),
    ),
  ).toBe(true);
});
it("refuses changed ownership and never retries an ambiguous DROP acknowledgement", async () => {
  const admin = databaseAdmin();
  const record = await createLaneDatabase(admin);
  await expect(
    dropLaneDatabase(admin, { ...record, oid: "43" }),
  ).rejects.toThrow("ownership changed");
  await expect(
    dropLaneDatabase(admin, { ...record, marked: false }),
  ).rejects.toThrow("ownership unavailable");
  expect(
    admin.query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.startsWith("DROP DATABASE"),
    ),
  ).toBe(false);
  const original = admin.query.getMockImplementation();
  admin.query.mockImplementation(async (sql, values) => {
    const result = await original(sql, values);
    if (typeof sql === "string" && sql.startsWith("DROP DATABASE"))
      throw Error("invented acknowledgement loss");
    return result;
  });
  await expect(dropLaneDatabase(admin, record)).rejects.toThrow();
  expect(
    admin.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.startsWith("DROP DATABASE"),
    ),
  ).toHaveLength(1);
});
it("retains a creation intent if ownership marking cannot be confirmed", async () => {
  const admin = databaseAdmin();
  const original = admin.query.getMockImplementation();
  admin.query.mockImplementation(async (sql, values) => {
    if (typeof sql === "string" && sql.startsWith("COMMENT"))
      throw Error("invented private failure");
    return original(sql, values);
  });
  let error;
  try {
    await createLaneDatabase(admin);
  } catch (failure) {
    error = failure;
  }
  expect(error.message).toBe("Integration database ownership setup failed");
  expect(error.ownedDatabase).toMatchObject({ oid: "42", marked: false });
  expect(
    admin.query.mock.calls.some(
      ([sql]) => typeof sql === "string" && sql.startsWith("DROP DATABASE"),
    ),
  ).toBe(false);
});
it("fails a malformed administrative target without exposing it or claiming test evidence", async () => {
  const root = directory();
  mkdirSync(path.join(root, "tests/integration"), { recursive: true });
  for (const name of ["a", "b"])
    writeFileSync(path.join(root, `tests/integration/${name}.test.ts`), "");
  vi.stubEnv("DNE_TEST_DATABASE_URL", "invented-private-connection-value");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runIntegration(root)).toBe(1);
  const evidence = readFileSync(
    path.join(root, "artifacts/integration-shards.json"),
    "utf8",
  );
  expect(evidence).not.toContain("invented-private-connection-value");
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
    "invented-private-connection-value",
  );
  expect(JSON.parse(evidence)).toMatchObject({
    exitStatus: 1,
    lanes: [],
    error: "Integration verification failed during configuration.",
  });
});
function controlledNativeRun() {
  const root = directory();
  mkdirSync(path.join(root, "tests/integration"), { recursive: true });
  const files = ["first", "second", "third", "fourth"].map((name) => {
    const file = path.join(root, `tests/integration/${name}.test.ts`);
    writeFileSync(file, "");
    return file;
  });
  vi.stubEnv(
    "DNE_TEST_DATABASE_URL",
    `postgresql://invented:private@127.0.0.1/dne_test_${"a".repeat(32)}`,
  );
  const databases = new Map();
  vi.mocked(Pool).mockImplementation(function () {
    return {
      on: vi.fn(),
      end: vi.fn(async () => {}),
      query: vi.fn(async (sql, values) => {
        if (sql.startsWith("CREATE DATABASE"))
          databases.set(sql.match(/"([^"]+)"/)[1], { oid: "42" });
        if (sql.startsWith("COMMENT ON DATABASE"))
          databases.get(sql.match(/"([^"]+)"/)[1]).marker =
            sql.match(/IS '([^']+)'/)[1];
        if (sql.includes("count(*)"))
          return { rows: [{ n: databases.has(values[0]) ? 1 : 0 }] };
        if (sql.startsWith("SELECT oid"))
          return {
            rows: databases.has(values[0]) ? [databases.get(values[0])] : [],
          };
        return { rows: [] };
      }),
    };
  });
  vi.mocked(dropAttendanceBrowserDatabase).mockImplementation(
    async (_admin, name) => {
      databases.delete(name);
    },
  );
  const launched = [];
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const index = Number(
      args.find((arg) => arg.startsWith("--shard=")).match(/=(\d)/)[1],
    );
    const report = fixture().lanes[index - 1].report;
    report.testResults[0].name = files[index - 1];
    child.finish = (exitStatus = 0) => {
      const destination = path.join(
        root,
        `artifacts/integration-shards/${index}`,
      );
      writeFileSync(
        path.join(destination, "results.json"),
        JSON.stringify(report),
      );
      writeFileSync(
        path.join(destination, "unhandled.json"),
        JSON.stringify(zero()),
      );
      child.emit("close", exitStatus, null);
    };
    launched.push(child);
    return child;
  });
  return { root, launched, databases };
}
it("LAND-SCHED-01 starts four isolated native lanes before any lane closes", async () => {
  const { root, launched, databases } = controlledNativeRun();
  const run = runIntegration(root);
  await vi.waitFor(() => expect(launched).toHaveLength(4));
  expect(databases.size).toBe(4);
  expect(
    new Set(
      vi
        .mocked(spawn)
        .mock.calls.map((call) => call[2].env.DNE_TEST_DATABASE_URL),
    ).size,
  ).toBe(4);
  for (const child of launched) child.finish();
  expect(await run).toBe(0);
  expect(databases.size).toBe(0);
});
it("LAND-SCHED-02 retains every concurrent lane outcome when one fails", async () => {
  const { root, launched, databases } = controlledNativeRun();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const run = runIntegration(root);
  await vi.waitFor(() => expect(launched).toHaveLength(4));
  launched.forEach((child, index) => child.finish(index === 0 ? 1 : 0));
  expect(await run).toBe(1);
  const evidence = JSON.parse(
    readFileSync(path.join(root, "artifacts/integration-shards.json"), "utf8"),
  );
  expect(evidence.lanes.map((lane) => lane.exitStatus)).toEqual([1, 0, 0, 0]);
  expect(databases.size).toBe(0);
});
it("LAND-SCHED-03 waits for all interrupted children before owned cleanup", async () => {
  const { root, launched, databases } = controlledNativeRun();
  const previous = new Set(process.listeners("SIGTERM"));
  const run = runIntegration(root);
  await vi.waitFor(() => expect(launched).toHaveLength(4));
  const stop = process
    .listeners("SIGTERM")
    .find((listener) => !previous.has(listener));
  stop();
  for (const child of launched)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  for (const child of launched.slice(0, 3))
    child.emit("close", null, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  expect(databases.size).toBe(4);
  launched[3].emit("close", null, "SIGTERM");
  expect(await run).toBe(1);
  expect(databases.size).toBe(0);
});
it("refuses CLI filters before starting resources and never echoes their private values", () => {
  const marker = "invented-private-filter-value";
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/integration-runner.mjs"), "--filter", marker],
    { cwd: directory(), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("complete unfiltered test inventory");
  expect(result.stderr).not.toContain(marker);
});
it("keeps the two diagnostic writers distinct and rejects unbounded lane selectors", async () => {
  const mkdir = vi.fn(),
    write = vi.fn();
  vi.doMock("node:fs", () => ({ mkdirSync: mkdir, writeFileSync: write }));
  for (const lane of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    vi.resetModules();
    vi.stubEnv("DNE_INTEGRATION_SHARD", lane);
    const { default: reporter } =
      await import("../support/integration-diagnostics-reporter.ts");
    reporter.onTestRunEnd([], []);
    expect(write.mock.lastCall[0]).toBe(
      `artifacts/integration-shards/${lane}/unhandled.json`,
    );
    expect(JSON.parse(write.mock.lastCall[1])).toEqual(zero());
  }
  vi.resetModules();
  vi.stubEnv("DNE_INTEGRATION_SHARD", "invented-private-lane");
  await expect(
    import("../support/integration-diagnostics-reporter.ts"),
  ).rejects.toThrow("Invalid integration lane");
  expect(JSON.stringify(write.mock.calls)).not.toContain(
    "invented-private-lane",
  );
});
it("contains evidence-write failures at the real CLI boundary without leaking private configuration or paths", () => {
  const root = directory();
  mkdirSync(path.join(root, "tests/integration"), { recursive: true });
  for (const name of ["a", "b"])
    writeFileSync(path.join(root, `tests/integration/${name}.test.ts`), "");
  writeFileSync(path.join(root, "artifacts"), "invented private file");
  const marker = "invented-private-database-value";
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/integration-runner.mjs")],
    {
      cwd: root,
      env: { ...process.env, DNE_TEST_DATABASE_URL: marker },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("evidence could not be preserved");
  expect(result.stderr).not.toContain(marker);
  expect(result.stderr).not.toContain(root);
});

it("SPEED04 uses eight isolated lanes on a large local runner and four on smaller CI hosts", () => {
  expect(testLaneCount(12)).toBe(8);
  expect(testLaneCount(18)).toBe(8);
  expect(testLaneCount(8)).toBe(4);
  expect(testLaneCount(2)).toBe(4);
});
