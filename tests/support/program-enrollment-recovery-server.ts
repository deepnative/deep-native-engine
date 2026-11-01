import { randomBytes } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore, type StaffRole } from "./administrator-fixture.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { programEnrollmentStore } from "../../src/program-enrollments.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { listenLoopback, closeLoopback } from "./loopback-server.ts";
import { dropAttendanceBrowserDatabase } from "./attendance-browser-database.ts";
import type { ProgramEnrollmentObservation } from "./program-enrollment-observation.ts";

/** Actual application and PostgreSQL with test-owned email/transport boundaries.
 * There are no fault routes or production switches, and no outbound delivery. */
export async function programEnrollmentFixture(
  observation?: ProgramEnrollmentObservation,
) {
  const step: ProgramEnrollmentObservation["step"] =
    observation?.step ?? ((_phase, action) => action());
  const base = process.env.DNE_TEST_DATABASE_URL;
  if (!base || !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(base).pathname))
    throw Error("Generated verification database required");
  const name = `dne_test_${randomBytes(16).toString("hex")}`;
  const adminUrl = new URL(base),
    ownUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const admin = new Pool({
    connectionString: adminUrl.href,
    connectionTimeoutMillis: 3000,
  });
  const pool = new Pool({
    connectionString: ownUrl.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  const state = {
    fault: "none" as
      "none" | "commit_after" | "commit_before" | "release_after",
    pause: null as null | {
      after: string;
      reached: () => void;
      resume: Promise<void>;
    },
    commits: 0,
    lostReplies: 0,
    inserts: 0,
    rollbacksAfterCommit: 0,
    delivered: [] as Array<{ address: string; link: string }>,
  };
  const scoped = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      let inserted = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql === "ROLLBACK" && committed) state.rollbacksAfterCommit++;
          if (sql === "COMMIT" && inserted && state.fault === "commit_before") {
            state.fault = "none";
            state.lostReplies++;
            await client.query("ROLLBACK");
            throw Error("Invented transport loss before COMMIT");
          }
          const result = await client.query(sql, values);
          if (sql.startsWith("INSERT INTO local_program_enrollments")) {
            inserted = true;
            state.inserts++;
          }
          if (sql === "COMMIT" && inserted) {
            committed = true;
            state.commits++;
            if (state.fault === "commit_after") {
              state.fault = "none";
              state.lostReplies++;
              throw Error("Invented transport loss after actual COMMIT");
            }
          }
          const pause = state.pause;
          if (pause && sql.includes(pause.after)) {
            state.pause = null;
            pause.reached();
            await pause.resume;
          }
          return result;
        }) as PoolClient["query"],
        release: (error?: Error | boolean) => {
          client.release(error);
          if (inserted && committed && state.fault === "release_after") {
            state.fault = "none";
            state.lostReplies++;
            throw Error(
              "Invented release acknowledgement loss after actual COMMIT",
            );
          }
        },
      };
    },
  } as unknown as Pool;
  let created = false;
  let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
  try {
    await step("create", () => admin.query(`CREATE DATABASE "${name}"`));
    created = true;
    await step("migrate", () => migrate(pool));
    await step("seed", () => seedDraftPack(pool));
    const router = express();
    router.use((req, res, next) => application(req, res, next));
    server = await step("listener", () => listenLoopback(router));
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned loopback listener unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const secret = randomBytes(32).toString("hex");
    const members = store(pool),
      auth = authorizationStore(pool),
      catalog = catalogStore(pool);
    const programs = programEnrollmentStore(scoped, "test");
    const email = memberEmailAccess(
      pool,
      {
        async send(address, link) {
          state.delivered.push({ address, link });
        },
      },
      origin,
    );
    const application = app(members, {
      origin,
      secret,
      mode: "test",
      catalog,
      programs,
      foundationImport: foundationImportStore(pool),
      authorization: auth,
      localStaffEntry: true,
      staffEntry: staffEntryStore(pool),
      memberEmail: email,
    });
    async function staff(role: StaffRole, lifetime = 3600000) {
      const token = randomBytes(32).toString("hex");
      const id = await auth.provisionStaff(
        token,
        role,
        new Date(Date.now() + lifetime),
      );
      return { id, token };
    }
    async function member(
      background: "explorer" | "professional" | "technical" = "explorer",
    ) {
      const token = randomBytes(32).toString("hex");
      await members.create(token, { background, goal: "everyday" });
      const session = await members.session(token);
      if (session.kind !== "active")
        throw Error("Owned fixture member missing");
      return { id: session.learner.id, token };
    }
    async function publish() {
      const editor = await staff("editor"),
        reviewer = await staff("reviewer");
      if (
        (await foundationImportStore(pool).import(editor.token)) !== "imported"
      )
        throw Error("Ordinary reviewed import unavailable");
      for (const item of await reviewedFoundation()) {
        if (
          !(await catalog.submit(editor.token, item.id, 2)) ||
          !(await catalog.approve(reviewer.token, item.id, 2, true)) ||
          !(await catalog.publish(editor.token, item.id, 2))
        )
          throw Error("Ordinary source publication unavailable");
      }
      return { editor, reviewer };
    }
    async function close() {
      await step("close-listener", () => closeLoopback(server!));
      await step("close-pool", () => pool.end());
      try {
        await step("close-drain-and-drop", () =>
          dropAttendanceBrowserDatabase(admin, name),
        );
      } finally {
        await step("close-admin", () => admin.end());
      }
    }
    return {
      pool,
      programs,
      members,
      auth,
      catalog,
      email,
      state,
      origin,
      secret,
      server,
      staff,
      member,
      publish,
      close,
    };
  } catch (error) {
    if (server) await step("close-listener", () => closeLoopback(server!));
    await step("close-pool", () => pool.end());
    try {
      if (created)
        await step("close-drain-and-drop", () =>
          dropAttendanceBrowserDatabase(admin, name),
        );
    } finally {
      await step("close-admin", () => admin.end());
    }
    throw error;
  }
}
