import { it, expect } from "vitest";
import {
  assertCoverage,
  assertJourneys,
  assertUnitResults,
} from "../../scripts/quality-gates.mjs";
const copy = (v) => JSON.parse(JSON.stringify(v));
const counts = { total: 100, covered: 100, skipped: 0 };
const metrics = () =>
  Object.fromEntries(
    ["statements", "branches", "functions", "lines"].map((k) => [
      k,
      { ...counts },
    ]),
  );
const coverage = () => ({ total: metrics(), "/repo/src/app.ts": metrics() });
const register = {
  version: "v1",
  scope: "test",
  projects: ["desktop", "mobile"],
  slice: [
    {
      id: "L01",
      actor: "learner",
      preconditions: "new",
      steps: "learn",
      expected: "saved",
      issues: [1],
      critical: true,
    },
  ],
  fullMvp: [{ id: "OUTSTANDING" }],
};
const execution = (projectName) => ({
  projectName,
  expectedStatus: "passed",
  status: "expected",
  results: [{ status: "passed", retry: 0 }],
});
const browser = () => ({
  errors: [],
  suites: [
    {
      suites: [
        {
          specs: [
            {
              title: "[L01] learn",
              tests: [execution("desktop"), execution("mobile")],
            },
          ],
        },
      ],
    },
  ],
});
it("requires all unit tests to pass with nonempty, consistent evidence", () => {
  const report = {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ assertionResults: [{ status: "passed" }] }],
  };
  expect(assertUnitResults(report)).toEqual({ passed: 1, total: 1 });
  for (const change of [
    { success: false },
    { numTotalTests: 0 },
    { numPassedTests: 0 },
    { numPendingTests: 1 },
    { numTodoTests: 1 },
    { testResults: [] },
  ])
    expect(() => assertUnitResults({ ...report, ...change })).toThrow();
});
it("uses raw unit counts, rejects low module coverage and missing/unimported source", () => {
  expect(assertCoverage(coverage(), ["src/app.ts"], "/repo")).toEqual(
    metrics(),
  );
  const low = coverage();
  low["/repo/src/app.ts"].branches.covered = 98;
  expect(() => assertCoverage(low, ["src/app.ts"], "/repo")).toThrow(
    /below 99/,
  );
  expect(() =>
    assertCoverage(coverage(), ["src/app.ts", "src/unimported.ts"], "/repo"),
  ).toThrow(/every application/);
  expect(() => assertCoverage(coverage(), [], "/repo")).toThrow();
  const empty = coverage();
  empty.total.functions.total = 0;
  empty.total.functions.covered = 0;
  expect(() => assertCoverage(empty, ["src/app.ts"], "/repo")).toThrow(/Empty/);
  const inconsistent = coverage();
  inconsistent.total.lines.total = 101;
  inconsistent.total.lines.covered = 101;
  expect(() => assertCoverage(inconsistent, ["src/app.ts"], "/repo")).toThrow(
    /differs/,
  );
  const malformed = coverage();
  malformed.total.lines.covered = 101;
  expect(() => assertCoverage(malformed, ["src/app.ts"], "/repo")).toThrow(
    /Malformed/,
  );
});
it("requires every scenario on every supported browser and keeps full-MVP work outstanding", () => {
  const result = assertJourneys(register, browser());
  expect(result.passed).toBe(1);
  expect(result.executions).toBe(2);
  expect(result.fullMvp).toEqual({
    passed: 0,
    total: 1,
    uncovered: ["OUTSTANDING"],
  });
});
it.each([
  "missing",
  "skipped",
  "failed",
  "retry",
  "unmapped",
  "duplicate",
  "empty",
  "report-error",
  "wrong-project",
  "expected-failure",
])("rejects %s browser evidence", (fault) => {
  const report = browser();
  const spec = report.suites[0].suites[0].specs[0];
  if (fault === "missing") spec.tests.pop();
  if (fault === "skipped") spec.tests[0].results[0].status = "skipped";
  if (fault === "failed") spec.tests[0].status = "unexpected";
  if (fault === "retry") spec.tests[0].results[0].retry = 1;
  if (fault === "unmapped") spec.title = "unknown";
  if (fault === "duplicate") spec.tests.push(execution("desktop"));
  if (fault === "empty") report.suites = [];
  if (fault === "report-error") report.errors = [{ message: "failed startup" }];
  if (fault === "wrong-project") spec.tests[0].projectName = "unknown";
  if (fault === "expected-failure") spec.tests[0].expectedStatus = "failed";
  expect(() => assertJourneys(register, report)).toThrow();
});
it("rejects empty, duplicated or incomplete journey registers", () => {
  for (const key of ["slice", "fullMvp", "projects"])
    expect(() =>
      assertJourneys({ ...register, [key]: [] }, browser()),
    ).toThrow();
  const duplicated = copy(register);
  duplicated.slice.push({ ...duplicated.slice[0] });
  expect(() => assertJourneys(duplicated, browser())).toThrow(/Duplicate/);
  const incomplete = copy(register);
  delete incomplete.slice[0].steps;
  expect(() => assertJourneys(incomplete, browser())).toThrow(/Incomplete/);
});
