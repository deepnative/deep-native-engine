import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import {
  assertMappingApproval,
  assertReleaseEvidence,
} from "./full-release-evidence.mjs";
import { requireGate } from "./quality-gates.mjs";

const output = "artifacts/full-release-verification.json";
const browserOutput = "artifacts/e2e-full-results.json";
const traceRoot = "artifacts/browser-full-results";
const result = {
  scope: "full-MVP",
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  commands: [],
  exitStatus: 1,
};
let stage = "input contract";
let admin;
let created = false;
let databaseName;
let storageRoot;

function git(...args) {
  const command = spawnSync("git", args, { encoding: "utf8" });
  requireGate(command.status === 0, "Cannot identify release revision");
  return command.stdout.trim();
}
function run(command, args, env = process.env) {
  stage = `${command} ${args.join(" ")}`;
  const commandResult = spawnSync(command, args, { stdio: "inherit", env });
  result.commands.push({ command: stage, exitStatus: commandResult.status });
  requireGate(
    commandResult.status === 0,
    "Required full-release command failed",
  );
}
function revision() {
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
  };
}

try {
  mkdirSync("artifacts", { recursive: true });
  rmSync(output, { force: true });
  rmSync(browserOutput, { force: true });
  rmSync(traceRoot, { recursive: true, force: true });
  requireGate(
    process.argv.length === 2,
    "Full-release verification runs its own browser suite; report arguments are not accepted",
  );
  stage = "mapping approval";
  const register = JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8"));
  const approval = JSON.parse(
    readFileSync("tests/e2e/full-mvp-approval.json", "utf8"),
  );
  requireGate(
    register.fullMvpVersion === "full-mvp-v1",
    "Full-MVP proposal version changed without gate review",
  );
  assertMappingApproval(register, approval);

  stage = "clean revision";
  result.revision = revision();
  requireGate(!result.revision.dirty, "Full-release checkout must be clean");
  result.runId = randomUUID();
  run("node", ["scripts/check-installed-deps.mjs"]);

  stage = "isolated test database";
  const url = new URL(
    process.env.DNE_DATABASE_URL ??
      "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
  );
  requireGate(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.search &&
      !url.hash,
    "Full-release verification requires a loopback database",
  );
  admin = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
  });
  admin.on("error", () => {
    result.databaseError = "Release test database connection interrupted.";
    result.exitStatus = 1;
  });
  databaseName = `dne_test_${randomBytes(16).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const version = await admin.query("SHOW server_version");
  result.postgresVersion = version.rows[0].server_version;
  url.pathname = `/${databaseName}`;
  storageRoot = mkdtempSync(path.join(tmpdir(), "dne-full-release-"));
  const env = {
    ...process.env,
    DNE_TEST_DATABASE_URL: url.toString(),
    DNE_TEST_PRIVATE_STORAGE_ROOT: storageRoot,
    DNE_FULL_RELEASE_RUN_ID: result.runId,
    DNE_FULL_RELEASE_COMMIT: result.revision.commit,
    DNE_FULL_RELEASE_TREE: result.revision.tree,
  };

  run("npm", ["run", "build"], env);
  run("npm", ["run", "test:e2e:full"], env);
  const browserFinishedAt = new Date().toISOString();
  stage = "full browser evidence";
  const reportBytes = readFileSync(browserOutput);
  const report = JSON.parse(reportBytes);
  const after = revision();
  requireGate(
    after.commit === result.revision.commit &&
      after.tree === result.revision.tree &&
      !after.dirty,
    "Full-release source changed during browser execution",
  );
  Object.assign(
    result,
    assertReleaseEvidence({
      register,
      approval,
      report,
      reportBytes,
      traceRoot,
      revision: after,
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: browserFinishedAt,
    }),
  );
  result.exitStatus = result.databaseError ? 1 : 0;
} catch {
  result.error = `Full-release verification failed during ${stage}.`;
  console.error(result.error);
} finally {
  const cleanup = async (action, message) => {
    try {
      await action();
    } catch {
      result.exitStatus = 1;
      (result.cleanupErrors ??= []).push(message);
      console.error(message);
    }
  };
  if (created)
    await cleanup(
      () => admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`),
      "Release test database cleanup failed.",
    );
  if (admin)
    await cleanup(
      () => admin.end(),
      "Release database connection cleanup failed.",
    );
  if (storageRoot)
    await cleanup(
      () => rmSync(storageRoot, { recursive: true, force: true }),
      "Release private storage cleanup failed.",
    );
  result.finishedAt = new Date().toISOString();
  try {
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    result.exitStatus = 1;
    console.error("Full-release verification report could not be written.");
  }
  process.exitCode = result.exitStatus;
}
