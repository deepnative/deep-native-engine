import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";

/** Owned browser fixture: lose only the acknowledgement after PostgreSQL really
 * commits the first grant. No production fault flag or automatic replay. */
export async function startCircleGrantRecoveryServer(pool: Pool) {
  const observation = {
    grantCommits: 0,
    lostReplies: 0,
    rollbacksAfterCommit: 0,
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let granting = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO preview_circle_moderator_grants"))
            granting = true;
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && granting) {
            committed = true;
            observation.grantCommits++;
            if (observation.lostReplies === 0) {
              observation.lostReplies++;
              throw Error("Invented lost circle grant COMMIT acknowledgement");
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const options = {
    origin: "http://127.0.0.1:0",
    secret: randomBytes(32).toString("hex"),
    mode: "test" as const,
    localStaffEntry: true,
    localCircleAdmin: true,
    circleDiscussionEnabled: true,
    staffEntry: staffEntryStore(pool),
    authorization: authorizationStore(pool),
    circleGrantAdmin: undefined as
      ReturnType<typeof circleGrantAdminStore> | undefined,
  };
  options.circleGrantAdmin = circleGrantAdminStore(scoped, options.secret, {
    mode: "test",
    writes: true,
    discussion: true,
  });
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
