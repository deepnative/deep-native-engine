import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
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
import {
  controlUrl,
  createLaneDatabase,
  dropLaneDatabase,
  integrationFiles,
  mergeIntegrationReports,
  mergeUnhandled,
  runIntegration,
} from "../../scripts/integration-runner.mjs";

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
it("merges both original lane reports while retaining every file, assertion and raw count", () => {
  const { expected, lanes } = fixture();
  const original = JSON.stringify(lanes);
  const result = mergeIntegrationReports(expected, lanes);
  expect(result).toMatchObject({
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numPendingTests: 0,
    startTime: 100,
  });
  expect(result.testResults.map((file) => file.name)).toEqual(expected);
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
      x.lanes[1].index = 3;
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
  expect(mergeUnhandled([zero(), zero()])).toEqual(zero());
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
  const merged = mergeUnhandled([report, report]);
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
  for (const lane of ["1", "2"]) {
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
