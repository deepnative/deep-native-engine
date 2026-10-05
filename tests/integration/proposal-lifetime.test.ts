import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool),
  normal = proposalStore(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(() => pool.end());
const value = {
  title: "Invented private title",
  body: "Invented private body",
  sources: "Invented source",
};
const operations = [
  "create",
  "owned",
  "preview",
  "edit",
  "submit",
  "withdraw",
  "queue",
  "changes",
  "quarantine",
  "reject",
] as const;
const cases = operations.flatMap((operation) =>
  (["commit", "handback"] as const).map((boundary) => ({
    operation,
    boundary,
  })),
);
it.each(cases)(
  "withholds $operation after authority expires at $boundary without replaying its durable outcome",
  async ({ operation, boundary }) => {
    const owner = randomBytes(32).toString("hex"),
      moderator = randomBytes(32).toString("hex");
    await db.create(owner, { background: "explorer", goal: "everyday" });
    const member = await db.session(owner);
    if (member.kind !== "active") throw Error("Missing member fixture");
    const staffId = await auth.provisionStaff(
      moderator,
      "moderator",
      new Date(Date.now() + 3600000),
    );
    const id = await normal.createDraft(owner, value, true);
    if (!id) throw Error("Missing proposal fixture");
    const staff = ["queue", "changes", "quarantine", "reject"].includes(
      operation,
    );
    if (staff)
      expect(await normal.submit(owner, id, true, 1)).toBe("submitted");
    const actor = staff ? staffId : member.learner.id,
      token = staff ? moderator : owner;
    let committed = false;
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    const backend = proposalStore({
      // Unchanged-source creation/listing use direct queries. Delay their reply
      // too, so this regression observes the original failure before migration.
      async query(sql: string, values?: unknown[]) {
        const result = await pool.query(sql, values);
        const reply = pool.query("SELECT pg_sleep(0.6)");
        replies.push(reply);
        await reply;
        return result;
      },
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              committed = true;
              if (boundary === "commit") {
                const reply = pool.query("SELECT pg_sleep(0.6)");
                replies.push(reply);
                await reply;
              }
            }
            return result;
          },
          release(error?: Error) {
            if (boundary === "handback" && committed) {
              const until = performance.now() + 600;
              while (performance.now() < until) {
                /* native synchronous handback */
              }
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const paths = {
      create: "/contribute",
      owned: "/contribute",
      preview: `/contribute/${id}`,
      edit: `/contribute/${id}/edit`,
      submit: `/contribute/${id}/submit`,
      withdraw: `/contribute/${id}/withdraw`,
      queue: "/moderate/proposals",
      changes: `/moderate/proposals/${id}/request-changes`,
      quarantine: `/moderate/proposals/${id}/quarantine`,
      reject: `/moderate/proposals/${id}/reject`,
    };
    const forms = {
      create: { ...value, sample_confirmed: "yes" },
      owned: {},
      preview: {},
      queue: {},
      edit: { ...value, body: "Invented correction", revision: "1" },
      submit: { revision: "1", rights_confirmed: "yes" },
      withdraw: { confirm: "yes" },
      changes: {
        revision: "1",
        feedback: "Invented change request",
        confirm: "yes",
      },
      quarantine: {},
      reject: {},
    };
    const origin = "http://127.0.0.1:3000",
      secret = "invented-proposal-lifetime",
      read = ["owned", "preview", "queue"].includes(operation);
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
        [actor],
      );
      const response = await withLoopback(
        app(db, { origin, secret, proposals: backend, authorization: auth }),
        (server) => {
          const call = (
            read
              ? request(server).get(paths[operation])
              : request(server).post(paths[operation])
          )
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `dne_preview=${token}`);
          return read
            ? call
            : call
                .set("Origin", origin)
                .type("form")
                .send({ ...forms[operation], csrf: csrf(token, secret) });
        },
      );
      await Promise.all(replies);
      expect(
        (
          await pool.query(
            "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
            [actor],
          )
        ).rows[0].expired,
      ).toBe(true);
      expect(response.status).toBe(
        read ? (operation === "preview" ? 404 : 403) : 503,
      );
      expect(response.headers.location).toBeUndefined();
      expect(response.text).not.toContain(value.body);
      if (read) expect(response.text).not.toContain(value.title);
      else
        expect(response.text).toMatch(
          /unconfirmed|unknown|could not be confirmed/i,
        );
      expect(committed).toBe(true);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(statements).not.toContain("ROLLBACK");
      const rows = (
        await pool.query(
          "SELECT id,state,revision FROM member_proposals ORDER BY id",
        )
      ).rows;
      expect(rows).toHaveLength(operation === "create" ? 2 : 1);
      const retained = rows.find((row) => row.id === id);
      expect(retained).toMatchObject({
        state:
          operation === "submit" || operation === "queue"
            ? "submitted"
            : operation === "changes"
              ? "changes_requested"
              : operation === "quarantine"
                ? "quarantined"
                : operation === "reject"
                  ? "rejected"
                  : operation === "withdraw"
                    ? "withdrawn"
                    : "draft",
        revision: operation === "edit" ? 2 : 1,
      });
      const auditBefore = (
        await pool.query("SELECT count(*)::int count FROM proposal_audit")
      ).rows[0].count;
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [actor],
      );
      await normal.owned(owner);
      expect(
        (await pool.query("SELECT count(*)::int count FROM proposal_audit"))
          .rows[0].count,
      ).toBe(auditBefore);
    } finally {
      await Promise.allSettled(replies);
    }
  },
);

it.each(["query", "commit", "rollback"] as const)(
  "bounds an unresolved %s reply and discards it without queuing another command",
  async (boundary) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "professional", goal: "work" });
    const id = await normal.createDraft(token, value, true);
    if (!id) throw Error("Missing proposal fixture");
    let resume!: () => void;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    let releases = 0,
      discarded = false,
      intercepted = false;
    const backend = proposalStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            // A missing principal establishes a known-open rollback path.
            if (
              boundary === "rollback" &&
              sql.startsWith("SELECT id,expires_at")
            )
              return { rows: [] };
            const result = await client.query(sql, values);
            if (
              (boundary === "query" &&
                sql.startsWith("UPDATE member_proposals")) ||
              (boundary === "commit" && sql === "COMMIT") ||
              (boundary === "rollback" && sql === "ROLLBACK")
            ) {
              intercepted = true;
              replies.push(stalled);
              await stalled;
            }
            return result;
          },
          release(error?: Error) {
            releases++;
            discarded = !!error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const entered = performance.now();
    try {
      await expect(backend.withdraw(token, id)).rejects.toThrow(
        "Proposal operation unconfirmed",
      );
      expect(intercepted).toBe(true);
      expect(performance.now() - entered).toBeLessThan(8000);
      expect(releases).toBe(1);
      expect(discarded).toBe(true);
      expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(
        boundary === "rollback" ? 1 : 0,
      );
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(
        boundary === "commit" ? 1 : 0,
      );
      resume();
      await Promise.all(replies);
      expect(await normal.preview(token, id)).toMatchObject({
        state: boundary === "commit" ? "withdrawn" : "draft",
        body: boundary === "commit" ? null : value.body,
      });
    } finally {
      resume();
      await Promise.allSettled(replies);
    }
  },
  12000,
);

it("bounds real exhausted-pool acquisition and discards the late connection without querying", async () => {
  const { Pool: PgPool } = await import("pg");
  const limited = new PgPool({
    connectionString: process.env.DNE_TEST_DATABASE_URL,
    max: 1,
  });
  const held = await limited.connect();
  let late!: Promise<void>,
    released = 0,
    queried = false,
    heldReturned = false;
  const backend = proposalStore({
    connect: () => {
      const acquisition = limited.connect().then((client) => ({
        query: (sql: string, values?: unknown[]) => {
          queried = true;
          return client.query(sql, values);
        },
        release: (error?: Error) => {
          released++;
          expect(error).toBeInstanceOf(Error);
          client.release(error);
        },
      }));
      late = acquisition.then(() => {});
      return acquisition;
    },
  } as unknown as Pool);
  try {
    const entered = performance.now();
    expect(await backend.owned("invented-token")).toBeNull();
    expect(performance.now() - entered).toBeLessThan(5000);
    expect(released).toBe(0);
    held.release();
    heldReturned = true;
    await late;
    // The transaction's pending acquisition callback runs in the same microtask turn.
    await Promise.resolve();
    expect(released).toBe(1);
    expect(queried).toBe(false);
  } finally {
    if (!heldReturned) held.release();
    await limited.end();
  }
}, 10000);

it("locks owner lists in UUID order while retaining newest-first display", async () => {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "technical", goal: "build" });
  const ids = [
    await normal.createDraft(token, value, true),
    await normal.createDraft(token, value, true),
  ].sort();
  await pool.query(
    "UPDATE member_proposals SET created_at=CASE WHEN id=$1 THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END",
    [ids[0]],
  );
  const blocker = await pool.connect(),
    competitor = await pool.connect();
  let pid: number | undefined, pending: Promise<unknown> | undefined;
  const backend = proposalStore({
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      return client;
    },
  } as unknown as Pool);
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE",
      [ids[0]],
    );
    pending = backend.owned(token);
    let waiting = false;
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      if (
        pid &&
        (
          await pool.query(
            "SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.waiting
      ) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await competitor.query("BEGIN");
    let available = true;
    try {
      await competitor.query(
        "SELECT id FROM member_proposals WHERE id=$1 FOR UPDATE NOWAIT",
        [ids[1]],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "55P03") throw error;
      available = false;
    }
    await competitor.query("ROLLBACK");
    await blocker.query("ROLLBACK");
    const listed = await pending;
    pending = undefined;
    expect(available).toBe(true);
    expect((listed as { id: string }[]).map((row) => row.id)).toEqual(
      ids.slice().reverse(),
    );
  } finally {
    await competitor.query("ROLLBACK");
    competitor.release();
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
});
