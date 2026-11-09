import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { memberExportStore } from "../../src/member-export.ts";
import {
  memberRecordAccessStore,
  type OperatorRecords,
} from "../../src/member-record-access.ts";
import { memberSharingStore } from "../../src/member-sharing.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #40 RECACCESS-01..10 on real PostgreSQL with invented members and staff.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  access = memberRecordAccessStore(pool),
  exporter = memberExportStore(pool),
  sharing = memberSharingStore(pool),
  origin = "http://127.0.0.1:3000",
  application = app(members, {
    origin,
    secret: "native-record-access-test",
    mode: "test",
    memberRecordAccess: access,
    memberSharing: sharing,
  });

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
async function staff(role: "operator" | "platform_admin" | "reviewer") {
  const token = randomBytes(32).toString("hex");
  const id = await auth.provisionStaff(
    token,
    role,
    new Date(Date.now() + 86_400_000),
  );
  return { token, id };
}
async function milestone(memberId: string, title = "Invented milestone") {
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Invented goal',$3,'Invented next step')`,
    [randomUUID(), memberId, title],
  );
}
async function supportRequest(memberId: string, body: string) {
  await pool.query(
    `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body)
     VALUES($1,$2,$2,$3,'Invented subject',$4)`,
    [randomUUID(), memberId, randomUUID(), body],
  );
}
const ready = (result: OperatorRecords) => {
  if (result.kind !== "ready") throw Error(`Download was ${result.kind}`);
  return result.payload;
};
const grants = async (memberId: string) =>
  (
    await pool.query(
      "SELECT scope,revoked_at FROM member_record_access WHERE member_id=$1",
      [memberId],
    )
  ).rows;
const downloads = async (memberId: string) =>
  (
    await pool.query<{ scope: string; staff_id: string }>(
      "SELECT scope,staff_id FROM member_record_access_downloads WHERE member_id=$1",
      [memberId],
    )
  ).rows;

it("RECACCESS-01 an operator downloads only the scope the member allowed, and the download is logged", async () => {
  const owner = await member(),
    other = await member(),
    operator = await staff("operator");
  await milestone(owner.id, "Owner milestone");
  await milestone(other.id, "Other member's milestone");
  await supportRequest(owner.id, "Owner private support body");
  expect(await access.grant(owner.token, "learning")).toEqual({
    kind: "ready",
  });
  const payload = ready(
    await access.download(operator.token, owner.id, "learning"),
  );
  expect(payload.version).toBe("operator-member-records-v1");
  expect(payload.reference).toBe(owner.id);
  expect(Object.keys(payload.records).sort()).toEqual(
    [
      "assignmentAttempts",
      "assignmentChoices",
      "contentAssessments",
      "exercises",
      "lessonActivity",
      "lessonUsefulness",
      "milestones",
    ].sort(),
  );
  expect(payload.records.milestones).toEqual([
    expect.objectContaining({ milestoneTitle: "Owner milestone" }),
  ]);
  const text = JSON.stringify(payload);
  expect(text).not.toContain("Other member's milestone");
  expect(text).not.toContain("Owner private support body");
  expect(text).not.toContain(operator.id);
  expect(payload.page).toEqual({
    number: 1,
    recordCount: 1,
    complete: true,
    nextCursor: null,
  });
  expect(await downloads(owner.id)).toEqual([
    { scope: "learning", staff_id: operator.id },
  ]);
  expect(await downloads(other.id)).toEqual([]);
});

it("RECACCESS-02 without the member's permission nothing is disclosed and nothing is logged", async () => {
  const owner = await member(),
    operator = await staff("operator");
  await milestone(owner.id);
  expect(await access.download(operator.token, owner.id, "learning")).toEqual({
    kind: "denied",
  });
  // An unknown reference looks exactly the same as a missing permission.
  expect(
    await access.download(operator.token, randomUUID(), "learning"),
  ).toEqual({ kind: "denied" });
  expect(await downloads(owner.id)).toEqual([]);
});

it("RECACCESS-03 a permission for one scope never opens another", async () => {
  const owner = await member(),
    operator = await staff("operator");
  await supportRequest(owner.id, "Support body outside scope");
  await access.grant(owner.token, "billing");
  expect(await access.download(operator.token, owner.id, "support")).toEqual({
    kind: "denied",
  });
  expect(
    ready(await access.download(operator.token, owner.id, "billing")),
  ).not.toHaveProperty("records.supportRequests");
  expect(await downloads(owner.id)).toEqual([
    expect.objectContaining({ scope: "billing" }),
  ]);
});

it("RECACCESS-04 an expired or revoked permission is refused", async () => {
  const owner = await member(),
    operator = await staff("platform_admin");
  await pool.query(
    `WITH t AS (SELECT clock_timestamp() AS now)
     INSERT INTO member_record_access(id,member_id,scope,created_at,expires_at)
     SELECT $1,$2,'learning',now-interval '8 days',now-interval '1 day' FROM t`,
    [randomUUID(), owner.id],
  );
  expect(await access.download(operator.token, owner.id, "learning")).toEqual({
    kind: "denied",
  });
  await access.grant(owner.token, "support");
  ready(await access.download(operator.token, owner.id, "support"));
  const listed = await access.list(owner.token);
  if (listed.kind !== "ready") throw Error("Permissions missing");
  const current = listed.value.find((item) => item.current);
  expect(current).toMatchObject({ scope: "support", current: true });
  expect(await access.revoke(owner.token, current!.id)).toEqual({
    kind: "ready",
  });
  expect(await access.download(operator.token, owner.id, "support")).toEqual({
    kind: "denied",
  });
  // Revoking twice changes nothing, and another member can't revoke it.
  const other = await member();
  expect(await access.revoke(owner.token, current!.id)).toEqual({
    kind: "ready",
  });
  expect(await access.revoke(other.token, current!.id)).toEqual({
    kind: "invalid",
  });
});

it("RECACCESS-05 only operators and administrators may download", async () => {
  const owner = await member(),
    reviewer = await staff("reviewer");
  await access.grant(owner.token, "learning");
  expect(await access.operator(reviewer.token)).toBe("denied");
  expect(await access.download(reviewer.token, owner.id, "learning")).toEqual({
    kind: "denied",
  });
  // A member session is not a staff session, even the owner's own.
  expect(await access.download(owner.token, owner.id, "learning")).toEqual({
    kind: "denied",
  });
  expect(await downloads(owner.id)).toEqual([]);
});

it("RECACCESS-06 a granted scope can't be granted twice at once, and the history is immutable", async () => {
  const owner = await member();
  await access.grant(owner.token, "learning");
  await access.grant(owner.token, "learning");
  expect(await grants(owner.id)).toHaveLength(1);
  expect(await access.grant(owner.token, "everything")).toEqual({
    kind: "invalid",
  });
  await expect(
    pool.query("UPDATE member_record_access SET scope='billing'"),
  ).rejects.toThrow(/only be revoked once/);
  await expect(pool.query("DELETE FROM member_record_access")).rejects.toThrow(
    /retained/,
  );
  await expect(
    pool.query(
      `INSERT INTO member_record_access(id,member_id,scope,created_at,expires_at)
       VALUES($1,$2,'billing',clock_timestamp(),clock_timestamp()+interval '8 days')`,
      [randomUUID(), owner.id],
    ),
  ).rejects.toThrow(/check constraint/);
  // A download line can't be invented without current permission.
  await expect(
    pool.query(
      `INSERT INTO member_record_access_downloads(id,access_id,member_id,staff_id,scope)
       SELECT $1,id,member_id,$2,'billing' FROM member_record_access`,
      [randomUUID(), randomUUID()],
    ),
  ).rejects.toThrow(/current record access/);
});

it("RECACCESS-07 the member sees each download, without who made it, in their history and their own export", async () => {
  const owner = await member(),
    operator = await staff("operator");
  await access.grant(owner.token, "billing");
  ready(await access.download(operator.token, owner.id, "billing"));
  const history = await sharing.staffAccess(owner.token);
  expect(history).toMatchObject({
    kind: "ready",
    value: {
      entries: [
        { source: "records", action: "records_downloaded", via: "billing" },
      ],
    },
  });
  const exported = await exporter.exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Owner export missing");
  expect(exported.payload.version).toBe("local-member-records-v45");
  expect(exported.payload.records.recordAccess).toEqual([
    expect.objectContaining({
      scope: "billing",
      downloads: 1,
      revokedAt: null,
    }),
  ]);
  expect(exported.payload.records.staffAccess).toEqual([
    expect.objectContaining({
      source: "records",
      action: "records_downloaded",
      via: "billing",
    }),
  ]);
  expect(JSON.stringify(exported.payload)).not.toContain(operator.id);
});

it("RECACCESS-08 a long download pages with a cursor bound to that member and scope", async () => {
  const owner = await member(),
    other = await member(),
    operator = await staff("operator");
  for (let i = 0; i < 101; i++) await milestone(owner.id, `Milestone ${i}`);
  await access.grant(owner.token, "learning");
  await access.grant(other.token, "learning");
  const first = ready(
    await access.download(operator.token, owner.id, "learning"),
  );
  expect(first.page).toMatchObject({ recordCount: 100, complete: false });
  const cursor = first.page.nextCursor!;
  expect(
    await access.download(operator.token, other.id, "learning", cursor),
  ).toEqual({ kind: "denied" });
  const second = ready(
    await access.download(operator.token, owner.id, "learning", cursor),
  );
  expect(second.page).toMatchObject({
    number: 2,
    recordCount: 1,
    complete: true,
  });
  // One logged download for the whole paged download.
  expect(await downloads(owner.id)).toHaveLength(1);
});

it("RECACCESS-09 deleting the account removes the permissions and their download lines", async () => {
  const owner = await member(),
    operator = await staff("operator");
  await access.grant(owner.token, "learning");
  ready(await access.download(operator.token, owner.id, "learning"));
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(
    (await pool.query("SELECT 1 FROM member_record_access")).rowCount,
  ).toBe(0);
  expect(
    (await pool.query("SELECT 1 FROM member_record_access_downloads")).rowCount,
  ).toBe(0);
});

it("RECACCESS-10 the pages: a member allows and stops a download, and an operator downloads JSON", async () => {
  const owner = await member(),
    operator = await staff("operator");
  await milestone(owner.id, "Page milestone");
  await withLoopback(application, async (listener) => {
    const agent = request.agent(listener);
    const page = await agent
      .get("/account/record-access")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Let operators download my records");
    expect(page.text).toContain(owner.id);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1]!;
    const allowed = await agent
      .post("/account/record-access")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, scope: "learning" });
    expect(allowed.status).toBe(303);

    const form = await request(listener)
      .get("/operator/member-records")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${operator.token}`);
    expect(form.status).toBe(200);
    const staffCsrf = /name="csrf" value="([^"]+)"/.exec(form.text)![1]!;
    const download = await request(listener)
      .post("/operator/member-records")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${operator.token}`)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf: staffCsrf,
        reference: owner.id,
        scope: "learning",
        cursor: "",
      });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("application/json");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.text).toContain("Page milestone");
    const refused = await request(listener)
      .post("/operator/member-records")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${operator.token}`)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf: staffCsrf,
        reference: owner.id,
        scope: "billing",
        cursor: "",
      });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Nothing was downloaded");

    const listed = await agent
      .get("/account/record-access")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`);
    expect(listed.text).toContain("Downloaded once.");
    const id = /record-access\/([0-9a-f-]{36})\/revoke/.exec(listed.text)![1]!;
    const stopped = await agent
      .post(`/account/record-access/${id}/revoke`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`)
      .set("Origin", origin)
      .type("form")
      .send({ csrf });
    expect(stopped.status).toBe(303);
    const after = await request(listener)
      .post("/operator/member-records")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${operator.token}`)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf: staffCsrf,
        reference: owner.id,
        scope: "learning",
        cursor: "",
      });
    expect(after.status).toBe(403);
    const history = await agent
      .get("/account/sharing/staff-access")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`);
    expect(history.text).toContain(
      "An operator downloaded your learning records, with your permission.",
    );
  });
});
