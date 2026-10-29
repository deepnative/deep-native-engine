import { randomBytes } from "node:crypto";
import express from "express";
import type { Pool, PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { attemptStore } from "../../src/attempts.ts";
import { catalogStore } from "../../src/catalog.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { assignmentEvidenceStore } from "../../src/assignment-evidence.ts";
import { assignmentObjectStorage } from "../../src/assignment-evidence-storage.ts";
import { preparedObjectStorage } from "../../src/prepared-sample-storage.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { listenLoopback, closeLoopback } from "./loopback-server.ts";

/** Test-only driver boundary: lose one reply AFTER an actual successful COMMIT.
 * Configuration rollback replaces the app on the same owned random-port server,
 * retaining its database and origin. A restarted app gets a fresh secret, making
 * old browser forms stale as they are after a runtime restart. No production
 * fault flag, fabricated receipt, automatic retry or shared gate server. */
export async function startAssignmentEvidenceRecoveryServer(
  pool: Pool,
  root: string,
) {
  const observed = { commits: 0, lostReplies: 0, rollbacksAfterCommit: 0 };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let created = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO assignment_evidence_operations"))
            created = true;
          if (sql === "ROLLBACK" && committed) observed.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && created) {
            committed = true;
            observed.commits++;
            if (observed.lostReplies === 0) {
              observed.lostReplies++;
              throw Error("Invented lost assignment-copy COMMIT reply");
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const common = {
    origin: "http://127.0.0.1:0",
    secret: randomBytes(32).toString("hex"),
    mode: "test" as const,
    attempts: attemptStore(pool),
    catalog: catalogStore(pool),
    memberExport: memberExportStore(pool),
  };
  const createApplication = (enabled: boolean) =>
    app(store(pool), {
      ...common,
      evidence: evidenceStore(
        pool,
        assignmentObjectStorage(
          pool,
          preparedObjectStorage(pool, fileObjectStorage(root)),
        ),
        common.secret,
      ),
      assignmentHandoff: enabled,
      assignmentEvidence: assignmentEvidenceStore(scoped, { enabled }),
    });
  let application = createApplication(true);
  const router = express();
  router.use((req, res, next) => application(req, res, next));
  const server = await listenLoopback(router);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLoopback(server);
    throw Error("Owned assignment recovery listener unavailable");
  }
  common.origin = `http://127.0.0.1:${address.port}`;
  application = createApplication(true);
  return {
    server,
    origin: common.origin,
    observed,
    setCreationEnabled(enabled: boolean) {
      application = createApplication(enabled);
    },
    restartWithFreshSecret(enabled: boolean) {
      common.secret = randomBytes(32).toString("hex");
      application = createApplication(enabled);
    },
    close: () => closeLoopback(server),
  };
}
