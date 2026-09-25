import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertCoverage,
  assertJourneys,
  assertFullReleaseJourneys,
  assertProvisionalReleaseJourneys,
  assertUnitResults,
  requiredCheckToken,
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
          requiredChecks: [
            { action: "do full journey", expected: "observable outcome" },
          ],
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
  expect(
    mapped.fullMvp
      .flatMap((family) => family.cases)
      .reduce((count, item) => count + item.requiredChecks.length, 0),
  ).toBe(206);
  for (const [id, minimum] of [
    ["F-ROADMAP-03-C", 2],
    ["F-ECO-06-C", 2],
    ["F-ECO-07-C", 3],
  ]) {
    const item = mapped.fullMvp
      .flatMap((family) => family.cases)
      .find((test) => test.id === id);
    expect(item.requiredChecks.length).toBeGreaterThanOrEqual(minimum);
  }
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
  const untracked = copy(mapped);
  delete untracked.fullMvp[0].cases[0].requiredChecks;
  expect(() => assertJourneys(untracked, browser())).toThrow(/Incomplete/);
});
it("keeps source-derived competence, export and moderation obligations independently mandatory", () => {
  const cases = proposal.fullMvp.flatMap((family) => family.cases);
  const obligations = [
    {
      id: "F-ROADMAP-01-B",
      action: /publish.*content.*no completed assessment/i,
      expected: /neither assessed competence nor a completed human-review/i,
    },
    {
      id: "F-ROADMAP-09-D",
      action: /authorized operator.*recorded.*current export authorization/i,
      expected:
        /only records within.*authorization.*another member.*outside its scope/i,
    },
    {
      id: "F-ROADMAP-09-D",
      action: /operator.*without recorded member authorization/i,
      expected: /denied.*no member records/i,
    },
    {
      id: "F-ROADMAP-09-D",
      action: /operator.*authorization expires/i,
      expected: /denied.*no member records/i,
    },
    {
      id: "F-ROADMAP-09-D",
      action: /operator.*outside its permitted member or record scope/i,
      expected: /denied.*no unauthorized records/i,
    },
    {
      id: "F-ECO-04-B",
      action:
        /authorized moderator.*reported circle scope.*act on the reported post.*reason.*unrelated private assignments/i,
      expected:
        /only the reported scope.*affected.*record identifies.*moderator and reason.*unrelated private work cannot be opened or disclosed/i,
    },
    {
      id: "F-ECO-04-B",
      action: /moderation action as an outsider/i,
      expected: /denied.*no moderation effect.*no private disclosure/i,
    },
    {
      id: "F-ECO-04-B",
      action:
        /moderation action as a peer member without moderator authorization/i,
      expected: /denied.*no moderation effect.*no private disclosure/i,
    },
    {
      id: "F-ECO-04-B",
      action:
        /revoke the moderator.*authorization.*retry the moderation action/i,
      expected: /denied.*no moderation effect.*no private disclosure/i,
    },
  ];
  expect(
    cases.find((item) => item.id === "F-ECO-04-B").requiredChecks,
  ).toHaveLength(6);
  for (const obligation of obligations) {
    const item = cases.find((test) => test.id === obligation.id);
    expect(item.critical).toBe(true);
    const matches = item.requiredChecks.filter((check) =>
      obligation.action.test(check.action),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].expected).toMatch(obligation.expected);
  }

  // Complete synthetic evidence tests the validator contract, not browser behavior.
  const report = {
    errors: [],
    suites: [
      {
        specs: cases.map((item) => ({
          title: `[${item.id}] synthetic check contract`,
          tests: proposal.projects.map((projectName) => ({
            ...execution(projectName),
            results: [
              {
                status: "passed",
                retry: 0,
                annotations: item.requiredChecks.map((check, index) => ({
                  type: "required-check",
                  description: requiredCheckToken(item.id, index + 1, check),
                })),
              },
            ],
          })),
        })),
      },
    ],
  };
  expect(assertFullReleaseJourneys(proposal, report)).toMatchObject({
    passed: 100,
    total: 100,
    criticalPassed: 94,
    executions: 200,
  });
  for (const obligation of obligations) {
    const item = cases.find((test) => test.id === obligation.id);
    const checkIndex = item.requiredChecks.findIndex((check) =>
      obligation.action.test(check.action),
    );
    const specIndex = cases.findIndex((test) => test.id === obligation.id);
    for (const [browserIndex, browserName] of proposal.projects.entries()) {
      const incomplete = copy(report);
      incomplete.suites[0].specs[specIndex].tests[
        browserIndex
      ].results[0].annotations.splice(checkIndex, 1);
      expect(() => assertFullReleaseJourneys(proposal, incomplete)).toThrow(
        new RegExp(
          `Incomplete required subcases.*${obligation.id}.*${browserName}`,
        ),
      );
    }
  }
});
it("can gate the full-release denominator only when every reserved browser journey passes", () => {
  const release = browser();
  release.suites[0].suites[0].specs[0].title = "[F-OUTSTANDING-A] full journey";
  const check = register.fullMvp[0].cases[0].requiredChecks[0];
  const annotation = {
    type: "required-check",
    description: requiredCheckToken("F-OUTSTANDING-A", 1, check),
  };
  for (const result of release.suites[0].suites[0].specs[0].tests)
    result.results[0].annotations = [annotation];
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
  const missingSubcase = copy(release);
  missingSubcase.suites[0].suites[0].specs[0].tests[1].results[0].annotations =
    [];
  expect(() => assertFullReleaseJourneys(register, missingSubcase)).toThrow(
    /Incomplete required subcases/,
  );
  const duplicateSubcase = copy(release);
  duplicateSubcase.suites[0].suites[0].specs[0].tests[0].results[0].annotations.push(
    annotation,
  );
  expect(() => assertFullReleaseJourneys(register, duplicateSubcase)).toThrow(
    /Incomplete required subcases/,
  );
  const staleMapping = copy(register);
  staleMapping.fullMvp[0].cases[0].requiredChecks[0].expected = "different";
  expect(() => assertFullReleaseJourneys(staleMapping, release)).toThrow(
    /Incomplete required subcases/,
  );
  const skipped = copy(release);
  skipped.suites[0].suites[0].specs[0].tests[0].results[0].status = "skipped";
  expect(() => assertFullReleaseJourneys(register, skipped)).toThrow();
  expect(() => assertFullReleaseJourneys(register, browser())).toThrow(
    /Unmapped/,
  );
});
it("requires every mandatory subcase on each browser under the same ID", () => {
  const mapped = copy(register);
  mapped.fullMvp[0].cases[0].requiredChecks.push({
    action: "exercise second policy path",
    expected: "second observable outcome",
  });
  const report = browser();
  report.suites[0].suites[0].specs[0].title =
    "[F-OUTSTANDING-A] both policy paths";
  const item = mapped.fullMvp[0].cases[0];
  const tokens = item.requiredChecks.map((check, index) => ({
    type: "required-check",
    description: requiredCheckToken(item.id, index + 1, check),
  }));
  for (const test of report.suites[0].suites[0].specs[0].tests)
    test.results[0].annotations = copy(tokens);
  expect(assertFullReleaseJourneys(mapped, report)).toMatchObject({
    passed: 1,
    total: 1,
    executions: 2,
  });
  report.suites[0].suites[0].specs[0].tests[1].results[0].annotations.pop();
  expect(() => assertFullReleaseJourneys(mapped, report)).toThrow(
    /Incomplete required subcases.*mobile/,
  );
});
it("requires ROADMAP-02-A/B/D, ECO-01 to ECO-04, ECO-06-A and BUILD-08-B provisional browser evidence without approving release", () => {
  const ids = [
    "F-ROADMAP-02-A",
    "F-ROADMAP-02-B",
    "F-ROADMAP-02-D",
    "F-ECO-01-A",
    "F-ECO-01-B",
    "F-ECO-01-C",
    "F-ECO-02-A",
    "F-ECO-02-B",
    "F-ECO-02-C",
    "F-ECO-03-A",
    "F-ECO-03-B",
    "F-ECO-03-C",
    "F-ECO-04-A",
    "F-ECO-06-A",
    "F-BUILD-08-B",
  ];
  const cases = proposal.fullMvp.flatMap((family) => family.cases);
  const report = {
    errors: [],
    suites: [
      {
        specs: ids.map((id) => ({
          title: `[${id}] proposed journey`,
          tests: proposal.projects.map((projectName) => ({
            ...execution(projectName),
            results: [
              {
                status: "passed",
                retry: 0,
                annotations: cases
                  .find((item) => item.id === id)
                  .requiredChecks.map((check, index) => ({
                    type: "required-check",
                    description: requiredCheckToken(id, index + 1, check),
                  })),
              },
            ],
          })),
        })),
      },
    ],
  };
  expect(assertProvisionalReleaseJourneys(proposal, report)).toMatchObject({
    approved: false,
    passed: 15,
    total: 15,
    criticalPassed: 9,
    criticalTotal: 9,
    executions: 15 * proposal.projects.length,
  });
  for (const [browserIndex, browserName] of proposal.projects.entries()) {
    for (const [name, corrupt] of [
      ["missing", (annotations) => annotations.pop()],
      ["all missing", (annotations) => annotations.splice(0)],
      ["stale", (annotations) => (annotations[0].description = "stale")],
      ["duplicate", (annotations) => (annotations[1] = { ...annotations[0] })],
    ]) {
      const changed = copy(report);
      corrupt(
        changed.suites[0].specs[0].tests[browserIndex].results[0].annotations,
      );
      expect(
        () => assertProvisionalReleaseJourneys(proposal, changed),
        `${name} marker on ${browserName}`,
      ).toThrow(
        new RegExp(
          `Incomplete required subcases.*F-ROADMAP-02-A.*${browserName}`,
        ),
      );
    }
    const singleCheckMissing = copy(report);
    singleCheckMissing.suites[0].specs[1].tests[
      browserIndex
    ].results[0].annotations = [];
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, singleCheckMissing),
    ).toThrow(
      new RegExp(
        `Incomplete required subcases.*F-ROADMAP-02-B.*${browserName}`,
      ),
    );
    const editorMissing = copy(report);
    editorMissing.suites[0].specs[2].tests[
      browserIndex
    ].results[0].annotations = [];
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, editorMissing),
    ).toThrow(
      new RegExp(
        `Incomplete required subcases.*F-ROADMAP-02-D.*${browserName}`,
      ),
    );
    const foundationMissing = copy(report);
    foundationMissing.suites[0].specs[4].tests[
      browserIndex
    ].results[0].annotations = [];
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, foundationMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-ECO-01-B.*${browserName}`),
    );
    const crossAudienceMissing = copy(report);
    crossAudienceMissing.suites[0].specs[7].tests[
      browserIndex
    ].results[0].annotations.pop();
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, crossAudienceMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-ECO-02-B.*${browserName}`),
    );
    const recoveryMissing = copy(report);
    recoveryMissing.suites[0].specs[11].tests[
      browserIndex
    ].results[0].annotations.pop();
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, recoveryMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-ECO-03-C.*${browserName}`),
    );
    const privacyMissing = copy(report);
    privacyMissing.suites[0].specs[12].tests[
      browserIndex
    ].results[0].annotations.pop();
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, privacyMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-ECO-04-A.*${browserName}`),
    );
    const noncareerMissing = copy(report);
    noncareerMissing.suites[0].specs[13].tests[
      browserIndex
    ].results[0].annotations.pop();
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, noncareerMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-ECO-06-A.*${browserName}`),
    );
    const revocationMissing = copy(report);
    revocationMissing.suites[0].specs[14].tests[
      browserIndex
    ].results[0].annotations.pop();
    expect(() =>
      assertProvisionalReleaseJourneys(proposal, revocationMissing),
    ).toThrow(
      new RegExp(`Incomplete required subcases.*F-BUILD-08-B.*${browserName}`),
    );
  }
  const missing = copy(report);
  missing.suites[0].specs.pop();
  expect(() => assertProvisionalReleaseJourneys(proposal, missing)).toThrow();
  const retried = copy(report);
  retried.suites[0].specs[0].tests[0].results[0].retry = 1;
  expect(() => assertProvisionalReleaseJourneys(proposal, retried)).toThrow();
  const unmapped = copy(report);
  unmapped.suites[0].specs[0].title = "[F-ECO-05-A] wrong journey";
  expect(() => assertProvisionalReleaseJourneys(proposal, unmapped)).toThrow();
  const duplicatedExecution = copy(report);
  duplicatedExecution.suites[0].specs[0].tests.push(
    copy(duplicatedExecution.suites[0].specs[0].tests[0]),
  );
  expect(() =>
    assertProvisionalReleaseJourneys(proposal, duplicatedExecution),
  ).toThrow(/Duplicate scenario\/browser execution/);
  const skipped = copy(report);
  skipped.suites[0].specs[0].tests[0].results[0].status = "skipped";
  expect(() => assertProvisionalReleaseJourneys(proposal, skipped)).toThrow(
    /Failed, skipped, missing or retried/,
  );
  const failed = copy(report);
  failed.suites[0].specs[0].tests[0].status = "unexpected";
  expect(() => assertProvisionalReleaseJourneys(proposal, failed)).toThrow(
    /Failed, skipped, missing or retried/,
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
