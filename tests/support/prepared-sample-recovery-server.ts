import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { preparedObjectStorage } from "../../src/prepared-sample-storage.ts";
import { preparedSampleStore } from "../../src/prepared-samples.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { listenLoopback, closeLoopback } from "./loopback-server.ts";
/** The only injected fault follows a successful real PostgreSQL COMMIT. No
 * production fault switch, retry or unsafe deletion of potentially saved bytes. */
export async function startPreparedSampleRecoveryServer(
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
          if (sql.includes("INSERT INTO provided_evidence_operations"))
            created = true;
          if (sql === "ROLLBACK" && committed) observed.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && created) {
            committed = true;
            observed.commits++;
            if (observed.lostReplies === 0) {
              observed.lostReplies++;
              throw Error("Invented lost prepared-copy COMMIT reply");
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const secret = randomBytes(32).toString("hex");
  const options = {
    origin: "http://127.0.0.1:0",
    secret,
    mode: "test" as const,
    preparedReviewSamples: true,
    preparedSamples: preparedSampleStore(scoped, {
      enabled: true,
      mode: "test",
      origin: "http://127.0.0.1:0",
    }),
    evidence: evidenceStore(
      pool,
      preparedObjectStorage(pool, fileObjectStorage(root)),
      secret,
    ),
    memberExport: memberExportStore(pool),
  };
  const server = await listenLoopback(app(store(pool), options));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLoopback(server);
    throw Error("Owned recovery listener unavailable");
  }
  options.origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin: options.origin,
    observed,
    close: () => closeLoopback(server),
  };
}
