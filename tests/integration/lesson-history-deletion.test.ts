import type { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool();
const db = store(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Missing synthetic member");
  return { token, id: session.learner.id };
}
async function fixture() {
  const owner = await member();
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const lesson: DraftContent = {
    id: "SYN-989",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented retained lesson",
    body: "Compare invented sample details.",
    owner: "Synthetic editor",
    sources: "Original synthetic brief",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  for (const id of [lesson.id, "SYN-990"]) {
    expect(await catalog.createDraft(editor, { ...lesson, id })).toBe(true);
    expect(await catalog.submit(editor, id, 1)).toBe(true);
    expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
    expect(await catalog.publish(editor, id, 1)).toBe(true);
  }
  expect(await db.openLesson(owner.id, lesson.id, 1)).toBe(true);
  const retained = async () =>
    (
      await pool.query(
        "SELECT * FROM lesson_activity WHERE member_id=$1 ORDER BY content_id",
        [owner.id],
      )
    ).rows;
  return { owner, lesson, retained };
}
it("withholds retained private library history after committed deletion", async () => {
  const { owner, lesson, retained } = await fixture();
  const before = await retained();
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  await withLoopback(
    app(db, {
      origin: "http://127.0.0.1:3000",
      secret: "synthetic-lesson-secret",
      mode: "test",
      catalog: catalogStore(pool),
    }),
    async (server) => {
      const response = await request(server)
        .get("/library")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`);
      expect.soft(response.status).toBe(403);
      expect.soft(response.text).not.toContain(lesson.id);
      expect.soft(response.text).not.toContain(lesson.title);
      expect.soft(response.text).not.toContain("Opened in reader");
    },
  );
  expect(await retained()).toEqual(before);
});
it("cannot open or advance a lesson after committed deletion", async () => {
  const { owner, lesson, retained } = await fixture();
  const before = await retained();
  await withLoopback(
    app(db, {
      origin: "http://127.0.0.1:3000",
      secret: "synthetic-lesson-secret",
      mode: "test",
      catalog: catalogStore(pool),
    }),
    async (server) => {
      const page = await request(server)
        .get(`/library/${lesson.id}`)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1]!;
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
      const open = await request(server)
        .get("/library/SYN-990")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`);
      expect.soft(open.status).toBe(409);
      const start = await request(server)
        .post(`/library/${lesson.id}/progress`)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .set("Origin", "http://127.0.0.1:3000")
        .type("form")
        .send({ csrf, content_version: "1", intent: "start" });
      expect.soft(start.status).toBe(409);
    },
  );
  expect(await retained()).toEqual(before);
});
const operations = ["read", "open", "start", "complete"] as const;
type Operation = (typeof operations)[number];
async function operationFixture(kind: Operation) {
  const f = await fixture();
  if (kind === "complete")
    expect(await db.advanceLesson(f.owner.id, f.lesson.id, 1, "start")).toBe(
      true,
    );
  const act = (api = db, id = f.owner.id) =>
    kind === "read"
      ? api.lessonActivities(id)
      : kind === "open"
        ? api.openLesson(id, "SYN-990", 1)
        : api.advanceLesson(id, f.lesson.id, 1, kind);
  return { ...f, act };
}
async function denied(pending: Promise<unknown>, kind: Operation) {
  if (kind === "read")
    await expect(pending).rejects.toThrow("Lesson history unavailable");
  else expect(await pending).toBe(false);
}
async function blocksOn(pid: number, fragment: string) {
  await expect
    .poll(
      async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
 AND pid<>pg_backend_pid() AND $1::integer=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0`,
              [pid, fragment],
            )
          ).rows[0].count,
        ),
      { timeout: 3000 },
    )
    .toBe(1);
}
it.each(operations)(
  "denies %s for missing, revoked, expired and deleting owners without rewriting retained rows",
  async (kind) => {
    const f = await operationFixture(kind),
      before = await f.retained();
    const other = await member();
    if (kind === "read") expect(await f.act(db, other.id)).toEqual([]);
    else if (kind !== "open") expect(await f.act(db, other.id)).toBe(false);
    await denied(f.act(db, randomUUID()), kind);
    for (const state of ["revoked", "expired", "deleting"]) {
      await pool.query(
        "UPDATE principals SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
        [f.owner.id],
      );
      if (state === "revoked")
        await pool.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
      if (state === "expired")
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
      if (state === "deleting")
        await pool.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
      await denied(f.act(), kind);
      expect(await f.retained()).toEqual(before);
    }
  },
);
it.each(
  operations.flatMap((kind) =>
    ["principal", "workspace"].map((lock) => ({ kind, lock })),
  ),
)(
  "denies $kind when deletion commits during its $lock wait",
  async ({ kind, lock }) => {
    const f = await operationFixture(kind),
      before = await f.retained(),
      holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await holder.query(
        `SELECT id FROM principals WHERE id=$1 FOR ${lock === "principal" ? "UPDATE" : "SHARE"}`,
        [f.owner.id],
      );
      await holder.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        [f.owner.id],
      );
      pending = f.act();
      const denial = denied(pending, kind);
      await blocksOn(
        pid,
        lock === "principal"
          ? "SELECT id,expires_at"
          : "SELECT id FROM workspaces",
      );
      await holder.query("COMMIT");
      await denial;
      expect(await f.retained()).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      holder.release();
    }
  },
);
it.each(operations)(
  "finishes %s before deletion can acquire its workspace lock",
  async (kind) => {
    const f = await operationFixture(kind);
    let entered!: () => void,
      resume!: () => void,
      pid = 0;
    const locked = new Promise<void>((resolve) => (entered = resolve)),
      proceed = new Promise<void>((resolve) => (resume = resolve));
    const paused = store({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (
              sql.includes("FROM lesson_activity a") ||
              sql.startsWith("INSERT INTO lesson_activity") ||
              sql.startsWith("UPDATE lesson_activity")
            ) {
              pid = (await client.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid;
              entered();
              await proceed;
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    const reading = f.act(paused),
      deletion = await pool.connect();
    let deleting: Promise<void> | undefined;
    try {
      await locked;
      deleting = (async () => {
        await deletion.query("BEGIN");
        await deletion.query(
          "SELECT id FROM principals WHERE id=$1 FOR SHARE",
          [f.owner.id],
        );
        await deletion.query(
          "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
          [f.owner.id],
        );
        await deletion.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.owner.id],
        );
        await deletion.query("COMMIT");
      })();
      await blocksOn(pid, "SELECT id FROM workspaces");
      expect(
        (
          await pool.query("SELECT deleting_at FROM workspaces WHERE id=$1", [
            f.owner.id,
          ])
        ).rows,
      ).toEqual([{ deleting_at: null }]);
      resume();
      const result = await reading;
      if (kind === "read")
        expect(result).toMatchObject([
          { contentId: f.lesson.id, contentVersion: 1 },
        ]);
      else expect(result).toBe(true);
      await deleting;
      const retained = await f.retained();
      await denied(f.act(), kind);
      expect(await f.retained()).toEqual(retained);
    } finally {
      resume();
      await Promise.allSettled([reading, ...(deleting ? [deleting] : [])]);
      await deletion.query("ROLLBACK");
      deletion.release();
    }
  },
);
it.each(
  operations.flatMap((kind) =>
    ["principal", "workspace"].map((lock) => ({ kind, lock })),
  ),
)(
  "rolls back $kind after expiry during its $lock wait",
  async ({ kind, lock }) => {
    const f = await operationFixture(kind),
      before = await f.retained(),
      holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [f.owner.id],
      );
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await holder.query(
        `SELECT id FROM ${lock === "principal" ? "principals" : "workspaces"} WHERE id=$1 FOR UPDATE`,
        [f.owner.id],
      );
      pending = f.act();
      const denial = denied(pending, kind);
      await blocksOn(
        pid,
        lock === "principal"
          ? "SELECT id,expires_at"
          : "SELECT id FROM workspaces",
      );
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
                [f.owner.id],
              )
            ).rows[0].expired,
          { timeout: 3500, interval: 20 },
        )
        .toBe(true);
      await holder.query("COMMIT");
      await denial;
      expect(await f.retained()).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      holder.release();
    }
  },
);
it.each(
  operations.flatMap((kind) =>
    ["query", "commit-before", "commit-after"].map((fault) => ({
      kind,
      fault,
    })),
  ),
)(
  "withholds $kind on $fault failure without replay",
  async ({ kind, fault }) => {
    const f = await operationFixture(kind),
      before = await f.retained();
    let calls = 0,
      commits = 0;
    const broken = store({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const data =
              sql.includes("FROM lesson_activity a") ||
              sql.startsWith("INSERT INTO lesson_activity") ||
              sql.startsWith("UPDATE lesson_activity");
            if (data) calls++;
            if (sql === "COMMIT") {
              commits++;
              if (fault === "commit-before")
                throw new Error("Private synthetic transaction detail");
            }
            const result = await client.query(sql, values);
            if (
              (data && fault === "query") ||
              (sql === "COMMIT" && fault === "commit-after")
            )
              throw new Error("Private synthetic transaction detail");
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool);
    await expect(f.act(broken)).rejects.toThrow(
      "Private synthetic transaction detail",
    );
    expect(calls).toBe(1);
    expect(commits).toBe(fault === "query" ? 0 : 1);
    const after = await f.retained();
    if (fault !== "commit-after" || kind === "read")
      expect(after).toEqual(before);
    else expect(after).not.toEqual(before);
  },
);
