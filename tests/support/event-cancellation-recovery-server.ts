import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import type { EventPreview } from "../../src/events.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";

/** Owned browser fixture: lose only the acknowledgement after PostgreSQL really
 * commits the first cancellation. No production fault flag or automatic replay. */
export async function startEventCancellationRecoveryServer(
  pool: Pool,
  event: EventPreview,
) {
  const observation = {
    cancellationCommits: 0,
    lostReplies: 0,
    rollbacksAfterCommit: 0,
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let cancelling = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO private_event_cancellations"))
            cancelling = true;
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && cancelling) {
            committed = true;
            observation.cancellationCommits++;
            if (observation.lostReplies === 0) {
              observation.lostReplies++;
              throw Error(
                "Invented lost event cancellation COMMIT acknowledgement",
              );
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
    localEventAdmin: true,
    staffEntry: staffEntryStore(pool),
    authorization: authorizationStore(pool),
    eventCancellations: undefined as
      ReturnType<typeof eventCancellationStore> | undefined,
  };
  options.eventCancellations = eventCancellationStore(scoped, {
    mode: "test",
    writes: true,
    registration: true,
    catalog: [event],
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
