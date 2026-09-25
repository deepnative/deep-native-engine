import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, store } from "./store.ts";
import { app } from "./app.ts";
import { authorizationStore } from "./authorization.ts";
import { evidenceStore, fileObjectStorage } from "./evidence.ts";
import { catalogStore, seedDraftPack } from "./catalog.ts";
import { trackStore } from "./track-readiness.ts";
import { proposalStore } from "./proposals.ts";
import { careerStore } from "./career.ts";
import { circleStore } from "./circles.ts";
import { metricsStore } from "./metrics.ts";
import { attemptStore } from "./attempts.ts";
import { practiceStore } from "./practice.ts";
import { memberExportStore } from "./member-export.ts";

export function evidenceCapabilityClock(
  mode: string,
  privateStorageRoot: string,
  enabled: string | undefined,
): () => number {
  if (mode !== "test" || enabled !== "1") return Date.now;
  const file = join(privateStorageRoot, ".test-evidence-clock");
  return () => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Date.now();
      throw error;
    }
    const instant = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(instant))
      throw new Error("Invalid test evidence clock.");
    return instant;
  };
}

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
    await seedDraftPack(pool);
    const server = app(store(pool), {
      ...settings,
      authorization: authorizationStore(pool),
      catalog: catalogStore(pool),
      tracks: trackStore(pool),
      proposals: proposalStore(pool),
      career: careerStore(pool),
      circles: circleStore(pool),
      metrics: metricsStore(pool),
      attempts: attemptStore(pool),
      practice: practiceStore(pool),
      memberExport: memberExportStore(pool),
      evidence: evidenceStore(
        pool,
        fileObjectStorage(settings.privateStorageRoot),
        settings.secret,
        evidenceCapabilityClock(
          settings.mode,
          settings.privateStorageRoot,
          env.DNE_TEST_EVIDENCE_CLOCK,
        ),
      ),
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
