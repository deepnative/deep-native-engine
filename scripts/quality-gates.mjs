import path from "node:path";
import { createHash } from "node:crypto";
export function requireGate(value, message) {
  if (!value) throw new Error(message);
}
export function requiredCheckToken(id, index, check) {
  const digest = createHash("sha256")
    .update(JSON.stringify(check))
    .digest("hex");
  return `${id}:${index}:${digest}`;
}
export function assertUnitResults(report) {
  requireGate(
    report.success === true && report.numTotalTests > 0,
    "Missing, empty or failing test run",
  );
  requireGate(
    report.numPassedTests === report.numTotalTests &&
      report.numFailedTests === 0 &&
      report.numPendingTests === 0 &&
      report.numTodoTests === 0,
    "Every required test must pass without skips",
  );
  const cases = report.testResults.flatMap((file) => file.assertionResults);
  requireGate(
    cases.length === report.numTotalTests &&
      cases.every((t) => t.status === "passed"),
    "Incomplete test evidence",
  );
  return { passed: report.numPassedTests, total: report.numTotalTests };
}
export function assertCoverage(report, sourceFiles, root) {
  const names = Object.keys(report)
    .filter((n) => n !== "total")
    .map((n) => path.relative(root, n).split(path.sep).join("/"))
    .sort();
  requireGate(
    sourceFiles.length > 0 &&
      JSON.stringify(names) === JSON.stringify([...sourceFiles].sort()),
    "Coverage must include every application source file, including unimported files",
  );
  for (const [name, metrics] of Object.entries(report)) {
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      const data = metrics[metric];
      requireGate(
        data &&
          Number.isInteger(data.total) &&
          Number.isInteger(data.covered) &&
          data.total >= 0 &&
          data.covered >= 0 &&
          data.covered <= data.total &&
          data.skipped === 0,
        "Malformed coverage counts",
      );
      requireGate(
        data.total > 0 || (name !== "total" && metric === "branches"),
        "Empty coverage denominator",
      );
      requireGate(
        data.total === 0 || data.covered / data.total >= 0.99,
        `${name}: ${metric} below 99%`,
      );
    }
  }
  requireGate(Boolean(report.total), "Missing global coverage");
  for (const metric of ["statements", "branches", "functions", "lines"]) {
    for (const count of ["covered", "total"]) {
      const sum = Object.entries(report)
        .filter(([name]) => name !== "total")
        .reduce((n, [, value]) => n + value[metric][count], 0);
      requireGate(
        sum === report.total[metric][count],
        "Global coverage differs from module counts",
      );
    }
  }
  return report.total;
}
export function assertJourneys(register, report) {
  requireGate(
    register.version &&
      register.fullMvpVersion &&
      register.slice.length > 0 &&
      register.fullMvp.length > 0 &&
      register.projects.length > 0,
    "Empty journey register",
  );
  const ids = register.slice.map((s) => s.id),
    full = register.fullMvp.map((s) => s.id);
  const releaseCases = register.fullMvp.flatMap((s) => s.cases ?? []);
  const releaseIds = releaseCases.map((s) => s.id);
  requireGate(
    new Set(ids).size === ids.length && new Set(full).size === full.length,
    "Duplicate scenario IDs",
  );
  requireGate(
    new Set(releaseIds).size === releaseIds.length,
    "Duplicate full-MVP browser test ID",
  );
  if (register.fullMvpVersion === "full-mvp-v1") {
    // This is a proposed inventory, not approval or evidence of executed tests.
    // Changing its denominator or criticality needs an explicit versioned review.
    const expectedFamilies = [
      ...Array.from(
        { length: 9 },
        (_, i) => `ROADMAP-${String(i + 1).padStart(2, "0")}`,
      ),
      ...Array.from(
        { length: 10 },
        (_, i) => `BUILD-${String(i + 1).padStart(2, "0")}`,
      ),
      ...Array.from(
        { length: 8 },
        (_, i) => `ECO-${String(i + 1).padStart(2, "0")}`,
      ),
    ];
    const expectedCases = expectedFamilies.flatMap((id) =>
      [...(id.startsWith("ECO-") ? "ABC" : "ABCD")].map(
        (letter) => `F-${id}-${letter}`,
      ),
    );
    const sameIds = (actual, expected) =>
      JSON.stringify([...actual].sort()) ===
      JSON.stringify([...expected].sort());
    requireGate(
      sameIds(full, expectedFamilies) && sameIds(releaseIds, expectedCases),
      "Changed proposed full-MVP family or case inventory",
    );
    requireGate(
      register.fullMvp.every(
        (family) =>
          family.critical === !["ECO-02", "ECO-03"].includes(family.id) &&
          family.cases.every((test) => test.critical === family.critical),
      ),
      "Changed proposed full-MVP criticality",
    );
  }
  requireGate(
    register.fullMvp.every(
      (s) =>
        s.source &&
        s.requirement &&
        s.actor &&
        s.preconditions &&
        s.steps &&
        s.expected &&
        s.risk &&
        Array.isArray(s.cases) &&
        s.cases.length > 0 &&
        s.cases.every(
          (test) =>
            test.id?.startsWith(`F-${s.id}-`) &&
            test.steps &&
            test.expected &&
            Array.isArray(test.requiredChecks) &&
            test.requiredChecks.length > 0 &&
            test.requiredChecks.every(
              (check) =>
                typeof check.action === "string" &&
                check.action.trim().length > 0 &&
                typeof check.expected === "string" &&
                check.expected.trim().length > 0,
            ) &&
            new Set(test.requiredChecks.map((check) => JSON.stringify(check)))
              .size === test.requiredChecks.length &&
            typeof test.critical === "boolean" &&
            (!s.critical || test.critical),
        ) &&
        Array.isArray(s.issues) &&
        s.issues.length > 0 &&
        s.issues.every((id) => Number.isSafeInteger(id) && id > 0) &&
        typeof s.critical === "boolean",
    ),
    "Incomplete full-MVP journey definition",
  );
  requireGate(
    register.fullMvp.every((s) => s.status === "outstanding"),
    "Unverified full-MVP completion claim",
  );
  requireGate(
    new Set(register.projects).size === register.projects.length,
    "Duplicate browser projects",
  );
  requireGate(
    register.slice.every(
      (s) =>
        s.actor &&
        s.preconditions &&
        s.steps &&
        s.expected &&
        s.issues.length &&
        typeof s.critical === "boolean",
    ),
    "Incomplete journey definition",
  );
  const observed = new Map();
  let count = 0;
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      const match = spec.title.match(/^\[([A-Z0-9-]+)\]/);
      requireGate(match && ids.includes(match[1]), "Unmapped browser scenario");
      for (const result of spec.tests) {
        requireGate(
          register.projects.includes(result.projectName),
          "Unexpected browser project",
        );
        const key = `${match[1]}:${result.projectName}`;
        requireGate(!observed.has(key), "Duplicate scenario/browser execution");
        requireGate(
          result.expectedStatus === "passed" &&
            result.status === "expected" &&
            result.results.length === 1 &&
            result.results[0].status === "passed" &&
            result.results[0].retry === 0,
          "Failed, skipped, missing or retried browser test",
        );
        observed.set(key, true);
        count++;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  requireGate(
    Array.isArray(report.suites) &&
      Array.isArray(report.errors) &&
      report.errors.length === 0,
    "Missing or failed browser report",
  );
  report.suites.forEach(visit);
  const covered = ids.filter((id) =>
    register.projects.every((project) => observed.has(`${id}:${project}`)),
  );
  const missing = ids.filter((id) => !covered.includes(id));
  const critical = register.slice.filter((s) => s.critical);
  requireGate(
    critical.every((s) => covered.includes(s.id)),
    "Uncovered critical journey",
  );
  requireGate(
    covered.length / ids.length >= 0.99,
    "Journey coverage below 99%",
  );
  requireGate(
    count === ids.length * register.projects.length,
    "Missing browser matrix execution",
  );
  // Full-MVP journeys are intentionally separate; this slice has not satisfied them.
  return {
    register: register.version,
    scope: register.scope,
    passed: covered.length,
    total: ids.length,
    criticalPassed: critical.length,
    criticalTotal: critical.length,
    executions: count,
    uncovered: missing,
    fullMvp: {
      register: register.fullMvpVersion,
      families: full.length,
      passed: 0,
      total: releaseIds.length,
      criticalPassed: 0,
      criticalTotal: releaseCases.filter((s) => s.critical).length,
      uncovered: releaseIds,
    },
  };
}

function assertRequiredCheckEvidence(register, report) {
  const requiredById = new Map(
    register.fullMvp.flatMap((family) =>
      family.cases.map((test) => [
        test.id,
        test.requiredChecks.map((check, index) =>
          requiredCheckToken(test.id, index + 1, check),
        ),
      ]),
    ),
  );
  function checkEvidence(suite) {
    for (const spec of suite.specs ?? []) {
      const id = /^\[([A-Z0-9-]+)\]/.exec(spec.title)?.[1];
      const required = requiredById.get(id);
      requireGate(required, "Unmapped required-check evidence");
      for (const test of spec.tests) {
        const observed = (test.results[0].annotations ?? [])
          .filter((annotation) => annotation.type === "required-check")
          .map((annotation) => annotation.description);
        requireGate(
          observed.length === required.length &&
            JSON.stringify([...observed].sort()) ===
              JSON.stringify([...required].sort()),
          `Incomplete required subcases for ${id} on ${test.projectName}`,
        );
      }
    }
    for (const child of suite.suites ?? []) checkEvidence(child);
  }
  report.suites.forEach(checkEvidence);
}

// Run this gate on the full release browser report when the full MVP exists.
// The local-slice gate keeps its own denominator and reports these rows as
// outstanding; passing the local slice never promotes a release journey.
export function assertFullReleaseJourneys(register, report) {
  const release = assertJourneys(
    {
      ...register,
      scope: "full-MVP",
      slice: register.fullMvp.flatMap((scenario) =>
        scenario.cases.map((test) => ({
          id: test.id,
          actor: scenario.actor,
          preconditions: scenario.preconditions,
          steps: test.steps,
          expected: test.expected,
          issues: scenario.issues,
          critical: test.critical,
        })),
      ),
    },
    report,
  );
  assertRequiredCheckEvidence(register, report);
  return {
    register: register.fullMvpVersion,
    scope: release.scope,
    passed: release.passed,
    total: release.total,
    criticalPassed: release.criticalPassed,
    criticalTotal: release.criticalTotal,
    executions: release.executions,
    uncovered: release.uncovered,
  };
}

// This is executable evidence for a bounded part of the approved mapping.
// It cannot approve the denominator or satisfy the full-release gate.
export function assertProvisionalReleaseJourneys(register, report) {
  const ids = [
    "F-ROADMAP-02-A",
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
  ];
  const cases = register.fullMvp.flatMap((family) =>
    family.cases.map((test) => ({
      id: test.id,
      actor: family.actor,
      preconditions: family.preconditions,
      steps: test.steps,
      expected: test.expected,
      issues: family.issues,
      critical: test.critical,
    })),
  );
  requireGate(
    ids.every((id) => cases.some((test) => test.id === id)),
    "Missing proposed provisional browser ID",
  );
  const result = assertJourneys(
    {
      ...register,
      scope: "provisional-full-MVP-tranche",
      slice: cases.filter((test) => ids.includes(test.id)),
    },
    report,
  );
  assertRequiredCheckEvidence(register, report);
  return {
    register: register.fullMvpVersion,
    scope: result.scope,
    approved: false,
    passed: result.passed,
    total: result.total,
    criticalPassed: result.criticalPassed,
    criticalTotal: result.criticalTotal,
    executions: result.executions,
    uncovered: result.uncovered,
  };
}
