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
  requireGate,
} from "./quality-gates.mjs";
const root = process.cwd();
const report = {
  scope: "initial-learning-v4",
  startedAt: new Date().toISOString(),
  node: process.version,
  commands: [],
  exitStatus: 1,
};
mkdirSync("artifacts", { recursive: true });
for (const item of [
  "coverage",
  "unit-results.json",
  "integration-results.json",
  "e2e-results.json",
  "application-verification.json",
])
  rmSync(`artifacts/${item}`, { recursive: true, force: true });
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  requireGate(result.status === 0, "Cannot identify revision");
  return result.stdout.trim();
};
let admin;
let created = false;
let name;
let privateStorageRoot;
function run(command, args, env = process.env) {
  const start = new Date().toISOString();
  const result = spawnSync(command, args, { stdio: "inherit", env });
  report.commands.push({
    command: [command, ...args].join(" "),
    start,
    exitStatus: result.status,
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
  report.revision = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
  };
  run("npm", ["run", "format:check"]);
  run("npm", ["run", "lint"]);
  run("npm", ["run", "typecheck"]);
  run("npm", ["run", "test:unit"]);
  report.unitTests = assertUnitResults(read("unit-results.json"));
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
  admin = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
  });
  name = `dne_test_${randomBytes(16).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  const env = { ...process.env, DNE_TEST_DATABASE_URL: url.toString() };
  privateStorageRoot = mkdtempSync(
    path.join(tmpdir(), "dne-private-evidence-"),
  );
  env.DNE_TEST_PRIVATE_STORAGE_ROOT = privateStorageRoot;
  run("npm", ["run", "test:integration"], env);
  report.integrationTests = assertUnitResults(read("integration-results.json"));
  run("npm", ["run", "test:e2e"], env);
  report.journeys = assertJourneys(
    JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8")),
    read("e2e-results.json"),
  );
  run("npm", ["audit", "--omit=dev", "--audit-level=high"]);
  report.exitStatus = 0;
} catch (error) {
  report.error = error.message;
  console.error("Application verification FAIL:", error.message);
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } catch {
    report.exitStatus = 1;
    report.cleanupError = "Test database cleanup failed";
  }
  if (admin) await admin.end();
  if (privateStorageRoot)
    rmSync(privateStorageRoot, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(
    "artifacts/application-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.exitCode = report.exitStatus;
}
