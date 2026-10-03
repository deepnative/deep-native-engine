import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { hash, migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import {
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
  MAX_MEMBER_EXPORT_BYTES,
} from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-export-test-secret"),
  exports = memberExportStore(pool),
  circle = "everyday-ai";
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented export member missing");
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
async function page(token: string, cursor?: string) {
  const value = await exports.exportOwned(token, cursor);
  expect(value.kind).toBe("ready");
  if (value.kind !== "ready") throw Error("Owned export unavailable");
  expect(
    value.payload.version,
    "New circle sections need their own export schema version",
  ).toBe("local-member-records-v18");
  expect(value.payload.page.recordCount).toBeLessThanOrEqual(
    MAX_MEMBER_EXPORT_RECORDS,
  );
  expect(Buffer.byteLength(JSON.stringify(value.payload))).toBeLessThanOrEqual(
    MAX_MEMBER_EXPORT_BYTES,
  );
  return value.payload;
}
it("exports only owned circle text and safe own reports, preserving independent reply ownership through erasure", async () => {
  const owner = await member(),
    peer = await member();
  const root = await discussion.post(
    owner.token,
    circle,
    randomUUID(),
    "Invented source belonging only to root owner",
    true,
  );
  if (root.kind !== "ready") throw Error("Missing sample question");
  const reply = await discussion.post(
    peer.token,
    circle,
    randomUUID(),
    "Invented independent reply belonging only to peer",
    true,
    root.value.id,
  );
  if (reply.kind !== "ready") throw Error("Missing sample reply");
  const report = await discussion.report(
    peer.token,
    circle,
    root.value.id,
    randomUUID(),
    "privacy",
  );
  if (report.kind !== "ready") throw Error("Missing own report");
  const own = await page(owner.token),
    other = await page(peer.token);
  expect(own.records.circlePosts).toMatchObject([
    {
      id: root.value.id,
      body: "Invented source belonging only to root owner",
      kind: "question",
    },
  ]);
  expect(own.records.circleReports).toEqual([]);
  expect(other.records.circlePosts).toMatchObject([
    {
      id: reply.value.id,
      body: "Invented independent reply belonging only to peer",
      kind: "reply",
    },
  ]);
  expect(other.records.circleReports).toMatchObject([
    { id: report.value.id, category: "privacy", state: "retained" },
  ]);
  const serialized = JSON.stringify(other.records);
  expect(serialized).not.toContain(
    "Invented source belonging only to root owner",
  );
  expect(serialized).not.toContain(owner.id);
  expect(serialized).not.toContain(root.value.id);
  expect(serialized).not.toContain("Peer ");
  expect(serialized).not.toContain("fingerprint");
  expect(serialized).not.toContain("idempotencyKey");
  expect(serialized).not.toContain("moderationAudit");
  expect(
    (await discussion.withdraw(owner.token, circle, root.value.id, true)).kind,
  ).toBe("ready");
  const withdrawn = await page(owner.token);
  expect(withdrawn.records.circlePosts).toMatchObject([
    { id: root.value.id, body: null, state: "withdrawn" },
  ]);
  expect(JSON.stringify(withdrawn)).not.toContain(
    "Invented source belonging only to root owner",
  );
  await members.remove(owner.id);
  const retained = await page(peer.token);
  expect(retained.records.circlePosts).toMatchObject([
    {
      id: reply.value.id,
      body: "Invented independent reply belonging only to peer",
    },
  ]);
  expect(retained.records.circleReports).toMatchObject([
    { id: report.value.id, state: "retained" },
  ]);
  expect(JSON.stringify(retained)).not.toContain(root.value.id);
  expect(
    (await discussion.withdraw(peer.token, circle, reply.value.id, true)).kind,
  ).toBe("ready");
  expect((await page(peer.token)).records.circlePosts).toMatchObject([
    { id: reply.value.id, body: null, state: "withdrawn" },
  ]);
  await members.remove(peer.id);
  for (const table of [
    "preview_circle_posts",
    "preview_circle_choices",
    "preview_circle_reports",
    "preview_circle_moderation_audit",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
    ).toBe(0);
});
it.each(["Invented bounded export question", "é".repeat(2000)])(
  "continues over 100 owned circle records with both record and byte limits",
  async (body) => {
    const owner = await member(),
      foreign = await member(),
      ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const value = await discussion.post(
        owner.token,
        circle,
        randomUUID(),
        body,
        true,
      );
      if (value.kind !== "ready")
        throw Error("Owned circle export fixture limit unexpected");
      ids.push(value.value.id);
    }
    const collected: string[] = [];
    let cursor: string | undefined,
      pages = 0,
      byteLimited = false;
    do {
      const current = await page(owner.token, cursor);
      pages++;
      collected.push(
        ...(current.records.circlePosts ?? []).map(
          (record) => record.id as string,
        ),
      );
      if (
        !current.page.complete &&
        current.page.recordCount < MAX_MEMBER_EXPORT_RECORDS
      )
        byteLimited = true;
      if (pages === 1 && current.page.nextCursor) {
        expect(
          (await exports.exportOwned(foreign.token, current.page.nextCursor))
            .kind,
        ).toBe("denied");
        expect(
          (
            await exports.exportOwned(
              owner.token,
              current.page.nextCursor + "tampered",
            )
          ).kind,
        ).toBe("denied");
      }
      cursor = current.page.nextCursor ?? undefined;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(collected.sort()).toEqual(ids.sort());
    expect(new Set(collected).size).toBe(105);
    if (body.startsWith("é")) expect(byteLimited).toBe(true);
  },
  30000,
);

it("preserves a signed legacy v2 proposal continuation and appends current circle sections afterward", async () => {
  const owner = await member(),
    secret = Buffer.alloc(32, 41),
    legacy = memberExportStore(pool, secret);
  const before = "10000000-0000-4000-8000-000000000001",
    after = "f0000000-0000-4000-8000-000000000001",
    key = "80000000-0000-4000-8000-000000000001";
  for (const [id, body] of [
    [before, "Earlier invented private proposal"],
    [after, "Later invented private proposal"],
  ])
    await pool.query(
      "INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at) VALUES($1,$2,'Invented',$3,'Original',clock_timestamp())",
      [id, owner.id, body],
    );
  const post = await discussion.post(
    owner.token,
    circle,
    randomUUID(),
    "Invented circle item after legacy sections",
    true,
  );
  if (post.kind !== "ready") throw Error("Owned circle item missing");
  // Cursor v2 index 13 was proposals before v17. Its format/signature and
  // index meaning must survive the append without restarting or skipping it.
  const body = Buffer.from(
    JSON.stringify([2, 13, [key], 2, Date.now() + 60000]),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(hash(owner.token))
    .update(".")
    .update(body)
    .digest("base64url");
  const value = await legacy.exportOwned(owner.token, body + "." + signature);
  expect(value.kind).toBe("ready");
  if (value.kind !== "ready") throw Error("Legacy continuation unavailable");
  expect(value.payload.page.number).toBe(2);
  expect(value.payload.version).toBe("local-member-records-v18");
  expect(value.payload.records.proposals).toMatchObject([
    { id: after, body: "Later invented private proposal" },
  ]);
  expect(JSON.stringify(value.payload.records)).not.toContain(before);
  expect(value.payload.records.circlePosts).toMatchObject([
    { id: post.value.id, body: "Invented circle item after legacy sections" },
  ]);
});
