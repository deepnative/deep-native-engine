import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { store, migrate } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
  type CircleResult,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  auth = authorizationStore(pool);
const secret = "invented-race-matrix-secret",
  discussion = circleDiscussionStore(pool, secret),
  circle = "everyday-ai";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function controlled(pause = false) {
  const arrived = latch(),
    resume = latch();
  let pid = 0;
  async function connect() {
    const client = await pool.connect();
    try {
      pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
        .rows[0]!.pid;
    } catch (error) {
      client.release();
      throw error;
    }
    return new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (sql: string, values: unknown[] = []) => {
            if (pause && sql === "COMMIT") {
              arrived.resolve();
              await resume.promise;
            }
            return target.query(sql, values);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  // Member removal's public method uses a single implicit transaction. Wrap that
  // real DELETE in an explicit transaction solely to expose its commit barrier.
  const scoped = {
    connect,
    query: async (sql: string, values: unknown[] = []) => {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(sql, values);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as Pool;
  return { pool: scoped, arrived, resume, pid: () => pid };
}
async function blockedBy(waiter: () => number, holder: () => number) {
  const deadline = performance.now() + 3000;
  let blocked = false;
  while (performance.now() < deadline) {
    if (waiter() && holder()) {
      const observed = await pool.query<{ blocked: boolean }>(
        "SELECT $1::integer=ANY(pg_blocking_pids($2)) blocked",
        [holder(), waiter()],
      );
      if (observed.rows[0]?.blocked) {
        blocked = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(
    blocked,
    "Observe the real losing operation waiting on the winner's transaction",
  ).toBe(true);
}
async function participant() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token);
  if (s.kind !== "active") throw Error("Invented member unavailable");
  expect(await circles.join(token, circle)).toBe("joined");
  expect(
    (
      await discussion.choose(
        token,
        circle,
        randomUUID(),
        "1",
        CIRCLE_DISCUSSION_POLICY,
        true,
      )
    ).kind,
  ).toBe("ready");
  return { token, id: s.learner.id };
}
type Kind =
  | "list"
  | "thread"
  | "post"
  | "reply"
  | "report"
  | "hide"
  | "restore"
  | "queue";
type Change = "leave" | "choice" | "text" | "erase" | "grant";
async function setup(kind: Kind) {
  const source = await participant(),
    peer = await participant();
  const admin = randomBytes(32).toString("hex"),
    operator = randomBytes(32).toString("hex"),
    expiry = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expiry);
  const staffId = await auth.provisionStaff(operator, "moderator", expiry);
  const granted = await discussion.grantModerator(
    admin,
    staffId,
    circle,
    randomUUID(),
    new Date(Date.now() + 600000),
  );
  if (granted.kind !== "ready") throw Error("Invented grant unavailable");
  const root = await discussion.post(
    source.token,
    circle,
    randomUUID(),
    "Invented race root",
    true,
  );
  if (root.kind !== "ready") throw Error("Invented root unavailable");
  if (kind === "queue")
    expect(
      (
        await discussion.report(
          peer.token,
          circle,
          root.value.id,
          randomUUID(),
          "privacy",
        )
      ).kind,
    ).toBe("ready");
  if (kind === "restore")
    expect(
      (
        await discussion.moderate(
          operator,
          circle,
          root.value.id,
          randomUUID(),
          "hide",
          1,
          "privacy",
        )
      ).kind,
    ).toBe("ready");
  return {
    source,
    peer,
    admin,
    operator,
    staffId,
    grant: granted.value.id,
    root: root.value.id,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function action(
  db: ReturnType<typeof circleDiscussionStore>,
  kind: Kind,
  f: Fixture,
) {
  const key = randomUUID();
  switch (kind) {
    case "list":
      return db.list(f.peer.token, circle);
    case "thread":
      return db.thread(f.peer.token, circle, f.root);
    case "post":
      return db.post(
        f.source.token,
        circle,
        key,
        "Invented new question",
        true,
      );
    case "reply":
      return db.post(
        f.peer.token,
        circle,
        key,
        "Invented independent reply",
        true,
        f.root,
      );
    case "report":
      return db.report(f.peer.token, circle, f.root, key, "privacy");
    case "hide":
      return db.moderate(f.operator, circle, f.root, key, "hide", 1, "privacy");
    case "restore":
      return db.moderate(
        f.operator,
        circle,
        f.root,
        key,
        "restore",
        2,
        "test_correction",
      );
    case "queue":
      return db.moderationQueue(f.operator, circle);
  }
}
async function invalidate(dbPool: Pool, change: Change, f: Fixture) {
  const db = circleDiscussionStore(dbPool, secret);
  switch (change) {
    case "leave":
      expect(await circleStore(dbPool).leave(f.source.token, circle)).toBe(
        true,
      );
      break;
    case "choice":
      expect((await db.withdrawChoice(f.source.token, circle, true)).kind).toBe(
        "ready",
      );
      break;
    case "text":
      expect(
        (await db.withdraw(f.source.token, circle, f.root, true)).kind,
      ).toBe("ready");
      break;
    case "erase":
      await store(dbPool).remove(f.source.id);
      break;
    case "grant":
      expect((await db.revokeModerator(f.admin, circle, f.grant)).kind).toBe(
        "ready",
      );
      break;
  }
}
const pairs: { kind: Kind; change: Change }[] = [];
for (const kind of [
  "list",
  "thread",
  "post",
  "reply",
  "report",
  "hide",
  "restore",
] as const)
  for (const change of ["leave", "choice", "text", "erase"] as const)
    if (!(kind === "post" && change === "text")) pairs.push({ kind, change });
for (const kind of ["queue", "hide", "restore"] as const)
  pairs.push({ kind, change: "grant" });
const cases = pairs.flatMap((pair) => [
  { ...pair, winner: "invalidation" as const },
  { ...pair, winner: "operation" as const },
]);
it.each(cases)(
  "$kind versus $change: $winner wins its real transaction locks",
  async ({ kind, change, winner }) => {
    const f = await setup(kind),
      first = controlled(true),
      second = controlled();
    let outcome: CircleResult<unknown> | undefined;
    const run = async (p: Pool) => {
      outcome = await action(circleDiscussionStore(p, secret), kind, f);
    };
    const earlier =
      winner === "invalidation"
        ? invalidate(first.pool, change, f)
        : run(first.pool);
    const settledFirst = Promise.allSettled([earlier]);
    let settledSecond: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await first.arrived.promise;
      const later =
        winner === "invalidation"
          ? run(second.pool)
          : invalidate(second.pool, change, f);
      settledSecond = Promise.allSettled([later]);
      await blockedBy(second.pid, first.pid);
      first.resume.resolve();
      expect(await settledFirst).toEqual([
        { status: "fulfilled", value: undefined },
      ]);
      expect(await settledSecond).toEqual([
        { status: "fulfilled", value: undefined },
      ]);
      expect(outcome).toBeDefined();
      if (winner === "operation") expect(outcome?.kind).toBe("ready");
      else if (kind === "list")
        expect(outcome).toEqual({
          kind: "ready",
          value: { items: [], nextCursor: null },
        });
      else expect(outcome).toEqual({ kind: "denied" });
      if (change === "grant")
        expect(
          (await discussion.moderationQueue(f.operator, circle)).kind,
        ).toBe("denied");
      else {
        const listing = await discussion.list(f.peer.token, circle);
        expect(listing).toEqual({
          kind: "ready",
          value: { items: [], nextCursor: null },
        });
        expect(
          (await discussion.thread(f.peer.token, circle, f.root)).kind,
        ).toBe("denied");
        if (kind === "reply" && winner === "operation") {
          const own = await discussion.owned(f.peer.token, circle);
          expect(own.kind).toBe("ready");
          if (own.kind === "ready")
            expect(own.value.items.map((row) => row.body)).toEqual([
              "Invented independent reply",
            ]);
        }
      }
      if (winner === "invalidation") {
        expect(
          (
            await pool.query(
              "SELECT id FROM preview_circle_posts WHERE member_id=$1 AND root_id IS NOT NULL",
              [f.peer.id],
            )
          ).rowCount,
        ).toBe(0);
        if (kind === "report")
          expect(
            (
              await pool.query(
                "SELECT id FROM preview_circle_reports WHERE member_id=$1",
                [f.peer.id],
              )
            ).rowCount,
          ).toBe(0);
        if (kind === "hide" || kind === "restore")
          expect(
            (
              await pool.query(
                "SELECT action FROM preview_circle_moderation_audit WHERE post_id=$1 ORDER BY old_revision",
                [f.root],
              )
            ).rows,
          ).toEqual(
            kind === "restore" && change !== "erase"
              ? [{ action: "hidden" }]
              : [],
          );
      }
    } finally {
      first.resume.resolve();
      await settledFirst;
      if (settledSecond) await settledSecond;
    }
  },
  15000,
);

const expiryCases = [
  ...(
    ["list", "thread", "post", "reply", "report", "hide", "restore"] as const
  ).map((kind) => ({ kind, lease: "source" as const })),
  ...(["queue", "hide", "restore"] as const).map((kind) => ({
    kind,
    lease: "grant" as const,
  })),
];
it.each(expiryCases)(
  "$kind withholds expired $lease authority after an actual row-lock wait",
  async ({ kind, lease }) => {
    const f = await setup(kind),
      holder = await pool.connect(),
      waiter = controlled();
    let observed:
      Promise<PromiseSettledResult<CircleResult<unknown>>[]> | undefined;
    try {
      await holder.query("BEGIN");
      if (lease === "source")
        await holder.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
          [f.source.id],
        );
      else
        await holder.query(
          "UPDATE preview_circle_moderator_grants SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
          [f.grant],
        );
      const pid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")
      ).rows[0]!.pid;
      observed = Promise.allSettled([
        action(circleDiscussionStore(waiter.pool, secret), kind, f),
      ]);
      await blockedBy(waiter.pid, () => pid);
      const sql =
        lease === "source"
          ? "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1"
          : "SELECT expires_at<=clock_timestamp() expired FROM preview_circle_moderator_grants WHERE id=$1";
      const id = lease === "source" ? f.source.id : f.grant,
        deadline = performance.now() + 3000;
      let expired = false;
      while (performance.now() < deadline) {
        if (
          (await holder.query<{ expired: boolean }>(sql, [id])).rows[0]?.expired
        ) {
          expired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(
        expired,
        "Observe DB wall-clock expiry before releasing the real authorization row lock",
      ).toBe(true);
      await holder.query("COMMIT");
      const result = await observed;
      expect(result).toEqual([
        {
          status: "fulfilled",
          value:
            kind === "list"
              ? { kind: "ready", value: { items: [], nextCursor: null } }
              : { kind: "denied" },
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT id FROM preview_circle_posts WHERE member_id=$1 AND root_id IS NOT NULL",
            [f.peer.id],
          )
        ).rowCount,
      ).toBe(0);
      if (kind === "report")
        expect(
          (
            await pool.query(
              "SELECT id FROM preview_circle_reports WHERE member_id=$1",
              [f.peer.id],
            )
          ).rowCount,
        ).toBe(0);
      if (kind === "hide" || kind === "restore")
        expect(
          (
            await pool.query(
              "SELECT action FROM preview_circle_moderation_audit WHERE post_id=$1 ORDER BY old_revision",
              [f.root],
            )
          ).rows,
        ).toEqual(kind === "restore" ? [{ action: "hidden" }] : []);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (observed) await observed;
    }
  },
  15000,
);
