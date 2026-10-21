// Opt-in owner-run rehearsal tooling. Application behavior stays in src/.
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, Pool } from "pg";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fallback = "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev";
const fixtureId = "DEMO-509";
class PreviewError extends Error {}
const failure = (stage) =>
  new PreviewError(
    `Private preview failed at ${stage}. See the local preview guide; private details are not logged.`,
  );

const cleanupStages = new Set([
  "runtime-close",
  "fixture-pool-close",
  "creation-observation",
  "session-observation",
  "session-refusal",
  "owned-drop",
  "drop-client-close",
  "control-pool-close",
  "directory-removal",
  "recovery-record-write",
]);
const unavailable = Symbol("unavailable cleanup field");
function cleanupField(record, key) {
  if (!record || typeof record !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return undefined;
    return Object.hasOwn(descriptor, "value") ? descriptor.value : unavailable;
  } catch {
    return unavailable;
  }
}
export function cleanupDiagnostic(record) {
  const stage = cleanupField(record, "cleanupStage");
  const kind = cleanupField(record, "cleanupKind");
  const code = cleanupField(record, "cleanupCode");
  const elapsedMs = cleanupField(record, "cleanupElapsedMs");
  return {
    record: record && typeof record === "object" ? "present" : "missing",
    stage: cleanupStages.has(stage) ? stage : "unknown",
    kind:
      kind === undefined
        ? "absent"
        : kind === "owned-session-present"
          ? kind
          : "unknown",
    code:
      code === undefined
        ? "absent"
        : typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
          ? code
          : "unknown",
    elapsedMs:
      Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 600000
        ? Math.floor(elapsedMs)
        : "unknown",
  };
}
export function recordCleanupFailure(record, stage, error, elapsedMs) {
  try {
    if (cleanupField(record, "cleanupStage") !== undefined) return;
    const code = cleanupField(error, "code");
    record.cleanupStage = cleanupStages.has(stage) ? stage : "unknown";
    record.cleanupElapsedMs =
      Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 600000
        ? elapsedMs
        : "unknown";
    if (error !== undefined)
      record.cleanupCode =
        typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
          ? code
          : "unknown";
  } catch {
    // Diagnostics must never interrupt the remaining owned cleanup steps.
  }
}

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
      "One invented non-qualified lesson and five finite synthetic staff identities only; no member, grant, queue, feedback, completion, allowance, support request, discussion, proposal, event schedule or participation seeded.",
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
      const cleanupStart = performance.now();
      const failed = (stage, error) =>
        recordCleanupFailure(
          metadata,
          stage,
          error,
          performance.now() - cleanupStart,
        );
      try {
        await running?.close();
      } catch (error) {
        clean = false;
        failed("runtime-close", error);
      }
      try {
        await fixturePool?.end();
      } catch (error) {
        clean = false;
        failed("fixture-pool-close", error);
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
          if (exists) {
            clean = false;
            failed("creation-observation");
          } else creationPending = false;
        } catch (error) {
          clean = false;
          failed("creation-observation", error);
        }
      }
      if (made && clean) {
        let operation = "session-observation";
        try {
          // Client pool.end() confirms local shutdown, not when PostgreSQL has
          // processed every socket close. Under a loaded gate a closing backend
          // can outlast PostgreSQL's own five-second DROP wait, so observe the
          // database until its sessions leave (bounded, read-only, nothing is
          // terminated). After an observed zero, the single ordinary DROP stays
          // the authority check for a connection racing with that observation.
          const deadline = Date.now() + 20000;
          const observedSessions = async () =>
            (
              await control.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",
                [database],
              )
            ).rows[0].n;
          let remaining = await observedSessions();
          while (Date.now() < deadline && remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (Date.now() < deadline) remaining = await observedSessions();
          }
          if (remaining > 0) {
            // This is an observed refusal, not a fabricated driver SQLSTATE.
            // Keep the owned resource without racing DROP's own wait/timeout.
            clean = false;
            metadata.cleanupKind = "owned-session-present";
            failed("session-refusal");
          } else {
            operation = "owned-drop";
            // Only this invocation's acknowledged database reaches this branch.
            // Administrative DDL has its own finite server budget; control reads
            // and the observed-session refusal retain their existing limits.
            const drop = new Client({
              connectionString: controlUrl.href,
              connectionTimeoutMillis: 3000,
              statement_timeout: 30000,
              application_name: "dne-owner-preview-drop",
            });
            drop.on("error", (error) => {
              clean = false;
              failed("owned-drop", error);
            });
            try {
              await drop.connect();
              await drop.query(`DROP DATABASE "${database}"`);
              made = false;
            } catch (error) {
              clean = false;
              failed("owned-drop", error);
            } finally {
              try {
                await drop.end();
              } catch (error) {
                clean = false;
                failed("drop-client-close", error);
              }
            }
          }
        } catch (error) {
          clean = false;
          failed(operation, error);
        }
      }
      try {
        await control?.end();
      } catch (error) {
        clean = false;
        failed("control-pool-close", error);
      }
      closed = true;
      if (clean) {
        try {
          await rm(privateRoot, { recursive: true, force: true });
        } catch (error) {
          failed("directory-removal", error);
          throw error;
        }
      } else {
        metadata.cleanup =
          "Cleanup blocked. Shutdown/removal or database creation acknowledgement is incomplete; do not force-drop or terminate other connections. After checking this invocation's identity and closing its remaining connections, use this private record to remove only its database and directory.";
        try {
          await save();
        } catch (error) {
          failed("recovery-record-write", error);
          throw error;
        }
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
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
      DNE_PREPARED_REVIEW_SAMPLES: "enabled",
      DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
      // Participate and contribute: existing exact-grant circle moderation,
      // proposal moderation and invented event rehearsal. Nothing is seeded.
      DNE_CIRCLE_DISCUSSION: "enabled",
      DNE_LOCAL_CIRCLE_ADMIN: "enabled",
      DNE_EVENT_REGISTRATION: "enabled",
      DNE_LOCAL_EVENT_SCHEDULING: "enabled",
      DNE_LOCAL_EVENT_ADMIN: "enabled",
      // Submit and receive feedback: existing exact support-request assignment
      // by an administrator to a distinct operator. Nothing is seeded.
      DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
      // Participate and contribute: existing exact-revision workflow-note
      // review requests, read only by an exactly assigned moderator.
      DNE_WORKFLOW_REVIEW_REQUESTS: "enabled",
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
      moderatorCredential = randomBytes(32).toString("hex"),
      editorCredential = randomBytes(32).toString("hex"),
      operatorCredential = randomBytes(32).toString("hex");
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
    const moderatorId = await auth.provisionStaff(
      moderatorCredential,
      "moderator",
      expiry,
    );
    await auth.provisionStaff(editorCredential, "editor", expiry);
    // A distinct operator: administrators cannot assign support to themselves.
    const operatorId = await auth.provisionStaff(
      operatorCredential,
      "operator",
      expiry,
    );
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
    const assignment = {
      ...draft,
      id: "DEMO-544",
      kind: "assignment",
      title: "Invented preview: check a sample plan",
      body: "Invented private rehearsal only, not qualified curriculum or formal assessment. Plan a two-hour sample reading event for twelve invented volunteers. Write a short instruction an AI could use to suggest a checklist, then explain how you would check its suggestions against the two-hour limit and twelve-volunteer context. Use no real personal or client information.",
    };
    for (const item of [draft, assignment]) {
      if (
        !(await catalog.createDraft(editorCredential, item)) ||
        !(await catalog.submit(editorCredential, item.id, item.version)) ||
        !(await catalog.approve(
          reviewerCredential,
          item.id,
          item.version,
          true,
        )) ||
        !(await catalog.publish(editorCredential, item.id, item.version))
      )
        throw failure(stage);
    }
    Object.assign(metadata, {
      origin: running.origin,
      expiry: expiry.toISOString(),
      administratorId,
      administratorCredential,
      reviewerId,
      reviewerCredential,
      moderatorId,
      moderatorCredential,
      operatorId,
      operatorCredential,
    });
    await save();
    return {
      origin: running.origin,
      ...before,
      privateRoot,
      metadataFile,
      close,
      cleanupDiagnostic: () => cleanupDiagnostic(metadata),
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
      if (!clean)
        console.error(
          `Preview cleanup diagnostic: ${JSON.stringify(preview.cleanupDiagnostic())}`,
        );
      process.exitCode = clean ? 0 : 1;
    } catch {
      console.error(
        "Owned preview shutdown failed; inspect its private setup file locally.",
      );
      console.error(
        `Preview cleanup diagnostic: ${JSON.stringify(preview.cleanupDiagnostic())}`,
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
