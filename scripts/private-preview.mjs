// Opt-in owner-run rehearsal tooling. Application behavior stays in src/.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fallback = "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev";
const fixtureId = "DEMO-509";
class PreviewError extends Error {}
const failure = (stage) =>
  new PreviewError(
    `Private preview failed at ${stage}. See the local preview guide; private details are not logged.`,
  );

export function controlConnection(env) {
  // No inherited application flags, provider choices, ports or storage roots.
  if (
    Object.keys(env).some(
      (key) => key.startsWith("DNE_") && key !== "DNE_PREVIEW_CONTROL_URL",
    )
  )
    throw failure("configuration");
  let url;
  try {
    url = new URL(env.DNE_PREVIEW_CONTROL_URL ?? fallback);
  } catch {
    throw failure("configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw failure("configuration");
  url.pathname = "/postgres";
  return url;
}

function command(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw failure("build or revision inspection");
  return result.stdout.trim();
}
function revision() {
  return {
    revision: command("git", ["rev-parse", "HEAD"]),
    tree: command("git", ["rev-parse", "HEAD^{tree}"]),
    workingTreeModified: command("git", ["status", "--porcelain"]) !== "",
  };
}

export async function launchPreview(env) {
  const controlUrl = controlConnection(env);
  const temporaryBase = await realpath(tmpdir()),
    repositoryBase = await realpath(root);
  // A custom/symlinked TMPDIR must not put credentials in served assets or a
  // directory that the runtime snapshot would recursively copy.
  if (
    temporaryBase === repositoryBase ||
    temporaryBase.startsWith(repositoryBase + sep)
  )
    throw failure("private storage");
  const before = revision();
  // Always build here, including direct launcher use; never reuse stale dist.
  command(process.execPath, ["scripts/check-installed-deps.mjs"]);
  command("npm", ["run", "build"]);
  const privateRoot = await mkdtemp(
    join(temporaryBase, `dne-owner-preview-${process.pid}-`),
  );
  const storage = join(privateRoot, "evidence"),
    runtimeRoot = join(privateRoot, "runtime");
  const database = "dne_test_" + randomBytes(16).toString("hex");
  const databaseUrl = new URL(controlUrl);
  databaseUrl.pathname = "/" + database;
  const metadataFile = join(privateRoot, "runtime-private.json");
  let control,
    running,
    fixturePool,
    made = false,
    creationPending = false,
    closed = false,
    stage = "resource setup";
  let closing;
  const metadata = {
    ...before,
    started: new Date().toISOString(),
    pid: process.pid,
    database: databaseUrl.href,
    privateRoot,
    storage,
    runtimeRoot,
    provider: "deterministic local test only; no live services",
    fixture:
      "One invented non-qualified lesson and three finite synthetic staff identities only; no member, grant, queue, feedback, completion, allowance or participation seeded.",
  };
  const save = () =>
    writeFile(metadataFile, JSON.stringify(metadata, null, 2) + "\n", {
      mode: 0o600,
    });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      if (closed) return true;
      let clean = true;
      try {
        await running?.close();
      } catch {
        clean = false;
      }
      try {
        await fixturePool?.end();
      } catch {
        clean = false;
      }
      if (creationPending) {
        // A lost CREATE acknowledgement is not proof that nothing committed.
        // Observe the exact generated name, but never drop an unconfirmed DB.
        try {
          const exists = (
            await control.query(
              "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS present",
              [database],
            )
          ).rows[0].present;
          if (exists) clean = false;
          else creationPending = false;
        } catch {
          clean = false;
        }
      }
      if (made) {
        try {
          // Client pool.end() confirms local shutdown, not when PostgreSQL has
          // processed every socket close. A separate count can falsely retain
          // already-closing owned backends. Use the single ordinary DROP as the
          // database's authority check; it never terminates another connection.
          if (clean) {
            await control.query(`DROP DATABASE "${database}"`);
            made = false;
          }
        } catch {
          clean = false;
        }
      }
      try {
        await control?.end();
      } catch {
        clean = false;
      }
      closed = true;
      if (clean) await rm(privateRoot, { recursive: true, force: true });
      else {
        metadata.cleanup =
          "Cleanup blocked. Shutdown/removal or database creation acknowledgement is incomplete; do not force-drop or terminate other connections. After checking this invocation's identity and closing its remaining connections, use this private record to remove only its database and directory.";
        await save();
      }
      return clean;
    })();
    return closing;
  }
  try {
    await mkdir(storage, { mode: 0o700 });
    await save();
    control = new Pool({
      connectionString: controlUrl.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      application_name: "dne-owner-preview-control",
    });
    // Driver errors are not safe console messages. Operations surface a fixed diagnostic.
    control.on("error", () => {});
    creationPending = true;
    try {
      await control.query(`CREATE DATABASE "${database}"`);
    } catch (error) {
      // These explicit refusals cannot have created our database. A duplicate
      // name belongs to somebody else and is never ours to delete.
      if (["28P01", "28000", "42501", "42P04"].includes(error?.code))
        creationPending = false;
      throw error;
    }
    made = true;
    creationPending = false;
    stage = "runtime snapshot";
    // Snapshot dependencies as well as built code so checkout changes cannot alter it.
    for (const name of [
      "dist",
      "public",
      "assets",
      "migrations",
      "package.json",
      "package-lock.json",
      "node_modules",
    ])
      await cp(join(root, name), join(runtimeRoot, name), { recursive: true });
    const after = revision();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw failure("revision changed");
    stage = "runtime startup";
    const { start } = await import(
      pathToFileURL(join(runtimeRoot, "dist/runtime.js")).href
    );
    running = await start({
      DNE_DATABASE_URL: databaseUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_STAFF_ENTRY: "enabled",
      DNE_PREPARED_REVIEW_SAMPLES: "enabled",
      DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
    });
    fixturePool = new Pool({
      connectionString: databaseUrl.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    fixturePool.on("error", () => {});
    stage = "invented fixture setup";
    const { authorizationStore } = await import(
      pathToFileURL(join(runtimeRoot, "dist/authorization.js")).href
    );
    const { catalogStore } = await import(
      pathToFileURL(join(runtimeRoot, "dist/catalog.js")).href
    );
    const auth = authorizationStore(fixturePool),
      catalog = catalogStore(fixturePool);
    const expiry = new Date(Date.now() + 4 * 3600000);
    const administratorCredential = randomBytes(32).toString("hex"),
      reviewerCredential = randomBytes(32).toString("hex"),
      editorCredential = randomBytes(32).toString("hex");
    const administratorId = await auth.provisionStaff(
      administratorCredential,
      "platform_admin",
      expiry,
    );
    const reviewerId = await auth.provisionStaff(
      reviewerCredential,
      "reviewer",
      expiry,
    );
    await auth.provisionStaff(editorCredential, "editor", expiry);
    const draft = {
      id: fixtureId,
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: "Invented preview: clarify a sample request",
      body: "This is an invented private rehearsal sample, not approved foundation curriculum. Using only invented details, state a sample context, ask for a short checklist and check each suggestion against the supplied sample before acting.",
      owner: "Synthetic preview editor",
      sources: "Original invented preview text",
      rights: "Owned invented sample only",
      goals: [],
      backgrounds: [],
      domains: [],
      prerequisites: "None",
      rubric: null,
      rubricVersion: null,
    };
    if (
      !(await catalog.createDraft(editorCredential, draft)) ||
      !(await catalog.submit(editorCredential, fixtureId, 1)) ||
      !(await catalog.approve(reviewerCredential, fixtureId, 1, true)) ||
      !(await catalog.publish(editorCredential, fixtureId, 1))
    )
      throw failure(stage);
    Object.assign(metadata, {
      origin: running.origin,
      expiry: expiry.toISOString(),
      administratorId,
      administratorCredential,
      reviewerId,
      reviewerCredential,
    });
    await save();
    return {
      origin: running.origin,
      ...before,
      privateRoot,
      metadataFile,
      close,
    };
  } catch {
    const clean = await close().catch(() => false);
    throw new PreviewError(
      `${failure(stage).message}${clean ? "" : ` Owned cleanup is blocked; inspect ${metadataFile} locally.`}`,
    );
  }
}

export async function main(env = process.env) {
  let preview,
    stopRequested = false,
    stopping = false;
  const stop = async () => {
    stopRequested = true;
    if (!preview || stopping) return;
    stopping = true;
    try {
      const clean = await preview.close();
      if (!clean)
        console.error(
          `Owned cleanup blocked; inspect ${preview.metadataFile} locally. Do not force-drop other connections.`,
        );
      process.exitCode = clean ? 0 : 1;
    } catch {
      console.error(
        "Owned preview shutdown failed; inspect its private setup file locally.",
      );
      process.exitCode = 1;
    }
  };
  // A stop requested during startup is honored after owned setup unwinds; no
  // default signal termination may strand a newly created database mid-copy.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (process.argv.length !== 2) throw failure("configuration");
    preview = await launchPreview(env);
    if (stopRequested) {
      await stop();
      return;
    }
    console.info(
      JSON.stringify({
        origin: preview.origin,
        revision: preview.revision,
        tree: preview.tree,
        workingTreeModified: preview.workingTreeModified,
        provider: "deterministic local test only",
        qualification: "invented fixture, no qualified signoff",
        staffSetupFile: preview.metadataFile,
        lifetime:
          "fresh temporary data; stop with Ctrl+C; staff expires in four hours",
      }),
    );
  } catch (error) {
    console.error(
      error instanceof PreviewError
        ? error.message
        : "Private preview startup failed. See the local preview guide; private details are not logged.",
    );
    process.exitCode = 1;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
