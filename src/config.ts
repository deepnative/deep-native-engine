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
  if (!Number.isInteger(port) || port < 1 || port > 65535)
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
  return {
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
