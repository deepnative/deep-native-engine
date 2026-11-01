import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { circleStore } from "../../src/circles.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool),
  circles = circleStore(pool);
const discussion = circleDiscussionStore(pool, "invented-signout-race");
const origin = "http://127.0.0.1:3000";
const sender = { async send(_address: string, _link: string) {} };
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

async function fixture() {
  const owner = randomBytes(32).toString("hex"),
    peer = randomBytes(32).toString("hex");
  const circle = "everyday-ai";
  for (const token of [owner, peer]) {
    await members.create(token, { background: "explorer", goal: "everyday" });
    expect(await circles.join(token, circle)).toBe("joined");
    expect(
      (
        await discussion.choose(
          token,
          circle,
          randomUUID(),
          "1",
          "circle-discussion-test-v1",
          true,
        )
      ).kind,
    ).toBe("ready");
  }
  const admin = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const staff = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  expect(
    (
      await discussion.grantModerator(
        admin,
        staff,
        circle,
        randomUUID(),
        new Date(Date.now() + 1800000),
      )
    ).kind,
  ).toBe("ready");
  const root = await discussion.post(
    peer,
    circle,
    randomUUID(),
    "Invented peer root",
    true,
  );
  if (root.kind !== "ready") throw Error("Missing peer root");
  const reply = await discussion.post(
    owner,
    circle,
    randomUUID(),
    "Invented affected member reply",
    true,
    root.value.id,
  );
  if (reply.kind !== "ready") throw Error("Missing affected reply");
  expect(
    (
      await discussion.moderate(
        moderator,
        circle,
        reply.value.id,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  let link = "";
  const email = memberEmailAccess(
    pool,
    {
      async send(_address, value) {
        link = value;
      },
    },
    origin,
  );
  expect(
    await email.requestAttach(owner, "invented-circle-owner@example.invalid"),
  ).toBe("sent");
  expect(
    (await email.consume(new URL(link).searchParams.get("code")!, owner)).kind,
  ).toBe("attached");
  return { owner, peer, circle, post: reply.value.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const actions = ["request", "history", "receipt", "withdraw"] as const;
type Action = (typeof actions)[number];
async function retained(f: Fixture) {
  const result = await discussion.requestAppeal(
    f.owner,
    f.circle,
    f.post,
    randomUUID(),
    2,
    "missing_context",
    true,
  );
  if (result.kind !== "ready") throw Error("Missing retained appeal");
  return result.value.id;
}
function action(
  store: ReturnType<typeof circleDiscussionStore>,
  f: Fixture,
  name: Action,
  id: string,
  key: string,
) {
  if (name === "request")
    return store.requestAppeal(
      f.owner,
      f.circle,
      f.post,
      key,
      2,
      "missing_context",
      true,
    );
  if (name === "history") return store.appealHistory(f.owner, f.circle);
  if (name === "receipt") return store.appealReceipt(f.owner, f.circle, id);
  return store.withdrawAppeal(f.owner, f.circle, id, true);
}
async function snapshot() {
  return (await pool.query("SELECT * FROM preview_circle_appeals ORDER BY id"))
    .rows;
}
// Hold an actual transaction after its locks and writes, before COMMIT. The
// other connection must appear in PostgreSQL's blocking graph before release.
function heldCommit() {
  let release!: () => void,
    held = false,
    pid = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const boundary = {
    async connect() {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT") {
            held = true;
            await gate;
          }
          return client.query(sql, values);
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  return {
    boundary,
    release,
    async reached() {
      await vi.waitFor(() => expect(held).toBe(true), {
        timeout: 3000,
        interval: 10,
      });
    },
    async blocked() {
      await vi.waitFor(
        async () => {
          const result = await pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
            [pid],
          );
          expect(result.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 10 },
      );
    },
  };
}

for (const order of ["signout-first", "appeal-first"] as const)
  it.each(actions)(
    `AUDIT-CIRCLE-SIGNOUT-01/02 ${order} serializes %s against actual bearer rotation`,
    async (name) => {
      const f = await fixture(),
        id = name === "request" ? "" : await retained(f),
        key = randomUUID();
      const before = await snapshot(),
        lock = heldCommit();
      const controlled = circleDiscussionStore(
        lock.boundary,
        "invented-signout-race",
      );
      const email = memberEmailAccess(
        order === "signout-first" ? lock.boundary : pool,
        sender,
        origin,
      );
      const first =
        order === "signout-first"
          ? email.signOut(f.owner)
          : action(controlled, f, name, id, key);
      let second: typeof first | undefined;
      try {
        await lock.reached();
        second =
          order === "signout-first"
            ? action(discussion, f, name, id, key)
            : email.signOut(f.owner);
        await lock.blocked();
      } finally {
        lock.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      const a = await first,
        b = await second;
      expect(order === "signout-first" ? a : b).toBe("signed_out");
      const result = order === "signout-first" ? b : a;
      if (order === "signout-first") {
        expect(result).toEqual({ kind: "denied" });
        expect(await snapshot()).toEqual(before);
      } else {
        expect(result).toMatchObject({ kind: "ready" });
        if (name === "request") expect(await snapshot()).toHaveLength(1);
        else if (name === "withdraw")
          expect(await snapshot()).toMatchObject([{ state: "withdrawn" }]);
        else {
          expect(await snapshot()).toEqual(before);
          expect(JSON.stringify(result)).toContain("missing_context");
        }
      }
      const after = await snapshot();
      // A deliberate replay after sign-out cannot read, withdraw or duplicate work.
      expect(await action(discussion, f, name, id, key)).toEqual({
        kind: "denied",
      });
      expect(await snapshot()).toEqual(after);
      expect((await members.session(f.owner)).kind).not.toBe("active");
      expect((await members.session(f.peer)).kind).toBe("active");
    },
  );
