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
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const circles = circleStore(pool);
let running: Awaited<ReturnType<typeof start>>;
let storage: string;
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  storage = await mkdtemp(join(tmpdir(), "dne443-http-"));
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
  try {
    if (running) await running.close();
  } finally {
    if (storage) await rm(storage, { recursive: true, force: true });
  }
});
afterAll(async () => pool.end());

async function member(
  background: "explorer" | "professional" | "technical",
  goal: "everyday" | "work" | "build",
) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background, goal });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Invented circle member unavailable");
  return { token, id: session.learner.id };
}
const get = (token: string, path: string) =>
  request(running.server)
    .get(path)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
async function csrfFromCircleList(token: string) {
  const page = await get(token, "/circles").expect(200);
  const value = /name="csrf" value="([a-f0-9]{64})"/.exec(page.text)?.[1];
  if (!value) throw Error("Missing real circle CSRF field");
  return value;
}
async function post(
  token: string,
  path: string,
  fields: Record<string, string>,
) {
  return request(running.server)
    .post(path)
    .set("Host", new URL(running.origin).host)
    .set("Origin", running.origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ csrf: await csrfFromCircleList(token), ...fields });
}

it.each([
  ["explorer", "everyday", "everyday-ai"],
  ["professional", "work", "professional-work"],
  ["technical", "build", "technical-practice"],
] as const)(
  "offers a separate exact-circle sharing choice after %s joins, without exposing private exercise text",
  async (background, goal, circle) => {
    const a = await member(background, goal);
    const privateInstruction =
      "Invented private assignment: alpha project details";
    expect(
      await members.save(a.id, {
        instruction: privateInstruction,
        verification: "Private invented check",
        complete: false,
        goal,
      }),
    ).toBe("saved");
    expect(await circles.join(a.token, circle)).toBe("joined");
    const page = await get(a.token, `/circles/${circle}/discussion/choice`);
    expect(
      page.status,
      "Joined local learners need the separate discussion choice before peer exchange",
    ).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.text).toContain("circle-discussion-test-v1");
    expect(page.text).toContain("invented");
    expect(page.text).not.toContain(privateInstruction);
  },
);

it("denies discussion body reads to a legacy join-only member instead of inheriting sharing consent", async () => {
  const a = await member("explorer", "everyday");
  expect(await circles.join(a.token, "everyday-ai")).toBe("joined");
  const page = await get(a.token, "/circles/everyday-ai/discussion");
  expect(
    page.status,
    "Old circle membership must not imply a discussion permission",
  ).toBe(403);
  expect(page.headers["cache-control"]).toContain("no-store");
});

it("denies moderator worklist access for staff role alone, without an exact circle purpose grant", async () => {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const page = await get(token, "/moderate/circles/everyday-ai/reports");
  expect(
    page.status,
    "Proposal-moderator role is not a circle report grant",
  ).toBe(403);
  expect(page.headers["cache-control"]).toContain("no-store");
});

it("persists an explicitly confirmed local circle choice and redirects to the usable discussion", async () => {
  const a = await member("professional", "work");
  expect(await circles.join(a.token, "professional-work")).toBe("joined");
  const result = await post(
    a.token,
    "/circles/professional-work/discussion/choice",
    {
      generation: "1",
      policyVersion: "circle-discussion-test-v1",
      idempotencyKey: randomUUID(),
      confirm: "yes",
    },
  );
  expect(
    result.status,
    "A separately confirmed invented circle choice must be usable",
  ).toBe(303);
  expect(result.headers.location).toBe("/circles/professional-work/discussion");
});

async function sharing(token: string, circle: string) {
  const page = await get(token, `/circles/${circle}/discussion/choice`).expect(
    200,
  );
  const generation = /name="generation" value="([0-9]+)"/.exec(page.text)?.[1];
  if (!generation)
    throw Error("No current membership generation in sharing form");
  return post(token, `/circles/${circle}/discussion/choice`, {
    generation,
    policyVersion: "circle-discussion-test-v1",
    idempotencyKey: randomUUID(),
    confirm: "yes",
  });
}

it.each([
  ["explorer", "everyday", "everyday-ai"],
  ["professional", "work", "professional-work"],
  ["technical", "build", "technical-practice"],
] as const)(
  "supports invented peer exchange, report receipt and withdrawal for %s",
  async (background, goal, circle) => {
    const owner = await member(background, goal),
      peer = await member(background, goal);
    for (const actor of [owner, peer]) {
      expect(await circles.join(actor.token, circle)).toBe("joined");
      expect((await sharing(actor.token, circle)).status).toBe(303);
    }
    const key = randomUUID(),
      body =
        "Invented question <script>alert('sample')</script>: how can we verify a draft?";
    const write = () =>
      post(owner.token, `/circles/${circle}/discussion/posts`, {
        idempotencyKey: key,
        body,
        confirm: "yes",
      });
    expect((await write()).status).toBe(303);
    expect((await write()).status).toBe(303);
    const list = await get(peer.token, `/circles/${circle}/discussion`).expect(
      200,
    );
    expect(list.text).toContain("&lt;script&gt;");
    expect(list.text).not.toContain("<script>alert");
    const root = /\/threads\/([a-f0-9-]{36})/.exec(list.text)?.[1];
    if (!root) throw Error("Peer question link missing");
    expect(
      (
        await post(peer.token, `/circles/${circle}/discussion/posts`, {
          idempotencyKey: randomUUID(),
          rootId: root,
          body: "Invented reply: compare with the sample source.",
          confirm: "yes",
        })
      ).status,
    ).toBe(303);
    const thread = await get(
      owner.token,
      `/circles/${circle}/discussion/threads/${root}`,
    ).expect(200);
    expect(thread.text).toContain("Invented reply: compare");
    const reportKey = randomUUID();
    const report = () =>
      post(peer.token, `/circles/${circle}/discussion/posts/${root}/reports`, {
        idempotencyKey: reportKey,
        category: "privacy",
      });
    const receipt = await report();
    expect(receipt.status).toBe(200);
    expect(receipt.text).toContain("Private sample report receipt");
    expect((await report()).text).toBe(receipt.text);
    expect(
      (await get(owner.token, `/circles/${circle}/discussion/threads/${root}`))
        .text,
    ).not.toContain("Sample report saved");
    expect(
      (
        await post(
          owner.token,
          `/circles/${circle}/discussion/posts/${root}/withdraw`,
          { confirm: "yes" },
        )
      ).status,
    ).toBe(303);
    expect(
      (await get(peer.token, `/circles/${circle}/discussion/threads/${root}`))
        .status,
    ).toBe(403);
    const ownReply = await get(
      peer.token,
      `/circles/${circle}/discussion/owned`,
    ).expect(200);
    expect(ownReply.text).toContain("Invented reply: compare");
    expect(ownReply.text).not.toContain("Invented question");
    expect(ownReply.text).not.toContain(root);
    const rows = await pool.query(
      "SELECT state,body,fingerprint FROM preview_circle_posts WHERE id=$1",
      [root],
    );
    expect(rows.rows).toEqual([
      { state: "withdrawn", body: null, fingerprint: null },
    ]);
  },
);

it("does not republish earlier contributions after leaving or withdrawing and choosing again", async () => {
  const owner = await member("explorer", "everyday"),
    peer = await member("explorer", "everyday");
  const circle = "everyday-ai",
    path = `/circles/${circle}/discussion`;
  for (const actor of [owner, peer]) {
    expect(await circles.join(actor.token, circle)).toBe("joined");
    expect((await sharing(actor.token, circle)).status).toBe(303);
  }
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Earlier invented question",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  expect((await get(peer.token, path)).text).toContain(
    "Earlier invented question",
  );
  expect(await circles.leave(owner.token, circle)).toBe(true);
  expect((await get(peer.token, path)).text).not.toContain(
    "Earlier invented question",
  );
  expect((await get(owner.token, `${path}/owned`)).text).toContain(
    "Earlier invented question",
  );
  expect(await circles.join(owner.token, circle)).toBe("joined");
  expect((await sharing(owner.token, circle)).status).toBe(303);
  expect((await get(peer.token, path)).text).not.toContain(
    "Earlier invented question",
  );
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Current invented question",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  expect((await get(peer.token, path)).text).toContain(
    "Current invented question",
  );
  expect(
    (await post(owner.token, `${path}/choice/withdraw`, { confirm: "yes" }))
      .status,
  ).toBe(303);
  expect((await sharing(owner.token, circle)).status).toBe(303);
  const page = await get(peer.token, path).expect(200);
  expect(page.text).not.toContain("Earlier invented question");
  expect(page.text).not.toContain("Current invented question");
});

it("pauses new sharing without trapping an owner's retained text or withdrawal", async () => {
  const owner = await member("explorer", "everyday"),
    circle = "everyday-ai",
    path = `/circles/${circle}/discussion`;
  expect(await circles.join(owner.token, circle)).toBe("joined");
  expect((await sharing(owner.token, circle)).status).toBe(303);
  const published = await post(owner.token, `${path}/posts`, {
    body: "Invented text before pause",
    idempotencyKey: randomUUID(),
    confirm: "yes",
  });
  expect(published.status).toBe(303);
  const own = await get(owner.token, `${path}/owned`).expect(200);
  const id = /\/posts\/([a-f0-9-]{36})\/withdraw/.exec(own.text)?.[1];
  if (!id) throw Error("Owned contribution withdrawal control missing");
  await running.close();
  running = await start({
    ...process.env,
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: storage,
    DNE_CIRCLE_DISCUSSION: "disabled",
  });
  const circleList = await get(owner.token, "/circles").expect(200);
  expect(circleList.text).toContain("New discussion sharing is paused");
  expect(circleList.text).not.toContain("Choose invented discussion sharing");
  expect((await get(owner.token, `${path}/choice`)).status).toBe(403);
  expect((await get(owner.token, path)).status).toBe(403);
  expect((await get(owner.token, `${path}/owned`)).text).toContain(
    "Invented text before pause",
  );
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Must not save",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(owner.token, `${path}/posts/${id}/withdraw`, {
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  expect((await get(owner.token, `${path}/owned`)).text).not.toContain(
    "Invented text before pause",
  );
  expect(
    (await post(owner.token, `${path}/choice/withdraw`, { confirm: "yes" }))
      .status,
  ).toBe(303);
});

it("rejects unconfirmed, malformed, stale-generation and changed-key submissions", async () => {
  const owner = await member("explorer", "everyday"),
    circle = "everyday-ai",
    path = `/circles/${circle}/discussion`;
  expect(await circles.join(owner.token, circle)).toBe("joined");
  expect(
    (
      await post(owner.token, `${path}/choice`, {
        generation: "1",
        policyVersion: "circle-discussion-test-v1",
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await post(owner.token, `${path}/choice`, {
        generation: "2",
        policyVersion: "circle-discussion-test-v1",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(409);
  expect((await sharing(owner.token, circle)).status).toBe(303);
  expect((await get(owner.token, "/circles")).text).toContain(
    "Choose invented discussion sharing",
  );
  const rejected: Record<string, string>[] = [
    { body: "Invented unconfirmed", idempotencyKey: randomUUID() },
    { body: " ", idempotencyKey: randomUUID(), confirm: "yes" },
    { body: "x".repeat(2001), idempotencyKey: randomUUID(), confirm: "yes" },
    { body: "Invented", idempotencyKey: "bad", confirm: "yes" },
    {
      body: "Invented",
      idempotencyKey: randomUUID(),
      confirm: "yes",
      privateEvidence: "must never import",
    },
  ];
  for (const values of rejected)
    expect((await post(owner.token, `${path}/posts`, values)).status).toBe(422);
  const key = randomUUID();
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Original invented question",
        idempotencyKey: key,
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Changed question",
        idempotencyKey: key,
        confirm: "yes",
      })
    ).status,
  ).toBe(409);
  expect((await get(owner.token, `${path}?cursor=forged`)).status).toBe(422);
  expect((await get(owner.token, `${path}?memberId=${owner.id}`)).status).toBe(
    422,
  );
  expect(
    (await get(owner.token, "/circles/professional-work/discussion")).status,
  ).toBe(403);
  expect(
    (
      await pool.query(
        "SELECT body FROM preview_circle_posts WHERE member_id=$1",
        [owner.id],
      )
    ).rows,
  ).toEqual([{ body: "Original invented question" }]);
});

it("lets an exactly granted synthetic moderator hide and restore without reviving withdrawn text", async () => {
  const owner = await member("professional", "work"),
    reporter = await member("professional", "work"),
    circle = "professional-work",
    path = `/circles/${circle}/discussion`;
  for (const actor of [owner, reporter]) {
    expect(await circles.join(actor.token, circle)).toBe("joined");
    expect((await sharing(actor.token, circle)).status).toBe(303);
  }
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Invented moderation target",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  const list = await get(reporter.token, path).expect(200);
  const target = /\/threads\/([a-f0-9-]{36})/.exec(list.text)?.[1];
  if (!target) throw Error("Missing reported question link");
  expect(
    (
      await post(reporter.token, `${path}/posts/${target}/reports`, {
        category: "conduct",
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(200);
  const moderator = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex"),
    auth = authorizationStore(pool);
  const moderatorId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const adminId = await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  // Trusted test fixture only. Actual administrator grant/audit behavior has
  // separate acceptance requirements; this insert does not establish delivery.
  await pool.query(
    "INSERT INTO preview_circle_moderator_grants(id,staff_id,staff_role,circle_id,purpose,granted_by,idempotency_key,starts_at,expires_at) VALUES($1,$2,'moderator',$3,'circle-discussion-test-v1',$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')",
    [randomUUID(), moderatorId, circle, adminId, randomUUID()],
  );
  const queue = await get(moderator, `/moderate/circles/${circle}/reports`);
  expect(
    queue.status,
    "An exact current synthetic circle grant needs a usable scoped worklist",
  ).toBe(200);
  expect(queue.text).toContain("Invented moderation target");
  expect(queue.text).not.toContain(reporter.id);
  expect(queue.text).not.toContain(owner.id);
  const staffCsrf = /name="csrf" value="([a-f0-9]{64})"/.exec(queue.text)?.[1];
  if (!staffCsrf) throw Error("Missing actual moderator form CSRF");
  const decide = (action: string, revision: string, key = randomUUID()) =>
    request(running.server)
      .post(`/moderate/circles/${circle}/posts/${target}`)
      .set("Host", new URL(running.origin).host)
      .set("Origin", running.origin)
      .set("Cookie", `${COOKIE}=${moderator}`)
      .type("form")
      .send({
        csrf: staffCsrf,
        action,
        expectedRevision: revision,
        idempotencyKey: key,
        reason: "test_correction",
      });
  const hideKey = randomUUID();
  expect((await decide("hide", "1", hideKey)).status).toBe(303);
  expect((await decide("hide", "1", hideKey)).status).toBe(303);
  expect((await get(reporter.token, path)).text).not.toContain(
    "Invented moderation target",
  );
  expect((await decide("restore", "1")).status).toBe(409);
  expect((await decide("restore", "2")).status).toBe(303);
  expect((await get(reporter.token, path)).text).toContain(
    "Invented moderation target",
  );
  expect(
    (
      await post(owner.token, `${path}/posts/${target}/withdraw`, {
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  expect((await decide("restore", "4")).status).toBe(403);
  const history = await pool.query(
    "SELECT action,old_revision,new_revision FROM preview_circle_moderation_audit WHERE post_id=$1 ORDER BY id",
    [target],
  );
  expect(history.rows).toEqual([
    { action: "hidden", old_revision: 1, new_revision: 2 },
    { action: "restored", old_revision: 2, new_revision: 3 },
  ]);
});

it("retains only the reporter's own durable receipt after departure and target erasure", async () => {
  const owner = await member("explorer", "everyday"),
    peer = await member("explorer", "everyday"),
    circle = "everyday-ai",
    path = `/circles/${circle}/discussion`;
  for (const actor of [owner, peer]) {
    expect(await circles.join(actor.token, circle)).toBe("joined");
    expect((await sharing(actor.token, circle)).status).toBe(303);
  }
  expect(
    (
      await post(owner.token, `${path}/posts`, {
        body: "Invented durable receipt target",
        idempotencyKey: randomUUID(),
        confirm: "yes",
      })
    ).status,
  ).toBe(303);
  const list = await get(peer.token, path).expect(200),
    root = /\/threads\/([a-f0-9-]{36})/.exec(list.text)?.[1];
  if (!root) throw Error("Missing question link");
  const saved = await post(peer.token, `${path}/posts/${root}/reports`, {
    category: "privacy",
    idempotencyKey: randomUUID(),
  });
  expect(saved.status).toBe(200);
  const reportId = /Receipt ([a-f0-9-]{36})/.exec(saved.text)?.[1];
  if (!reportId) throw Error("Missing own report ID");
  const receipts = await get(peer.token, `${path}/reports`);
  expect(
    receipts.status,
    "A report needs a current-authorized durable owned receipt page",
  ).toBe(200);
  expect(receipts.text).toContain(reportId);
  expect(receipts.text).not.toContain(owner.id);
  expect((await get(owner.token, `${path}/reports/${reportId}`)).status).toBe(
    403,
  );
  expect(await circles.leave(peer.token, circle)).toBe(true);
  await members.remove(owner.id);
  const retained = await get(peer.token, `${path}/reports/${reportId}`).expect(
    200,
  );
  expect(retained.text).toContain("Target unavailable");
  expect(retained.text).toContain("privacy");
  expect(retained.text).not.toContain("Invented durable receipt target");
  expect(retained.text).not.toContain(root);
  expect(retained.text).not.toContain(owner.id);
});
