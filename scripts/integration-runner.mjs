import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { dropAttendanceBrowserDatabase } from "../tests/support/attendance-browser-database.ts";
import { requireGate } from "./quality-gates.mjs";

export function testLaneCount(cpus = availableParallelism()) {
  return cpus >= 12 ? 8 : 4;
}
const LANES = Array.from({ length: testLaneCount() }, (_, index) => index + 1);

const LIMIT = 1024 * 1024;
const signatures = {
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

export function integrationFiles(root) {
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      requireGate(!entry.isSymbolicLink(), "Unsafe integration source entry");
      const name = path.join(directory, entry.name);
      return entry.isDirectory()
        ? walk(name)
        : entry.isFile() && name.endsWith(".test.ts")
          ? [path.resolve(name)]
          : [];
    });
  const files = walk(path.join(root, "tests/integration")).sort();
  requireGate(files.length >= 2, "Integration file inventory missing or empty");
  return files;
}

export function mergeUnhandled(reports) {
  let count = 0;
  const entries = [];
  for (const value of reports) {
    requireGate(
      value?.schema === "integration-unhandled-v1" &&
        Number.isInteger(value.count) &&
        value.count >= 0 &&
        value.count <= 99 &&
        value.truncated === value.count > 3 &&
        Array.isArray(value.signatures) &&
        value.signatures.length === Math.min(value.count, 3),
      "Integration lane diagnostics missing or invalid",
    );
    count += value.count;
    for (const candidate of value.signatures) {
      const safe = {};
      for (const [key, allowed] of Object.entries(signatures)) {
        requireGate(
          allowed.includes(candidate?.[key]),
          "Integration lane diagnostic signature invalid",
        );
        safe[key] = candidate[key];
      }
      entries.push(safe);
    }
  }
  requireGate(
    reports.length === LANES.length,
    "All integration lane diagnostics required",
  );
  return {
    schema: "integration-unhandled-v1",
    count: Math.min(count, 99),
    truncated: count > 3,
    signatures: entries.slice(0, 3),
  };
}

export function mergeIntegrationReports(expectedFiles, lanes) {
  requireGate(
    lanes.length === LANES.length &&
      new Set(lanes.map((lane) => lane.index)).size === LANES.length &&
      lanes.every((lane) => LANES.includes(lane.index)),
    "Complete distinct integration lanes required",
  );
  const unhandled = mergeUnhandled(lanes.map((lane) => lane.unhandled));
  requireGate(unhandled.count === 0, "Integration lane unhandled errors");
  const expected = new Set(expectedFiles);
  requireGate(
    expected.size === expectedFiles.length && expected.size > 0,
    "Invalid integration file inventory",
  );
  const seen = new Set();
  const result = { success: true, startTime: Infinity, testResults: [] };
  const fields = [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ];
  for (const field of fields) result[field] = 0;
  const snapshot = {};
  for (const lane of lanes) {
    const child = lane.child;
    requireGate(
      child?.exitStatus === 0 &&
        child.signal === "none" &&
        child.processError === "none" &&
        child.outputBufferExceeded === false &&
        child.vitestUnhandledErrors === false &&
        child.vitestTeardownError === false &&
        child.npmErrorBanner === false,
      "Integration lane process failed",
    );
    const report = lane.report;
    requireGate(
      report?.success === true &&
        Array.isArray(report.testResults) &&
        report.testResults.length > 0 &&
        Number.isFinite(report.startTime),
      "Integration lane report missing or failing",
    );
    for (const field of fields) {
      requireGate(
        Number.isInteger(report[field]) && report[field] >= 0,
        "Invalid integration lane counts",
      );
      result[field] += report[field];
    }
    requireGate(
      report.numTotalTests > 0 &&
        report.numPassedTests === report.numTotalTests &&
        report.numFailedTests === 0 &&
        report.numPendingTests === 0 &&
        report.numTodoTests === 0 &&
        report.numFailedTestSuites === 0 &&
        report.numPendingTestSuites === 0 &&
        report.numPassedTestSuites === report.numTotalTestSuites,
      "Every integration lane test must pass without skips",
    );
    let assertions = 0;
    for (const file of report.testResults) {
      requireGate(
        typeof file.name === "string" &&
          path.isAbsolute(file.name) &&
          expected.has(file.name) &&
          !seen.has(file.name),
        "Missing, duplicate or foreign integration file evidence",
      );
      requireGate(
        file.status === "passed" &&
          Array.isArray(file.assertionResults) &&
          file.assertionResults.length > 0,
        "Integration file evidence missing or failed",
      );
      seen.add(file.name);
      for (const test of file.assertionResults) {
        requireGate(
          test.status === "passed" &&
            Array.isArray(test.failureMessages) &&
            test.failureMessages.length === 0 &&
            [test.meta?.retryCount, test.retryCount, test.retry].every(
              (count) => count === undefined || count === 0,
            ),
          "Integration assertion failed, skipped or retried",
        );
        assertions++;
      }
      result.testResults.push(file);
    }
    requireGate(
      assertions === report.numTotalTests,
      "Integration lane assertion counts disagree",
    );
    requireGate(
      report.snapshot &&
        report.snapshot.failure === false &&
        report.snapshot.unmatched === 0,
      "Integration lane snapshot failure",
    );
    for (const [key, value] of Object.entries(report.snapshot)) {
      if (typeof value === "number") {
        requireGate(
          Number.isInteger(value) && value >= 0,
          "Invalid integration snapshot count",
        );
        snapshot[key] = (snapshot[key] ?? 0) + value;
      } else if (typeof value === "boolean")
        snapshot[key] = Boolean(snapshot[key] || value);
      else if (Array.isArray(value))
        snapshot[key] = [...(snapshot[key] ?? []), ...value];
      else throw Error("Unsupported integration snapshot evidence");
    }
    result.startTime = Math.min(result.startTime, report.startTime);
  }
  requireGate(
    seen.size === expected.size &&
      [...expected].every((file) => seen.has(file)),
    "Incomplete integration file union",
  );
  result.testResults.sort((a, b) => a.name.localeCompare(b.name));
  result.snapshot = snapshot;
  return result;
}

export function controlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("Generated loopback integration database required");
  }
  requireGate(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      /^\/dne_test_[a-f0-9]{32}$/.test(url.pathname) &&
      !url.search &&
      !url.hash,
    "Generated loopback integration database required",
  );
  url.pathname = "/postgres";
  return url;
}

export async function createLaneDatabase(admin) {
  const name = `dne_test_${randomBytes(16).toString("hex")}`;
  const marker = `dne-integration-lane-${randomBytes(16).toString("hex")}`;
  requireGate(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM pg_database WHERE datname=$1",
        [name],
      )
    ).rows[0]?.n === 0,
    "Integration database already exists",
  );
  const record = { name, marker, oid: null, marked: false };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    record.oid = (
      await admin.query(
        "SELECT oid::text oid FROM pg_database WHERE datname=$1",
        [name],
      )
    ).rows[0]?.oid;
    requireGate(
      typeof record.oid === "string",
      "Integration database identity unavailable",
    );
    await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
    record.marked = true;
    return record;
  } catch {
    // An unmarked database must remain available for guarded manual recovery.
    const error = Error("Integration database ownership setup failed");
    error.ownedDatabase = record;
    throw error;
  }
}

export async function dropLaneDatabase(admin, record) {
  requireGate(
    /^dne_test_[a-f0-9]{32}$/.test(record?.name) &&
      /^dne-integration-lane-[a-f0-9]{32}$/.test(record?.marker) &&
      record.marked === true &&
      typeof record.oid === "string",
    "Integration database ownership unavailable; preserved",
  );
  const current = (
    await admin.query(
      "SELECT oid::text oid,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",
      [record.name],
    )
  ).rows[0];
  requireGate(
    current?.oid === record.oid && current?.marker === record.marker,
    "Integration database ownership changed; preserved",
  );
  await dropAttendanceBrowserDatabase(admin, record.name);
  requireGate(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM pg_database WHERE datname=$1",
        [record.name],
      )
    ).rows[0]?.n === 0,
    "Integration database removal unconfirmed",
  );
}

function launch(index, root, env, children) {
  const started = new Date().toISOString();
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.integration.config.ts",
      `--shard=${index}/${LANES.length}`,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  let stdout = "",
    stderr = "",
    stdoutBytes = 0,
    stderrBytes = 0;
  let processError = "none",
    outputBufferExceeded = false;
  const capture = (stream) => (bytes) => {
    if (stream === "stdout") stdoutBytes += bytes.length;
    else stderrBytes += bytes.length;
    if (stdoutBytes + stderrBytes > LIMIT) {
      outputBufferExceeded = true;
      child.kill("SIGTERM");
    } else if (stream === "stdout") stdout += String(bytes);
    else stderr += String(bytes);
  };
  child.stdout.on("data", capture("stdout"));
  child.stderr.on("data", capture("stderr"));
  child.once("error", () => {
    processError = "launcher-error";
  });
  return new Promise((resolve) =>
    child.once("close", (exitStatus, signal) => {
      children.delete(child);
      const output = `${stdout}\n${stderr}`;
      resolve({
        index,
        started,
        finished: new Date().toISOString(),
        exitStatus,
        signal: signal
          ? ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT"].includes(signal)
            ? signal
            : "other"
          : "none",
        processError,
        outputBufferExceeded,
        stdoutBytes,
        stderrBytes,
        vitestUnhandledErrors:
          /Vitest caught \d+ unhandled errors? during the test run\./.test(
            output,
          ),
        vitestTeardownError:
          /\bEnvironmentTeardownError\b|\[vitest-pool\]: Timeout terminating/.test(
            output,
          ),
        npmErrorBanner: /(?:^|\n)npm (?:error|ERR!)(?:\s|$)/.test(output),
      });
    }),
  );
}

export async function runIntegration(root = process.cwd()) {
  const evidence = {
    schema: "integration-lanes-v1",
    laneCount: LANES.length,
    started: new Date().toISOString(),
    exitStatus: 1,
    lanes: [],
    cleanupErrors: [],
  };
  const children = new Set();
  const pending = [];
  const resources = [];
  let admin,
    interrupted = false;
  let stage = "configuration";
  const stop = () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  try {
    const expectedFiles = integrationFiles(root);
    const url = controlUrl(process.env.DNE_TEST_DATABASE_URL);
    const destination = path.join(root, "artifacts/integration-shards");
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    for (const name of [
      "integration-results.json",
      "integration-unhandled.json",
      "integration-shards.json",
    ])
      rmSync(path.join(root, "artifacts", name), { force: true });
    admin = new Pool({
      connectionString: url.toString(),
      connectionTimeoutMillis: 3000,
    });
    admin.on("error", () => {
      interrupted = true;
    });
    stage = "owned lane setup";
    for (const index of LANES) {
      requireGate(!interrupted, "Integration execution interrupted");
      let database;
      try {
        database = await createLaneDatabase(admin);
      } catch (error) {
        if (error.ownedDatabase)
          resources.push({ database: error.ownedDatabase });
        throw Error("Owned lane setup failed", { cause: error });
      }
      const resource = { database, privateRoot: null };
      resources.push(resource);
      resource.privateRoot = realpathSync(
        mkdtempSync(path.join(tmpdir(), `dne-integration-lane-${index}-`)),
      );
      mkdirSync(path.join(destination, String(index)));
    }
    stage = "native lane execution";
    for (const [position, resource] of resources.entries()) {
      requireGate(!interrupted, "Integration execution interrupted");
      const index = position + 1;
      const connection = new URL(url);
      connection.pathname = `/${resource.database.name}`;
      pending.push(
        launch(
          index,
          root,
          {
            ...process.env,
            DNE_TEST_DATABASE_URL: connection.toString(),
            DNE_TEST_PRIVATE_STORAGE_ROOT: resource.privateRoot,
            DNE_INTEGRATION_SHARD: String(index),
          },
          children,
        ),
      );
    }
    const outcomes = await Promise.all(pending);
    evidence.lanes = outcomes;
    stage = "original lane evidence";
    const lanes = outcomes.map((child) => ({
      index: child.index,
      child,
      report: read(path.join(destination, String(child.index), "results.json")),
      unhandled: read(
        path.join(destination, String(child.index), "unhandled.json"),
      ),
    }));
    writeFileSync(
      path.join(root, "artifacts/integration-unhandled.json"),
      JSON.stringify(mergeUnhandled(lanes.map((lane) => lane.unhandled))) +
        "\n",
    );
    const combined = mergeIntegrationReports(expectedFiles, lanes);
    requireGate(
      JSON.stringify(integrationFiles(root)) ===
        JSON.stringify(expectedFiles) && !interrupted,
      "Integration execution interrupted or inventory changed",
    );
    writeFileSync(
      path.join(root, "artifacts/integration-results.json"),
      JSON.stringify(combined) + "\n",
    );
    evidence.fileCount = expectedFiles.length;
    evidence.tests = combined.numTotalTests;
    evidence.exitStatus = 0;
  } catch {
    evidence.error = `Integration verification failed during ${stage}.`;
    console.error(evidence.error);
  } finally {
    if (children.size) {
      stop();
      await Promise.allSettled(pending);
    }
    // Every launched child has closed before this cleanup; no foreign process
    // is signalled and no observed live database session is forcibly removed.
    for (const resource of resources) {
      try {
        await dropLaneDatabase(admin, resource.database);
        resource.removed = true;
      } catch {
        evidence.exitStatus = 1;
        evidence.cleanupErrors.push(
          "Owned lane database preserved; cleanup unconfirmed.",
        );
      }
      if (resource.privateRoot && resource.removed) {
        try {
          rmSync(resource.privateRoot, { recursive: true });
        } catch {
          evidence.exitStatus = 1;
          evidence.cleanupErrors.push(
            "Owned lane storage cleanup unconfirmed.",
          );
        }
      }
    }
    if (admin) {
      try {
        await admin.end();
      } catch {
        evidence.exitStatus = 1;
        evidence.cleanupErrors.push("Integration control close failed.");
      }
    }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (interrupted) evidence.exitStatus = 1;
    evidence.resources = resources.map(
      ({ database, privateRoot, removed }) => ({
        ...database,
        privateRoot,
        removed: removed === true,
      }),
    );
    evidence.finished = new Date().toISOString();
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(root, "artifacts/integration-shards.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
  return evidence.exitStatus;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 2) {
    console.error(
      "Integration runner requires its complete unfiltered test inventory.",
    );
    process.exitCode = 1;
  } else {
    try {
      process.exitCode = await runIntegration();
    } catch {
      console.error(
        "Integration verification evidence could not be preserved.",
      );
      process.exitCode = 1;
    }
  }
}
