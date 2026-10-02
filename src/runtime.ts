import { Pool } from "pg";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, store } from "./store.ts";
import { app } from "./app.ts";
import { authorizationStore } from "./authorization.ts";
import { evidenceStore, fileObjectStorage } from "./evidence.ts";
import { deterministicRegistry } from "./adapters.ts";
import { localAiConsentStore } from "./local-ai-consent.ts";
import { localAiControlStore } from "./local-ai-control.ts";
import { catalogStore, seedDraftPack } from "./catalog.ts";
import { trackStore } from "./track-readiness.ts";
import { proposalStore } from "./proposals.ts";
import { careerStore } from "./career.ts";
import { circleStore } from "./circles.ts";
import { metricsStore } from "./metrics.ts";
import { attemptStore } from "./attempts.ts";
import { practiceStore } from "./practice.ts";
import { practiceSessionStore } from "./practice-sessions.ts";
import { memberExportStore } from "./member-export.ts";
import { usefulnessStore } from "./usefulness.ts";
import { workflowFeedbackStore } from "./workflow-feedback.ts";
import { memberSlotHolds } from "./slot-holds.ts";
import { availabilityStore } from "./availability.ts";
import { manualObservationStore } from "./manual-observations.ts";
import { assignmentReadinessStore } from "./assignment-readiness.ts";
import { recoverPendingMemberDeletions } from "./deletion-recovery.ts";

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
  let ownedServer: Server | undefined;
  try {
    await migrate(pool);
    await seedDraftPack(pool);
    const objects = fileObjectStorage(settings.privateStorageRoot);
    const options = {
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
      practiceSessions: practiceSessionStore(pool),
      memberExport: memberExportStore(pool),
      usefulness: usefulnessStore(pool),
      workflowFeedback: workflowFeedbackStore(pool),
      availability: availabilityStore(pool),
      memberSlotHolds: memberSlotHolds(pool),
      manualObservations: manualObservationStore(pool),
      assignmentReadiness: assignmentReadinessStore(pool),
      // config() rejects live hosting before reaching this local runtime.
      localAiConsent: localAiConsentStore(
        pool,
        objects,
        deterministicRegistry(env, settings.mode as "demo" | "test"),
      ),
      localAiControl: localAiControlStore(pool),
      evidence: evidenceStore(
        pool,
        objects,
        settings.secret,
        evidenceCapabilityClock(
          settings.mode,
          settings.privateStorageRoot,
          env.DNE_TEST_EVIDENCE_CLOCK,
        ),
      ),
    };
    const server = app(store(pool), options).listen(settings.port, "127.0.0.1");
    ownedServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.port < 1)
      throw new Error("The local listener has no bound TCP address.");
    // app() reads this shared options object for every Host/Origin check.
    // Publish the bound address synchronously before recovery or another await.
    options.port = address.port;
    options.origin = new URL("http://127.0.0.1:" + address.port).origin;
    let cursor: string | null = null;
    let activeRecovery: Promise<void> | undefined;
    const recover = () => {
      if (activeRecovery) return;
      activeRecovery = (async () => {
        try {
          const result = await recoverPendingMemberDeletions(
            pool,
            objects,
            cursor,
          );
          cursor = result.nextCursor;
          if (result.failed)
            console.error("A pending local deletion will be retried.");
        } catch {
          console.error("Pending local deletion recovery is unavailable.");
        }
      })().finally(() => {
        activeRecovery = undefined;
      });
    };
    const recoveryTimer = setInterval(recover, 5_000);
    recoveryTimer.unref();
    recover();
    return {
      server,
      port: options.port,
      origin: options.origin,
      close: async () => {
        clearInterval(recoveryTimer);
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } finally {
          await activeRecovery;
          await pool.end();
        }
      },
    };
  } catch (error) {
    try {
      if (ownedServer?.listening)
        await new Promise<void>((resolve, reject) =>
          ownedServer!.close((failure) =>
            failure ? reject(failure) : resolve(),
          ),
        );
    } finally {
      await pool.end();
    }
    throw error;
  }
}
