import type { PoolConfig } from "pg";
import type { HostedConfig } from "./hosted-config.ts";
import { azureDatabasePassword } from "./azure-database.ts";

/** Both the application and explicit operator commands use the same identity. */
export function databaseConnection(settings: {
  databaseUrl: string;
  hosted?: HostedConfig;
}): PoolConfig {
  if (settings.hosted?.databaseAuthentication !== "managed-identity")
    return { connectionString: settings.databaseUrl };
  const database = new URL(settings.databaseUrl);
  return {
    host: database.hostname,
    port: Number(database.port || 5432),
    user: database.username,
    database: database.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
    password: azureDatabasePassword(settings.hosted.managedIdentityClientId),
  };
}
