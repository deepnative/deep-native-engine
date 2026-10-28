import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { start } from "../../src/runtime.ts";
import type { Pool } from "pg";
import { migrate, store, hash } from "../../src/store.ts";
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
    DNE_LOCAL_STAFF_ENTRY: "enabled",
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
  return { owner, peer, moderator, admin, staffId, circle, id: post.value.id };
}

it("MODA-01 affected member opens an actual reconsideration request for the exact hidden decision", async () => {
  const f = await hiddenContribution();
  const response = await request(running.server)
    .get(`/circles/${f.circle}/discussion/posts/${f.id}/appeals`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${f.owner}`);
  expect(
    response.status,
    "The affected owner needs a real exact-decision reconsideration form after scoped moderation",
  ).toBe(200);
  expect(response.text).toContain("Request reconsideration of this decision");
  expect(response.text).toContain('name="decisionRevision" value="2"');
  expect(response.text).toContain('name="reason"');
  expect(response.text).not.toContain(f.moderator);
});

type Fixture = Awaited<ReturnType<typeof hiddenContribution>>;
const path = (f: Fixture) =>
  `/circles/${f.circle}/discussion/posts/${f.id}/appeals`;
const cookie = (credential: string) =>
  credential.startsWith("dne_staff=") ? credential : `${COOKIE}=${credential}`;
const get = (credential: string, url: string) =>
  request(running.server)
    .get(url)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", cookie(credential));
const csrf = (text: string) => {
  const value = /name="csrf" value="([a-f0-9]{64})"/.exec(text)?.[1];
  if (!value) throw Error("Actual form lacks CSRF");
  return value;
};
const post = (
  credential: string,
  url: string,
  key: string,
  fields: Record<string, string>,
) =>
  request(running.server)
    .post(url)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", cookie(credential))
    .type("form")
    .send({ csrf: key, ...fields });
async function signIn(credential: string) {
  const form = await request(running.server)
    .get("/staff/sign-in")
    .set("Host", new URL(running.origin).host)
    .expect(200);
  const entry = (form.headers["set-cookie"] as unknown as string[])
    .find((c) => c.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const response = await request(running.server)
    .post("/staff/sign-in")
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", entry)
    .type("form")
    .send({ csrf: csrf(form.text), credential })
    .expect(303);
  return (response.headers["set-cookie"] as unknown as string[])
    .find((c) => c.startsWith("dne_staff="))!
    .split(";")[0]!;
}
async function requested(f: Fixture, key = randomUUID()) {
  const value = await discussion.requestAppeal(
    f.owner,
    f.circle,
    f.id,
    key,
    2,
    "recheck_rule",
    true,
  );
  if (value.kind !== "ready")
    throw Error(`Request not retained: ${value.kind}`);
  return {
    id: value.value.id,
    key,
    url: `/circles/${f.circle}/discussion/appeals/${value.value.id}`,
  };
}

it("MODA-01/06 normal owner POST retains exactly one content-free request and bounded own download", async () => {
  const f = await hiddenContribution(),
    key = randomUUID();
  const form = await get(f.owner, path(f)).expect(200);
  const response = await post(f.owner, path(f), csrf(form.text), {
    idempotencyKey: key,
    decisionRevision: "2",
    reason: "missing_context",
    confirm: "yes",
  }).expect(303);
  const receipt = await get(f.owner, response.headers.location!).expect(200);
  expect(receipt.text).toContain("Recorded request: pending");
  expect(receipt.text).toContain("missing context");
  expect(receipt.text).not.toContain("never copy this body");
  const download = await get(
    f.owner,
    `/circles/${f.circle}/discussion/appeals/download`,
  ).expect(200);
  expect(download.headers["content-disposition"]).toBe(
    'attachment; filename="circle-moderation-appeals.json"',
  );
  expect(download.headers["cache-control"]).toContain("no-store");
  expect(download.headers["x-content-type-options"]).toBe("nosniff");
  expect(download.body).toMatchObject({
    appealsVersion: 1,
    circleId: f.circle,
    items: [
      {
        postId: f.id,
        decisionRevision: 2,
        requestReason: "missing_context",
        state: "pending",
        availability: "available",
        resolution: null,
      },
    ],
  });
  expect(download.body.items).toHaveLength(1);
  expect(JSON.stringify(download.body)).not.toMatch(
    /actor|resolver|reporter|fingerprint|idempotency|body|workspace|token/,
  );
  const rows = (await pool.query("SELECT * FROM preview_circle_appeals")).rows;
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!)).not.toContain("body");
  expect(
    await discussion.reconcile(f.owner, f.circle, "appeal", key),
  ).toMatchObject({
    kind: "ready",
    value: { found: true, status: "pending", revision: 2 },
  });
});

it("MODA-02 request replay and semantic duplicates retain one record, while changed payload conflicts", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
  for (const key of [a.key, randomUUID()])
    expect(
      await discussion.requestAppeal(
        f.owner,
        f.circle,
        f.id,
        key,
        2,
        "recheck_rule",
        true,
      ),
    ).toEqual({ kind: "ready", value: { id: a.id } });
  for (const key of [a.key, randomUUID()])
    expect(
      await discussion.requestAppeal(
        f.owner,
        f.circle,
        f.id,
        key,
        2,
        "other",
        true,
      ),
    ).toEqual({ kind: "conflict" });
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(1);
});

it("MODA-02 rejects stale/no-decision/foreign requests, missing confirmation, private extra fields and CSRF", async () => {
  const f = await hiddenContribution();
  expect(
    await discussion.requestAppeal(
      f.owner,
      f.circle,
      f.id,
      randomUUID(),
      3,
      "recheck_rule",
      true,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await discussion.requestAppeal(
      f.peer,
      f.circle,
      f.id,
      randomUUID(),
      2,
      "recheck_rule",
      true,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await discussion.requestAppeal(
      f.owner,
      f.circle,
      f.id,
      randomUUID(),
      2,
      "recheck_rule",
      false,
    ),
  ).toEqual({ kind: "invalid" });
  const form = await get(f.owner, path(f)).expect(200),
    fields = {
      idempotencyKey: randomUUID(),
      decisionRevision: "2",
      reason: "other",
      confirm: "yes",
    };
  await post(f.owner, path(f), csrf(form.text), {
    ...fields,
    body: "Never copy private assignment",
  }).expect(422);
  await post(f.owner, path(f), "invalid", fields).expect(403);
  await post(f.owner, path(f) + "?extra=true", csrf(form.text), fields).expect(
    422,
  );
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(0);
});

it.each(["uphold", "restore"] as const)(
  "MODA-03/04 normal finitely granted moderator records %s and owner sees the result",
  async (outcome) => {
    const f = await hiddenContribution(),
      a = await requested(f),
      staff = await signIn(f.moderator);
    const queuePath = `/moderate/circles/${f.circle}/appeals`,
      queue = await get(staff, queuePath).expect(200),
      key = randomUUID();
    expect(queue.text).toContain("never copy this body");
    expect(queue.text).not.toContain(f.owner);
    const fields = {
      idempotencyKey: key,
      expectedRevision: "2",
      outcome,
      confirm: "yes",
    };
    await post(
      staff,
      `${queuePath}/${a.id}/resolve`,
      csrf(queue.text),
      fields,
    ).expect(303);
    const state = outcome === "restore" ? "restored" : "upheld",
      revision = outcome === "restore" ? 3 : 2;
    expect((await get(f.owner, a.url).expect(200)).text).toContain(
      `Recorded request: ${state}`,
    );
    expect(
      await discussion.resolveAppeal(
        f.moderator,
        f.circle,
        a.id,
        key,
        outcome,
        2,
        outcome === "restore" ? "decision_corrected" : "rule_applies",
      ),
    ).toEqual({ kind: "ready", value: { id: a.id, revision } });
    expect(
      await discussion.resolveAppeal(
        f.moderator,
        f.circle,
        a.id,
        randomUUID(),
        outcome,
        2,
        outcome === "restore" ? "decision_corrected" : "rule_applies",
      ),
    ).toEqual({ kind: "conflict" });
    expect(
      await discussion.reconcile(
        f.moderator,
        f.circle,
        "appeal-resolution",
        key,
      ),
    ).toMatchObject({
      kind: "ready",
      value: { id: a.id, found: true, status: state, revision },
    });
    const notice = await discussion.moderationNotice(f.owner, f.circle, f.id);
    expect(notice).toMatchObject({
      kind: "ready",
      value: {
        postState: outcome === "restore" ? "visible" : "hidden",
        postRevision: revision,
      },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM preview_circle_moderation_audit",
        )
      ).rows[0]!.n,
    ).toBe(outcome === "restore" ? 2 : 1);
  },
);

it("MODA-03 denies member, wrong circle, staff without grant and revoked moderator without exposing request data", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
  await get(f.peer, a.url).expect(403);
  await get(f.peer, `/circles/${f.circle}/discussion/appeals/download`)
    .expect(200)
    .then((r) => expect(r.body.items).toEqual([]));
  expect(await discussion.appealQueue(f.owner, f.circle)).toEqual({
    kind: "denied",
  });
  expect(await discussion.appealQueue(f.admin, f.circle)).toEqual({
    kind: "denied",
  });
  expect(
    await discussion.appealQueue(f.moderator, "technical-practice"),
  ).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE preview_circle_moderator_grants SET revoked_at=clock_timestamp() WHERE staff_id=$1",
    [f.staffId],
  );
  expect(await discussion.appealQueue(f.moderator, f.circle)).toEqual({
    kind: "denied",
  });
  expect(
    await discussion.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "denied" });
  expect(await discussion.appealReceipt(f.owner, f.circle, a.id)).toMatchObject(
    { kind: "ready", value: { state: "pending" } },
  );
});

it("MODA-04 concurrent conflicting resolutions record one terminal result and one correction at most", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
  const results = await Promise.all([
    discussion.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "uphold",
      2,
      "rule_applies",
    ),
    discussion.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "restore",
      2,
      "decision_corrected",
    ),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  const row = (
    await pool.query("SELECT state FROM preview_circle_appeals WHERE id=$1", [
      a.id,
    ])
  ).rows[0]!;
  expect(["upheld", "restored"]).toContain(row.state);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM preview_circle_moderation_audit",
      )
    ).rows[0]!.n,
  ).toBe(row.state === "restored" ? 2 : 1);
});

it("MODA-05 owner withdraws pending request, removes staff availability and cannot reopen the same decision", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
  const page = await get(f.owner, a.url).expect(200);
  await post(f.owner, a.url + "/withdraw", csrf(page.text), {
    confirm: "yes",
  }).expect(303);
  expect(
    await discussion.withdrawAppeal(f.owner, f.circle, a.id, true),
  ).toEqual({ kind: "ready", value: { id: a.id } });
  expect(await discussion.appealQueue(f.moderator, f.circle)).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  expect(
    await discussion.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "restore",
      2,
      "decision_corrected",
    ),
  ).toEqual({ kind: "conflict" });
  expect((await get(f.owner, path(f)).expect(200)).text).not.toContain(
    'name="decisionRevision"',
  );
  expect((await get(f.owner, a.url).expect(200)).text).toContain(
    "Request withdrawn",
  );
});

it.each(["leave", "sharing", "text"] as const)(
  "MODA-05/06 %s removes staff source/action availability but keeps private own history",
  async (change) => {
    const f = await hiddenContribution(),
      a = await requested(f);
    if (change === "leave")
      expect(await circles.leave(f.owner, f.circle)).toBe(true);
    else if (change === "sharing")
      expect(
        (await discussion.withdrawChoice(f.owner, f.circle, true)).kind,
      ).toBe("ready");
    else
      expect(
        (await discussion.withdraw(f.owner, f.circle, f.id, true)).kind,
      ).toBe("ready");
    expect(await discussion.appealQueue(f.moderator, f.circle)).toEqual({
      kind: "ready",
      value: { items: [], nextCursor: null },
    });
    expect(
      (
        await discussion.resolveAppeal(
          f.moderator,
          f.circle,
          a.id,
          randomUUID(),
          "restore",
          2,
          "decision_corrected",
        )
      ).kind,
    ).toBe("denied");
    expect(
      await discussion.appealReceipt(f.owner, f.circle, a.id),
    ).toMatchObject({
      kind: "ready",
      value: { state: "pending", availability: "unavailable" },
    });
    expect(
      (
        await get(
          f.owner,
          `/circles/${f.circle}/discussion/appeals/download`,
        ).expect(200)
      ).body.items,
    ).toHaveLength(1);
  },
);

it("MODA-05 a later hide supersedes an earlier pending request and cannot be overwritten by its resolution", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
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
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.id,
        randomUUID(),
        "hide",
        3,
        "conduct",
      )
    ).kind,
  ).toBe("ready");
  expect(await discussion.appealReceipt(f.owner, f.circle, a.id)).toMatchObject(
    {
      kind: "ready",
      value: { state: "pending", availability: "superseded", postRevision: 4 },
    },
  );
  expect(
    await discussion.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "restore",
      2,
      "decision_corrected",
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    (
      await discussion.requestAppeal(
        f.owner,
        f.circle,
        f.id,
        randomUUID(),
        4,
        "other",
        true,
      )
    ).kind,
  ).toBe("ready");
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(2);
});

it("MODA-06 write pause retains own request/download/withdrawal while creation and review deny", async () => {
  const f = await hiddenContribution(),
    a = await requested(f),
    paused = circleDiscussionStore(pool, "invented-pause", false);
  expect(await paused.appealReceipt(f.owner, f.circle, a.id)).toMatchObject({
    kind: "ready",
    value: { availability: "write_paused" },
  });
  expect((await paused.appealHistory(f.owner, f.circle)).kind).toBe("ready");
  expect(
    await paused.requestAppeal(
      f.owner,
      f.circle,
      f.id,
      randomUUID(),
      2,
      "other",
      true,
    ),
  ).toEqual({ kind: "denied" });
  expect(await paused.appealQueue(f.moderator, f.circle)).toEqual({
    kind: "denied",
  });
  expect(
    await paused.resolveAppeal(
      f.moderator,
      f.circle,
      a.id,
      randomUUID(),
      "uphold",
      2,
      "rule_applies",
    ),
  ).toEqual({ kind: "denied" });
  expect(
    (await paused.withdrawAppeal(f.owner, f.circle, a.id, true)).kind,
  ).toBe("ready");
});

it("MODA-06 owner erasure cascades request/result and denies stale read without deleting another member", async () => {
  const f = await hiddenContribution(),
    a = await requested(f),
    session = await members.session(f.owner);
  if (session.kind !== "active") throw Error("Missing current owner");
  await members.remove(session.learner.id);
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(0);
  expect(await discussion.appealReceipt(f.owner, f.circle, a.id)).toEqual({
    kind: "denied",
  });
  expect((await members.session(f.peer)).kind).toBe("active");
  const response = await get(
    f.owner,
    `/circles/${f.circle}/discussion/appeals/download`,
  ).expect(303);
  expect(response.headers["content-disposition"]).toBeUndefined();
});

it("MODA-06 migration is repeatable and rejects rewritten request identity, terminal changes and direct retention deletion", async () => {
  const f = await hiddenContribution(),
    a = await requested(f);
  await migrate(pool);
  await expect(
    pool.query(
      "UPDATE preview_circle_appeals SET request_reason='other' WHERE id=$1",
      [a.id],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM preview_circle_appeals WHERE id=$1", [a.id]),
  ).rejects.toThrow("owner erasure");
  expect(
    (await discussion.withdrawAppeal(f.owner, f.circle, a.id, true)).kind,
  ).toBe("ready");
  await expect(
    pool.query(
      "UPDATE preview_circle_appeals SET state='pending',closed_at=NULL WHERE id=$1",
      [a.id],
    ),
  ).rejects.toThrow("immutable");
  expect(await discussion.appealReceipt(f.owner, f.circle, a.id)).toMatchObject(
    { kind: "ready", value: { state: "withdrawn" } },
  );
});

it("MODA-02/06 complete bounded download retains 200 actual records and rejects the 201st decision request", async () => {
  const f = await hiddenContribution(),
    session = await members.session(f.owner);
  if (session.kind !== "active") throw Error("Missing current owner");
  const owner = session.learner.id;
  // Deliberately seeded structural bound fixture, not a normal-screen journey.
  await pool.query(
    `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,body,state,revision,idempotency_key,fingerprint)
    SELECT gen_random_uuid(),$1,$1,$2,c.id,'Invented structural bound fixture','hidden',2,gen_random_uuid(),repeat('e',64)
    FROM preview_circle_choices c CROSS JOIN generate_series(1,199) n WHERE c.member_id=$1 AND c.circle_id=$2 AND c.revoked_at IS NULL`,
    [owner, f.circle],
  );
  await pool.query(
    `INSERT INTO preview_circle_moderation_audit(actor_id,actor_role,member_id,workspace_id,circle_id,post_id,action,reason,old_revision,new_revision,idempotency_key,fingerprint)
    SELECT $1,'moderator',p.member_id,p.workspace_id,p.circle_id,p.id,'hidden','privacy',1,2,gen_random_uuid(),repeat('e',64)
    FROM preview_circle_posts p WHERE p.member_id=$2 AND p.circle_id=$3 AND p.id<>$4`,
    [f.staffId, owner, f.circle, f.id],
  );
  await pool.query(
    `INSERT INTO preview_circle_appeals(id,member_id,workspace_id,circle_id,post_id,decision_revision,request_reason,idempotency_key,fingerprint)
    SELECT gen_random_uuid(),member_id,workspace_id,circle_id,post_id,new_revision,'recheck_rule',gen_random_uuid(),repeat('e',64)
    FROM preview_circle_moderation_audit WHERE member_id=$1 AND circle_id=$2`,
    [owner, f.circle],
  );
  const download = await get(
    f.owner,
    `/circles/${f.circle}/discussion/appeals/download`,
  ).expect(200);
  expect(download.body.items).toHaveLength(200);
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
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        f.id,
        randomUUID(),
        "hide",
        3,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  expect(
    await discussion.requestAppeal(
      f.owner,
      f.circle,
      f.id,
      randomUUID(),
      4,
      "other",
      true,
    ),
  ).toEqual({ kind: "limit" });
  await expect(
    pool.query(
      `INSERT INTO preview_circle_appeals(id,member_id,workspace_id,circle_id,post_id,decision_revision,request_reason,idempotency_key,fingerprint)
    VALUES($1,$2,$2,$3,$4,4,'other',$5,repeat('e',64))`,
      [randomUUID(), owner, f.circle, f.id, randomUUID()],
    ),
  ).rejects.toThrow("retained-appeal bound");
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(200);
});

it.each(["request", "resolution"] as const)(
  "MODA-07 actual committed %s with lost response is recovered by its original authorized key",
  async (operation) => {
    const f = await hiddenContribution(),
      a = operation === "resolution" ? await requested(f) : null,
      key = randomUUID();
    let lose = true;
    const uncertainPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            if (text === "COMMIT" && lose) {
              lose = false;
              throw Error("Invented lost COMMIT response after actual commit");
            }
            return result;
          },
          release(error?: Error) {
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const uncertain = circleDiscussionStore(
      uncertainPool,
      "invented-commit-loss",
    );
    if (operation === "request") {
      await expect(
        uncertain.requestAppeal(f.owner, f.circle, f.id, key, 2, "other", true),
      ).rejects.toThrow("outcome unconfirmed");
      expect(
        await discussion.reconcile(f.owner, f.circle, "appeal", key),
      ).toMatchObject({
        kind: "ready",
        value: { found: true, status: "pending", revision: 2 },
      });
    } else {
      await expect(
        uncertain.resolveAppeal(
          f.moderator,
          f.circle,
          a!.id,
          key,
          "uphold",
          2,
          "rule_applies",
        ),
      ).rejects.toThrow("outcome unconfirmed");
      expect(
        await discussion.reconcile(
          f.moderator,
          f.circle,
          "appeal-resolution",
          key,
        ),
      ).toMatchObject({
        kind: "ready",
        value: { id: a!.id, found: true, status: "upheld", revision: 2 },
      });
    }
    expect(
      (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
        .rows[0]!.n,
    ).toBe(1);
    expect(lose).toBe(false);
  },
);

it("MODA-03/06 actually waits on the owning workspace then denies its newly deleting state", async () => {
  const f = await hiddenContribution(),
    a = await requested(f),
    session = await members.session(f.owner);
  if (session.kind !== "active") throw Error("Missing current owner");
  const blocker = await pool.connect();
  let pending: ReturnType<typeof discussion.appealReceipt> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [session.learner.id],
    );
    pending = discussion.appealReceipt(f.owner, f.circle, a.id);
    const deadline = Date.now() + 3000;
    let observed = false;
    while (Date.now() < deadline) {
      const waits = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT owner_principal_id FROM workspaces%' AND pid<>pg_backend_pid()",
      );
      if (waits.rowCount) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      observed,
      "Actual new appeal reader must be observed waiting on its owner's workspace lock",
    ).toBe(true);
    await blocker.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
});

it("MODA-05/06 erasing a different root owner does not erase the reply owner's private appeal", async () => {
  const f = await hiddenContribution(false);
  const root = await discussion.post(
    f.peer,
    f.circle,
    randomUUID(),
    "Invented independently owned root",
    true,
  );
  if (root.kind !== "ready") throw Error("Missing root");
  const reply = await discussion.post(
    f.owner,
    f.circle,
    randomUUID(),
    "Invented reply",
    true,
    root.value.id,
  );
  if (reply.kind !== "ready") throw Error("Missing reply");
  expect(
    (
      await discussion.moderate(
        f.moderator,
        f.circle,
        reply.value.id,
        randomUUID(),
        "hide",
        1,
        "privacy",
      )
    ).kind,
  ).toBe("ready");
  const a = await discussion.requestAppeal(
    f.owner,
    f.circle,
    reply.value.id,
    randomUUID(),
    2,
    "recheck_rule",
    true,
  );
  if (a.kind !== "ready") throw Error("Missing reply appeal");
  const peer = await members.session(f.peer);
  if (peer.kind !== "active") throw Error("Missing peer");
  await members.remove(peer.learner.id);
  expect(
    await discussion.appealReceipt(f.owner, f.circle, a.value.id),
  ).toMatchObject({
    kind: "ready",
    value: { state: "pending", availability: "unavailable" },
  });
  expect(
    (
      await discussion.resolveAppeal(
        f.moderator,
        f.circle,
        a.value.id,
        randomUUID(),
        "restore",
        2,
        "decision_corrected",
      )
    ).kind,
  ).toBe("denied");
  expect(
    (await pool.query("SELECT count(*)::int n FROM preview_circle_appeals"))
      .rows[0]!.n,
  ).toBe(1);
});

it.each(["expired", "revoked"] as const)(
  "MODA-02/06 %s owner cannot read retained request or receive its attachment",
  async (state) => {
    const f = await hiddenContribution(),
      a = await requested(f);
    await pool.query(
      state === "expired"
        ? "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
        : "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
      [hash(f.owner)],
    );
    expect(await discussion.appealReceipt(f.owner, f.circle, a.id)).toEqual({
      kind: "denied",
    });
    expect(await discussion.appealHistory(f.owner, f.circle)).toEqual({
      kind: "denied",
    });
    const response = await get(
      f.owner,
      `/circles/${f.circle}/discussion/appeals/download`,
    ).expect(303);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).not.toContain("recheck_rule");
  },
);
