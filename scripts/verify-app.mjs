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
  assertCrossBrowserJourney,
  assertProvisionalReleaseJourneys,
  requireGate,
} from "./quality-gates.mjs";
const root = process.cwd();
const report = {
  scope: "initial-learning-v35",
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
const signatureValues = {
  kind: [
    "unhandled-rejection",
    "uncaught-exception",
    "unhandled-error",
    "other",
  ],
  name: [
    "type-error",
    "error",
    "aggregate-error",
    "database-error",
    "timeout-error",
    "environment-teardown-error",
    "other",
  ],
  code: [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "57P01",
    "53300",
    "other",
  ],
  testFile: [
    "availability.test.ts",
    "ledger-migration.test.ts",
    "ledger.test.ts",
    "member-deletion.test.ts",
    "member-export.test.ts",
    "restore.test.ts",
    "slot-holds.test.ts",
    "store.test.ts",
    "other",
  ],
  firstFrame: [
    "integration-test",
    "test-support",
    "application",
    "dependency",
    "node-runtime",
    "other",
  ],
};
function integrationUnhandled() {
  try {
    const value = read("integration-unhandled.json");
    const expectedTruncated = value.count > 3;
    if (
      value.schema !== "integration-unhandled-v1" ||
      !Number.isInteger(value.count) ||
      value.count < 0 ||
      value.count > 99 ||
      typeof value.truncated !== "boolean" ||
      !Array.isArray(value.signatures) ||
      value.signatures.length > 3 ||
      value.signatures.length !== Math.min(value.count, 3) ||
      value.truncated !== expectedTruncated
    )
      return "unavailable";
    const signatures = value.signatures.map((candidate) => {
      const entry = {};
      for (const [key, allowed] of Object.entries(signatureValues)) {
        if (!allowed.includes(candidate?.[key])) return null;
        entry[key] = candidate[key];
      }
      return entry;
    });
    if (signatures.includes(null)) return "unavailable";
    return { count: value.count, truncated: value.truncated, signatures };
  } catch {
    return "unavailable";
  }
}
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
  const child = childDiagnostics(result);
  if (command === "npm" && args[0] === "run" && args[1] === "test:integration")
    child.integrationUnhandled = integrationUnhandled();
  report.commands.push({
    command: [command, ...args].join(" "),
    start,
    exitStatus: result.status,
    child,
  });
  if (
    command === "npm" &&
    args[0] === "run" &&
    args[1] === "test:integration"
  ) {
    requireGate(
      child.integrationUnhandled !== "unavailable",
      "Integration diagnostic report missing or invalid",
    );
    requireGate(
      child.integrationUnhandled.count === 0 || result.status !== 0,
      "Integration unhandled errors were reported despite a zero child exit",
    );
  }
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
    "integration-unhandled.json",
    "e2e-results.json",
    "e2e-cross-browser-results.json",
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
  const files = [
    ...source("src"),
    ...source("public").filter((file) => file.endsWith(".js")),
  ];
  requireGate(
    files.every((f) => f.endsWith(".ts") || f.endsWith(".js")),
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
  run("npm", ["run", "test:e2e:cross-browser"], env);
  stage = "local cross-browser keyboard journey evidence";
  report.crossBrowserKeyboardJourney = assertCrossBrowserJourney(
    JSON.parse(readFileSync("tests/e2e/cross-browser-scenarios.json", "utf8")),
    JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8")),
    read("e2e-cross-browser-results.json"),
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
