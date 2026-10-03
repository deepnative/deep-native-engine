import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  discussion = circleDiscussionStore(pool, "invented-circle-test-secret");
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
const token = () => randomBytes(32).toString("hex");
it("creates one separately scoped grant and audits its explicit creation and revocation", async () => {
  const admin = token(),
    staff = token();
  const adminId = await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const staffId = await auth.provisionStaff(
    staff,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const expires = new Date(Date.now() + 1800000),
    key = randomUUID();
  const first = await discussion.grantModerator(
    admin,
    staffId,
    "everyday-ai",
    key,
    expires,
  );
  expect(
    first.kind,
    "A current trusted administrator needs the explicit circle-purpose grant operation",
  ).toBe("ready");
  if (first.kind !== "ready") throw Error("Missing grant receipt");
  expect(
    await discussion.grantModerator(
      admin,
      staffId,
      "everyday-ai",
      key,
      expires,
    ),
  ).toEqual(first);
  expect(
    await discussion.grantModerator(
      admin,
      staffId,
      "professional-work",
      key,
      expires,
    ),
  ).toEqual({ kind: "conflict" });
  const audit = await pool.query(
    "SELECT actor_id,staff_id,circle_id,action FROM preview_circle_grant_audit WHERE grant_id=$1 ORDER BY id",
    [first.value.id],
  );
  expect(audit.rows).toEqual([
    {
      actor_id: adminId,
      staff_id: staffId,
      circle_id: "everyday-ai",
      action: "created",
    },
  ]);
  expect((await discussion.moderationQueue(staff, "everyday-ai")).kind).toBe(
    "ready",
  );
  expect(
    (await discussion.moderationQueue(staff, "professional-work")).kind,
  ).toBe("denied");
  expect(
    (await discussion.revokeModerator(admin, "everyday-ai", first.value.id))
      .kind,
  ).toBe("ready");
  expect(
    (await discussion.revokeModerator(admin, "everyday-ai", first.value.id))
      .kind,
  ).toBe("ready");
  expect((await discussion.moderationQueue(staff, "everyday-ai")).kind).toBe(
    "denied",
  );
  expect(
    (
      await pool.query(
        "SELECT action FROM preview_circle_grant_audit WHERE grant_id=$1 ORDER BY id",
        [first.value.id],
      )
    ).rows,
  ).toEqual([{ action: "created" }, { action: "revoked" }]);
});
it("rejects nonadministrators, unrelated staff roles, invalid circles and expired grant requests", async () => {
  const nonadmin = token(),
    staff = token(),
    admin = token(),
    operator = token();
  await auth.provisionStaff(
    nonadmin,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const staffId = await auth.provisionStaff(
    staff,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const operatorId = await auth.provisionStaff(
    operator,
    "operator",
    new Date(Date.now() + 3600000),
  );
  expect(
    (
      await discussion.grantModerator(
        nonadmin,
        staffId,
        "everyday-ai",
        randomUUID(),
        new Date(Date.now() + 60000),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await discussion.grantModerator(
        admin,
        operatorId,
        "everyday-ai",
        randomUUID(),
        new Date(Date.now() + 60000),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await discussion.grantModerator(
        admin,
        staffId,
        "foreign",
        randomUUID(),
        new Date(Date.now() + 60000),
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await discussion.grantModerator(
        admin,
        staffId,
        "everyday-ai",
        randomUUID(),
        new Date(0),
      )
    ).kind,
  ).toBe("invalid");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_moderator_grants",
      )
    ).rows[0].n,
  ).toBe(0);
});

async function exchange() {
  const members = (await import("../../src/store.ts")).store(pool),
    circles = (await import("../../src/circles.ts")).circleStore(pool),
    circle = "everyday-ai",
    owner = token(),
    peer = token(),
    admin = token(),
    moderator = token();
  for (const actor of [owner, peer]) {
    await members.create(actor, { background: "explorer", goal: "everyday" });
    expect(await circles.join(actor, circle)).toBe("joined");
    expect(
      (
        await discussion.choose(
          actor,
          circle,
          randomUUID(),
          "1",
          "circle-discussion-test-v1",
          true,
        )
      ).kind,
    ).toBe("ready");
  }
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
  const grant = await discussion.grantModerator(
    admin,
    staffId,
    circle,
    randomUUID(),
    new Date(Date.now() + 1800000),
  );
  const post = await discussion.post(
    owner,
    circle,
    randomUUID(),
    "Invented source question",
    true,
  );
  if (grant.kind !== "ready" || post.kind !== "ready")
    throw Error("Invented moderation fixture unavailable");
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
  return {
    circle,
    owner,
    peer,
    admin,
    moderator,
    staffId,
    postId: post.value.id,
    grantId: grant.value.id,
    members,
    circles,
  };
}
it("removes queue content and restoration after an original source's choice is withdrawn", async () => {
  const f = await exchange();
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  const before = await discussion.moderationQueue(f.moderator, f.circle);
  expect(before.kind).toBe("ready");
  if (before.kind === "ready")
    expect(before.value.items[0]?.target?.body).toBe(
      "Invented source question",
    );
  expect((await discussion.withdrawChoice(f.owner, f.circle, true)).kind).toBe(
    "ready",
  );
  const after = await discussion.moderationQueue(f.moderator, f.circle);
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") expect(after.value.items[0]?.target).toBeNull();
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "restore",
        2,
        "test_correction",
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await discussion.choose(
        f.owner,
        f.circle,
        randomUUID(),
        "1",
        "circle-discussion-test-v1",
        true,
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "restore",
        2,
        "test_correction",
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await pool.query(
        "SELECT state,revision FROM preview_circle_posts WHERE id=$1",
        [f.postId],
      )
    ).rows,
  ).toEqual([{ state: "hidden", revision: 2 }]);
});
it("denies a revoked moderator without erasing the owner's independent retained content", async () => {
  const f = await exchange();
  expect(
    (await discussion.revokeModerator(f.admin, f.circle, f.grantId)).kind,
  ).toBe("ready");
  expect((await discussion.moderationQueue(f.moderator, f.circle)).kind).toBe(
    "denied",
  );
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "hide",
        1,
        "conduct",
      )
    ).kind,
  ).toBe("denied");
  const owner = await discussion.owned(f.owner, f.circle);
  expect(owner.kind).toBe("ready");
  if (owner.kind === "ready")
    expect(owner.value.items[0]?.body).toBe("Invented source question");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_moderation_audit WHERE post_id=$1",
        [f.postId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("denies target access and restoration after source departure or erasure while retaining content-free reports", async () => {
  const f = await exchange();
  expect(await f.circles.leave(f.owner, f.circle)).toBe(true);
  let queue = await discussion.moderationQueue(f.moderator, f.circle);
  expect(queue.kind).toBe("ready");
  if (queue.kind === "ready") expect(queue.value.items[0]?.target).toBeNull();
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("denied");
  const session = await f.members.session(f.owner);
  if (session.kind !== "active") throw Error("Fixture owner missing");
  await f.members.remove(session.learner.id);
  queue = await discussion.moderationQueue(f.moderator, f.circle);
  expect(queue.kind).toBe("ready");
  if (queue.kind === "ready") {
    expect(queue.value.items.length).toBe(1);
    expect(queue.value.items[0]?.target).toBeNull();
  }
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.postId,
        randomUUID(),
        "restore",
        1,
        "test_correction",
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_reports WHERE target_id=$1",
        [f.postId],
      )
    ).rows[0].n,
  ).toBe(1);
});
