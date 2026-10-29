import { randomBytes } from "node:crypto";
import express from "express";
import type { Pool, PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { proposalStore } from "../../src/proposals.ts";
import { publicationStore } from "../../src/proposal-publication.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { listenLoopback, closeLoopback } from "./loopback-server.ts";

/** Lose one reply only after an actual publication COMMIT. Rebuilding the app
 * rotates its secret on the same owned origin; no production fault switch. */
export async function startPublicationRecoveryServer(pool: Pool) {
  const observed = { commits: 0, lostReplies: 0, rollbacksAfterCommit: 0 };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let published = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (
            sql.includes("UPDATE proposal_publications SET state='published'")
          )
            published = true;
          if (sql === "ROLLBACK" && committed) observed.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && published) {
            committed = true;
            observed.commits++;
            if (observed.lostReplies === 0) {
              observed.lostReplies++;
              throw Error("Invented lost publication COMMIT reply");
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
    localStaffEntry: true,
    staffEntry: staffEntryStore(pool),
    memberExport: memberExportStore(pool),
  };
  const create = (enabled: boolean) =>
    app(store(pool), {
      ...common,
      memberContributions: enabled,
      proposals: proposalStore(pool, undefined, { ordinaryEnabled: enabled }),
      publications: publicationStore(scoped, { enabled }),
    });
  let application = create(true);
  const router = express();
  router.use((req, res, next) => application(req, res, next));
  const server = await listenLoopback(router);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLoopback(server);
    throw Error("Owned recovery server absent");
  }
  common.origin = `http://127.0.0.1:${address.port}`;
  application = create(true);
  return {
    origin: common.origin,
    observed,
    close: () => closeLoopback(server),
    restart(enabled: boolean) {
      common.secret = randomBytes(32).toString("hex");
      application = create(enabled);
    },
  };
}
