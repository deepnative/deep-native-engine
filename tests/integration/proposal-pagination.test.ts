import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const proposals = proposalStore(pool);

beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(async () => pool.end());

it("lets a moderator reach a newer submission past 100 retained quarantined proposals", async () => {
  const memberToken = randomBytes(32).toString("hex");
  await db.create(memberToken, { background: "explorer", goal: "everyday" });
  const session = await db.session(memberToken);
  if (session.kind !== "active") throw Error("Synthetic member setup failed");

  const staffToken = randomBytes(32).toString("hex");
  const staffId = await authorizationStore(pool).provisionStaff(
    staffToken,
    "moderator",
    new Date(Date.now() + 3_600_000),
  );
  const olderIds = Array.from({ length: 100 }, () => randomUUID());
  await pool.query(
    `INSERT INTO member_proposals
       (id,member_id,title,body,sources,state,sample_attested_at,
        rights_attested_at,submitted_at,moderated_by,moderated_at)
     SELECT id,$2,'Retained synthetic quarantine','Invented sample',
       'Invented source','quarantined',$3,$3,$3,$4,$3
     FROM unnest($1::uuid[]) id`,
    [olderIds, session.learner.id, "2026-09-01T00:00:00Z", staffId],
  );

  const newerTitle = "Newer synthetic submission beyond the first 100";
  const newerId = await proposals.createDraft(
    memberToken,
    {
      title: newerTitle,
      body: "Invented newer sample",
      sources: "Invented newer source",
    },
    true,
  );
  expect(newerId).toBeTruthy();
  expect(await proposals.submit(memberToken, newerId!, true, 1)).toBe(
    "submitted",
  );
  await pool.query("UPDATE member_proposals SET submitted_at=$2 WHERE id=$1", [
    newerId,
    "2026-09-02T00:00:00Z",
  ]);

  // Assert the fixture before reading: the missing item must be an eligible,
  // newer submission, while the older 100 remain retained in quarantine.
  const seeded = await pool.query<{ state: string; count: string }>(
    `SELECT state,COUNT(*)::text AS count FROM member_proposals
     WHERE id=ANY($1::uuid[]) OR id=$2 GROUP BY state`,
    [olderIds, newerId],
  );
  expect(
    Object.fromEntries(seeded.rows.map((row) => [row.state, +row.count])),
  ).toEqual({
    quarantined: 100,
    submitted: 1,
  });

  const origin = "http://127.0.0.1:3000";
  const server = app(db, {
    origin,
    secret: "synthetic-moderation-pagination-secret",
    proposals,
  }).listen(0);
  try {
    const agent = request.agent(server);
    const getPage = (path: string) =>
      agent
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `dne_preview=${staffToken}`);
    const first = await getPage("/moderate/proposals").expect(200);
    expect(first.text).toContain("Retained synthetic quarantine");
    expect(first.text).not.toContain(newerTitle);
    expect(first.text).not.toContain(newerId!);

    // The only safe way to reach the later work item is through another page;
    // moderation of older quarantined proposals must not be required.
    const nextPage = first.text.match(
      /<a\b[^>]*href="([^"]+)"[^>]*>\s*Next page\s*<\/a>/i,
    )?.[1];
    expect(
      nextPage,
      "The first 100 retained items need a next-page link",
    ).toBeDefined();
    const second = await getPage(nextPage!).expect(200);
    expect(second.text).toContain(newerTitle);
    expect(second.text).toContain(newerId!);

    const retained = await pool.query<{ state: string; count: string }>(
      `SELECT state,COUNT(*)::text AS count FROM member_proposals
       WHERE id=ANY($1::uuid[]) OR id=$2 GROUP BY state`,
      [olderIds, newerId],
    );
    expect(
      Object.fromEntries(retained.rows.map((row) => [row.state, +row.count])),
    ).toEqual({ quarantined: 100, submitted: 1 });
  } finally {
    server.close();
  }
});
