import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
  circle = "everyday-ai",
  secret = "invented-reconcile-secret";
const discussion = circleDiscussionStore(pool, secret);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex"),
    key = randomUUID();
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  expect(await circles.join(token, circle)).toBe("joined");
  const choice = await discussion.choose(
    token,
    circle,
    key,
    "1",
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  if (choice.kind !== "ready") throw Error("Invented choice missing");
  return { token, id: session.learner.id, key, choice: choice.value.id };
}
it("reconciles only the current actor's exact-circle original key without copying text or foreign references", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  const post = await discussion.post(
    a.token,
    circle,
    key,
    "Invented unrepeated secret text",
    true,
  );
  if (post.kind !== "ready") throw Error("Invented question missing");
  expect(await discussion.reconcile(a.token, circle, "post", key)).toEqual({
    kind: "ready",
    value: { found: true, id: post.value.id, status: "visible", revision: 1 },
  });
  const empty = {
    kind: "ready",
    value: { found: false, id: null, status: null, revision: null },
  };
  expect(await discussion.reconcile(b.token, circle, "post", key)).toEqual(
    empty,
  );
  expect(
    await discussion.reconcile(a.token, "professional-work", "post", key),
  ).toEqual(empty);
  expect(await discussion.reconcile(a.token, circle, "report", key)).toEqual(
    empty,
  );
  expect(
    await discussion.reconcile(a.token, circle, "post", randomUUID()),
  ).toEqual(empty);
  expect(
    await discussion.reconcile(a.token, circle, "post", "not-a-key"),
  ).toEqual({ kind: "invalid" });
  expect(await discussion.reconcile(a.token, circle, "unknown", key)).toEqual({
    kind: "invalid",
  });
  expect(await discussion.reconcile(a.token, circle, "choice", a.key)).toEqual({
    kind: "ready",
    value: { found: true, id: a.choice, status: "retained", revision: null },
  });
  await discussion.withdraw(a.token, circle, post.value.id, true);
  expect(await discussion.reconcile(a.token, circle, "post", key)).toEqual({
    kind: "ready",
    value: { found: true, id: post.value.id, status: "withdrawn", revision: 2 },
  });
  await circles.leave(a.token, circle);
  expect(
    await circleDiscussionStore(pool, secret, false).reconcile(
      a.token,
      circle,
      "post",
      key,
    ),
  ).toEqual({
    kind: "ready",
    value: { found: true, id: post.value.id, status: "withdrawn", revision: 2 },
  });
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    a.id,
  ]);
  expect(await discussion.reconcile(a.token, circle, "post", key)).toEqual({
    kind: "denied",
  });
});
it("keeps the reporter's original-key receipt independent of target erasure and withholds foreign identities", async () => {
  const a = await member(),
    b = await member(),
    key = randomUUID();
  const post = await discussion.post(
    a.token,
    circle,
    randomUUID(),
    "Invented target that must never enter reconciliation",
    true,
  );
  if (post.kind !== "ready") throw Error("Invented target missing");
  const report = await discussion.report(
    b.token,
    circle,
    post.value.id,
    key,
    "privacy",
  );
  if (report.kind !== "ready") throw Error("Invented report missing");
  const receipt = {
    kind: "ready",
    value: {
      found: true,
      id: report.value.id,
      status: "retained",
      revision: null,
    },
  };
  expect(await discussion.reconcile(b.token, circle, "report", key)).toEqual(
    receipt,
  );
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    a.id,
  ]);
  expect(await discussion.reconcile(b.token, circle, "report", key)).toEqual(
    receipt,
  );
  expect(
    await discussion.reconcile(b.token, circle, "moderation", key),
  ).toEqual({ kind: "denied" });
});

it("reconciles content-free staff action metadata only under a current exact-circle grant", async () => {
  const a = await member(),
    staff = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex"),
    key = randomUUID();
  const auth = authorizationStore(pool);
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
  const post = await discussion.post(
    a.token,
    circle,
    randomUUID(),
    "Invented content unavailable in receipts",
    true,
  );
  if (post.kind !== "ready") throw Error("Invented post unavailable");
  expect(await discussion.reconcile(staff, circle, "moderation", key)).toEqual({
    kind: "denied",
  });
  const grant = await discussion.grantModerator(
    admin,
    staffId,
    circle,
    randomUUID(),
    new Date(Date.now() + 1800000),
  );
  if (grant.kind !== "ready") throw Error("Invented grant unavailable");
  expect(
    (
      await discussion.moderate(
        staff,
        circle,
        post.value.id,
        key,
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  const receipt = {
    kind: "ready",
    value: { found: true, id: null, status: "hidden", revision: 2 },
  };
  expect(await discussion.reconcile(staff, circle, "moderation", key)).toEqual(
    receipt,
  );
  expect(
    await circleDiscussionStore(pool, secret, false).reconcile(
      staff,
      circle,
      "moderation",
      key,
    ),
  ).toEqual(receipt);
  expect(
    await discussion.reconcile(staff, "professional-work", "moderation", key),
  ).toEqual({ kind: "denied" });
  expect(
    (await discussion.revokeModerator(admin, circle, grant.value.id)).kind,
  ).toBe("ready");
  expect(await discussion.reconcile(staff, circle, "moderation", key)).toEqual({
    kind: "denied",
  });
  const replacement = await discussion.grantModerator(
    admin,
    staffId,
    circle,
    randomUUID(),
    new Date(Date.now() + 1800000),
  );
  if (replacement.kind !== "ready")
    throw Error("Fresh invented grant unavailable");
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    a.id,
  ]);
  expect(await discussion.reconcile(staff, circle, "moderation", key)).toEqual({
    kind: "ready",
    value: { found: false, id: null, status: null, revision: null },
  });
  await pool.query(
    "UPDATE preview_circle_moderator_grants SET starts_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [replacement.value.id],
  );
  expect(await discussion.reconcile(staff, circle, "moderation", key)).toEqual({
    kind: "denied",
  });
});
