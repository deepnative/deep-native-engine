import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import request from "supertest";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { migrate, store } from "../../src/store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool();
const db = store(pool);
const attempts = attemptStore(pool);
const secret = "invented-attempt-lifetime-secret";
const privateText = "Invented retained private response for lifetime checks.";
const operations = [
  "start",
  "save",
  "submit",
  "revise",
  "reflection-save",
  "reflection-delete",
  "remove",
  "list",
  "detail",
] as const;
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, content_versions CASCADE");
});
afterAll(async () => pool.end());

async function fixture(
  operation: (typeof operations)[number] | "compare" | "portfolio",
) {
  const credential = token();
  await db.create(credential, { background: "explorer", goal: "everyday" });
  const session = await db.session(credential);
  if (session.kind !== "active") throw new Error("Missing invented member");
  const owner = session.learner.id;
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  const editor = token(),
    reviewer = token();
  await auth.provisionStaff(
    editor,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const draft: DraftContent = {
    id: "SYN-980",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented private lifetime assignment",
    body: "An invented brief",
    owner: "Invented editor",
    sources: "Original sample",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner, draft.id, 1)).toBe(true);
  let id = "";
  if (operation !== "start") {
    id = (await attempts.start(credential))!;
    expect(await attempts.save(credential, id, 1, privateText)).toBe(true);
    if (
      [
        "revise",
        "reflection-save",
        "reflection-delete",
        "compare",
        "portfolio",
      ].includes(operation)
    )
      expect(await attempts.submit(credential, id, 2)).toBe(true);
    if (operation === "reflection-delete")
      expect(
        await attempts.saveReflection(credential, id, 1, 0, {
          evidence: "Invented reflection",
          gaps: "",
          intention: "",
        }),
      ).toBe(true);
  }
  if (operation === "compare") {
    expect(await attempts.revise(credential, id)).toBe(true);
    expect(
      await attempts.save(
        credential,
        id,
        3,
        "Invented second immutable private response.",
      ),
    ).toBe(true);
    expect(await attempts.submit(credential, id, 4)).toBe(true);
  }
  return { credential, owner, id };
}

it.each(
  ([...operations, "compare", "portfolio"] as const).flatMap((operation) =>
    ["commit", "handback"].map((delay) => ({ operation, delay })),
  ),
)(
  "withholds expired $operation through successful $delay and recovers exact durable state without replay",
  async ({ operation, delay }) => {
    const item = await fixture(operation);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
      [item.owner],
    );
    const preRead = [
      "save",
      "submit",
      "revise",
      "reflection-save",
      "reflection-delete",
    ].includes(operation);
    let commits = 0,
      injected = false,
      releases = 0;
    const faultPool = {
      connect: async () => {
        const client = await pool.connect();
        let delayedRelease = false;
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              if (commits === (preRead ? 2 : 1)) {
                injected = true;
                if (delay === "commit")
                  await new Promise((resolve) => setTimeout(resolve, 2500));
                else delayedRelease = true;
              }
            }
            return result;
          },
          release: (error?: Error | boolean) => {
            if (delayedRelease)
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                2500,
              );
            releases++;
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const route =
      operation === "start"
        ? "/assignments/attempts/start"
        : operation === "list"
          ? "/assignments/attempts"
          : ["detail", "compare", "portfolio"].includes(operation)
            ? `/assignments/attempts/${item.id}${operation === "compare" ? "/compare?from=1&to=2" : operation === "portfolio" ? "/portfolio/1" : ""}`
            : operation.startsWith("reflection-")
              ? `/assignments/attempts/${item.id}/reflections/1/${operation === "reflection-save" ? "save" : "delete"}`
              : `/assignments/attempts/${item.id}/${operation === "remove" ? "delete" : operation}`;
    const response = await withLoopback(
      app(db, {
        origin: "http://127.0.0.1:3000",
        secret,
        attempts: attemptStore(faultPool),
      }),
      (server) => {
        let call = ["list", "detail", "compare", "portfolio"].includes(
          operation,
        )
          ? request(server).get(route)
          : request(server).post(route);
        call = call
          .set("Host", "127.0.0.1:3000")
          .set("Cookie", `${COOKIE}=${item.credential}`);
        return ["list", "detail", "compare", "portfolio"].includes(operation)
          ? call
          : call
              .set("Origin", "http://127.0.0.1:3000")
              .type("form")
              .send({
                csrf: csrf(item.credential, secret),
                revision: "2",
                response: "Invented changed response",
                confirm: "yes",
                sample_confirmed: "yes",
                reflection_revision:
                  operation === "reflection-delete" ? "1" : "0",
                evidence: "Invented new reflection",
                gaps: "",
                intention: "",
              });
      },
    );
    expect(injected).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [item.owner],
        )
      ).rows[0].expired,
    ).toBe(true);
    expect.soft(response.status).toBe(503);
    if (operation === "save") {
      expect
        .soft(response.text)
        .toContain("Response to copy before leaving this page");
      expect.soft(response.text).toContain("Invented changed response");
    }
    expect.soft(response.headers["content-disposition"]).toBeUndefined();
    expect
      .soft(response.text)
      .not.toContain("Invented private lifetime assignment");
    expect.soft(response.text).not.toContain(privateText);
    expect.soft(response.text).not.toContain("<form");
    expect
      .soft(response.text)
      .not.toMatch(/Nothing was (saved|submitted|deleted)/);
    // Let the deliberately delayed driver return settle before fresh authority.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(commits).toBe(preRead ? 2 : 1);
    expect(releases).toBe(preRead ? 2 : 1);
    const retained = async () => ({
      attempts: (
        await pool.query(
          "SELECT * FROM assignment_attempts WHERE member_id=$1 ORDER BY id",
          [item.owner],
        )
      ).rows,
      snapshots: (
        await pool.query(
          "SELECT s.* FROM assignment_submission_snapshots s JOIN assignment_attempts a ON a.id=s.attempt_id WHERE a.member_id=$1 ORDER BY s.sequence",
          [item.owner],
        )
      ).rows,
      reflections: (
        await pool.query(
          "SELECT r.* FROM assignment_submission_reflections r JOIN assignment_attempts a ON a.id=r.attempt_id WHERE a.member_id=$1 ORDER BY r.sequence",
          [item.owner],
        )
      ).rows,
    });
    const durable = await retained();
    expect(durable.attempts).toHaveLength(operation === "remove" ? 0 : 1);
    if (operation === "save")
      expect(durable.attempts[0]).toMatchObject({
        response: "Invented changed response",
        revision: 3,
      });
    if (operation === "submit") expect(durable.snapshots).toHaveLength(1);
    if (operation === "revise") {
      expect(durable.attempts[0].submitted_at).toBeNull();
      expect(durable.snapshots).toHaveLength(1);
    }
    if (operation === "reflection-save")
      expect(durable.reflections[0]).toMatchObject({
        evidence: "Invented new reflection",
        revision: 1,
      });
    if (operation === "reflection-delete")
      expect(durable.reflections[0]).toMatchObject({
        evidence: "",
        revision: 2,
      });
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [item.owner],
    );
    expect(await attempts.list(item.credential)).not.toBeNull();
    if (operation !== "remove")
      expect(
        await attempts.detail(item.credential, durable.attempts[0].id),
      ).not.toBeNull();
    expect(await retained()).toEqual(durable);
  },
  10_000,
);

function invoke(
  backend: ReturnType<typeof attemptStore>,
  operation: (typeof operations)[number],
  item: Awaited<ReturnType<typeof fixture>>,
) {
  if (operation === "start") return backend.start(item.credential);
  if (operation === "save")
    return backend.save(
      item.credential,
      item.id,
      2,
      "Invented changed response",
    );
  if (operation === "submit")
    return backend.submit(item.credential, item.id, 2);
  if (operation === "revise") return backend.revise(item.credential, item.id);
  if (operation === "reflection-save")
    return backend.saveReflection(item.credential, item.id, 1, 0, {
      evidence: "Invented new reflection",
      gaps: "",
      intention: "",
    });
  if (operation === "reflection-delete")
    return backend.deleteReflection(item.credential, item.id, 1, 1);
  if (operation === "remove") return backend.remove(item.credential, item.id);
  if (operation === "list") return backend.list(item.credential);
  return backend.detail(item.credential, item.id);
}

async function retained(owner: string) {
  return (
    await pool.query(
      `SELECT a.*,COALESCE((SELECT jsonb_agg(s ORDER BY s.sequence) FROM assignment_submission_snapshots s WHERE s.attempt_id=a.id),'[]'::jsonb) snapshots, COALESCE((SELECT jsonb_agg(r ORDER BY r.sequence) FROM assignment_submission_reflections r WHERE r.attempt_id=a.id),'[]'::jsonb) reflections FROM assignment_attempts a WHERE member_id=$1 ORDER BY id`,
      [owner],
    )
  ).rows;
}

it.each(
  operations.flatMap((operation) =>
    (["query", "commit", "rollback"] as const).map((boundary) => ({
      operation,
      boundary,
    })),
  ),
)(
  "bounds $operation at an unresolved $boundary and disposes without queued work or replay",
  async ({ operation, boundary }) => {
    const item = await fixture(operation);
    const before = await retained(item.owner);
    let resume!: () => void;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const statements: string[] = [];
    let intercepted = false,
      releases = 0,
      discarded = false;
    const backend = attemptStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            if (
              boundary === "rollback" &&
              sql.startsWith("SELECT id,expires_at")
            )
              return { rows: [] };
            const result = await client.query(sql, values);
            if (
              (boundary === "query" && sql.includes("assignment_attempts")) ||
              (boundary === "commit" && sql === "COMMIT") ||
              (boundary === "rollback" && sql === "ROLLBACK")
            ) {
              intercepted = true;
              await stalled;
            }
            return result;
          },
          release(error?: Error | boolean) {
            releases++;
            discarded = !!error;
            client.release(error);
          },
        };
      },
    } as unknown as Pool);
    const entered = performance.now();
    try {
      await expect(invoke(backend, operation, item)).rejects.toThrow(
        "Assignment attempt operation unconfirmed",
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
      const durable = await retained(item.owner);
      if (
        boundary !== "commit" ||
        operation === "list" ||
        operation === "detail"
      )
        expect(durable).toEqual(before);
      else if (operation === "remove") expect(durable).toEqual([]);
      else {
        expect(durable).toHaveLength(1);
        if (operation === "start")
          expect(durable[0]).toMatchObject({
            revision: 1,
            submission_count: 0,
          });
        if (operation === "save")
          expect(durable[0]).toMatchObject({
            revision: 3,
            response: "Invented changed response",
          });
        if (operation === "submit")
          expect(durable[0].snapshots).toHaveLength(1);
        if (operation === "revise") {
          expect(durable[0].submitted_at).toBeNull();
          expect(durable[0].snapshots).toHaveLength(1);
        }
        if (operation === "reflection-save")
          expect(durable[0].reflections[0]).toMatchObject({
            revision: 1,
            evidence: "Invented new reflection",
          });
        if (operation === "reflection-delete")
          expect(durable[0].reflections[0]).toMatchObject({
            revision: 2,
            evidence: "",
          });
      }
      expect(await attempts.list(item.credential)).not.toBeNull();
      expect(await retained(item.owner)).toEqual(durable);
      expect(
        statements.filter((sql) => sql.includes("assignment_attempts")),
      ).toHaveLength(boundary === "rollback" ? 0 : 1);
    } finally {
      resume();
    }
  },
  12000,
);

it.each(operations)(
  "bounds %s acquisition and discards the late real connection without a query",
  async (operation) => {
    const item = await fixture(operation);
    const before = await retained(item.owner);
    const { Pool: PgPool } = await import("pg");
    const limited = new PgPool({
      connectionString: process.env.DNE_TEST_DATABASE_URL,
      max: 1,
    });
    const held = await limited.connect();
    let late!: Promise<unknown>,
      released = 0,
      queried = false,
      returned = false;
    const backend = attemptStore({
      connect: () => {
        const acquisition = limited.connect().then((client) => ({
          query: (sql: string, values?: unknown[]) => {
            queried = true;
            return client.query(sql, values);
          },
          release: (error?: Error | boolean) => {
            released++;
            expect(error).toBeInstanceOf(Error);
            client.release(error);
          },
        }));
        late = acquisition;
        return acquisition;
      },
    } as unknown as Pool);
    try {
      const entered = performance.now();
      await expect(invoke(backend, operation, item)).rejects.toThrow(
        "Assignment attempt operation unconfirmed",
      );
      expect(performance.now() - entered).toBeLessThan(5000);
      expect(released).toBe(0);
      held.release();
      returned = true;
      await late;
      await Promise.resolve();
      expect(released).toBe(1);
      expect(queried).toBe(false);
      expect(await retained(item.owner)).toEqual(before);
    } finally {
      if (!returned) held.release();
      await limited.end();
    }
  },
  10000,
);
