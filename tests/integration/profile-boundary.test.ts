import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store, type Store } from "../../src/store.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool);
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-profile-boundary";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token, id: session.learner.id };
}
const input = {
  background: "professional",
  goal: "work",
  domain_tags: "education",
  weekly_minutes: "60",
};
function post(
  token: string,
  source: Store = db,
  extra: Record<string, string> = {},
) {
  return withLoopback(app(source, { origin, secret }), (server) =>
    request(server)
      .post("/profile")
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...input, ...extra }),
  );
}
async function snapshot(id: string) {
  return {
    profile: (await pool.query("SELECT * FROM learners WHERE id=$1", [id]))
      .rows,
    history: (
      await pool.query(
        "SELECT * FROM exercises WHERE learner_id=$1 ORDER BY goal_slot",
        [id],
      )
    ).rows,
  };
}
it("denies a retained valid session profile POST after deletion commits without changing private rows", async () => {
  const owner = await member();
  await db.save(owner.id, {
    instruction: "Invented private original practice",
    verification: "Check invented evidence",
    complete: true,
  });
  const before = await snapshot(owner.id);
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  const response = await post(owner.token);
  expect.soft(response.status).toBe(403);
  expect.soft(response.text).not.toContain("Invented private");
  expect(await snapshot(owner.id)).toEqual(before);
});

import type { Pool, PoolClient } from "pg";
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
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
it("uses session ownership and preserves original-goal history across valid repeated edits", async () => {
  const owner = await member(),
    other = await member();
  await db.save(owner.id, {
    instruction: "Private original",
    verification: "Check invented details",
    complete: true,
  });
  const before = await snapshot(owner.id),
    otherBefore = await snapshot(other.id);
  for (let i = 0; i < 2; i++)
    expect((await post(owner.token, db, { id: other.id })).status).toBe(303);
  expect((await snapshot(owner.id)).profile[0]).toMatchObject({
    goal: "work",
    domain_tags: ["education"],
    weekly_minutes: 60,
  });
  expect((await snapshot(owner.id)).history).toEqual(before.history);
  expect(await snapshot(other.id)).toEqual(otherBefore);
  expect(
    (await post(randomBytes(32).toString("hex"), db, { id: owner.id })).status,
  ).toBe(303);
  expect((await snapshot(owner.id)).history).toEqual(before.history);
});
it.each(["revoked", "expired"] as const)(
  "denies a %s session before profile mutation",
  async (reason) => {
    const owner = await member(),
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
    expect(response.text).not.toContain(owner.id);
    expect(await snapshot(owner.id)).toEqual(before);
  },
);
it.each(["deletion", "revocation"] as const)(
  "denies a waiting profile POST when %s commits first",
  async (change) => {
    const owner = await member(),
      before = await snapshot(owner.id),
      client = await pool.connect();
    let pending: ReturnType<typeof post> | undefined;
    try {
      await client.query("BEGIN");
      if (change === "deletion") {
        await client.query("SELECT id FROM principals WHERE id=$1 FOR SHARE", [
          owner.id,
        ]);
        await client.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [owner.id],
        );
      } else
        await client.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [owner.id],
        );
      pending = post(owner.token);
      expect(
        await blocked(
          change === "deletion"
            ? "SELECT id FROM workspaces"
            : "SELECT id,expires_at",
        ),
      ).toBe(true);
      await client.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.text).toContain("Profile unavailable");
      expect(response.text).not.toContain(owner.id);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      client.release();
    }
  },
);
it("commits a profile edit before a waiting deletion marker, then rejects later edits", async () => {
  const owner = await member(),
    reached = gate(),
    resume = gate();
  const controlled = store({
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.startsWith("UPDATE learners")) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      } as unknown as PoolClient;
    },
  } as unknown as Pool);
  const editing = post(owner.token, controlled),
    client = await pool.connect();
  let marking: Promise<unknown> | undefined;
  try {
    await reached.wait;
    await client.query("BEGIN");
    await client.query("SELECT id FROM principals WHERE id=$1 FOR SHARE", [
      owner.id,
    ]);
    marking = client.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
      [owner.id],
    );
    expect(await blocked("UPDATE workspaces SET deleting_at")).toBe(true);
    resume.release();
    expect((await editing).status).toBe(303);
    await marking;
    await client.query("COMMIT");
    const before = await snapshot(owner.id);
    expect(before.profile[0]).toMatchObject({ goal: "work" });
    expect((await post(owner.token, db, { goal: "build" })).status).toBe(403);
    expect(await snapshot(owner.id)).toEqual(before);
  } finally {
    resume.release();
    await Promise.allSettled([editing, ...(marking ? [marking] : [])]);
    await client.query("ROLLBACK");
    client.release();
  }
});
it.each(["workspace", "learner"] as const)(
  "rolls back profile changes when the session expires waiting for the %s lock",
  async (lock) => {
    const owner = await member(),
      before = await snapshot(owner.id),
      client = await pool.connect();
    let pending: ReturnType<typeof post> | undefined;
    try {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id=$1",
        [owner.id],
      );
      await client.query("BEGIN");
      await client.query(
        lock === "workspace"
          ? "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE"
          : "SELECT id FROM learners WHERE id=$1 FOR UPDATE",
        [owner.id],
      );
      pending = post(owner.token);
      expect(
        await blocked(
          lock === "workspace"
            ? "SELECT id FROM workspaces"
            : "UPDATE learners SET",
        ),
      ).toBe(true);
      for (let n = 0; n < 150; n++) {
        const { rows } = await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [owner.id],
        );
        if (rows[0].expired) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        (
          await pool.query(
            "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
            [owner.id],
          )
        ).rows[0].expired,
      ).toBe(true);
      await client.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await snapshot(owner.id)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      await Promise.allSettled(pending ? [pending] : []);
      client.release();
    }
  },
);
it.each(["write", "uncertain-commit"] as const)(
  "never reports success or retries a %s failure",
  async (failure) => {
    const owner = await member(),
      before = await snapshot(owner.id);
    let writes = 0;
    const controlled = store({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql.startsWith("UPDATE learners")) {
              writes++;
              if (failure === "write")
                throw Error("PRIVATE SYNTHETIC DB DETAIL");
            }
            const result = await client.query(sql, values);
            if (sql === "COMMIT")
              throw Error("PRIVATE SYNTHETIC UNCERTAIN COMMIT");
            return result;
          },
          release: client.release.bind(client),
        } as unknown as PoolClient;
      },
    } as unknown as Pool);
    const response = await post(owner.token, controlled);
    expect(response.status).toBe(503);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toContain("PRIVATE SYNTHETIC");
    expect(writes).toBe(1);
    if (failure === "write") expect(await snapshot(owner.id)).toEqual(before);
    else
      expect((await snapshot(owner.id)).profile[0]).toMatchObject({
        goal: "work",
      });
  },
);

it("cannot report a profile save after its learner row is absent", async () => {
  const owner = await member();
  await pool.query("DELETE FROM learners WHERE id=$1", [owner.id]);
  expect(
    await db.updateProfile(owner.id, {
      background: "explorer",
      goal: "everyday",
      backgroundTags: [],
      domainTags: [],
      itRoles: [],
      experience: null,
      exploratory: false,
    }),
  ).toBe(false);
  expect((await snapshot(owner.id)).profile).toEqual([]);
});
