import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventAttendanceStore } from "../../src/event-attendance.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { memberEventCatalog } from "../../src/member-event-catalog.ts";
import { eventCatalogReader } from "../../src/event-catalog.ts";
/** Owned browser fault fixture loses only a successful permission COMMIT reply.
 * No production fault switch, fabricated save or automatic dispatch is added. */
export async function startAttendanceRecoveryServer(pool: Pool) {
  const evidence = { permissionCommits: 0, lostReplies: 0 },
    secret = randomBytes(32).toString("hex");
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let permission = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO private_event_attendance_permissions"))
            permission = true;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && permission) {
            evidence.permissionCommits++;
            if (evidence.lostReplies === 0) {
              evidence.lostReplies++;
              throw Error(
                "Invented lost successful permission COMMIT acknowledgement",
              );
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  let server: Server | undefined,
    origin = "http://127.0.0.1:0";
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server
        ? server.close((error) => (error ? reject(error) : resolve()))
        : resolve(),
    );
  const listen = async (enabled: boolean, port: number) => {
    const reader = eventCatalogReader();
    const options = {
      origin,
      secret,
      mode: "test" as const,
      localStaffEntry: true,
      eventRegistration: true,
      staffEntry: staffEntryStore(pool),
      authorization: authorizationStore(pool),
      eventAttendance: eventAttendanceStore(
        scoped,
        { mode: "test", enabled, registration: true },
        secret,
      ),
      eventEnrollments: eventEnrollmentStore(pool, {
        mode: "test",
        enabled: true,
        catalogReader: reader,
      }),
      memberEvents: memberEventCatalog(pool, "test", reader),
    };
    server = app(store(pool), options).listen(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned attendance fixture listener unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    options.origin = origin;
  };
  try {
    await listen(true, 0);
    return {
      origin,
      evidence,
      close,
      pause: async () => {
        const port = Number(new URL(origin).port);
        await close();
        server = undefined;
        await listen(false, port);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
