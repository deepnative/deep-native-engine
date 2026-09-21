import path from "node:path";
export function requireGate(value, message) {
  if (!value) throw new Error(message);
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
      register.slice.length > 0 &&
      register.fullMvp.length > 0 &&
      register.projects.length > 0,
    "Empty journey register",
  );
  const ids = register.slice.map((s) => s.id),
    full = register.fullMvp.map((s) => s.id);
  requireGate(
    new Set(ids).size === ids.length && new Set(full).size === full.length,
    "Duplicate scenario IDs",
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
    fullMvp: { passed: 0, total: full.length, uncovered: full },
  };
}
