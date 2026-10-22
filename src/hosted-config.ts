import type { ApplicationMode } from "./adapters.ts";

export interface HostedConfig {
  origin: string;
  blobAccountUrl: string;
  blobContainer: string;
  managedIdentityClientId: string;
  databaseAuthentication?: "managed-identity";
}

const blobKeys = [
  "DNE_AZURE_BLOB_ACCOUNT_URL",
  "DNE_AZURE_BLOB_CONTAINER",
  "DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID",
] as const;
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(host);
const invalid = () =>
  Error("Hosted application configuration is incomplete or invalid.");

/** Hosting is explicit and separate from the simulated provider contract. */
export function hostedConfig(
  env: NodeJS.ProcessEnv,
  database: URL,
  mode: ApplicationMode,
): HostedConfig | undefined {
  if (
    env.DNE_DATABASE_AUTH !== undefined &&
    env.DNE_DATABASE_AUTH !== "managed-identity"
  )
    throw invalid();
  if (env.DNE_PUBLIC_ORIGIN === undefined) {
    if (
      env.DNE_DATABASE_AUTH !== undefined ||
      blobKeys.some((key) => env[key] !== undefined)
    )
      throw invalid();
    return undefined;
  }
  let origin: URL;
  try {
    origin = new URL(env.DNE_PUBLIC_ORIGIN);
  } catch {
    throw invalid();
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== env.DNE_PUBLIC_ORIGIN ||
    origin.port !== "" ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      origin.hostname,
    ) ||
    origin.hostname.endsWith(".localhost") ||
    env.DNE_DEMO_IMPERSONATION === "true"
  )
    throw invalid();

  const parameters = [...database.searchParams];
  const name = database.pathname.slice(1);
  const identityDatabase = env.DNE_DATABASE_AUTH === "managed-identity";
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hash !== "" ||
    database.username === "" ||
    (identityDatabase
      ? database.password !== "" ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(database.username) ||
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.postgres\.database\.azure\.com$/.test(
          database.hostname,
        )
      : database.password === "") ||
    parameters.length !== 1 ||
    parameters[0]![0] !== "sslmode" ||
    parameters[0]![1] !== "verify-full" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
    (mode === "test"
      ? !loopback(database.hostname) || !/^dne_test_[a-f0-9]{32}$/.test(name)
      : loopback(database.hostname) || /(^|_)(dev|demo|test)($|_)/.test(name))
  )
    throw invalid();

  const blobAccountUrl = env.DNE_AZURE_BLOB_ACCOUNT_URL;
  const blobContainer = env.DNE_AZURE_BLOB_CONTAINER;
  const managedIdentityClientId = env.DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID;
  if (
    typeof blobAccountUrl !== "string" ||
    !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(
      blobAccountUrl,
    ) ||
    typeof blobContainer !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(blobContainer) ||
    blobContainer.includes("--") ||
    typeof managedIdentityClientId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      managedIdentityClientId,
    )
  )
    throw invalid();
  return {
    origin: origin.origin,
    blobAccountUrl,
    blobContainer,
    managedIdentityClientId,
    ...(identityDatabase
      ? { databaseAuthentication: "managed-identity" as const }
      : {}),
  };
}
