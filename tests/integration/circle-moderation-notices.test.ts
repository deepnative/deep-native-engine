import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool),
  circles = circleStore(pool);
const discussion = circleDiscussionStore(pool, "invented-notice-fixture");
let running: Awaited<ReturnType<typeof start>>;
let storage: string;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  storage = await mkdtemp(join(tmpdir(), "dne196-notice-"));
  running = await start({
    ...process.env,
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_CIRCLE_DISCUSSION: "enabled",
  });
});
afterEach(async () => {
  await running?.close();
  if (storage) await rm(storage, { recursive: true });
});
afterAll(async () => pool.end());

async function hiddenContribution(hide = true) {
  const owner = randomBytes(32).toString("hex"),
    peer = randomBytes(32).toString("hex");
  const admin = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
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
  const auth = authorizationStore(pool);
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
  const post = await discussion.post(
    owner,
    circle,
    randomUUID(),
    "Invented circle source; never copy this body into the decision notice",
    true,
  );
  if (post.kind !== "ready") throw Error("Missing invented contribution");
  expect(
    (
      await discussion.report(
        peer,
        circle,
        post.value.id,
        randomUUID(),
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  if (hide)
    expect(
      (
        await discussion.moderate(
          moderator,
          circle,
          post.value.id,
          randomUUID(),
          "hide",
          1,
          "privacy",
        )
      ).kind,
    ).toBe("ready");
  return { owner, peer, moderator, circle, id: post.value.id };
}

it("MODN-01 affected member opens a recorded private moderation decision with its reason and time", async () => {
  const f = await hiddenContribution();
  const response = await request(running.server)
    .get(`/circles/${f.circle}/discussion/posts/${f.id}/moderation-notice`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${f.owner}`);
  expect(
    response.status,
    "An affected member needs a normal own-decision notice instead of an unavailable route",
  ).toBe(200);
  expect(response.text).toContain("Your private moderation decision notice");
  expect(response.text).toContain("privacy");
  expect(response.text).toContain("Decision time");
  expect(response.text).not.toContain("never copy this body");
  expect(response.text).not.toContain(f.moderator);
});

const noticePath = (f: { circle: string; id: string }) =>
  `/circles/${f.circle}/discussion/posts/${f.id}/moderation-notice`;
const get = (token: string, path: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);

it("MODN-01/04 downloads exactly the latest content-free decision and creates no retained record", async () => {
  const f = await hiddenContribution();
  const before = (
    await pool.query(
      "SELECT count(*)::int n FROM preview_circle_moderation_audit",
    )
  ).rows[0].n;
  const owned = await get(
    f.owner,
    `/circles/${f.circle}/discussion/owned`,
  ).expect(200);
  expect(owned.text).toContain(noticePath(f));
  const response = await get(f.owner, noticePath(f) + "/download").expect(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-disposition"]).toContain(
    'attachment; filename="circle-moderation-notice.json"',
  );
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.body).toEqual({
    noticeVersion: 1,
    circleId: f.circle,
    postId: f.id,
    postState: "hidden",
    postRevision: 2,
    decision: {
      action: "hidden",
      reason: "privacy",
      oldRevision: 1,
      newRevision: 2,
      occurredAt: expect.any(String),
    },
  });
  expect(JSON.stringify(response.body)).not.toMatch(
    /actor|reporter|fingerprint|idempotency|body/,
  );
  await get(f.owner, noticePath(f) + "/download").expect(200);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM preview_circle_moderation_audit",
      )
    ).rows[0].n,
  ).toBe(before);
});
it("MODN-01 distinguishes no decision and the latest restoration from an earlier hide", async () => {
  const f = await hiddenContribution(false);
  expect((await get(f.owner, noticePath(f)).expect(200)).text).toContain(
    "No moderation decision is recorded",
  );
  expect(
    (await get(f.owner, noticePath(f) + "/download").expect(200)).body.decision,
  ).toBeNull();
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.id,
        randomUUID(),
        "hide",
        1,
        "conduct",
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.id,
        randomUUID(),
        "restore",
        2,
        "test_correction",
      )
    ).kind,
  ).toBe("ready");
  const value = (await get(f.owner, noticePath(f) + "/download").expect(200))
    .body;
  expect(value).toMatchObject({
    postState: "visible",
    postRevision: 3,
    decision: {
      action: "restored",
      reason: "test_correction",
      oldRevision: 2,
      newRevision: 3,
    },
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM preview_circle_moderation_audit WHERE post_id=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(2);
});
it.each(["peer", "moderator", "unknown", "wrong-circle"])(
  "MODN-02 denies %s without decision or attachment disclosure",
  async (kind) => {
    const f = await hiddenContribution();
    const token =
      kind === "peer" ? f.peer : kind === "moderator" ? f.moderator : f.owner;
    const path =
      kind === "unknown"
        ? noticePath({ ...f, id: randomUUID() })
        : kind === "wrong-circle"
          ? noticePath({ ...f, circle: "professional-work" })
          : noticePath(f);
    expect(
      await discussion.moderationNotice(
        token,
        kind === "wrong-circle" ? "professional-work" : f.circle,
        kind === "unknown" ? path.split("/")[5]! : f.id,
      ),
    ).toEqual({ kind: "denied" });
    for (const suffix of ["", "/download"]) {
      const response = await get(token, path + suffix).expect(
        kind === "moderator" ? 303 : 403,
      );
      if (kind === "moderator") expect(response.headers.location).toBe("/");
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.text).not.toContain("Decision time");
      expect(response.text).not.toContain(f.id);
    }
  },
);
it.each(["bad-id", "query", "duplicate-query"])(
  "MODN-02 rejects %s before returning notice bytes",
  async (kind) => {
    const f = await hiddenContribution();
    const path =
      kind === "bad-id"
        ? noticePath({ ...f, id: "invalid" })
        : noticePath(f) +
          (kind === "query" ? "?member_id=other" : "?cursor=a&cursor=b");
    const response = await get(f.owner, path).expect(422);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).not.toContain("Decision time");
  },
);
it("MODN-03 retains private notices after leave, sharing/post withdrawal and write pause without republishing text", async () => {
  const f = await hiddenContribution();
  expect((await discussion.withdrawChoice(f.owner, f.circle, true)).kind).toBe(
    "ready",
  );
  expect(await circles.leave(f.owner, f.circle)).toBe(true);
  await get(f.owner, noticePath(f)).expect(200);
  expect((await discussion.withdraw(f.owner, f.circle, f.id, true)).kind).toBe(
    "ready",
  );
  const paused = circleDiscussionStore(pool, "invented-pause", false);
  const result = await paused.moderationNotice(f.owner, f.circle, f.id);
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      postState: "withdrawn",
      postRevision: 3,
      decision: { action: "hidden", newRevision: 2 },
    },
  });
  await running.close();
  running = await start({
    ...process.env,
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_CIRCLE_DISCUSSION: "disabled",
  });
  const response = await get(f.owner, noticePath(f) + "/download").expect(200);
  expect(response.body.postState).toBe("withdrawn");
  expect(response.text).not.toContain("never copy this body");
  expect(
    (
      await pool.query(
        "SELECT body,state FROM preview_circle_posts WHERE id=$1",
        [f.id],
      )
    ).rows[0],
  ).toEqual({ body: null, state: "withdrawn" });
});
it.each(["expired", "revoked", "deleting", "deleted"])(
  "MODN-02/03 withholds %s owner notices and erases owned audit on account deletion",
  async (kind) => {
    const f = await hiddenContribution();
    const session = await members.session(f.owner);
    if (session.kind !== "active") throw Error("Missing fixture owner");
    if (kind === "deleted") await members.remove(session.learner.id);
    else if (kind === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [session.learner.id],
      );
    else
      await pool.query(
        `UPDATE principals SET ${kind === "expired" ? "expires_at=clock_timestamp()-interval '1 second'" : "revoked_at=clock_timestamp()"} WHERE id=$1`,
        [session.learner.id],
      );
    expect(await discussion.moderationNotice(f.owner, f.circle, f.id)).toEqual({
      kind: "denied",
    });
    const response = await get(f.owner, noticePath(f) + "/download").expect(
      kind === "deleting" ? 403 : 303,
    );
    if (kind !== "deleting") expect(response.headers.location).toBe("/");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).not.toContain("Decision time");
    if (kind === "deleted")
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_moderation_audit WHERE post_id=$1",
            [f.id],
          )
        ).rowCount,
      ).toBe(0);
  },
);
it("MODN-02/03 rechecks owner deletion state after an observed real workspace lock wait", async () => {
  const f = await hiddenContribution();
  const session = await members.session(f.owner);
  if (session.kind !== "active") throw Error("Missing owner");
  const holder = await pool.connect();
  let pending: ReturnType<typeof discussion.moderationNotice> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [session.learner.id],
    );
    pending = discussion.moderationNotice(f.owner, f.circle, f.id);
    const deadline = Date.now() + 2000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT owner_principal_id FROM workspaces%') blocked",
        )
      ).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      blocked,
      "Observe the actual authorization row lock before releasing it",
    ).toBe(true);
    await holder.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending?.catch(() => {});
  }
});
