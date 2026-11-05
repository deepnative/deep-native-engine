import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { app } from "../../src/app.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { circleStore } from "../../src/circles.ts";
import { evidenceStore } from "../../src/evidence.ts";
import { memberSharingStore } from "../../src/member-sharing.ts";
import { COOKIE } from "../../src/session.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  discussion = circleDiscussionStore(pool, "invented-sharing-test-secret"),
  support = supportRequestStore(pool),
  sharing = memberSharingStore(pool),
  evidence = evidenceStore(
    pool,
    {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => Buffer.from("invented")),
      remove: vi.fn(async () => {}),
    },
    "invented-sharing-test-secret",
  ),
  circle = "everyday-ai",
  other = "professional-work";

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id };
}
async function share(token: string, id = circle, generation = "1") {
  const joined = await circles.join(token, id);
  expect(joined).toBe("joined");
  const chosen = await discussion.choose(
    token,
    id,
    randomUUID(),
    generation,
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  expect(chosen.kind).toBe("ready");
}
async function post(token: string, text: string, root?: string) {
  const made = await discussion.post(
    token,
    circle,
    randomUUID(),
    text,
    true,
    root,
  );
  if (made.kind !== "ready") throw Error("Invented post missing");
  return made.value.id;
}
async function summary(token: string) {
  const result = await sharing.summary(token);
  if (result.kind !== "ready") throw Error(`Summary was ${result.kind}`);
  return result.value;
}
/** Seeds rows whose own flows need staff and inventory this page never reads. */
async function seed(sql: string, values: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    await client.query(sql, values);
  } finally {
    await client.query("SET session_replication_role=origin");
    client.release();
  }
}

it("WHOSEES-01 a new member has nothing shared", async () => {
  const { token } = await member();
  expect(await summary(token)).toEqual({
    circles: [],
    evidence: 0,
    workflowReviews: 0,
    eventPermissions: 0,
    openSupport: 0,
    publishedContributions: 0,
    coaches: expect.any(Number) as number,
  });
});

it("WHOSEES-02 circle sharing is named and only readable posts are counted", async () => {
  const owner = await member(),
    peer = await member();
  await share(owner.token);
  await share(peer.token);
  expect(await circles.join(owner.token, other)).toBe("joined");
  const root = await post(owner.token, "An invented question");
  await post(peer.token, "An invented reply", root);
  await post(owner.token, "Another invented question");

  const seen = await discussion.list(peer.token, circle);
  if (seen.kind !== "ready") throw Error("Peer list missing");
  const mine = await summary(owner.token);
  expect(mine.circles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: circle, sharing: true, readablePosts: 2 }),
      expect.objectContaining({ id: other, sharing: false, readablePosts: 0 }),
    ]),
  );
  expect(mine.circles).toHaveLength(2);
  expect(seen.value.items).toHaveLength(2);
  expect((await summary(peer.token)).circles).toEqual([
    expect.objectContaining({ id: circle, sharing: true, readablePosts: 1 }),
  ]);
});

it("WHOSEES-03 withdrawing, hiding, revoking and leaving remove posts from the count at once", async () => {
  const owner = await member(),
    peer = await member();
  await share(owner.token);
  await share(peer.token);
  const first = await post(owner.token, "First invented question");
  const second = await post(owner.token, "Second invented question");
  const reply = await post(peer.token, "An invented reply", first);
  const count = async (token: string) =>
    (await summary(token)).circles.find((c) => c.id === circle)?.readablePosts;
  expect(await count(owner.token)).toBe(2);
  expect(await count(peer.token)).toBe(1);

  await discussion.withdraw(owner.token, circle, second, true);
  expect(await count(owner.token)).toBe(1);

  // A hidden post can't be read by peers, and neither can replies under it.
  await pool.query(
    "UPDATE preview_circle_posts SET state='hidden',revision=revision+1 WHERE id=$1",
    [first],
  );
  expect(await count(owner.token)).toBe(0);
  expect(await count(peer.token)).toBe(0);
  await pool.query(
    "UPDATE preview_circle_posts SET state='visible',revision=revision+1 WHERE id=$1",
    [first],
  );
  expect(await count(peer.token)).toBe(1);

  await discussion.withdrawChoice(owner.token, circle, true);
  const off = (await summary(owner.token)).circles[0]!;
  expect(off).toMatchObject({ sharing: false, readablePosts: 0 });
  expect(await count(peer.token)).toBe(0);
  expect(reply).toBeTruthy();

  await circles.leave(owner.token, circle);
  expect((await summary(owner.token)).circles).toEqual([]);

  // Rejoining and choosing again starts fresh: old posts stay out of peers' sight.
  expect(await circles.join(owner.token, circle)).toBe("joined");
  await discussion.choose(
    owner.token,
    circle,
    randomUUID(),
    "2",
    CIRCLE_DISCUSSION_POLICY,
    true,
  );
  expect((await summary(owner.token)).circles[0]).toMatchObject({
    sharing: true,
    readablePosts: 0,
  });
});

it("WHOSEES-04 staff-reviewed work counts only what is still shared", async () => {
  const { token, id } = await member();
  const upload = (privateReview: boolean) =>
    evidence.upload(token, {
      name: "Invented.txt",
      mediaType: "text/plain",
      data: Buffer.from("Invented private text."),
      consent: {
        rightsConfirmed: true,
        privateReview,
        communityPublication: false,
      },
    });
  const allowed = await upload(true);
  await upload(false);
  if (allowed.kind !== "created") throw Error(`Upload was ${allowed.kind}`);
  expect((await summary(token)).evidence).toBe(1);
  await evidence.revokePrivateReview(token, allowed.id);
  expect((await summary(token)).evidence).toBe(0);

  const opened = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Invented subject",
    body: "Invented body",
  });
  const closed = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Another invented subject",
    body: "Another invented body",
  });
  if (!("receipt" in opened) || !("receipt" in closed))
    throw Error("Invented support request missing");
  await pool.query(
    "UPDATE support_requests SET resolved_at=clock_timestamp(),resolved_by=$2 WHERE id=$1",
    [closed.receipt.requestId, randomUUID()],
  );
  expect((await summary(token)).openSupport).toBe(1);

  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [id],
    )
  ).rows[0]!.id;
  // Created and expired well in the past, so no count can land inside its life.
  const ago = (days: number) => `clock_timestamp()-interval '${days} days'`;
  for (const [created, expires, withdrawn] of [
    ["clock_timestamp()", "clock_timestamp()+interval '1 day'", "NULL"],
    [
      "clock_timestamp()",
      "clock_timestamp()+interval '1 day'",
      "clock_timestamp()",
    ],
    [ago(3), ago(1), "NULL"],
  ])
    await seed(
      `INSERT INTO workflow_review_requests(id,workspace_id,member_id,source_instance_id,workflow_id,workflow_version,source_revision,created_at,expires_at,withdrawn_at)
       VALUES($1,$2,$3,$4,'WF-001',1,1,${created},${expires},${withdrawn})`,
      [randomUUID(), workspace, id, randomUUID()],
    );
  expect((await summary(token)).workflowReviews).toBe(1);

  for (const [created, expires, withdrawn] of [
    ["clock_timestamp()", "clock_timestamp()+interval '1 day'", "NULL"],
    [
      "clock_timestamp()",
      "clock_timestamp()+interval '1 day'",
      "clock_timestamp()",
    ],
    [ago(3), ago(1), "NULL"],
  ])
    await seed(
      `INSERT INTO private_event_attendance_permissions(id,registration_id,workspace_id,member_id,created_at,starts_at,expires_at,withdrawn_at)
       VALUES($1,$2,$3,$4,${created},${created},${expires},${withdrawn})`,
      [randomUUID(), randomUUID(), workspace, id],
    );
  expect((await summary(token)).eventPermissions).toBe(1);
});

it("WHOSEES-05 published contributions are counted", async () => {
  const { token, id } = await member();
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [id],
    )
  ).rows[0]!.id;
  for (const [state, columns, values] of [
    [
      "published",
      "operation_id,attribution,audience,permission_version,published_at",
      `'${randomUUID()}','Invented name','members','member-display-v1',clock_timestamp()`,
    ],
    ["accepted", "", ""],
    ["withdrawn", "withdrawn_at", "clock_timestamp()"],
  ] as const)
    await seed(
      `INSERT INTO proposal_publications(id,proposal_id,member_id,workspace_id,revision,accepted_by,accepted_role,state${columns && `,${columns}`})
       VALUES($1,$2,$3,$4,1,$5,'platform_admin','${state}'${values && `,${values}`})`,
      [randomUUID(), randomUUID(), id, workspace, randomUUID()],
    );
  expect((await summary(token)).publishedContributions).toBe(1);
});

it("WHOSEES-06 default coaches count from the start and a removed coach stops counting", async () => {
  await pool.query(
    `INSERT INTO account_roles(email_hash,role)
     SELECT email_hash,'coach' FROM default_coaches ON CONFLICT DO NOTHING`,
  );
  const { token, id } = await member();
  const defaults = await pool.query("SELECT 1 FROM default_coaches");
  expect((await summary(token)).coaches).toBe(defaults.rowCount);
  await pool.query("DELETE FROM coach_assignments WHERE learner_id=$1", [id]);
  expect((await summary(token)).coaches).toBe(0);
  await seed(
    `INSERT INTO coach_assignments(learner_id,coach_email_hash,assigned_by)
     VALUES($1,$2,$3)`,
    [id, hash("invented-coach@example.test"), randomUUID()],
  );
  expect((await summary(token)).coaches).toBe(1);
});

it("WHOSEES-07 a member reads only their own page and departed members are denied", async () => {
  const owner = await member(),
    peer = await member(),
    secret = "invented-sharing-route-secret",
    origin = "http://127.0.0.1:1";
  await share(owner.token);
  await post(owner.token, "An invented question");
  const server = await listenLoopback(
    app(members, {
      origin,
      secret,
      memberSharing: sharing,
    }),
  );
  onTestFinished(() => closeLoopback(server));
  const open = (token: string, path = "/account/sharing") =>
    request(server)
      .get(path)
      .set("Host", new URL(origin).host)
      .set("Cookie", `${COOKIE}=${token}`);

  const mine = await open(owner.token);
  expect(mine.status).toBe(200);
  expect(mine.text).toContain("Who can see my work");
  expect(mine.text).toContain("Everyday AI practice");
  expect(mine.text).toContain("can read 1 of your posts");
  const theirs = await open(peer.token);
  expect(theirs.status).toBe(200);
  expect(theirs.text).not.toContain("Everyday AI practice");

  expect(
    (
      await request(server)
        .get("/account/sharing")
        .set("Host", new URL(origin).host)
    ).status,
  ).toBe(303);
  expect((await open(peer.token, "/account/sharing?who=me")).status).toBe(400);

  expect((await sharing.summary("not-a-token")).kind).toBe("denied");
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [peer.id],
  );
  expect((await sharing.summary(peer.token)).kind).toBe("denied");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [owner.id],
  );
  expect((await sharing.summary(owner.token)).kind).toBe("denied");
});
