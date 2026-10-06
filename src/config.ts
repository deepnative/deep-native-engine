import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterReadiness,
  applicationMode,
  demoImpersonation,
  validateDatabaseIsolation,
} from "./adapters.ts";

function canonicalCandidate(value: string) {
  let current = resolve(value);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

export function config(env: NodeJS.ProcessEnv) {
  const databaseUrl = env.DNE_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Set DNE_DATABASE_URL to the local preview database.");
  const url = new URL(databaseUrl);
  const mode = applicationMode(env.DNE_APP_MODE);
  if (
    url.search !== "" ||
    url.hash !== "" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("The preview requires a loopback PostgreSQL database.");
  if (mode === "live")
    throw new Error(
      "Live application hosting requires a separately authorized configuration.",
    );
  validateDatabaseIsolation(mode, url);
  const port = Number(env.DNE_PORT ?? 3000);
  const ephemeralTestPort = mode === "test" && env.DNE_PORT === "0";
  if (
    !Number.isInteger(port) ||
    port > 65535 ||
    (port < 1 && !ephemeralTestPort)
  )
    throw new Error("DNE_PORT must be a valid port.");
  if (env.DNE_PRIVATE_STORAGE_ROOT === "")
    throw new Error("DNE_PRIVATE_STORAGE_ROOT must name a private directory.");
  const privateStorageRoot = canonicalCandidate(
      env.DNE_PRIVATE_STORAGE_ROOT ?? ".dne-private/evidence",
    ),
    publicRoot = realpathSync(
      fileURLToPath(new URL("../public", import.meta.url)),
    );
  if (
    privateStorageRoot === publicRoot ||
    privateStorageRoot.startsWith(`${publicRoot}${sep}`)
  )
    throw new Error("Private evidence storage cannot be served publicly.");
  const localStaffEntry = env.DNE_LOCAL_STAFF_ENTRY ?? "disabled";
  if (!["enabled", "disabled"].includes(localStaffEntry))
    throw Error("DNE_LOCAL_STAFF_ENTRY must be enabled or disabled.");
  const localSupportAssignment = env.DNE_LOCAL_SUPPORT_ASSIGNMENT ?? "disabled";
  if (!["enabled", "disabled"].includes(localSupportAssignment))
    throw Error("DNE_LOCAL_SUPPORT_ASSIGNMENT must be enabled or disabled.");
  const reviewerWorklistReads = env.DNE_REVIEWER_WORKLIST_READS ?? "enabled";
  if (!["enabled", "disabled"].includes(reviewerWorklistReads))
    throw Error("DNE_REVIEWER_WORKLIST_READS must be enabled or disabled.");
  const reviewTimeWrites = env.DNE_REVIEW_TIME_WRITES ?? "disabled";
  if (!["enabled", "disabled"].includes(reviewTimeWrites))
    throw Error("DNE_REVIEW_TIME_WRITES must be enabled or disabled.");
  const supportTimeWrites = env.DNE_SUPPORT_TIME_WRITES ?? "enabled";
  if (!["enabled", "disabled"].includes(supportTimeWrites))
    throw Error("DNE_SUPPORT_TIME_WRITES must be enabled or disabled.");
  const circleDiscussion = env.DNE_CIRCLE_DISCUSSION ?? "disabled";
  if (!["enabled", "disabled"].includes(circleDiscussion))
    throw Error("DNE_CIRCLE_DISCUSSION must be enabled or disabled.");
  const localHoldInspectionReads =
    env.DNE_LOCAL_AI_HOLD_INSPECTION ?? "disabled";
  if (!["enabled", "disabled"].includes(localHoldInspectionReads))
    throw Error("DNE_LOCAL_AI_HOLD_INSPECTION must be enabled or disabled.");
  const eventRegistration = env.DNE_EVENT_REGISTRATION ?? "disabled";
  if (!["enabled", "disabled"].includes(eventRegistration))
    throw Error("DNE_EVENT_REGISTRATION must be enabled or disabled.");
  return {
    localStaffEntry: localStaffEntry === "enabled",
    localSupportAssignment: localSupportAssignment === "enabled",
    localHoldInspectionReads: localHoldInspectionReads === "enabled",
    reviewerWorklistReads: reviewerWorklistReads === "enabled",
    reviewTimeWrites: reviewTimeWrites === "enabled",
    eventRegistration: eventRegistration === "enabled",
    circleDiscussion: circleDiscussion === "enabled",
    supportTimeWrites: supportTimeWrites === "enabled",
    databaseUrl,
    port,
    origin: new URL(`http://127.0.0.1:${port}`).origin,
    secret: randomBytes(32).toString("hex"),
    mode,
    adapters: adapterReadiness(env, mode),
    demoImpersonation: demoImpersonation(env.DNE_DEMO_IMPERSONATION, mode),
    privateStorageRoot,
  };
}
