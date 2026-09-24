import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertFullReleaseJourneys, requireGate } from "./quality-gates.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const commitPattern = /^[a-f0-9]{40}$/;
const runPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function releaseMappingDigest(register) {
  return sha256(
    JSON.stringify({
      version: register.fullMvpVersion,
      projects: register.projects,
      fullMvp: register.fullMvp,
    }),
  );
}

export function assertMappingApproval(register, approval) {
  requireGate(
    approval?.status === "approved" &&
      approval.version === register.fullMvpVersion &&
      typeof approval.reviewer === "string" &&
      approval.reviewer.trim().length >= 3 &&
      /^https:\/\/github\.com\/deepnative\/deep-native-engine\/issues\/94#issuecomment-\d+$/.test(
        approval.decisionUrl,
      ) &&
      typeof approval.decidedAt === "string" &&
      !Number.isNaN(Date.parse(approval.decidedAt)),
    "Full-MVP mapping approval missing or incomplete",
  );
  const digest = releaseMappingDigest(register);
  requireGate(
    approval.sha256 === digest,
    "Full-MVP mapping digest changed after approval",
  );
  return digest;
}

function traceEvidence(report, traceRoot) {
  const root = realpathSync(traceRoot);
  requireGate(lstatSync(root).isDirectory(), "Full-release trace root missing");
  const traces = [];
  const seen = new Set();
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      const id = /^\[([A-Z0-9-]+)\]/.exec(spec.title)?.[1];
      for (const test of spec.tests ?? []) {
        const attachments = test.results?.[0]?.attachments;
        const trace = attachments?.filter(
          (item) =>
            item.name === "trace" && item.contentType === "application/zip",
        );
        requireGate(
          trace?.length === 1,
          "Full-release trace missing or duplicated",
        );
        const location = trace[0].path;
        requireGate(
          typeof location === "string" && path.isAbsolute(location),
          "Full-release trace location missing",
        );
        let actual;
        try {
          requireGate(
            !lstatSync(location).isSymbolicLink(),
            "Full-release trace link is unsafe",
          );
          actual = realpathSync(location);
          requireGate(
            actual.startsWith(root + path.sep) && !seen.has(actual),
            "Full-release trace is outside the run or duplicated",
          );
          seen.add(actual);
        } catch {
          throw new Error("Full-release trace missing or unsafe");
        }
        const bytes = readFileSync(actual);
        requireGate(
          bytes.length > 22 &&
            bytes.subarray(0, 4).equals(Buffer.from("PK\x03\x04")),
          "Full-release trace archive is empty or invalid",
        );
        traces.push({
          scenario: id,
          project: test.projectName,
          sha256: sha256(bytes),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  report.suites.forEach(visit);
  return traces.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.project.localeCompare(b.project),
  );
}

export function assertReleaseEvidence({
  register,
  approval,
  report,
  reportBytes,
  traceRoot,
  revision,
  runId,
  startedAt,
  finishedAt,
}) {
  const approvalSha256 = assertMappingApproval(register, approval);
  requireGate(
    commitPattern.test(revision?.commit) &&
      commitPattern.test(revision?.tree) &&
      revision.dirty === false &&
      runPattern.test(runId) &&
      Number.isFinite(Date.parse(startedAt)) &&
      Number.isFinite(Date.parse(finishedAt)) &&
      Date.parse(finishedAt) >= Date.parse(startedAt),
    "Full-release run or clean revision identity missing",
  );
  requireGate(
    Buffer.isBuffer(reportBytes) &&
      JSON.stringify(JSON.parse(reportBytes)) === JSON.stringify(report),
    "Full-release browser report differs from captured bytes",
  );
  const config = report?.config;
  requireGate(
    config?.forbidOnly === true &&
      typeof config.version === "string" &&
      config.version.length > 0 &&
      config.metadata?.release?.commit === revision.commit &&
      config.metadata.release.tree === revision.tree &&
      config.metadata.release.runId === runId &&
      config.metadata.release.dirty === false &&
      Array.isArray(config.projects) &&
      config.projects.length === register.projects.length &&
      register.projects.every((name) =>
        config.projects.some(
          (project) =>
            project.name === name &&
            project.retries === 0 &&
            project.repeatEach === 1,
        ),
      ),
    "Full-release browser run does not match revision or required configuration",
  );
  const release = assertFullReleaseJourneys(register, report);
  const stats = report.stats;
  requireGate(
    stats?.expected === release.executions &&
      stats.skipped === 0 &&
      stats.unexpected === 0 &&
      stats.flaky === 0 &&
      Number.isFinite(Date.parse(stats.startTime)) &&
      Date.parse(stats.startTime) >= Date.parse(startedAt) &&
      Date.parse(stats.startTime) <= Date.parse(finishedAt),
    "Full-release browser summary is incomplete or outside this run",
  );
  const traces = traceEvidence(report, traceRoot);
  requireGate(
    traces.length === release.executions,
    "Full-release browser executions lack traces",
  );
  return {
    ...release,
    approvalSha256,
    browserReportSha256: sha256(reportBytes),
    browserVersion: config.version,
    runId,
    revision,
    traces,
  };
}
