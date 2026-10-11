import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { reviewTimeGrantAdminStore } from "../../src/review-time-grant-admin.ts";

/** Test-owned listener: lose the first grant and revoke acknowledgements only
 * after PostgreSQL actually commits each named write. No production fault flag,
 * retry, credentials in a URL, or use of the separate milestone preview. */
export async function startReviewTimeGrantRecoveryServer(
  pool: Pool,
  storageRoot: string,
  administration: "disabled" | "enabled" | "recovery-only" = "enabled",
  loseAcknowledgements = true,
) {
  const observation = {
    grantCommits: 0,
    revokeCommits: 0,
    grantLostReplies: 0,
    revokeLostReplies: 0,
    rollbacksAfterCommit: 0,
    databaseErrors: [] as string[],
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let action: "grant" | "revoke" | undefined;
      let committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO review_time_grants")) action = "grant";
          if (sql.includes("INSERT INTO review_time_grant_revocations"))
            action = "revoke";
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          let result;
          try {
            result = await client.query(sql, values);
          } catch (error) {
            // Retain fixed classifications only, never SQL arguments or text.
            const code = (error as { code?: string }).code;
            observation.databaseErrors.push(
              code &&
                [
                  "23502",
                  "23503",
                  "23505",
                  "23514",
                  "40P01",
                  "55P03",
                  "42703",
                  "42P01",
                  "P0001",
                ].includes(code)
                ? code
                : "other",
            );
            throw error;
          }
          if (sql === "COMMIT" && action) {
            committed = true;
            if (action === "grant") {
              observation.grantCommits++;
              if (loseAcknowledgements && observation.grantLostReplies === 0) {
                observation.grantLostReplies++;
                throw Error("Invented lost grant COMMIT acknowledgement");
              }
            } else {
              observation.revokeCommits++;
              if (loseAcknowledgements && observation.revokeLostReplies === 0) {
                observation.revokeLostReplies++;
                throw Error("Invented lost revoke COMMIT acknowledgement");
              }
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
    reviewTimeGrantAdministration: administration,
    reviewTimeGrantAdmin: reviewTimeGrantAdminStore(
      scoped,
      { administration, mode: "test" },
      Buffer.from(secret, "hex"),
    ),
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
