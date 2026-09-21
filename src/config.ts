import { randomBytes } from "node:crypto";
export function config(env: NodeJS.ProcessEnv) {
  const databaseUrl = env.DNE_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Set DNE_DATABASE_URL to the local preview database.");
  const url = new URL(databaseUrl);
  if (
    url.search !== "" ||
    url.hash !== "" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("The preview requires a loopback PostgreSQL database.");
  const port = Number(env.DNE_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("DNE_PORT must be a valid port.");
  return {
    databaseUrl,
    port,
    origin: new URL(`http://127.0.0.1:${port}`).origin,
    secret: randomBytes(32).toString("hex"),
  };
}
