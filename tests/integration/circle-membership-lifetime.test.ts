import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { circleStore } from "../../src/circles.ts";
import { csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  db = store(pool),
  normal = circleStore(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
const circle = "everyday-ai";
const cases = (["list", "join", "leave"] as const).flatMap((operation) =>
  (["commit", "handback"] as const).map((boundary) => ({
    operation,
    boundary,
  })),
);
it.each(cases)(
  "withholds $operation after expiry at $boundary and recovers its one durable membership",
  async ({ operation, boundary }) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "explorer", goal: "everyday" });
    const member = await db.session(token);
    if (member.kind !== "active") throw Error("Missing invented member");
    if (operation !== "join")
      expect(await normal.join(token, circle)).toBe("joined");
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    let committed = false,
      discarded = false;
    const backend = circleStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              committed = true;
              if (boundary === "commit") {
                const reply = pool.query("SELECT pg_sleep(1.2)");
                replies.push(reply);
                await reply;
              }
            }
            return result;
          },
          release(error?: Error) {
            if (boundary === "handback" && committed) {
              const until = performance.now() + 1200;
              while (performance.now() < until) {
                /* native synchronous handback */
              }
            }
            discarded = !!error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const origin = "http://127.0.0.1:3000",
      secret = "invented-circle-lifetime";
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [member.learner.id],
      );
      const response = await withLoopback(
        app(db, { origin, secret, circles: backend }),
        (server) => {
          const call = (
            operation === "list"
              ? request(server).get("/circles")
              : request(server).post(`/circles/${circle}/${operation}`)
          )
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `dne_preview=${token}`);
          return operation === "list"
            ? call
            : call
                .set("Origin", origin)
                .type("form")
                .send({ csrf: csrf(token, secret) });
        },
      );
      await Promise.all(replies);
      expect(
        (
          await pool.query(
            "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
            [member.learner.id],
          )
        ).rows[0].expired,
      ).toBe(true);
      expect(committed).toBe(true);
      expect.soft(response.status).toBe(operation === "list" ? 403 : 503);
      expect.soft(response.headers.location).toBeUndefined();
      expect.soft(response.text).not.toContain(`/circles/${circle}/leave`);
      if (operation !== "list") {
        expect.soft(response.text).toMatch(/unconfirmed/i);
        expect.soft(response.text).toContain('href="/circles"');
        expect.soft(response.text).not.toContain("<form");
      }
      expect.soft(discarded).toBe(true);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(statements).not.toContain("ROLLBACK");
      const readState = async () => ({
        membership: (
          await pool.query(
            "SELECT circle_id,generation,joined_at,left_at FROM preview_circle_memberships WHERE member_id=$1",
            [member.learner.id],
          )
        ).rows,
        history: (
          await pool.query(
            "SELECT circle_id,generation,joined_at,left_at FROM preview_circle_membership_history WHERE member_id=$1 ORDER BY generation",
            [member.learner.id],
          )
        ).rows,
      });
      const before = await readState();
      expect(before.membership).toHaveLength(1);
      expect(before.membership[0]).toMatchObject({
        circle_id: circle,
        generation: "1",
        left_at: operation === "leave" ? expect.any(Date) : null,
      });
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [member.learner.id],
      );
      expect(
        (await normal.list(token))?.find((item) => item.id === circle)?.joined,
      ).toBe(operation !== "leave");
      expect(await readState()).toEqual(before);
    } finally {
      await Promise.allSettled(replies);
    }
  },
);

const stalledCases = (["list", "join", "leave"] as const).flatMap((operation) =>
  (["query", "commit", "rollback"] as const).map((boundary) => ({
    operation,
    boundary,
  })),
);
it.each(stalledCases)(
  "bounds $operation at unresolved $boundary without queued rollback or replay",
  async ({ operation, boundary }) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "professional", goal: "work" });
    const member = await db.session(token);
    if (member.kind !== "active") throw Error("Missing invented member");
    if (operation !== "join")
      expect(await normal.join(token, circle)).toBe("joined");
    let resume!: () => void;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const statements: string[] = [],
      replies: Promise<unknown>[] = [];
    let released = 0,
      discarded = false,
      intercepted = false;
    const backend = circleStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            if (boundary === "rollback" && sql.includes("p.token_hash=$1"))
              return { rows: [] };
            const result = await client.query(sql, values);
            if (
              (boundary === "query" &&
                (operation === "list"
                  ? sql.includes("BOOL_OR")
                  : operation === "join"
                    ? sql.includes("INSERT INTO preview_circle_memberships")
                    : sql.includes(
                        "UPDATE preview_circle_memberships SET left_at",
                      ))) ||
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
            released++;
            discarded = !!error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const entered = performance.now();
    try {
      const pending =
        operation === "list"
          ? backend.list(token)
          : operation === "join"
            ? backend.join(token, circle)
            : backend.leave(token, circle);
      if (operation === "list") expect(await pending).toBeNull();
      else
        await expect(pending).rejects.toThrow("Circle operation unconfirmed");
      expect(intercepted).toBe(true);
      expect(performance.now() - entered).toBeLessThan(8000);
      expect(released).toBe(1);
      expect(discarded).toBe(true);
      expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(
        boundary === "rollback" ? 1 : 0,
      );
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(
        boundary === "commit" ? 1 : 0,
      );
      resume();
      await Promise.all(replies);
      const row = (
        await pool.query(
          "SELECT generation,left_at IS NULL active FROM preview_circle_memberships WHERE member_id=$1",
          [member.learner.id],
        )
      ).rows[0];
      if (operation === "join" && boundary !== "commit")
        expect(row).toBeUndefined();
      else
        expect(row).toEqual({
          generation: "1",
          active: !(operation === "leave" && boundary === "commit"),
        });
    } finally {
      resume();
      await Promise.allSettled(replies);
    }
  },
  12000,
);

it.each(["list", "join", "leave"] as const)(
  "bounds %s pool exhaustion and disposes the late connection without querying",
  async (operation) => {
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
    const backend = circleStore({
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
      const pending =
        operation === "list"
          ? backend.list("invented-token")
          : operation === "join"
            ? backend.join("invented-token", circle)
            : backend.leave("invented-token", circle);
      if (operation === "list") expect(await pending).toBeNull();
      else
        await expect(pending).rejects.toThrow("Circle operation unconfirmed");
      expect(performance.now() - entered).toBeLessThan(5000);
      expect(released).toBe(0);
      held.release();
      heldReturned = true;
      await late;
      await Promise.resolve();
      expect(released).toBe(1);
      expect(queried).toBe(false);
    } finally {
      if (!heldReturned) held.release();
      await limited.end();
    }
  },
  10000,
);
