import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { circleStore } from "../../src/circles.ts";
import {
  CIRCLE_DISCUSSION_POLICY,
  circleDiscussionStore,
  type CircleItem,
  type CircleResult,
} from "../../src/circle-discussion.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-follow-secret");
const circle = "everyday-ai";

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());

function ready<T>(value: CircleResult<T>): T {
  if (value.kind !== "ready") throw Error(`Expected ready, got ${value.kind}`);
  return value.value;
}
async function participant() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  expect(await circles.join(token, circle)).toBe("joined");
  ready(
    await discussion.choose(
      token,
      circle,
      randomUUID(),
      "1",
      CIRCLE_DISCUSSION_POLICY,
      true,
    ),
  );
  return { token, id: session.learner.id };
}
async function say(token: string, body: string, root?: string) {
  const posted = ready(
    await discussion.post(token, circle, randomUUID(), body, true, root),
  );
  return posted.id;
}
async function allPages(
  read: (
    cursor?: string,
  ) => Promise<
    CircleResult<{ items: CircleItem[]; nextCursor: string | null }>
  >,
) {
  const seen: CircleItem[] = [];
  let cursor: string | undefined;
  do {
    const page = ready(await read(cursor));
    seen.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return seen;
}
async function fill(owner: { id: string }, count: number, root: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM preview_circle_choices WHERE member_id=$1 AND circle_id=$2 AND revoked_at IS NULL`,
    [owner.id, circle],
  );
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint,created_at)
     SELECT gen_random_uuid(),$1,$1,$2,$3,$4,'post '||lpad(n::text,3,'0'),gen_random_uuid(),$5,
       now()-make_interval(mins=>1000-n)
     FROM generate_series(1,$6::integer) n`,
    [owner.id, circle, rows[0]!.id, root, "a".repeat(64), count],
  );
}

it("FOLLOW-01 lists questions newest first and pages without repeats or gaps", async () => {
  const asker = await participant();
  await fill(asker, 45, null);
  const seen = await allPages((cursor) =>
    discussion.list(asker.token, circle, cursor),
  );
  expect(seen.map((row) => row.body)).toEqual(
    Array.from(
      { length: 45 },
      (_, n) => `post ${String(45 - n).padStart(3, "0")}`,
    ),
  );
});

it("FOLLOW-02 reads replies oldest first and pages without repeats or gaps", async () => {
  const asker = await participant();
  const question = await say(asker.token, "An invented question");
  await fill(asker, 45, question);
  const seen = await allPages(async (cursor) => {
    const value = await discussion.thread(
      asker.token,
      circle,
      question,
      cursor,
    );
    return value.kind === "ready"
      ? { kind: "ready", value: value.value.replies }
      : value;
  });
  expect(seen.map((row) => row.body)).toEqual(
    Array.from(
      { length: 45 },
      (_, n) => `post ${String(n + 1).padStart(3, "0")}`,
    ),
  );
});

it("FOLLOW-01 keeps its place when the last-seen question's author is deleted", async () => {
  const stayer = await participant(),
    leaver = await participant(),
    reader = await participant();
  await fill(stayer, 25, null);
  // Newer than stayer's posts, so leaver's question ends the first page.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM preview_circle_choices WHERE member_id=$1",
    [leaver.id],
  );
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,body,idempotency_key,fingerprint,created_at)
     SELECT gen_random_uuid(),$1,$1,$2,$3,'gone '||n,gen_random_uuid(),$4,now()-make_interval(secs=>n)
     FROM generate_series(1,20) n`,
    [leaver.id, circle, rows[0]!.id, "a".repeat(64)],
  );
  const first = ready(await discussion.list(reader.token, circle));
  expect(first.items.every((row) => row.body?.startsWith("gone"))).toBe(true);
  await members.remove(leaver.id);
  const next = ready(
    await discussion.list(reader.token, circle, first.nextCursor!),
  );
  expect(next.items[0]?.body).toBe("post 025");
});

it("FOLLOW-03 says how many replies a question has and when the latest came", async () => {
  const asker = await participant(),
    replier = await participant();
  const quiet = await say(asker.token, "A quiet question");
  const busy = await say(asker.token, "A busy question");
  await say(replier.token, "Older reply", busy);
  const newer = await say(replier.token, "Newer reply", busy);
  const { rows } = await pool.query<{ at: string }>(
    "SELECT created_at::text AS at FROM preview_circle_posts WHERE id=$1",
    [newer],
  );
  const listed = ready(await discussion.list(replier.token, circle)).items;
  const row = (id: string) => listed.find((item) => item.id === id)!;
  expect(row(quiet)).toMatchObject({ replyCount: 0, latestReplyAt: null });
  expect(row(busy)).toMatchObject({
    replyCount: 2,
    latestReplyAt: rows[0]!.at,
  });
});

it("FOLLOW-04 summarises replies to my questions and leaves out my own", async () => {
  const asker = await participant(),
    replier = await participant();
  expect(ready(await discussion.activity(asker.token, circle))).toEqual({
    questions: 0,
    replies: 0,
    latestReplyAt: null,
  });
  const first = await say(asker.token, "First question");
  const second = await say(asker.token, "Second question");
  await say(asker.token, "My own follow-up", first);
  expect(ready(await discussion.activity(asker.token, circle))).toEqual({
    questions: 2,
    replies: 0,
    latestReplyAt: null,
  });
  await say(replier.token, "Reply one", first);
  const last = await say(replier.token, "Reply two", second);
  // Someone else's question and my reply on it aren't "replies to my questions".
  const theirs = await say(replier.token, "Their question");
  await say(asker.token, "My reply to them", theirs);
  const { rows } = await pool.query<{ at: string }>(
    "SELECT created_at::text AS at FROM preview_circle_posts WHERE id=$1",
    [last],
  );
  expect(ready(await discussion.activity(asker.token, circle))).toEqual({
    questions: 2,
    replies: 2,
    latestReplyAt: rows[0]!.at,
  });
});

it("FOLLOW-05 shows reply counts only on questions I still share", async () => {
  const asker = await participant(),
    replier = await participant();
  const shared = await say(asker.token, "Still shared");
  const reply = await say(asker.token, "My reply", shared);
  const gone = await say(asker.token, "Withdrawn question");
  await say(replier.token, "A reply", shared);
  ready(await discussion.withdraw(asker.token, circle, gone, true));
  const owned = ready(await discussion.owned(asker.token, circle)).items;
  const row = (id: string) => owned.find((item) => item.id === id)!;
  expect(row(shared)).toMatchObject({ replyCount: 2 });
  expect(row(reply).replyCount).toBeUndefined();
  expect(row(gone).replyCount).toBeUndefined();

  ready(await discussion.withdrawChoice(asker.token, circle, true));
  const afterStopping = ready(await discussion.owned(asker.token, circle));
  expect(
    afterStopping.items.every((item) => item.replyCount === undefined),
  ).toBe(true);
});

it.each([
  [
    "hidden by a moderator",
    async (id: string) =>
      pool.query(
        "UPDATE preview_circle_posts SET state='hidden',revision=revision+1 WHERE id=$1",
        [id],
      ),
  ],
  [
    "withdrawn by its author",
    async (id: string, replier: { token: string }) =>
      ready(await discussion.withdraw(replier.token, circle, id, true)),
  ],
  [
    "from an author who stopped sharing",
    async (_id: string, replier: { token: string }) =>
      ready(await discussion.withdrawChoice(replier.token, circle, true)),
  ],
  [
    "from an author who left",
    async (_id: string, replier: { token: string }) =>
      expect(await circles.leave(replier.token, circle)).toBe(true),
  ],
  [
    "from an author whose session ended",
    async (_id: string, replier: { id: string }) =>
      pool.query("UPDATE principals SET revoked_at=now() WHERE id=$1", [
        replier.id,
      ]),
  ],
  [
    "from an author being deleted",
    async (_id: string, replier: { id: string }) =>
      pool.query(
        "UPDATE workspaces SET deleting_at=now() WHERE owner_principal_id=$1",
        [replier.id],
      ),
  ],
])(
  "FOLLOW-06 counts a reply only while it can be read: %s",
  async (_name, remove) => {
    const asker = await participant(),
      replier = await participant();
    const question = await say(asker.token, "A question");
    const reply = await say(replier.token, "A reply", question);
    const count = async () =>
      ready(await discussion.list(asker.token, circle)).items[0]!.replyCount;
    expect(await count()).toBe(1);
    expect(ready(await discussion.activity(asker.token, circle)).replies).toBe(
      1,
    );
    await remove(reply, replier);
    expect(await count()).toBe(0);
    const summary = ready(await discussion.activity(asker.token, circle));
    expect(summary).toMatchObject({ replies: 0, latestReplyAt: null });
    const thread = ready(
      await discussion.thread(asker.token, circle, question),
    );
    expect(thread.replies.items).toEqual([]);
  },
);

it("FOLLOW-07 gives no summary after I stop sharing or leave, and never exposes names or text", async () => {
  const asker = await participant(),
    replier = await participant(),
    outsider = await participant();
  const question = await say(asker.token, "A question");
  await say(replier.token, "Private-looking reply text", question);
  const summary = ready(await discussion.activity(asker.token, circle));
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toContain("Private-looking");
  expect(serialized).not.toContain(replier.id);
  expect(Object.keys(summary).sort()).toEqual([
    "latestReplyAt",
    "questions",
    "replies",
  ]);

  // Sharing on but no questions of mine: nothing to report.
  expect(ready(await discussion.activity(outsider.token, circle))).toEqual({
    questions: 0,
    replies: 0,
    latestReplyAt: null,
  });
  // Bad token and unknown circle stop before any read.
  expect((await discussion.activity("not-a-token", circle)).kind).toBe(
    "denied",
  );
  expect((await discussion.activity(asker.token, "nope")).kind).toBe("denied");

  ready(await discussion.withdrawChoice(asker.token, circle, true));
  expect((await discussion.activity(asker.token, circle)).kind).toBe("denied");
  expect(await circles.leave(replier.token, circle)).toBe(true);
  expect((await discussion.activity(replier.token, circle)).kind).toBe(
    "denied",
  );
  // A later sharing choice doesn't bring back old questions.
  ready(
    await discussion.choose(
      asker.token,
      circle,
      randomUUID(),
      "1",
      CIRCLE_DISCUSSION_POLICY,
      true,
    ),
  );
  expect(ready(await discussion.activity(asker.token, circle))).toEqual({
    questions: 0,
    replies: 0,
    latestReplyAt: null,
  });
});
