import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import type { Pool } from "pg";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool),
  circles = circleStore(pool);
const discussion = circleDiscussionStore(
  pool,
  "invented-reporter-notice-fixture",
);
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
  const report = await discussion.report(
    peer,
    circle,
    post.value.id,
    randomUUID(),
    "privacy",
  );
  if (report.kind !== "ready") throw Error("Missing invented own report");
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
  return {
    owner,
    peer,
    moderator,
    staffId,
    circle,
    id: post.value.id,
    reportId: report.value.id,
  };
}

it("RPTN-01 reporter opens the latest recorded decision for exactly their own report", async () => {
  const f = await hiddenContribution();
  const response = await request(running.server)
    .get(
      `/circles/${f.circle}/discussion/reports/${f.reportId}/moderation-notice`,
    )
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${f.peer}`);
  expect(
    response.status,
    "Reporter needs the recorded decision rather than an unavailable notice route",
  ).toBe(200);
  expect(response.text).toContain("Your private report decision notice");
  expect(response.text).toContain("Decision time");
  expect(response.text).toContain("privacy");
  expect(response.text).not.toContain("never copy this body");
});

const noticePath = (f: { circle: string; reportId: string }) =>
  `/circles/${f.circle}/discussion/reports/${f.reportId}/moderation-notice`;
const get = (token: string, path: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
async function memberId(token: string) {
  const s = await members.session(token);
  if (s.kind !== "active") throw Error("Invented active member missing");
  return s.learner.id;
}
async function anotherMember() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  expect(await circles.join(token, "everyday-ai")).toBe("joined");
  expect(
    (
      await discussion.choose(
        token,
        "everyday-ai",
        randomUUID(),
        "1",
        "circle-discussion-test-v1",
        true,
      )
    ).kind,
  ).toBe("ready");
  return token;
}
it("RPTN-01/05 distinguishes no later decision, hide reason and latest restoration without creating rows", async () => {
  const f = await hiddenContribution(false),
    path = noticePath(f);
  const receipt = await get(
    f.peer,
    `/circles/${f.circle}/discussion/reports/${f.reportId}`,
  ).expect(200);
  expect(receipt.text).toContain(path);
  expect(
    (await get(f.peer, path + "/download").expect(200)).body.decision,
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
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM preview_circle_reports)::int reports,(SELECT count(*) FROM preview_circle_moderation_audit)::int decisions,(SELECT count(*) FROM preview_circle_appeals)::int appeals",
      )
    ).rows[0];
  const before = await counts();
  const response = await get(f.peer, path + "/download").expect(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-disposition"]).toBe(
    'attachment; filename="circle-report-decision-notice.json"',
  );
  expect(response.body).toEqual({
    reportNoticeVersion: 1,
    circleId: f.circle,
    reportId: f.reportId,
    category: "privacy",
    reportedAt: expect.any(String),
    targetStatus: "hidden",
    decision: {
      action: "hidden",
      reason: "conduct",
      oldRevision: 1,
      newRevision: 2,
      occurredAt: expect.any(String),
    },
  });
  for (const secret of [
    f.id,
    f.staffId,
    await memberId(f.owner),
    await memberId(f.peer),
    "never copy this body",
  ])
    expect(JSON.stringify(response.body)).not.toContain(secret);
  expect(JSON.stringify(response.body)).not.toMatch(
    /actor|pseudonym|fingerprint|idempotency|workspace|body|rootId|postId/,
  );
  expect(await counts()).toEqual(before);
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
  expect(
    (await get(f.peer, path + "/download").expect(200)).body,
  ).toMatchObject({
    targetStatus: "reported",
    decision: {
      action: "restored",
      reason: "test_correction",
      oldRevision: 2,
      newRevision: 3,
    },
  });
  expect((await get(f.peer, path).expect(200)).text).toContain(
    "not a resolution of your individual report",
  );
});
it("RPTN-01 never attributes a decision before this report to a later reporter", async () => {
  const f = await hiddenContribution();
  await discussion.moderate(
    f.moderator,
    f.circle,
    f.id,
    randomUUID(),
    "restore",
    2,
    "test_correction",
  );
  const later = await anotherMember(),
    report = await discussion.report(
      later,
      f.circle,
      f.id,
      randomUUID(),
      "other",
    );
  if (report.kind !== "ready") throw Error("Later report missing");
  expect(
    await discussion.reportModerationNotice(later, f.circle, report.value.id),
  ).toMatchObject({
    kind: "ready",
    value: { targetStatus: "reported", decision: null },
  });
  await discussion.moderate(
    f.moderator,
    f.circle,
    f.id,
    randomUUID(),
    "hide",
    3,
    "off_topic",
  );
  expect(
    await discussion.reportModerationNotice(later, f.circle, report.value.id),
  ).toMatchObject({
    kind: "ready",
    value: {
      decision: { action: "hidden", newRevision: 4, reason: "off_topic" },
    },
  });
});
it.each([
  "source-owner",
  "other-member",
  "staff",
  "unknown-report",
  "wrong-circle",
  "invalid-report",
  "query",
] as const)(
  "RPTN-02 denies %s without a downloadable attachment",
  async (kind) => {
    const f = await hiddenContribution();
    let token = f.peer,
      path = noticePath(f) + "/download",
      status = 403;
    if (kind === "source-owner") token = f.owner;
    if (kind === "other-member") token = await anotherMember();
    if (kind === "staff") {
      token = f.moderator;
      status = 303;
    }
    if (kind === "unknown-report")
      path = path.replace(f.reportId, randomUUID());
    if (kind === "wrong-circle")
      path = path.replace(f.circle, "professional-work");
    if (kind === "invalid-report") {
      path = path.replace(f.reportId, "bad");
      status = 422;
    }
    if (kind === "query") {
      path += "?targetId=" + f.id;
      status = 422;
    }
    const response = await get(token, path).expect(status);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).not.toContain("never copy this body");
    expect(response.text).not.toContain("Decision time");
  },
);
it.each([
  "reporter-leave",
  "reporter-choice",
  "source-leave",
  "source-choice",
  "source-text",
  "source-delete",
] as const)(
  "RPTN-03/06 keeps only own receipt when %s removes current eligibility",
  async (kind) => {
    const f = await hiddenContribution();
    if (kind === "reporter-leave") await circles.leave(f.peer, f.circle);
    if (kind === "reporter-choice")
      await discussion.withdrawChoice(f.peer, f.circle, true);
    if (kind === "source-leave") await circles.leave(f.owner, f.circle);
    if (kind === "source-choice")
      await discussion.withdrawChoice(f.owner, f.circle, true);
    if (kind === "source-text")
      await discussion.withdraw(f.owner, f.circle, f.id, true);
    if (kind === "source-delete") await members.remove(await memberId(f.owner));
    const response = await get(f.peer, noticePath(f) + "/download").expect(200);
    expect(response.body).toMatchObject({
      reportId: f.reportId,
      targetStatus: "unavailable",
      decision: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(f.id);
    expect(
      (await discussion.reportReceipt(f.peer, f.circle, f.reportId)).kind,
    ).toBe("ready");
    if (kind === "source-leave") {
      expect(await circles.join(f.owner, f.circle)).toBe("joined");
      expect(
        (
          await discussion.choose(
            f.owner,
            f.circle,
            randomUUID(),
            "2",
            "circle-discussion-test-v1",
            true,
          )
        ).kind,
      ).toBe("ready");
      expect(
        (await get(f.peer, noticePath(f) + "/download").expect(200)).body
          .decision,
      ).toBeNull();
    }
  },
);
it("RPTN-03 hides a reply decision when its independently owned root becomes hidden or erased", async () => {
  const f = await hiddenContribution(false),
    replyOwner = await anotherMember();
  const reply = await discussion.post(
    replyOwner,
    f.circle,
    randomUUID(),
    "Invented independently owned reply",
    true,
    f.id,
  );
  if (reply.kind !== "ready") throw Error("Reply fixture missing");
  const report = await discussion.report(
    f.peer,
    f.circle,
    reply.value.id,
    randomUUID(),
    "conduct",
  );
  if (report.kind !== "ready") throw Error("Reply report missing");
  await discussion.moderate(
    f.moderator,
    f.circle,
    reply.value.id,
    randomUUID(),
    "hide",
    1,
    "conduct",
  );
  expect(
    await discussion.reportModerationNotice(f.peer, f.circle, report.value.id),
  ).toMatchObject({ kind: "ready", value: { decision: { action: "hidden" } } });
  await discussion.moderate(
    f.moderator,
    f.circle,
    f.id,
    randomUUID(),
    "hide",
    1,
    "off_topic",
  );
  expect(
    await discussion.reportModerationNotice(f.peer, f.circle, report.value.id),
  ).toMatchObject({
    kind: "ready",
    value: { targetStatus: "unavailable", decision: null },
  });
  await members.remove(await memberId(f.owner));
  expect(
    await discussion.reportModerationNotice(f.peer, f.circle, report.value.id),
  ).toMatchObject({
    kind: "ready",
    value: { targetStatus: "unavailable", decision: null },
  });
  expect(
    (
      await pool.query("SELECT 1 FROM preview_circle_posts WHERE id=$1", [
        reply.value.id,
      ])
    ).rowCount,
  ).toBe(1);
});
it("RPTN-03 a write pause retains the private receipt without reading current decisions", async () => {
  const f = await hiddenContribution(),
    paused = circleDiscussionStore(
      pool,
      "invented-reporter-notice-fixture",
      false,
    );
  expect(
    await paused.reportModerationNotice(f.peer, f.circle, f.reportId),
  ).toMatchObject({
    kind: "ready",
    value: { targetStatus: "unavailable", decision: null },
  });
});
it.each(["expired", "revoked", "deleting", "deleted"] as const)(
  "RPTN-02/06 denies a %s reporter and account deletion erases its own receipt",
  async (state) => {
    const f = await hiddenContribution(),
      id = await memberId(f.peer);
    if (state === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    if (state === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    if (state === "deleting")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [id],
      );
    if (state === "deleted") await members.remove(id);
    expect(
      await discussion.reportModerationNotice(f.peer, f.circle, f.reportId),
    ).toEqual({ kind: "denied" });
    const response = await get(f.peer, noticePath(f) + "/download").expect(
      state === "deleting" ? 403 : 303,
    );
    expect(response.headers["content-disposition"]).toBeUndefined();
    if (state === "deleted")
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_reports WHERE member_id=$1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
  },
);
it("RPTN-04 observes a real reporter workspace lock wait then denies the newly deleting account", async () => {
  const f = await hiddenContribution(),
    id = await memberId(f.peer),
    holder = await pool.connect();
  let pending: ReturnType<typeof discussion.reportModerationNotice> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [id],
    );
    pending = discussion.reportModerationNotice(f.peer, f.circle, f.reportId);
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
    expect(blocked, "Observe actual authorization lock before releasing").toBe(
      true,
    );
    await holder.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending?.catch(() => {});
  }
});
it("RPTN-04 a concurrent hide or restoration cannot produce a mismatched current snapshot", async () => {
  const f = await hiddenContribution();
  const [notice, restore] = await Promise.all([
    discussion.reportModerationNotice(f.peer, f.circle, f.reportId),
    discussion.moderate(
      f.moderator,
      f.circle,
      f.id,
      randomUUID(),
      "restore",
      2,
      "test_correction",
    ),
  ]);
  expect(restore.kind).toBe("ready");
  expect(notice.kind).toBe("ready");
  if (notice.kind === "ready")
    expect(notice.value.decision?.action).toBe(
      notice.value.targetStatus === "hidden" ? "hidden" : "restored",
    );
  expect(
    await discussion.reportModerationNotice(f.peer, f.circle, f.reportId),
  ).toMatchObject({
    kind: "ready",
    value: {
      targetStatus: "reported",
      decision: { action: "restored", newRevision: 3 },
    },
  });
});
it.each(["COMMIT", "release"] as const)(
  "RPTN-05 actual native read with lost %s handback is not acknowledged and can be explicitly inspected again",
  async (phase) => {
    const f = await hiddenContribution();
    let lose = true;
    const uncertainPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            if (text === "COMMIT" && phase === "COMMIT" && lose) {
              lose = false;
              throw Error("Invented lost read COMMIT response");
            }
            return result;
          },
          release(error?: Error) {
            client.release(error);
            if (phase === "release" && lose) {
              lose = false;
              throw Error("Invented lost release handback");
            }
          },
        };
      },
    } as unknown as Pool;
    await expect(
      circleDiscussionStore(
        uncertainPool,
        "invented-lost-read",
      ).reportModerationNotice(f.peer, f.circle, f.reportId),
    ).rejects.toThrow(/unconfirmed|unavailable/);
    expect(lose).toBe(false);
    expect(
      await discussion.reportModerationNotice(f.peer, f.circle, f.reportId),
    ).toMatchObject({
      kind: "ready",
      value: { decision: { action: "hidden", newRevision: 2 } },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM preview_circle_moderation_audit",
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
