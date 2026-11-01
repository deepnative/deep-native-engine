import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  controlUrl,
  createLaneDatabase,
  dropLaneDatabase,
  testLaneCount,
} from "./integration-runner.mjs";
import { requireGate } from "./quality-gates.mjs";

// Keep each file's ordered tests together; each process owns its database/server/storage.
export async function runBrowsers(root = process.cwd()) {
  const lanes = Array.from(
    { length: testLaneCount() },
    (_, index) => index + 1,
  );
  const evidence = {
    schema: "browser-shards-v1",
    laneCount: lanes.length,
    started: new Date().toISOString(),
    exitStatus: 1,
    lanes: [],
    cleanupErrors: [],
  };
  const resources = [],
    children = new Set(),
    pending = [];
  let admin,
    interrupted = false;
  const stop = () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const launch = (args, env) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/playwright/cli.js"), ...args],
      { cwd: root, env, stdio: "ignore" },
    );
    children.add(child);
    let failed = false;
    child.once("error", () => {
      failed = true;
    });
    return new Promise((resolve) =>
      child.once("close", (code, signal) => {
        children.delete(child);
        resolve({
          exitStatus: failed || signal ? 1 : code,
          signal: signal ? "interrupted" : "none",
        });
      }),
    );
  };
  try {
    const url = controlUrl(process.env.DNE_TEST_DATABASE_URL);
    const destination = path.join(root, "artifacts/browser-shards");
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(path.join(destination, "blobs"), { recursive: true });
    rmSync(path.join(root, "artifacts/e2e-results.json"), { force: true });
    admin = new Pool({
      connectionString: url.toString(),
      connectionTimeoutMillis: 3000,
    });
    admin.on("error", stop);
    for (const index of lanes) {
      requireGate(!interrupted, "Browser execution interrupted");
      let database;
      try {
        database = await createLaneDatabase(admin);
      } catch (error) {
        if (error.ownedDatabase)
          resources.push({ database: error.ownedDatabase });
        throw error;
      }
      const resource = { index, database };
      resources.push(resource);
      resource.privateRoot = realpathSync(
        mkdtempSync(path.join(tmpdir(), "dne-browser-shard-")),
      );
      resource.server = createServer();
      await new Promise((resolve, reject) => {
        resource.server.once("error", reject);
        resource.server.listen(0, "127.0.0.1", resolve);
      });
      resource.port = resource.server.address().port;
    }
    for (const resource of resources) {
      requireGate(!interrupted, "Browser execution interrupted");
      await new Promise((resolve, reject) =>
        resource.server.close((error) => (error ? reject(error) : resolve())),
      );
      const connection = new URL(url);
      connection.pathname = `/${resource.database.name}`;
      const origin = `http://127.0.0.1:${resource.port}`;
      pending.push(
        launch(
          [
            "test",
            `--shard=${resource.index}/${lanes.length}`,
            "--reporter=blob",
            `--output=artifacts/browser-results/shard-${resource.index}`,
          ],
          {
            ...process.env,
            DNE_TEST_DATABASE_URL: connection.toString(),
            DNE_TEST_PRIVATE_STORAGE_ROOT: resource.privateRoot,
            DNE_E2E_ORIGIN: origin,
            DNE_PREPARED_BROWSER_ORIGIN: origin,
            DNE_STAFF_BROWSER_ORIGIN: origin,
            PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(
              destination,
              `blobs/shard-${resource.index}.zip`,
            ),
          },
        ),
      );
    }
    evidence.lanes = await Promise.all(pending);
    requireGate(
      !interrupted &&
        evidence.lanes.length === lanes.length &&
        evidence.lanes.every((lane) => lane.exitStatus === 0),
      "Browser shard failed",
    );
    const merging = launch(
      ["merge-reports", "--reporter=json", path.join(destination, "blobs")],
      {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(
          root,
          "artifacts/e2e-results.json",
        ),
      },
    );
    pending.push(merging);
    const merged = await merging;
    requireGate(
      merged.exitStatus === 0 && !interrupted,
      "Browser report merge failed",
    );
    evidence.exitStatus = 0;
  } catch {
    evidence.error =
      "Isolated browser verification failed; inspect original shard evidence.";
    console.error(evidence.error);
  } finally {
    if (children.size) {
      stop();
      await Promise.allSettled(pending);
    }
    for (const resource of resources) {
      if (resource.server?.listening)
        await new Promise((resolve) => resource.server.close(resolve));
      try {
        await dropLaneDatabase(admin, resource.database);
        resource.removed = true;
        if (resource.privateRoot)
          rmSync(resource.privateRoot, { recursive: true });
      } catch {
        evidence.exitStatus = 1;
        evidence.cleanupErrors.push(
          "Owned browser resource preserved; cleanup unconfirmed.",
        );
      }
    }
    try {
      if (admin) await admin.end();
    } catch {
      evidence.exitStatus = 1;
      evidence.cleanupErrors.push("Browser control close failed.");
    }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (interrupted) evidence.exitStatus = 1;
    evidence.resources = resources.map(
      ({ index, database, privateRoot, port, removed }) => ({
        index,
        ...database,
        privateRoot,
        port,
        removed: removed === true,
      }),
    );
    evidence.finished = new Date().toISOString();
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(root, "artifacts/browser-shards.json"),
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
    console.error("Browser runner requires the complete unfiltered inventory.");
    process.exitCode = 1;
  } else process.exitCode = await runBrowsers();
}
