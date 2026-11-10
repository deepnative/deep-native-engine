import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

// #196 RPTD-01..08: report dispositions against real PostgreSQL.
const pool = testPool();
const members = store(pool),
  circles = circleStore(pool);
const discussion = circleDiscussionStore(pool, "invented-disposition-fixture");
let running: Awaited<ReturnType<typeof start>>;
let storage: string;
beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  storage = await mkdtemp(join(tmpdir(), "dne196-disposition-"));
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

const circle = "everyday-ai";
const token = () => randomBytes(32).toString("hex");
async function member(join = true) {
  const value = token();
  await members.create(value, { background: "explorer", goal: "everyday" });
  if (join) {
    expect(await circles.join(value, circle)).toBe("joined");
    expect(
      (
        await discussion.choose(
          value,
          circle,
          randomUUID(),
          "1",
          "circle-discussion-test-v1",
          true,
        )
      ).kind,
    ).toBe("ready");
  }
  return value;
}
async function memberId(value: string) {
  const s = await members.session(value);
  if (s.kind !== "active") throw Error("Invented member missing");
  return s.learner.id;
}
async function fixture({ hideFirst = false } = {}) {
  const owner = await member(),
    peer = await member(),
    other = await member(),
    admin = token(),
    moderator = token(),
    unrelated = token();
  const auth = authorizationStore(pool),
    expiry = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expiry);
  const staffId = await auth.provisionStaff(moderator, "moderator", expiry);
  await auth.provisionStaff(unrelated, "moderator", expiry);
  const grant = await discussion.grantModerator(
    admin,
    staffId,
    circle,
    randomUUID(),
    new Date(Date.now() + 1800000),
  );
  if (grant.kind !== "ready") throw Error("Missing invented grant");
  const post = await discussion.post(
    owner,
    circle,
    randomUUID(),
    "INVENTED-DISPOSITION-SOURCE-BODY",
    true,
  );
  if (post.kind !== "ready") throw Error("Missing invented contribution");
  // A decision recorded before the report: hide, then restore (revision 3).
  if (hideFirst)
    for (const [action, revision, reason] of [
      ["hide", 1, "conduct"],
      ["restore", 2, "test_correction"],
    ] as const)
      expect(
        (
          await discussion.moderate(
            moderator,
            circle,
            post.value.id,
            randomUUID(),
            action,
            revision,
            reason,
          )
        ).kind,
      ).toBe("ready");
  const report = await discussion.report(
    peer,
    circle,
    post.value.id,
    randomUUID(),
    "privacy",
  );
  const second = await discussion.report(
    other,
    circle,
    post.value.id,
    randomUUID(),
    "conduct",
  );
  if (report.kind !== "ready" || second.kind !== "ready")
    throw Error("Missing invented reports");
  return {
    owner,
    peer,
    other,
    admin,
    moderator,
    unrelated,
    staffId,
    grantId: grant.value.id,
    postId: post.value.id,
    reportId: report.value.id,
    secondId: second.value.id,
  };
}
const dispose = (
  actor: string,
  reportId: string,
  action: string,
  reason: string,
  reportRevision = 1,
  sourceRevision = 1,
  decisionRevision: number | null = null,
  key = randomUUID(),
) =>
  discussion.disposeReport(
    actor,
    circle,
    reportId,
    key,
    action,
    reason,
    reportRevision,
    sourceRevision,
    decisionRevision,
  );
const http = (path: string, session: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${session}`);
const rows = async (reportId: string) =>
  (
    await pool.query(
      "SELECT revision,action,reason,source_revision,decision_revision FROM preview_circle_report_dispositions WHERE report_id=$1 ORDER BY revision",
      [reportId],
    )
  ).rows;

it("RPTD-01 rejects one report with an exact reason and the reporter downloads the content-free outcome", async () => {
  const f = await fixture();
  expect(
    await dispose(f.moderator, f.reportId, "reject", "rule_not_breached"),
  ).toEqual({ kind: "ready", value: { id: f.reportId, revision: 2 } });
  expect(await rows(f.reportId)).toEqual([
    {
      revision: 2,
      action: "rejected",
      reason: "rule_not_breached",
      source_revision: 1,
      decision_revision: null,
    },
  ]);
  // The contribution and every other report are unchanged.
  expect(await rows(f.secondId)).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT state,revision,body FROM preview_circle_posts WHERE id=$1",
        [f.postId],
      )
    ).rows[0],
  ).toEqual({
    state: "visible",
    revision: 1,
    body: "INVENTED-DISPOSITION-SOURCE-BODY",
  });
  const base = `/circles/${circle}/discussion/reports/${f.reportId}`;
  const receipt = await http(base, f.peer);
  expect(receipt.status).toBe(200);
  expect(receipt.text).toContain("Inspect what happened to this report");
  const page = await http(`${base}/disposition`, f.peer);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Rejected as not actionable");
  expect(page.text).toContain("No rule was breached");
  const download = await http(`${base}/disposition/download`, f.peer);
  expect(download.status).toBe(200);
  expect(download.headers["content-disposition"]).toContain(
    "circle-report-disposition.json",
  );
  expect(download.headers["cache-control"]).toBe("no-store");
  const body = JSON.parse(download.text);
  expect(Object.keys(body).sort()).toEqual([
    "category",
    "circleId",
    "disposition",
    "history",
    "reportDispositionVersion",
    "reportId",
    "reportedAt",
    "revision",
  ]);
  expect(body).toMatchObject({
    reportDispositionVersion: 1,
    reportId: f.reportId,
    category: "privacy",
    disposition: "rejected",
    revision: 2,
    history: [{ action: "rejected", reason: "rule_not_breached" }],
  });
  for (const secret of [
    "INVENTED-DISPOSITION-SOURCE-BODY",
    f.staffId,
    f.postId,
    await memberId(f.owner),
  ])
    expect(download.text).not.toContain(secret);
});

it("RPTD-02 escalation is a local second look, then one terminal rejection; no reopening", async () => {
  const f = await fixture();
  expect(
    (await dispose(f.moderator, f.reportId, "escalate", "policy_unclear")).kind,
  ).toBe("ready");
  // Escalation is not terminal and can't be repeated.
  expect(
    await dispose(f.moderator, f.reportId, "escalate", "needs_another_look", 2),
  ).toEqual({ kind: "conflict" });
  expect(
    await dispose(f.moderator, f.reportId, "reject", "insufficient_context", 2),
  ).toEqual({ kind: "ready", value: { id: f.reportId, revision: 3 } });
  for (const [action, reason] of [
    ["reject", "rule_not_breached"],
    ["escalate", "policy_unclear"],
  ] as const)
    expect(await dispose(f.moderator, f.reportId, action, reason, 3)).toEqual({
      kind: "conflict",
    });
  expect((await rows(f.reportId)).map((r) => r.action)).toEqual([
    "escalated",
    "rejected",
  ]);
  const read = await discussion.reportDisposition(f.peer, circle, f.reportId);
  expect(read).toMatchObject({
    kind: "ready",
    value: {
      disposition: "rejected",
      revision: 3,
      history: [
        { action: "escalated", reason: "policy_unclear" },
        { action: "rejected", reason: "insufficient_context" },
      ],
    },
  });
});

it("RPTD-03 a decision recorded before the report cannot close it", async () => {
  const early = await fixture({ hideFirst: true });
  expect(
    await dispose(
      early.moderator,
      early.reportId,
      "close",
      "recorded_target_decision",
      1,
      3,
      3,
    ),
  ).toEqual({ kind: "conflict" });
  await expect(
    pool.query(
      `INSERT INTO preview_circle_report_dispositions(report_id,circle_id,revision,action,reason,actor_id,actor_role,source_revision,decision_revision,idempotency_key,fingerprint)
       VALUES($1,$2,2,'closed','recorded_target_decision',$3,'moderator',3,3,$4,'x')`,
      [early.reportId, circle, early.staffId, randomUUID()],
    ),
  ).rejects.toThrow("requires a recorded decision after the report");
});

it("RPTD-03 closes against the exact latest decision recorded after the report", async () => {
  const f = await fixture();
  // No decision yet: nothing to close against.
  expect(
    await dispose(
      f.moderator,
      f.reportId,
      "close",
      "recorded_target_decision",
      1,
      1,
      2,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    (
      await discussion.moderate(
        f.moderator,
        circle,
        f.postId,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  // A fabricated or stale decision revision conflicts.
  expect(
    await dispose(
      f.moderator,
      f.reportId,
      "close",
      "recorded_target_decision",
      1,
      2,
      3,
    ),
  ).toEqual({ kind: "conflict" });
  const queue = await discussion.moderationQueue(f.moderator, circle);
  expect(queue).toMatchObject({
    kind: "ready",
    value: {
      items: expect.arrayContaining([
        expect.objectContaining({
          id: f.reportId,
          disposition: "open",
          dispositionRevision: 1,
          decisionRevision: 2,
        }),
      ]),
    },
  });
  expect(
    await dispose(
      f.moderator,
      f.reportId,
      "close",
      "recorded_target_decision",
      1,
      2,
      2,
    ),
  ).toEqual({ kind: "ready", value: { id: f.reportId, revision: 2 } });
  // The other report on the same target stays open; the post is unchanged.
  expect(await rows(f.secondId)).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT state,revision FROM preview_circle_posts WHERE id=$1",
        [f.postId],
      )
    ).rows[0],
  ).toEqual({ state: "hidden", revision: 2 });
});

it("RPTD-04 denies members, the source owner, unrelated staff, revoked grants and foreign reports", async () => {
  const f = await fixture();
  for (const actor of [f.peer, f.owner, f.unrelated, f.admin, token()])
    expect(
      await dispose(actor, f.reportId, "reject", "rule_not_breached"),
    ).toEqual({ kind: "denied" });
  // A report from another circle id or an unknown report is denied.
  expect(
    await discussion.disposeReport(
      f.moderator,
      "career-change",
      f.reportId,
      randomUUID(),
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await dispose(f.moderator, randomUUID(), "reject", "rule_not_breached"),
  ).toEqual({ kind: "denied" });
  // Only the reporter can read the disposition.
  for (const actor of [f.owner, f.other, f.moderator])
    expect(
      (await discussion.reportDisposition(actor, circle, f.reportId)).kind,
    ).toBe("denied");
  expect(
    (
      await http(
        `/circles/${circle}/discussion/reports/${f.reportId}/disposition/download`,
        f.owner,
      )
    ).headers["content-disposition"],
  ).toBeUndefined();
  expect(
    (await discussion.revokeModerator(f.admin, circle, f.grantId)).kind,
  ).toBe("ready");
  expect(
    await dispose(f.moderator, f.reportId, "reject", "rule_not_breached"),
  ).toEqual({ kind: "denied" });
  expect(await rows(f.reportId)).toEqual([]);
});

it.each(["reporter-leave", "reporter-choice", "source-withdraw"] as const)(
  "RPTD-05 %s denies new staff actions while the reporter keeps the content-free record",
  async (kind) => {
    const f = await fixture();
    expect(
      (await dispose(f.moderator, f.reportId, "escalate", "policy_unclear"))
        .kind,
    ).toBe("ready");
    if (kind === "reporter-leave") await circles.leave(f.peer, circle);
    if (kind === "reporter-choice")
      await discussion.withdrawChoice(f.peer, circle, true);
    if (kind === "source-withdraw")
      expect(
        (await discussion.withdraw(f.owner, circle, f.postId, true)).kind,
      ).toBe("ready");
    expect(
      await dispose(f.moderator, f.reportId, "reject", "rule_not_breached", 2),
    ).toEqual({ kind: "denied" });
    expect(
      await discussion.reportDisposition(f.peer, circle, f.reportId),
    ).toMatchObject({
      kind: "ready",
      value: { disposition: "escalated", revision: 2 },
    });
  },
);

it("RPTD-05 a discussion pause denies staff actions but keeps the reporter's read", async () => {
  const f = await fixture();
  const paused = circleDiscussionStore(
    pool,
    "invented-disposition-fixture",
    false,
  );
  expect(
    await paused.disposeReport(
      f.moderator,
      circle,
      f.reportId,
      randomUUID(),
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await paused.reportDisposition(f.peer, circle, f.reportId),
  ).toMatchObject({ kind: "ready", value: { disposition: "open" } });
});

it("RPTD-06 exact replay is stable, changed intent and stale revisions conflict, and races write once", async () => {
  const f = await fixture();
  const key = randomUUID();
  const first = await dispose(
    f.moderator,
    f.reportId,
    "reject",
    "rule_not_breached",
    1,
    1,
    null,
    key,
  );
  expect(first).toEqual({
    kind: "ready",
    value: { id: f.reportId, revision: 2 },
  });
  expect(
    await dispose(
      f.moderator,
      f.reportId,
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
      key,
    ),
  ).toEqual(first);
  expect(
    await dispose(
      f.moderator,
      f.reportId,
      "reject",
      "insufficient_context",
      1,
      1,
      null,
      key,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await dispose(
      f.moderator,
      f.secondId,
      "reject",
      "rule_not_breached",
      1,
      1,
      null,
      key,
    ),
  ).toEqual({ kind: "conflict" });
  // Stale source revision on the second report conflicts.
  expect(
    await dispose(f.moderator, f.secondId, "reject", "rule_not_breached", 1, 2),
  ).toEqual({ kind: "conflict" });
  // Two concurrent actions on one report: exactly one is recorded.
  const results = await Promise.all([
    dispose(f.moderator, f.secondId, "reject", "rule_not_breached"),
    dispose(f.moderator, f.secondId, "escalate", "policy_unclear"),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  expect(await rows(f.secondId)).toHaveLength(1);
});

it("RPTD-07 the original key can be inspected by the acting moderator only", async () => {
  const f = await fixture();
  const key = randomUUID();
  await dispose(
    f.moderator,
    f.reportId,
    "escalate",
    "needs_another_look",
    1,
    1,
    null,
    key,
  );
  expect(
    await discussion.reconcile(f.moderator, circle, "report-disposition", key),
  ).toEqual({
    kind: "ready",
    value: { found: true, id: f.reportId, status: "escalated", revision: 2 },
  });
  expect(
    await discussion.reconcile(
      f.moderator,
      circle,
      "report-disposition",
      randomUUID(),
    ),
  ).toMatchObject({ kind: "ready", value: { found: false } });
  expect(
    (await discussion.reconcile(f.peer, circle, "report-disposition", key))
      .kind,
  ).toBe("denied");
});

it("RPTD-08 guards history in the database and reporter erasure removes it", async () => {
  const f = await fixture();
  await dispose(f.moderator, f.reportId, "reject", "rule_not_breached");
  await expect(
    pool.query(
      "UPDATE preview_circle_report_dispositions SET reason='insufficient_context' WHERE report_id=$1",
      [f.reportId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      "DELETE FROM preview_circle_report_dispositions WHERE report_id=$1",
      [f.reportId],
    ),
  ).rejects.toThrow("immutable");
  // A third step after a terminal rejection is refused by the database too.
  await expect(
    pool.query(
      `INSERT INTO preview_circle_report_dispositions(report_id,circle_id,revision,action,reason,actor_id,actor_role,source_revision,idempotency_key,fingerprint)
       VALUES($1,$2,3,'rejected','rule_not_breached',$3,'moderator',1,$4,'x')`,
      [f.reportId, circle, f.staffId, randomUUID()],
    ),
  ).rejects.toThrow("transition is invalid");
  await expect(
    pool.query(
      `INSERT INTO preview_circle_report_dispositions(report_id,circle_id,revision,action,reason,actor_id,actor_role,source_revision,idempotency_key,fingerprint)
       VALUES($1,$2,2,'escalated','rule_not_breached',$3,'moderator',1,$4,'x')`,
      [f.secondId, circle, f.staffId, randomUUID()],
    ),
  ).rejects.toThrow("check constraint");
  await members.remove(await memberId(f.peer));
  expect(await rows(f.reportId)).toEqual([]);
  // Source-owner erasure leaves the other reporter's report and record intact.
  await dispose(f.moderator, f.secondId, "escalate", "policy_unclear");
  await members.remove(await memberId(f.owner));
  expect(await rows(f.secondId)).toHaveLength(1);
  expect(
    await discussion.reportDisposition(f.other, circle, f.secondId),
  ).toMatchObject({ kind: "ready", value: { disposition: "escalated" } });
});
