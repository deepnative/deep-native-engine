import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  assertUnitResults,
  assertCoverage,
  assertJourneys,
  assertProvisionalReleaseJourneys,
  requireGate,
} from "./quality-gates.mjs";
const root = process.cwd();
const report = {
  scope: "initial-learning-v30",
  startedAt: new Date().toISOString(),
  node: process.version,
  commands: [],
  exitStatus: 1,
};
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  requireGate(result.status === 0, "Cannot identify revision");
  return result.stdout.trim();
};
let admin;
let created = false;
let name;
let provisionalCreated = false;
let provisionalName;
let privateStorageRoot;
// Only code-owned stage names cross the console/report failure boundary.
// Database, parser and filesystem errors can contain credentials or member text.
let stage = "verification artifacts";
const CHILD_OUTPUT_LIMIT = 1024 * 1024;
function childDiagnostics(result) {
  // Only fixed classifications and sizes leave this boundary. In particular,
  // never persist child output, thrown values, or arbitrary error messages.
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}\n${stderr}`;
  const knownSignals = ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT"];
  return {
    stdin: "ignored",
    output: "captured-private",
    maxBufferBytes: CHILD_OUTPUT_LIMIT,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    signal: result.signal
      ? knownSignals.includes(result.signal)
        ? result.signal
        : "other"
      : "none",
    processError:
      result.error?.code === "ENOBUFS"
        ? "output-buffer-limit"
        : result.error
          ? "launcher-error"
          : "none",
    vitestUnhandledErrors:
      /Vitest caught \d+ unhandled errors? during the test run\./.test(output),
    vitestTeardownError:
      /\bEnvironmentTeardownError\b|\[vitest-pool\]: Timeout terminating/.test(
        output,
      ),
    npmErrorBanner: /(?:^|\n)npm (?:error|ERR!)(?:\s|$)/.test(output),
  };
}
function run(command, args, env = process.env) {
  stage = [command, ...args].join(" ");
  const start = new Date().toISOString();
  console.log(`Verification step: ${stage}`);
  // Child output may contain synthetic member data or provider errors. Keep it
  // out of the parent console, including on a failed command or buffer limit.
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: CHILD_OUTPUT_LIMIT,
    env,
  });
  report.commands.push({
    command: [command, ...args].join(" "),
    start,
    exitStatus: result.status,
    child: childDiagnostics(result),
  });
  requireGate(
    result.status === 0,
    `Verification command failed: ${command} ${args.join(" ")}`,
  );
}
function read(name) {
  return JSON.parse(readFileSync(`artifacts/${name}`, "utf8"));
}
function source(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((p) =>
    p.isDirectory() ? source(`${dir}/${p.name}`) : [`${dir}/${p.name}`],
  );
}
try {
  mkdirSync("artifacts", { recursive: true });
  for (const item of [
    "coverage",
    "unit-results.json",
    "integration-results.json",
    "e2e-results.json",
    "e2e-provisional-results.json",
    "application-verification.json",
  ])
    rmSync(`artifacts/${item}`, { recursive: true, force: true });
  stage = "revision identification";
  report.revision = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
  };
  run("node", ["scripts/check-installed-deps.mjs"]);
  run("npm", ["run", "format:check"]);
  run("npm", ["run", "lint"]);
  run("npm", ["run", "typecheck"]);
  run("npm", ["run", "test:unit"]);
  stage = "unit test evidence";
  report.unitTests = assertUnitResults(read("unit-results.json"));
  stage = "unit coverage evidence";
  const files = source("src");
  requireGate(
    files.every((f) => f.endsWith(".ts")),
    "Unmeasured application source",
  );
  report.unitCoverage = assertCoverage(
    read("coverage/coverage-summary.json"),
    files,
    root,
  );
  run("node", ["scripts/gate-probes.mjs"]);
  run("npm", ["run", "build"]);
  stage = "test database configuration";
  const url = new URL(
    process.env.DNE_DATABASE_URL ??
      "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
  );
  requireGate(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.search &&
      !url.hash,
    "Verification requires a loopback database without URL overrides",
  );
  stage = "test database setup";
  admin = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
  });
  admin.on("error", () => {
    report.databaseError = "Test database connection interrupted.";
    report.exitStatus = 1;
    console.error(report.databaseError);
  });
  name = `dne_test_${randomBytes(16).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  const env = { ...process.env, DNE_TEST_DATABASE_URL: url.toString() };
  stage = "private test storage setup";
  privateStorageRoot = mkdtempSync(
    path.join(tmpdir(), "dne-private-evidence-"),
  );
  env.DNE_TEST_PRIVATE_STORAGE_ROOT = privateStorageRoot;
  run("npm", ["run", "test:integration"], env);
  stage = "integration test evidence";
  report.integrationTests = assertUnitResults(read("integration-results.json"));
  run("npm", ["run", "test:e2e"], env);
  stage = "browser journey evidence";
  report.journeys = assertJourneys(
    JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8")),
    read("e2e-results.json"),
  );
  stage = "provisional test database setup";
  provisionalName = `dne_test_${randomBytes(16).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${provisionalName}"`);
  provisionalCreated = true;
  const provisionalUrl = new URL(url);
  provisionalUrl.pathname = `/${provisionalName}`;
  run("npm", ["run", "test:e2e:provisional"], {
    ...env,
    DNE_TEST_DATABASE_URL: provisionalUrl.toString(),
  });
  stage = "provisional full-MVP browser evidence";
  report.provisionalFullMvpEvidence = assertProvisionalReleaseJourneys(
    JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8")),
    read("e2e-provisional-results.json"),
  );
  run("npm", ["audit", "--omit=dev", "--audit-level=high"]);
  report.exitStatus = report.databaseError ? 1 : 0;
} catch {
  report.error = `Verification failed during ${stage}.`;
  console.error("Application verification FAIL:", report.error);
} finally {
  const cleanup = async (action, message) => {
    try {
      await action();
    } catch {
      report.exitStatus = 1;
      (report.cleanupErrors ??= []).push(message);
      console.error(message);
    }
  };
  if (provisionalCreated)
    await cleanup(
      () => admin.query(`DROP DATABASE "${provisionalName}" WITH (FORCE)`),
      "Provisional test database cleanup failed.",
    );
  if (created)
    await cleanup(
      () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`),
      "Test database cleanup failed.",
    );
  if (admin)
    await cleanup(
      () => admin.end(),
      "Test database connection cleanup failed.",
    );
  if (privateStorageRoot)
    await cleanup(
      () => rmSync(privateStorageRoot, { recursive: true, force: true }),
      "Private test storage cleanup failed.",
    );
  report.finishedAt = new Date().toISOString();
  try {
    writeFileSync(
      "artifacts/application-verification.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  } catch {
    report.exitStatus = 1;
    console.error("Application verification report could not be written.");
  }
  process.exitCode = report.exitStatus;
}
