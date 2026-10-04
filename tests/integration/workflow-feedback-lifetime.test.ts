import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  db = store(pool),
  normal = workflowFeedbackStore(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(() => pool.end());
const cases = (["commit", "handback"] as const).flatMap((boundary) =>
  (["list", "create", "update", "withdraw"] as const).map((operation) => ({
    boundary,
    operation,
  })),
);
it.each(cases)(
  "withholds late $operation at $boundary and preserves the committed outcome",
  async ({ boundary, operation }) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "explorer", goal: "everyday" });
    const session = await db.session(token);
    if (session.kind !== "active") throw Error("Missing fixture member");
    const id = session.learner.id;
    if (operation !== "create")
      expect(
        await normal.save(token, "WF-001", 1, "Invented private original", 0),
      ).toBe(true);
    const client = await pool.connect();
    let committed = false,
      released = false;
    const statements: string[] = [];
    const controlled = workflowFeedbackStore({
      connect: async () => ({
        async query(sql: string, values?: unknown[]) {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql === "COMMIT") {
            committed = true;
            if (boundary === "commit") await pool.query("SELECT pg_sleep(0.6)");
          }
          return result;
        },
        release(error?: Error) {
          if (boundary === "handback" && committed) {
            const end = performance.now() + 600;
            while (performance.now() < end) {
              /* native synchronous handback */
            }
          }
          released = true;
          client.release(error);
        },
      }),
    } as unknown as Pool);
    const origin = "http://127.0.0.1:3000",
      secret = "invented-workflow-lifetime";
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
        [id],
      );
      const response = await withLoopback(
        app(db, { origin, secret, workflowFeedback: controlled }),
        (server) => {
          const endpoint =
            "/workflow-feedback/WF-001" +
            (operation === "withdraw"
              ? "/withdraw"
              : operation === "list"
                ? ""
                : "/save");
          const call =
            operation === "list"
              ? request(server).get(endpoint)
              : request(server).post(endpoint);
          call
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `dne_preview=${token}`);
          return operation === "list"
            ? call
            : call
                .set("Origin", origin)
                .type("form")
                .send({
                  csrf: csrf(token, secret),
                  workflow_version: "1",
                  revision: operation === "create" ? "0" : "1",
                  note: "Invented replacement",
                  confirm: "yes",
                });
        },
      );
      expect(committed).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
            [id],
          )
        ).rows[0].expired,
      ).toBe(true);
      expect({
        status: response.status,
        disclosed: response.text.includes("Invented private original"),
      }).toEqual({
        status: operation === "list" ? 403 : 503,
        disclosed: false,
      });
      if (operation !== "list") expect(response.text).toContain("unconfirmed");
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(statements).not.toContain("ROLLBACK");
      const retained = (
        await pool.query(
          "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
          [id],
        )
      ).rows;
      expect(retained).toEqual(
        operation === "withdraw"
          ? []
          : [
              {
                note:
                  operation === "list"
                    ? "Invented private original"
                    : "Invented replacement",
                revision: operation === "update" ? 2 : 1,
              },
            ],
      );
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [id],
      );
      expect(await normal.list(token)).toMatchObject(retained);
    } finally {
      if (!released) client.release();
    }
  },
);

it.each(["before", "after"] as const)(
  "reports withdrawal uncertainty when transport fails %s COMMIT and recovers without replay",
  async (timing) => {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "professional", goal: "work" });
    expect(
      await normal.save(token, "WF-001", 1, "Invented retained note", 0),
    ).toBe(true);
    const backend = workflowFeedbackStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql === "COMMIT" && timing === "before")
              throw Error("Lost transport");
            const result = await client.query(sql, values);
            if (sql === "COMMIT") throw Error("Lost acknowledgement");
            return result;
          },
          release: (error?: Error) => client.release(error),
        };
      },
    } as unknown as Pool);
    const origin = "http://127.0.0.1:3000",
      secret = "invented-withdrawal-recovery";
    const response = await withLoopback(
      app(db, { origin, secret, workflowFeedback: backend }),
      (server) =>
        request(server)
          .post("/workflow-feedback/WF-001/withdraw")
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `dne_preview=${token}`)
          .type("form")
          .send({
            csrf: csrf(token, secret),
            workflow_version: "1",
            revision: "1",
            confirm: "yes",
          }),
    );
    expect(response.status).toBe(503);
    expect(response.text).toContain("Feedback withdrawal unconfirmed");
    expect(response.text).not.toContain("Nothing was removed");
    const rows = await normal.list(token);
    expect(rows).toHaveLength(timing === "before" ? 1 : 0);
    if (timing === "before")
      expect(rows?.[0]).toMatchObject({
        note: "Invented retained note",
        revision: 1,
      });
  },
);
