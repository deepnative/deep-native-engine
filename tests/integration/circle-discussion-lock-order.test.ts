import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-lock-test-secret"),
  auth = authorizationStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const databaseErrors: string[] = [];
function intercept(
  onConnect: (client: PoolClient) => Promise<void>,
  afterQuery: (sql: string, values: unknown[]) => Promise<void>,
) {
  return {
    connect: async () => {
      const client = await pool.connect();
      try {
        await onConnect(client);
      } catch (error) {
        client.release();
        throw error;
      }
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values: unknown[] = []) => {
              try {
                const result = await target.query(sql, values);
                await afterQuery(sql, values);
                return result;
              } catch (error) {
                const code = (error as { code?: string }).code;
                if (code) databaseErrors.push(code);
                throw error;
              }
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}
it("serializes a thread read and a reply moderation action without opposite target lock order", async () => {
  const circle = "everyday-ai",
    tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")],
    ids: string[] = [],
    choices: string[] = [];
  for (const token of tokens) {
    await members.create(token, { background: "explorer", goal: "everyday" });
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Fixture member missing");
    ids.push(session.learner.id);
    expect(await circles.join(token, circle)).toBe("joined");
    const choice = await discussion.choose(
      token,
      circle,
      randomUUID(),
      "1",
      CIRCLE_DISCUSSION_POLICY,
      true,
    );
    if (choice.kind !== "ready") throw Error("Fixture choice missing");
    choices.push(choice.value.id);
  }
  // Deliberate ordering: the reply sorts before its root. These fixture IDs do
  // not change authorization, state or the application's locking behavior.
  const root = "ffffffff-ffff-4fff-afff-ffffffffffff",
    reply = "00000000-0000-4000-8000-000000000001";
  for (const [index, id, rootId, body] of [
    [0, root, null, "Invented root"],
    [1, reply, root, "Invented reply"],
  ] as const)
    await pool.query(
      "INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        ids[index],
        circle,
        choices[index],
        rootId,
        body,
        randomUUID(),
        "a".repeat(64),
      ],
    );
  const admin = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const staffId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  expect(
    (
      await discussion.grantModerator(
        admin,
        staffId,
        circle,
        randomUUID(),
        new Date(Date.now() + 1800000),
      )
    ).kind,
  ).toBe("ready");
  const readRoot = deferred(),
    continueRead = deferred();
  let moderatorPid = 0;
  const reader = circleDiscussionStore(
    intercept(
      async () => {},
      async (sql, values) => {
        if (
          sql.includes("body,state,revision") &&
          sql.includes("FOR SHARE") &&
          Array.isArray(values[0]) &&
          values[0].length === 1 &&
          values[0][0] === root
        ) {
          readRoot.resolve();
          await continueRead.promise;
        }
      },
    ),
    "invented-lock-test-secret",
  );
  const writer = circleDiscussionStore(
    intercept(
      async (client) => {
        moderatorPid = (await client.query("SELECT pg_backend_pid() pid"))
          .rows[0].pid;
      },
      async () => {},
    ),
    "invented-lock-test-secret",
  );
  const reading = reader.thread(tokens[0]!, circle, root);
  await readRoot.promise;
  const writing = writer.moderate(
    moderator,
    circle,
    reply,
    randomUUID(),
    "hide",
    1,
    "test_correction",
  );
  // Attach rejection observation before probing so a DB timeout is never an
  // unhandled rejection or an automatic retry.
  const outcomes = Promise.allSettled([reading, writing]);
  try {
    const deadline = performance.now() + 3000;
    let blocked = false;
    while (performance.now() < deadline) {
      if (moderatorPid) {
        const row = (
          await pool.query(
            "SELECT cardinality(pg_blocking_pids($1))>0 blocked",
            [moderatorPid],
          )
        ).rows[0];
        if (row.blocked) {
          blocked = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(
      blocked,
      "Observe the actual moderator waiting on the reader's retained source/target locks",
    ).toBe(true);
  } finally {
    continueRead.resolve();
  }
  const settled = await outcomes;
  expect(
    databaseErrors,
    "No PostgreSQL deadlock or lock-timeout may be hidden by application recovery",
  ).toEqual([]);
  expect(
    settled.map((r) => r.status),
    "Both current-authorized operations must complete; a deadlock is not an acceptable conflict or retry",
  ).toEqual(["fulfilled", "fulfilled"]);
  for (const value of settled)
    if (value.status === "fulfilled") expect(value.value.kind).toBe("ready");
}, 30000);

it("checks principal and grant expiry at one final authorization instant", async () => {
  const admin = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex"),
    circle = "everyday-ai";
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const staffId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  expect(
    (
      await discussion.grantModerator(
        admin,
        staffId,
        circle,
        randomUUID(),
        new Date(Date.now() + 1800000),
      )
    ).kind,
  ).toBe("ready");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
    [staffId],
  );
  const checking = deferred(),
    continueCheck = deferred();
  const delayed = circleDiscussionStore(
    intercept(
      async () => {},
      async (sql) => {
        if (sql.includes("count(*)::integer n FROM principals")) {
          checking.resolve();
          await continueCheck.promise;
        }
      },
    ),
    "invented-lock-test-secret",
  );
  const operation = delayed.moderationQueue(moderator, circle);
  const observed = Promise.allSettled([operation]);
  await checking.promise;
  try {
    const deadline = performance.now() + 3000;
    let expired = false;
    while (performance.now() < deadline) {
      const row = (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
          [staffId],
        )
      ).rows[0];
      if (row.expired) {
        expired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(
      expired,
      "Observe actual DB principal expiry before the remaining grant check",
    ).toBe(true);
  } finally {
    continueCheck.resolve();
  }
  const settled = await observed;
  expect(settled[0]?.status).toBe("fulfilled");
  if (settled[0]?.status === "fulfilled")
    expect(
      settled[0].value.kind,
      "A grant must never carry a stale principal check across a later await",
    ).toBe("denied");
}, 30000);
