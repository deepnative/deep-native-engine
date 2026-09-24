import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertCoverage,
  assertJourneys,
  assertFullReleaseJourneys,
  assertUnitResults,
} from "../../scripts/quality-gates.mjs";
const copy = (v) => JSON.parse(JSON.stringify(v));
const proposal = JSON.parse(
  readFileSync(new URL("../e2e/scenarios.json", import.meta.url), "utf8"),
);
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
  fullMvpVersion: "full-v1",
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
  fullMvp: [
    {
      id: "OUTSTANDING",
      source: "roadmap",
      requirement: "full requirement",
      actor: "member",
      preconditions: "new member",
      steps: "start journey",
      expected: "observable result",
      risk: "privacy",
      issues: [24],
      critical: true,
      cases: [
        {
          id: "F-OUTSTANDING-A",
          steps: "do full journey",
          expected: "observable outcome",
          critical: true,
        },
      ],
      status: "outstanding",
    },
  ],
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
    register: "full-v1",
    families: 1,
    passed: 0,
    total: 1,
    criticalPassed: 0,
    criticalTotal: 1,
    uncovered: ["F-OUTSTANDING-A"],
  });
});
it("does not let the proposed full-MVP denominator or critical set shrink silently", () => {
  const mapped = {
    ...register,
    fullMvpVersion: proposal.fullMvpVersion,
    fullMvp: proposal.fullMvp,
  };
  expect(assertJourneys(mapped, browser()).fullMvp).toMatchObject({
    families: 27,
    total: 100,
    criticalTotal: 94,
  });
  const removed = copy(mapped);
  removed.fullMvp[0].cases.pop();
  expect(() => assertJourneys(removed, browser())).toThrow(/proposed full-MVP/);
  const replaced = copy(mapped);
  replaced.fullMvp[0].cases[0].id = "F-ROADMAP-01-Z";
  expect(() => assertJourneys(replaced, browser())).toThrow(
    /proposed full-MVP/,
  );
  const downgraded = copy(mapped);
  downgraded.fullMvp.find((s) => s.id === "ECO-04").cases[0].critical = false;
  expect(() => assertJourneys(downgraded, browser())).toThrow(
    /proposed full-MVP/,
  );
});
it("can gate the full-release denominator only when every reserved browser journey passes", () => {
  const release = browser();
  release.suites[0].suites[0].specs[0].title = "[F-OUTSTANDING-A] full journey";
  expect(assertFullReleaseJourneys(register, release)).toMatchObject({
    register: "full-v1",
    passed: 1,
    total: 1,
    criticalPassed: 1,
    criticalTotal: 1,
    uncovered: [],
  });
  const missing = copy(release);
  missing.suites[0].suites[0].specs[0].tests.pop();
  expect(() => assertFullReleaseJourneys(register, missing)).toThrow();
  const skipped = copy(release);
  skipped.suites[0].suites[0].specs[0].tests[0].results[0].status = "skipped";
  expect(() => assertFullReleaseJourneys(register, skipped)).toThrow();
  expect(() => assertFullReleaseJourneys(register, browser())).toThrow(
    /Unmapped/,
  );
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
  const incompleteRelease = copy(register);
  delete incompleteRelease.fullMvp[0].risk;
  expect(() => assertJourneys(incompleteRelease, browser())).toThrow(
    /Incomplete full/,
  );
  const duplicateBrowserId = copy(register);
  duplicateBrowserId.fullMvp[0].cases.push({
    ...duplicateBrowserId.fullMvp[0].cases[0],
  });
  expect(() => assertJourneys(duplicateBrowserId, browser())).toThrow(
    /Duplicate full/,
  );
  const falseCompletion = copy(register);
  falseCompletion.fullMvp[0].status = "passed";
  expect(() => assertJourneys(falseCompletion, browser())).toThrow(
    /Unverified full/,
  );
  const declassified = copy(register);
  declassified.fullMvp[0].cases[0].critical = false;
  expect(() => assertJourneys(declassified, browser())).toThrow(
    /Incomplete full/,
  );
});
