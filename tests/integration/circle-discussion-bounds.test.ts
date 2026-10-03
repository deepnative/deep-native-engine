import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
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
const circle = "everyday-ai",
  secret = "invented-max-retained-data-secret";
const reads: { sql: string; values: unknown[]; rows: number }[] = [];
const observedPool = {
  connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (sql: string, values: unknown[] = []) => {
            const result = await target.query(sql, values);
            if (sql.includes("LIMIT 21"))
              reads.push({ sql, values, rows: result.rows.length });
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
} as unknown as Pool;
const discussion = circleDiscussionStore(observedPool, secret);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  reads.length = 0;
});
afterAll(async () => pool.end());
async function participant() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token);
  if (s.kind !== "active") throw Error("Invented member missing");
  expect(await circles.join(token, circle)).toBe("joined");
  const c = await discussion.choose(
    token,
    circle,
    randomUUID(),
    "1",
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  if (c.kind !== "ready") throw Error("Invented choice missing");
  return { token, id: s.learner.id, choice: c.value.id };
}
async function fill(
  owner: Awaited<ReturnType<typeof participant>>,
  count: number,
  prefix: string,
  root: string | null = null,
) {
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint)
 SELECT ($6||lpad(n::text,12,'0'))::uuid,$1,$1,$2,$3,$4,repeat('x',2000),gen_random_uuid(),$5 FROM generate_series(1,$7::integer) n`,
    [owner.id, circle, owner.choice, root, "a".repeat(64), prefix, count],
  );
}
async function measured<T>(name: string, run: () => Promise<T>) {
  const start = performance.now();
  const result = await run();
  const elapsed = performance.now() - start;
  expect(
    elapsed,
    name + " respects the 10-second operation bound",
  ).toBeLessThan(10000);
  return result;
}
async function pages<T extends { id: string }>(
  name: string,
  run: (
    cursor?: string,
  ) => Promise<CircleResult<{ items: T[]; nextCursor: string | null }>>,
) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await measured(name, () => run(cursor));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Bounded page missing");
    expect(result.value.items.length).toBeLessThanOrEqual(20);
    ids.push(...result.value.items.map((x) => x.id));
    cursor = result.value.nextCursor ?? undefined;
    expect(ids.length).toBeLessThanOrEqual(1000);
  } while (cursor);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}
it("keeps maximum retained-data pages, moderation and erasure bounded without backfilling unavailable candidates", async () => {
  const a = await participant(),
    b = await participant(),
    c = await participant(),
    d = await participant();
  const root = "10000000-0000-4000-8000-000000000001";
  await fill(a, 200, "10000000-0000-4000-8000-");
  await fill(b, 100, "20000000-0000-4000-8000-", root);
  await fill(b, 100, "30000000-0000-4000-8000-");
  await fill(c, 200, "40000000-0000-4000-8000-");
  await fill(d, 200, "50000000-0000-4000-8000-");
  await pool.query(
    `INSERT INTO preview_circle_reports(id,member_id,workspace_id,circle_id,target_id,category,idempotency_key) SELECT gen_random_uuid(),$1,$1,$2,id,'privacy',gen_random_uuid() FROM preview_circle_posts WHERE member_id=$3`,
    [b.id, circle, a.id],
  );
  const admin = randomBytes(32).toString("hex"),
    mod = randomBytes(32).toString("hex"),
    expires = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expires);
  const staff = await auth.provisionStaff(mod, "moderator", expires);
  expect(
    (
      await discussion.grantModerator(
        admin,
        staff,
        circle,
        randomUUID(),
        new Date(Date.now() + 600000),
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await pages("root list", (cursor) =>
        discussion.list(b.token, circle, cursor),
      )
    ).length,
  ).toBe(700);
  expect(
    (
      await pages("thread replies", async (cursor) => {
        const r = await discussion.thread(b.token, circle, root, cursor);
        return r.kind === "ready"
          ? { kind: "ready", value: r.value.replies }
          : r;
      })
    ).length,
  ).toBe(100);
  expect(
    (
      await pages("owned history", (cursor) =>
        discussion.owned(b.token, circle, cursor),
      )
    ).length,
  ).toBe(200);
  expect(
    (
      await pages("own reports", (cursor) =>
        discussion.reports(b.token, circle, cursor),
      )
    ).length,
  ).toBe(200);
  expect(
    (
      await pages("moderator queue", (cursor) =>
        discussion.moderationQueue(mod, circle, cursor),
      )
    ).length,
  ).toBe(200);
  expect(reads.length).toBeGreaterThan(50);
  expect(reads.every((r) => r.rows <= 21)).toBe(true);
  // Explain actual captured candidate SQL and parameters against maximum fixture
  // data, not a different hand-written query or forced planner configuration.
  for (const read of [...new Map(reads.map((r) => [r.sql, r])).values()]) {
    const plan = await pool.query<{
      "QUERY PLAN": {
        Plan: { "Actual Rows": number; "Node Type": string };
        "Execution Time": number;
      }[];
    }>("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + read.sql, read.values);
    const result = plan.rows[0]!["QUERY PLAN"][0]!;
    expect(result.Plan["Node Type"]).toBe("Limit");
    expect(result.Plan["Actual Rows"]).toBeLessThanOrEqual(21);
    expect(result["Execution Time"]).toBeLessThan(10000);
  }
  expect(
    (
      await measured("hide", () =>
        discussion.moderate(
          mod,
          circle,
          root,
          randomUUID(),
          "hide",
          1,
          "privacy",
        ),
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await measured("restore", () =>
        discussion.moderate(
          mod,
          circle,
          root,
          randomUUID(),
          "restore",
          2,
          "test_correction",
        ),
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await measured("sharing withdrawal", () =>
        discussion.withdrawChoice(a.token, circle, true),
      )
    ).kind,
  ).toBe("ready");
  const unavailable = await measured("unavailable source page", () =>
    discussion.list(b.token, circle),
  );
  expect(unavailable.kind).toBe("ready");
  if (unavailable.kind !== "ready") throw Error("Unavailable page missing");
  expect(unavailable.value.items).toEqual([]);
  expect(unavailable.value.nextCursor).not.toBeNull();
  const queue = await discussion.moderationQueue(mod, circle);
  expect(queue.kind).toBe("ready");
  if (queue.kind !== "ready") throw Error("Queue missing");
  expect(queue.value.items).toHaveLength(20);
  expect(queue.value.items.every((x) => x.target === null)).toBe(true);
  await measured("source erasure", () => members.remove(a.id));
  expect(
    (
      await pages("independent retained history", (cursor) =>
        discussion.owned(b.token, circle, cursor),
      )
    ).length,
  ).toBe(200);
  expect(
    (
      await pages("independent safe reports", (cursor) =>
        discussion.reports(b.token, circle, cursor),
      )
    ).length,
  ).toBe(200);
}, 30000);
