import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertMappingApproval,
  assertReleaseEvidence,
  releaseMappingDigest,
} from "../../scripts/full-release-evidence.mjs";
import { requiredCheckToken } from "../../scripts/quality-gates.mjs";

// One-case synthetic validator fixtures exercise the contract. They are not
// browser runs and cannot approve the repository's 100-case register.
const register = {
  version: "local-v1",
  fullMvpVersion: "fixture-v1",
  scope: "synthetic-validator-fixture",
  projects: ["desktop", "mobile"],
  slice: [
    {
      id: "LOCAL-A",
      actor: "member",
      preconditions: "new",
      steps: "learn",
      expected: "saved",
      issues: [94],
      critical: true,
    },
  ],
  fullMvp: [
    {
      id: "FIXTURE-01",
      source: "fixture",
      requirement: "one synthetic test obligation",
      actor: "member",
      preconditions: "synthetic",
      steps: "exercise",
      expected: "observable",
      issues: [94],
      risk: "test-only",
      status: "outstanding",
      critical: true,
      cases: [
        {
          id: "F-FIXTURE-01-A",
          steps: "exercise synthetic path",
          expected: "observe result",
          requiredChecks: [
            { action: "exercise synthetic path", expected: "observe result" },
          ],
          critical: true,
        },
      ],
    },
  ],
};
const proposal = JSON.parse(
  readFileSync(new URL("../e2e/scenarios.json", import.meta.url), "utf8"),
);
const trackedApproval = JSON.parse(
  readFileSync(
    new URL("../e2e/full-mvp-approval.json", import.meta.url),
    "utf8",
  ),
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const revision = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  dirty: false,
};
const runId = "88e2f18f-8545-440e-a298-cdff7bc97aaf";
const startedAt = "2026-09-24T16:00:00.000Z";
const finishedAt = "2026-09-24T16:00:20.000Z";
const approval = () => ({
  status: "approved",
  version: register.fullMvpVersion,
  sha256: releaseMappingDigest(register),
  reviewer: "independent-reviewer",
  decisionUrl:
    "https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-123456789",
  decidedAt: "2026-09-24T15:00:00.000Z",
});
let directory;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
function evidence() {
  directory = mkdtempSync(path.join(tmpdir(), "dne-release-test-"));
  const traceRoot = path.join(directory, "traces");
  mkdirSync(traceRoot);
  const tests = register.projects.map((projectName) => {
    const file = path.join(traceRoot, `${projectName}.zip`);
    writeFileSync(
      file,
      Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(32)]),
    );
    return {
      projectName,
      expectedStatus: "passed",
      status: "expected",
      results: [
        {
          retry: 0,
          status: "passed",
          annotations: [
            {
              type: "required-check",
              description: requiredCheckToken(
                "F-FIXTURE-01-A",
                1,
                register.fullMvp[0].cases[0].requiredChecks[0],
              ),
            },
          ],
          attachments: [
            { name: "trace", contentType: "application/zip", path: file },
          ],
        },
      ],
    };
  });
  const report = {
    config: {
      forbidOnly: true,
      projects: register.projects.map((name) => ({
        name,
        retries: 0,
        repeatEach: 1,
      })),
      metadata: { release: { ...revision, runId } },
      version: "1.63.0",
    },
    stats: {
      startTime: "2026-09-24T16:00:01.000Z",
      expected: 2,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    },
    errors: [],
    suites: [{ specs: [{ title: "[F-FIXTURE-01-A] synthetic", tests }] }],
  };
  const reportPath = path.join(directory, "browser.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const inputs = {
    register,
    approval: approval(),
    report,
    reportBytes: readFileSync(reportPath),
    traceRoot,
    revision,
    runId,
    startedAt,
    finishedAt,
  };
  return { inputs, reportPath };
}

it("requires a separate reviewed mapping decision bound to every case and browser", () => {
  expect(() => assertMappingApproval(register, undefined)).toThrow(/approval/);
  expect(() =>
    assertMappingApproval(register, { ...approval(), status: "pending" }),
  ).toThrow(/approval/);
  expect(assertMappingApproval(register, approval())).toBe(approval().sha256);
  for (const change of [
    (r) => (r.fullMvp[0].cases[0].expected = "weaker result"),
    (r) => (r.fullMvp[0].cases[0].requiredChecks[0].expected = "weaker check"),
    (r) => (r.fullMvp[0].requirement = "changed source obligation"),
    (r) => (r.projects[0] = "different browser"),
    (r) => (r.fullMvp[0].cases[0].critical = false),
  ]) {
    const changed = clone(register);
    change(changed);
    expect(() => assertMappingApproval(changed, approval())).toThrow(/digest/);
  }
  for (const invalid of [
    { ...approval(), reviewer: "" },
    { ...approval(), decisionUrl: "https://example.com/fake" },
    { ...approval(), decidedAt: "not-a-date" },
    { ...approval(), version: "different-version" },
  ])
    expect(() => assertMappingApproval(register, invalid)).toThrow();
});
it("binds the tracked mapping approval to the independent technical decision", () => {
  expect(trackedApproval).toEqual({
    status: "approved",
    version: "full-mvp-v1",
    sha256: "581083999c08f794b3814470a2e2a708f3708ff0ea6dd9785999ce5a1bdf3a45",
    reviewer:
      "Codex dne-reviewer /root/qa002_corrected_mapping_review (GPT-6 Astra/high)",
    decisionUrl:
      "https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-5820945526",
    decidedAt: "2026-09-24T19:39:31Z",
  });
  expect(assertMappingApproval(proposal, trackedApproval)).toBe(
    trackedApproval.sha256,
  );
  expect(() =>
    assertMappingApproval(proposal, {
      ...trackedApproval,
      sha256:
        "0345855e5b331e2be1a4403a27f6af0128e0a1c3b83f9d50abaaef7bc623be81",
    }),
  ).toThrow(/digest/);
});
it("rejects preceding mapping digests and every post-approval check change", () => {
  // The prior published proposal fingerprint cannot approve this correction.
  const oldApproval = {
    ...approval(),
    version: proposal.fullMvpVersion,
    sha256: "14963de159ede2a79d43b963d0d7c974fc124538c7738ea1c36933fb90850631",
  };
  for (const digest of [
    oldApproval.sha256,
    "0345855e5b331e2be1a4403a27f6af0128e0a1c3b83f9d50abaaef7bc623be81",
  ]) {
    expect(() =>
      assertMappingApproval(proposal, { ...oldApproval, sha256: digest }),
    ).toThrow(/digest/);
  }
  const newApproval = {
    ...oldApproval,
    sha256: releaseMappingDigest(proposal),
  };
  expect(assertMappingApproval(proposal, newApproval)).toBe(newApproval.sha256);
  for (const [id, firstNewCheck] of [
    ["F-ROADMAP-01-B", 2],
    ["F-ROADMAP-09-D", 4],
    ["F-ECO-04-B", 2],
  ]) {
    const original = proposal.fullMvp
      .flatMap((family) => family.cases)
      .find((test) => test.id === id);
    for (
      let index = firstNewCheck;
      index < original.requiredChecks.length;
      index++
    ) {
      const changed = clone(proposal);
      const item = changed.fullMvp
        .flatMap((family) => family.cases)
        .find((test) => test.id === id);
      item.requiredChecks[index].expected = "weaker assertion";
      expect(() => assertMappingApproval(changed, newApproval)).toThrow(
        /digest/,
      );
    }
  }
});

it("binds a passing synthetic fixture to its run, revision, report and traces", () => {
  const { inputs } = evidence();
  const result = assertReleaseEvidence(inputs);
  expect(result).toMatchObject({
    register: "fixture-v1",
    passed: 1,
    total: 1,
    criticalPassed: 1,
    executions: 2,
    runId,
    revision,
    browserReportSha256: sha256(inputs.reportBytes),
  });
  expect(result.traces).toHaveLength(2);
  expect(result.traces[0].sha256).toHaveLength(64);
  expect(result.approvalSha256).toBe(approval().sha256);
});

it("rejects stale, dirty, mismatched or missing source and browser-run identities", () => {
  const { inputs } = evidence();
  for (const changed of [
    { ...inputs, approval: undefined },
    { ...inputs, revision: { ...revision, dirty: true } },
    { ...inputs, revision: { ...revision, commit: "0".repeat(40) } },
    { ...inputs, revision: { ...revision, tree: "0".repeat(40) } },
    { ...inputs, runId: "18e2f18f-8545-440e-a298-cdff7bc97aaf" },
    { ...inputs, reportBytes: Buffer.from("different report") },
    { ...inputs, startedAt: "2026-09-24T16:00:05.000Z" },
  ])
    expect(() => assertReleaseEvidence(changed)).toThrow();
  const changed = clone(inputs.report);
  changed.config.metadata.release.dirty = true;
  expect(() =>
    assertReleaseEvidence({
      ...inputs,
      report: changed,
      reportBytes: Buffer.from(JSON.stringify(changed)),
    }),
  ).toThrow();
});

it("rejects absent or mismatched trace artifacts and incomplete results", () => {
  const { inputs } = evidence();
  const missing = clone(inputs.report);
  missing.suites[0].specs[0].tests[0].results[0].attachments = [];
  expect(() =>
    assertReleaseEvidence({
      ...inputs,
      report: missing,
      reportBytes: Buffer.from(JSON.stringify(missing)),
    }),
  ).toThrow(/trace/);
  const wrong = clone(inputs.report);
  wrong.suites[0].specs[0].tests[0].results[0].attachments[0].path = path.join(
    directory,
    "browser.json",
  );
  expect(() =>
    assertReleaseEvidence({
      ...inputs,
      report: wrong,
      reportBytes: Buffer.from(JSON.stringify(wrong)),
    }),
  ).toThrow(/trace/);
  writeFileSync(
    path.join(inputs.traceRoot, "mobile.zip"),
    "not a trace archive",
  );
  expect(() => assertReleaseEvidence(inputs)).toThrow(/trace/);
  rmSync(path.join(inputs.traceRoot, "mobile.zip"));
  expect(() => assertReleaseEvidence(inputs)).toThrow(/trace/);
});

it("preserves failed, skipped, retried and partial browser rejection", () => {
  const { inputs } = evidence();
  for (const mutate of [
    (r) => r.suites[0].specs[0].tests.pop(),
    (r) => (r.suites[0].specs[0].tests[0].status = "unexpected"),
    (r) => (r.suites[0].specs[0].tests[0].results[0].retry = 1),
    (r) => (r.stats.skipped = 1),
  ]) {
    const changed = clone(inputs.report);
    mutate(changed);
    expect(() =>
      assertReleaseEvidence({
        ...inputs,
        report: changed,
        reportBytes: Buffer.from(JSON.stringify(changed)),
      }),
    ).toThrow();
  }
});
