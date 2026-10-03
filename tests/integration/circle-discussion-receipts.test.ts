import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-receipt-test-secret"),
  circle = "everyday-ai";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented receipt member missing");
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
  return { token, id: session.learner.id };
}
async function report(owner: string, peer: string) {
  const post = await discussion.post(
    owner,
    circle,
    randomUUID(),
    "Invented receipt target",
    true,
  );
  if (post.kind !== "ready") throw Error("Question fixture missing");
  const receipt = await discussion.report(
    peer,
    circle,
    post.value.id,
    randomUUID(),
    "privacy",
  );
  if (receipt.kind !== "ready") throw Error("Report fixture missing");
  return { postId: post.value.id, receiptId: receipt.value.id };
}
it("paginates own receipts with actor/circle/list-bound cursors and no foreign target identity", async () => {
  const owner = await member(),
    peer = await member(),
    foreign = await member(),
    ids: string[] = [],
    targets: string[] = [];
  for (let index = 0; index < 22; index++) {
    const saved = await report(owner.token, peer.token);
    ids.push(saved.receiptId);
    targets.push(saved.postId);
  }
  const first = await discussion.reports(peer.token, circle);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw Error("Own receipts unavailable");
  expect(first.value.items.length).toBe(20);
  expect(first.value.nextCursor).not.toBeNull();
  const cursor = first.value.nextCursor!;
  for (const item of first.value.items) {
    expect(Object.keys(item).sort()).toEqual([
      "category",
      "createdAt",
      "id",
      "status",
    ]);
    expect(item.status).toBe("reported");
  }
  for (const target of targets)
    expect(JSON.stringify(first.value.items)).not.toContain(target);
  expect((await discussion.reports(foreign.token, circle, cursor)).kind).toBe(
    "invalid",
  );
  expect(
    (await discussion.reports(peer.token, "professional-work", cursor)).kind,
  ).toBe("invalid");
  expect((await discussion.owned(peer.token, circle, cursor)).kind).toBe(
    "invalid",
  );
  expect(
    (await discussion.reports(peer.token, circle, cursor + "tampered")).kind,
  ).toBe("invalid");
  const second = await discussion.reports(peer.token, circle, cursor);
  expect(second.kind).toBe("ready");
  if (second.kind === "ready") {
    expect(second.value.items.length).toBe(2);
    expect(second.value.nextCursor).toBeNull();
    expect(
      [...first.value.items, ...second.value.items]
        .map((item) => item.id)
        .sort(),
    ).toEqual(ids.sort());
  }
  expect(
    (await discussion.reportReceipt(owner.token, circle, ids[0]!)).kind,
  ).toBe("denied");
});
it("shows content-free current hidden/unavailable states without granting source body access", async () => {
  const owner = await member(),
    peer = await member(),
    saved = await report(owner.token, peer.token),
    auth = authorizationStore(pool),
    admin = randomBytes(32).toString("hex"),
    moderator = randomBytes(32).toString("hex");
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
  expect(
    (
      await discussion.moderate(
        moderator,
        circle,
        saved.postId,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  let receipt = await discussion.reportReceipt(
    peer.token,
    circle,
    saved.receiptId,
  );
  expect(receipt).toMatchObject({ kind: "ready", value: { status: "hidden" } });
  expect(JSON.stringify(receipt)).not.toContain("Invented receipt target");
  expect(
    (
      await discussion.moderate(
        moderator,
        circle,
        saved.postId,
        randomUUID(),
        "restore",
        2,
        "test_correction",
      )
    ).kind,
  ).toBe("ready");
  expect(
    await discussion.reportReceipt(peer.token, circle, saved.receiptId),
  ).toMatchObject({ kind: "ready", value: { status: "reported" } });
  expect(
    (await discussion.withdraw(owner.token, circle, saved.postId, true)).kind,
  ).toBe("ready");
  receipt = await discussion.reportReceipt(peer.token, circle, saved.receiptId);
  expect(receipt).toMatchObject({
    kind: "ready",
    value: { status: "unavailable" },
  });
  expect(JSON.stringify(receipt)).not.toContain(saved.postId);
  expect(JSON.stringify(receipt)).not.toContain(owner.id);
});
it("preserves an own receipt while sharing is paused and treats its target as unavailable", async () => {
  const owner = await member(),
    peer = await member(),
    saved = await report(owner.token, peer.token);
  const paused = circleDiscussionStore(
    pool,
    "invented-receipt-test-secret",
    false,
  );
  expect(
    await paused.reportReceipt(peer.token, circle, saved.receiptId),
  ).toMatchObject({ kind: "ready", value: { status: "unavailable" } });
  expect((await paused.reports(peer.token, circle)).kind).toBe("ready");
});
it("preserves only the root owner's records when the reply author/reporter erases first", async () => {
  const owner = await member(),
    peer = await member(),
    saved = await report(owner.token, peer.token);
  const reply = await discussion.post(
    peer.token,
    circle,
    randomUUID(),
    "Invented reply being erased",
    true,
    saved.postId,
  );
  expect(reply.kind).toBe("ready");
  await members.remove(peer.id);
  expect(
    (await discussion.reportReceipt(peer.token, circle, saved.receiptId)).kind,
  ).toBe("denied");
  const root = await discussion.thread(owner.token, circle, saved.postId);
  expect(root.kind).toBe("ready");
  if (root.kind === "ready") {
    expect(root.value.root.body).toBe("Invented receipt target");
    expect(root.value.replies.items).toEqual([]);
  }
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_reports WHERE member_id=$1",
        [peer.id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM preview_circle_posts WHERE member_id=$1",
        [owner.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
