import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store, type Store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool),
  catalog = catalogStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-selection-boundary";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function member(
  background: "technical" | "professional" | "explorer" = "explorer",
) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token, id: session.learner.id };
}
async function fixture(existing = false, changes: Partial<DraftContent> = {}) {
  const owner = await member(),
    editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const item: DraftContent = {
    id: "SYN-956",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented private selection sample",
    body: "Invented selection brief only.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (draft: DraftContent) => {
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, draft.id, draft.version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, draft.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, draft.id, draft.version)).toBe(true);
  };
  await publish(item);
  if (existing) {
    expect(await db.chooseAssignment(owner.id, item.id, 1)).toBe(true);
    await pool.query(
      "UPDATE learner_assignment_choices SET chosen_at='2026-01-01' WHERE member_id=$1",
      [owner.id],
    );
  }
  await publish({ ...item, version: 2, ...changes });
  return { owner, item, editor, publish };
}
function post(
  token: string,
  source: Store = db,
  extra: Record<string, string> = {},
) {
  return withLoopback(app(source, { origin, secret, catalog }), (server) =>
    request(server)
      .post("/assignments/select")
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({
        csrf: csrf(token, secret),
        content_id: "SYN-956",
        content_version: "2",
        ...extra,
      }),
  );
}
async function snapshot(id: string) {
  return (
    await pool.query(
      "SELECT * FROM learner_assignment_choices WHERE member_id=$1",
      [id],
    )
  ).rows;
}
async function pauseAfterPreflight(
  token: string,
  source: Store = db,
  extra: Record<string, string> = {},
) {
  const reached = gate(),
    resume = gate();
  const pending = post(
    token,
    {
      ...source,
      chooseAssignment: async (...args) => {
        reached.release();
        await resume.wait;
        return source.chooseAssignment(...args);
      },
    },
    extra,
  );
  await Promise.race([
    reached.wait,
    pending.then(() => {
      throw Error("Selection never reached its write boundary");
    }),
  ]);
  return { pending, resume };
}

it.each([false, true])(
  "denies a selection after preflight when deletion committed first (existing choice: %s)",
  async (existing) => {
    const { owner, item } = await fixture(existing),
      before = await snapshot(owner.id);
    const { pending, resume } = await pauseAfterPreflight(owner.token);
    try {
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
      resume.release();
      const response = await pending;
      expect.soft(response.status).toBe(403);
      expect.soft(response.headers.location).toBeUndefined();
      expect.soft(response.text).not.toContain(item.title);
      expect.soft(response.text).not.toContain(owner.id);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      resume.release();
      await pending;
    }
  },
);

import type { Pool, PoolClient } from "pg";
async function blocked(fragment: string) {
  for (let n = 0; n < 150; n++) {
    const { rows } = await pool.query(
      "SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND position($1 in query)>0",
      [fragment],
    );
    if (rows.some((row) => row.blockers.length)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
async function expired(id: string) {
  for (let n = 0; n < 200; n++) {
    const result = await pool.query(
      "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
      [id],
    );
    if (result.rows[0].expired) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
function get(token: string) {
  return withLoopback(app(db, { origin, secret, catalog }), (server) =>
    request(server)
      .get("/learn")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
}
it.each(["technical", "professional", "explorer"] as const)(
  "persists the exact published choice across reload for %s without changing a foreign member",
  async (background) => {
    await fixture();
    const owner = await member(background),
      other = await member();
    expect(await db.chooseAssignment(other.id, "SYN-956", 2)).toBe(true);
    const otherBefore = await snapshot(other.id);
    const response = await post(owner.token, db, {
      id: other.id,
      member_id: other.id,
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/learn");
    expect(await db.assignmentChoice(owner.id)).toEqual({
      contentId: "SYN-956",
      contentVersion: 2,
    });
    for (let n = 0; n < 2; n++) {
      const reload = await get(owner.token);
      expect(reload.status).toBe(200);
      expect(reload.text).toContain("Your chosen sample");
      expect(reload.text).toContain("· version 2");
    }
    expect(await snapshot(other.id)).toEqual(otherBefore);
  },
);
it.each(["revoked", "expired"] as const)(
  "keeps sign-in behavior when the session is already %s at request time",
  async (reason) => {
    const { owner } = await fixture(true),
      before = await snapshot(owner.id);
    await pool.query(
      reason === "revoked"
        ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
        : "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
    const response = await post(owner.token);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/");
    expect(await snapshot(owner.id)).toEqual(before);
  },
);
it.each([false, true])(
  "denies a revoked principal after preflight while selection waits (existing choice: %s)",
  async (existing) => {
    const { owner } = await fixture(existing),
      before = await snapshot(owner.id);
    const { pending, resume } = await pauseAfterPreflight(owner.token),
      client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
      resume.release();
      expect(await blocked("SELECT id,expires_at")).toBe(true);
      await client.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      resume.release();
      await pending;
      client.release();
    }
  },
);
it.each([false, true])(
  "denies a deleting workspace after preflight while selection waits (existing choice: %s)",
  async (existing) => {
    const { owner } = await fixture(existing),
      before = await snapshot(owner.id);
    const { pending, resume } = await pauseAfterPreflight(owner.token),
      client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR SHARE", [
        owner.id,
      ]);
      await client.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
      resume.release();
      expect(await blocked("SELECT id FROM workspaces")).toBe(true);
      await client.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      resume.release();
      await pending;
      client.release();
    }
  },
);
it.each([
  ["workspace", false],
  ["workspace", true],
  ["choice", false],
  ["choice", true],
] as const)(
  "rolls back all choice fields after database-time expiry during the %s wait (existing choice: %s)",
  async (lock, existing) => {
    const { owner } = await fixture(existing),
      before = await snapshot(owner.id);
    const { pending, resume } = await pauseAfterPreflight(owner.token),
      client = await pool.connect();
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id=$1",
        [owner.id],
      );
      await client.query("BEGIN");
      if (lock === "workspace")
        await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          owner.id,
        ]);
      else if (existing)
        await client.query(
          "SELECT member_id FROM learner_assignment_choices WHERE member_id=$1 FOR UPDATE",
          [owner.id],
        );
      else
        await client.query(
          "LOCK TABLE learner_assignment_choices IN SHARE MODE",
        );
      resume.release();
      expect(
        await blocked(
          lock === "workspace"
            ? "SELECT id FROM workspaces"
            : "INSERT INTO learner_assignment_choices",
        ),
      ).toBe(true);
      expect(await expired(owner.id)).toBe(true);
      await client.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      resume.release();
      await pending;
      client.release();
    }
  },
);
it.each(["deletion", "revocation"] as const)(
  "commits a selection that holds canonical locks before waiting %s proceeds",
  async (change) => {
    const { owner } = await fixture(true),
      reached = gate(),
      resume = gate();
    const controlled = store({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith("INSERT INTO learner_assignment_choices")) {
              reached.release();
              await resume.wait;
            }
            return result;
          },
          release: client.release.bind(client),
        } as unknown as PoolClient;
      },
    } as unknown as Pool);
    const selecting = post(owner.token, controlled),
      client = await pool.connect();
    let marking: Promise<unknown> | undefined;
    try {
      await Promise.race([
        reached.wait,
        selecting.then(() => {
          throw Error("Selection did not reach its write");
        }),
      ]);
      await client.query("BEGIN");
      if (change === "deletion")
        await client.query("SELECT id FROM principals WHERE id=$1 FOR SHARE", [
          owner.id,
        ]);
      const sql =
        change === "deletion"
          ? "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1"
          : "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1";
      marking = client.query(sql, [owner.id]);
      expect(await blocked(sql)).toBe(true);
      resume.release();
      expect((await selecting).status).toBe(303);
      await marking;
      await client.query("COMMIT");
      const retained = await snapshot(owner.id);
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        content_id: "SYN-956",
        content_version: 2,
      });
      const later = await post(owner.token);
      expect(later.status).toBe(change === "deletion" ? 403 : 303);
      expect(later.headers.location).toBe(
        change === "revocation" ? "/" : undefined,
      );
      expect(await snapshot(owner.id)).toEqual(retained);
    } finally {
      resume.release();
      await Promise.allSettled([selecting, ...(marking ? [marking] : [])]);
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
it.each(["direction", "prerequisite", "retirement", "supersession"] as const)(
  "retains the prior exact version and timestamp when %s changes after preflight",
  async (change) => {
    const { owner, item, editor, publish } = await fixture(
        true,
        change === "direction" ? { goals: ["everyday"] } : {},
      ),
      before = await snapshot(owner.id);
    if (change === "prerequisite") {
      await publish({ ...item, id: "SYN-955", kind: "lesson" });
      await publish({
        ...item,
        version: 3,
        prerequisites: "",
        structuredPrerequisites: {
          schemaVersion: 1,
          all: [
            { kind: "lesson", id: "SYN-955", version: 1, activity: "started" },
          ],
        },
      });
      expect(await db.openLesson(owner.id, "SYN-955", 1)).toBe(true);
      expect(await db.advanceLesson(owner.id, "SYN-955", 1, "start")).toBe(
        true,
      );
    }
    const { pending, resume } = await pauseAfterPreflight(
      owner.token,
      db,
      change === "prerequisite" ? { content_version: "3" } : {},
    );
    try {
      if (change === "direction")
        await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [
          owner.id,
        ]);
      else if (change === "prerequisite")
        expect(await catalog.retire(editor, "SYN-955")).toBe(true);
      else if (change === "retirement")
        expect(await catalog.retire(editor, item.id)).toBe(true);
      else await publish({ ...item, version: 3 });
      resume.release();
      expect((await pending).status).toBe(409);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      resume.release();
      await pending;
    }
  },
);
it.each(["write", "write-and-rollback", "uncertain-commit"] as const)(
  "returns generic failure without replay for %s and reloads actual durable state",
  async (failure) => {
    const { owner } = await fixture(true),
      before = await snapshot(owner.id);
    let writes = 0,
      discarded = false;
    const controlled = store({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        let selection = false;
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql.startsWith("INSERT INTO learner_assignment_choices")) {
              selection = true;
              writes++;
              if (failure !== "uncertain-commit")
                throw Error("PRIVATE SYNTHETIC DB DETAIL");
            }
            if (
              selection &&
              failure === "write-and-rollback" &&
              sql === "ROLLBACK"
            )
              throw Error("PRIVATE SYNTHETIC ROLLBACK DETAIL");
            const result = await client.query(sql, values);
            if (selection && sql === "COMMIT")
              throw Error("PRIVATE SYNTHETIC UNCERTAIN COMMIT");
            return result;
          },
          release: (error?: Error) => {
            if (selection && error) discarded = true;
            client.release(error);
          },
        } as unknown as PoolClient;
      },
    } as unknown as Pool);
    const response = await post(owner.token, controlled);
    expect(response.status).toBe(503);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toContain("PRIVATE SYNTHETIC");
    expect(response.text).not.toContain(owner.id);
    expect(writes).toBe(1);
    expect(discarded).toBe(failure === "write-and-rollback");
    const reload = await get(owner.token);
    expect(reload.status).toBe(200);
    if (failure === "uncertain-commit") {
      expect(await db.assignmentChoice(owner.id)).toEqual({
        contentId: "SYN-956",
        contentVersion: 2,
      });
      expect(reload.text).toContain("Your chosen sample");
      expect(reload.text).toContain("· version 2");
    } else {
      expect(await snapshot(owner.id)).toEqual(before);
      expect(reload.text).toContain("Your saved choice is no longer available");
    }
  },
);
