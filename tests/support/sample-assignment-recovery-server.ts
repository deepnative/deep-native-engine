import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";

/** Test-owned port0 application. Its sole fault occurs after PostgreSQL really
 * commits the first assignment receipt. Staff entry, reads and erasure use the
 * normal pool. No production flag, private URL descriptor or automatic replay. */
export async function startSampleAssignmentRecoveryServer(
  pool: Pool,
  storageRoot: string,
) {
  const observation = {
    assignmentCommits: 0,
    lostReplies: 0,
    rollbacksAfterCommit: 0,
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let assignment = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO private_sample_assignment_operations"))
            assignment = true;
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && assignment) {
            committed = true;
            observation.assignmentCommits++;
            if (observation.lostReplies === 0) {
              observation.lostReplies++;
              throw Error("Invented lost assignment COMMIT response");
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
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    authorization: authorizationStore(pool),
    sampleAssignmentAdministration: true,
    sampleAssignments: sampleAssignmentStore(scoped, {
      enabled: true,
      mode: "test",
    }),
    evidence: evidenceStore(pool, fileObjectStorage(storageRoot), secret),
    memberExport: memberExportStore(pool),
  };
  let server: Server | undefined;
  try {
    server = app(store(pool), options).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned recovery listener unavailable");
    options.origin = `http://127.0.0.1:${address.port}`;
    const owned = server;
    return {
      origin: options.origin,
      observation,
      close: () =>
        new Promise<void>((resolve, reject) =>
          owned.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  } catch (error) {
    server?.close();
    throw error;
  }
}
