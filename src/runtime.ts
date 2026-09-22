import { Pool } from "pg";
import { config } from "./config.ts";
import { migrate, store } from "./store.ts";
import { app } from "./app.ts";
import { authorizationStore } from "./authorization.ts";
export async function start(env: NodeJS.ProcessEnv) {
  const settings = config(env);
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    application_name: "deep-native-preview",
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on("error", () =>
    console.error("Database connection interrupted; retry the request."),
  );
  try {
    await migrate(pool);
    const server = app(store(pool), {
      ...settings,
      authorization: authorizationStore(pool),
    }).listen(settings.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return {
      server,
      close: async () => {
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } finally {
          await pool.end();
        }
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
