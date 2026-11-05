#!/usr/bin/env node
// Lists, and with --apply removes, test resources that are provably disposable.
// See "Leftover test resources" in assets/docs/workflows/VERIFICATION.md.
//
// "No connections" alone proves nothing: a running gate's own databases sit at
// zero connections between stages, and a preview's pool closes idle connections.
// So this refuses outright during a gate and also requires age and no live
// reference. Anything it is unsure of is kept and listed with the reason.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";

const GATE_CONTAINER = "dne-gate-active";
const SHARED_SERVER = "deep-native-engine-postgres-1";
const DATABASE_NAME = /^dne_test_[a-f0-9]{32}$/;
// Every marker the test suite writes is a generated prefix and 32 hex digits.
const GENERATED_MARKER = /^[a-z0-9-]+-[a-f0-9]{32}$/;
const VERIFIER_NAME = /^dne-verify-[a-z0-9]+$/;
const OWNER_LABEL = "io.deepnative.verification-owner";
const CLAIM_LABEL = "io.deepnative.verification-claim";
const HOUR = 3600000;
const DEFAULT_MIN_AGE_HOURS = 24;

export function parseOptions(argv) {
  const options = { apply: false, minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--apply") options.apply = true;
    else if (option === "--claim" && argv[index + 1])
      options.claim = argv[++index];
    else if (
      option === "--min-age-hours" &&
      Number.isInteger(Number(argv[index + 1])) &&
      Number(argv[index + 1]) >= 1
    )
      options.minAgeHours = Number(argv[++index]);
    else throw Error(`Unrecognised or incomplete option: ${option}`);
  }
  return options;
}

const age = (value, now) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : now - time;
};

function databaseKeepReason(entry, context) {
  const { now, minAgeHours, processText, clients } = context;
  if (!DATABASE_NAME.test(entry.name)) return "not a generated test name";
  if (entry.isTemplate) return "marked as a template";
  if (entry.connections !== 0) return "in use by a current connection";
  if (entry.marker !== null && !GENERATED_MARKER.test(entry.marker))
    return "has an unrecognised comment, which may be someone's note";
  const created = age(entry.created, now),
    changed = age(entry.changed, now);
  if (created === null || changed === null) return "age unknown";
  if (Math.min(created, changed) < minAgeHours * HOUR)
    return `too recent (under ${minAgeHours}h)`;
  if (processText.includes(entry.name))
    return "a live process or container names it";
  const newestChange = now - Math.min(created, changed);
  const client = clients.find(
    // An unreadable start time cannot rule the client out.
    (candidate) => !(Date.parse(candidate.startedAt) > newestChange),
  );
  if (client) return `changed since ${client.name} started, so may be its own`;
  return null;
}

function containerKeepReason(entry, context) {
  const { now, minAgeHours, claim } = context;
  if (!VERIFIER_NAME.test(entry.name)) return "name is not a finished verifier";
  if (entry.labels?.[OWNER_LABEL] !== "gate") return "no verifier label";
  if (entry.status !== "exited" && entry.status !== "dead")
    return "not stopped";
  if (entry.mounts?.some((mount) => mount.Type === "volume"))
    return "holds a volume that may contain data";
  const stopped = age(entry.finishedAt, now);
  if (stopped === null || stopped < 0) return "age unknown";
  if (stopped < minAgeHours * HOUR) return `too recent (under ${minAgeHours}h)`;
  if (!claim || entry.labels[CLAIM_LABEL] !== claim)
    return `belongs to another claim (${entry.labels[CLAIM_LABEL] ?? "none"}); pass --claim only for your own`;
  return null;
}

export function planCleanup({
  databases,
  containers,
  processText,
  now,
  minAgeHours,
  claim,
}) {
  const gate = containers.find((entry) => entry.name === GATE_CONTAINER);
  if (gate)
    return {
      refused: `${GATE_CONTAINER} exists (${gate.status}): a gate may be running, so nothing is removed.`,
      databases: [],
      containers: [],
      kept: [],
    };
  const clients = containers.filter(
    (entry) => entry.status === "running" && entry.name !== SHARED_SERVER,
  );
  const context = { now, minAgeHours, processText, clients, claim };
  const result = { databases: [], containers: [], kept: [] };
  for (const entry of databases) {
    const reason = databaseKeepReason(entry, context);
    if (reason) result.kept.push({ name: entry.name, reason });
    else result.databases.push(entry);
  }
  for (const entry of containers) {
    // Unrelated containers are not candidates, so they are not worth listing.
    if (!entry.name.startsWith("dne-") && entry.name !== SHARED_SERVER)
      continue;
    const reason = containerKeepReason(entry, context);
    if (reason) result.kept.push({ name: entry.name, reason });
    else result.containers.push(entry);
  }
  return result;
}

/** Re-checks each resource just before removing it, and never retries a refusal. */
export async function apply(
  plan,
  { gateExists, current, drop, removeContainer },
) {
  const failures = [];
  const removed = [];
  for (const entry of [...plan.databases, ...plan.containers]) {
    if (gateExists()) {
      failures.push(
        `${GATE_CONTAINER} appeared; stopped before ${entry.name}.`,
      );
      break;
    }
    try {
      if (entry.id) removeContainer(entry.id);
      else {
        const state = await current(entry.name);
        if (state?.oid !== entry.oid || state.connections !== 0)
          throw Error("changed since planning");
        await drop(entry.name);
      }
      removed.push(entry.name);
    } catch (error) {
      failures.push(`${entry.name}: kept (${error.message})`);
    }
  }
  return { removed, failures };
}

function command(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(`${file} ${args[0]} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout;
}

function readContainers() {
  const ids = command("docker", ["ps", "-aq", "--no-trunc"])
    .split("\n")
    .filter(Boolean);
  if (!ids.length) return { containers: [], text: "" };
  const inspected = JSON.parse(command("docker", ["inspect", ...ids]));
  return {
    containers: inspected.map((entry) => ({
      id: entry.Id,
      name: entry.Name.replace(/^\//, ""),
      status: entry.State.Status,
      startedAt: entry.State.StartedAt,
      finishedAt: entry.State.FinishedAt?.startsWith("0001-")
        ? null
        : entry.State.FinishedAt,
      labels: entry.Config.Labels ?? {},
      mounts: entry.Mounts ?? [],
    })),
    // Only searched for database names; never printed.
    text: JSON.stringify(
      inspected
        .filter((entry) => entry.State.Status === "running")
        .map((entry) => [entry.Config.Env, entry.Config.Cmd, entry.Args]),
    ),
  };
}

const DATABASE_QUERY = `SELECT d.datname AS name, d.oid::text AS oid,
  shobj_description(d.oid,'pg_database') AS marker, d.datistemplate AS "isTemplate",
  (SELECT count(*)::integer FROM pg_stat_activity a WHERE a.datname=d.datname) AS connections,
  (pg_stat_file('base/'||d.oid||'/PG_VERSION')).modification AS created,
  (pg_stat_file('base/'||d.oid)).modification AS changed,
  pg_database_size(d.oid)::text AS "sizeBytes"
  FROM pg_database d WHERE d.datname LIKE 'dne\\_test\\_%'`;

function adminUrl() {
  const url = new URL(
    process.env.DNE_DATABASE_URL ??
      "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Cleanup only works on a loopback database.");
  return url.toString();
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

async function main(argv) {
  const options = parseOptions(argv);
  // Any failure to read Docker or the process list stops here: without them
  // nothing can be proved disposable.
  const { containers, text } = readContainers();
  const processText = `${command("ps", ["eww", "-ax", "-o", "command="])}\n${text}`;
  const admin = new pg.Pool({
    connectionString: adminUrl(),
    connectionTimeoutMillis: 3000,
    max: 1,
  });
  try {
    const databases = (await admin.query(DATABASE_QUERY)).rows;
    const plan = planCleanup({
      databases: databases.map((entry) => ({
        ...entry,
        created: entry.created?.toISOString?.() ?? entry.created,
        changed: entry.changed?.toISOString?.() ?? entry.changed,
      })),
      containers,
      processText,
      now: Date.now(),
      minAgeHours: options.minAgeHours,
      claim: options.claim,
    });
    const total = databases.reduce((sum, d) => sum + Number(d.sizeBytes), 0);
    console.log(`Test databases: ${databases.length}, ${megabytes(total)}`);
    if (plan.refused) console.log(`Refused: ${plan.refused}`);
    for (const entry of plan.databases)
      console.log(
        `Disposable database: ${entry.name} (${megabytes(Number(entry.sizeBytes))})`,
      );
    for (const entry of plan.containers)
      console.log(`Disposable container: ${entry.name}`);
    for (const entry of plan.kept)
      console.log(`Kept: ${entry.name}: ${entry.reason}`);
    const dangling = command("docker", ["volume", "ls", "-qf", "dangling=true"])
      .split("\n")
      .filter(Boolean).length;
    console.log(`Unattached Docker volumes (never touched here): ${dangling}`);
    if (!options.apply) {
      console.log(
        "Dry run: nothing was removed. Add --apply to remove the items above.",
      );
      return plan.refused ? 1 : 0;
    }
    if (plan.refused) return 1;
    const outcome = await apply(plan, {
      gateExists: () =>
        command("docker", ["ps", "-a", "--format", "{{.Names}}"])
          .split("\n")
          .includes(GATE_CONTAINER),
      current: async (name) =>
        (
          await admin.query(
            "SELECT d.oid::text AS oid,(SELECT count(*)::integer FROM pg_stat_activity a WHERE a.datname=d.datname) AS connections FROM pg_database d WHERE d.datname=$1",
            [name],
          )
        ).rows[0],
      // Without FORCE, PostgreSQL itself refuses if anything has connected.
      drop: (name) => admin.query(`DROP DATABASE "${name}"`),
      removeContainer: (id) => command("docker", ["rm", id]),
    });
    for (const name of outcome.removed) console.log(`Removed: ${name}`);
    for (const failure of outcome.failures)
      console.error(`Not removed: ${failure}`);
    return outcome.failures.length ? 1 : 0;
  } finally {
    await admin.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(
        `Cleanup stopped without removing anything further: ${error.message}`,
      );
      process.exitCode = 1;
    },
  );
