import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

test("[L47] operator sees labelled preview aggregates while a learner cannot read them", async ({
  browser,
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const operator = await browser.newContext({ baseURL: origin });
  await operator.addCookies([
    {
      name: "dne_preview",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  try {
    const baseline = await (
      await operator.request.get("/operator/metrics")
    ).json();
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page.getByRole("link", { name: "Local circles" }).click();
    await page
      .getByRole("button", { name: "Join Everyday AI practice" })
      .click();
    const denied = await page.request.get("/operator/metrics");
    expect(denied.status()).toBe(403);
    const response = await operator.request.get("/operator/metrics");
    expect(response.status()).toBe(200);
    const report = await response.json();
    expect(report.scope).toBe("synthetic-local-preview");
    expect(report.counts.members).toBe(baseline.counts.members + 1);
    expect(report.counts.participated).toBe(baseline.counts.participated + 1);
    expect(report.definitions.participated).toContain(
      "Leaving does not remove",
    );
    expect(JSON.stringify(report)).not.toContain("token_hash");
  } finally {
    await operator.close();
  }
});

test("[L68] operator sees retained observed submissions and bounded cross-content return without member detail", async ({
  browser,
  page,
}, info) => {
  const operatorToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    operatorToken,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const operator = await browser.newContext({ baseURL: origin });
  await operator.addCookies([
    {
      name: "dne_preview",
      value: operatorToken,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  try {
    const before = await (
      await operator.request.get("/operator/metrics")
    ).json();
    const learnerToken = randomBytes(32).toString("hex");
    const learning = store(pool);
    await learning.create(learnerToken, {
      background: "professional",
      goal: "work",
    });
    const session = await learning.session(learnerToken);
    expect(session.kind).toBe("active");
    if (session.kind !== "active")
      throw new Error("Synthetic member unavailable");
    const firstId =
      info.project.name === "desktop-chromium" ? "MET-901" : "MET-904";
    const nextId =
      info.project.name === "desktop-chromium" ? "MET-902" : "MET-905";
    const projectId =
      info.project.name === "desktop-chromium" ? "MET-903" : "MET-906";
    await pool.query(
      `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
       VALUES($1,1,'lesson','curated','First invented lesson','Sample only','Test','Test','Owned'),
             ($2,1,'lesson','curated','Next invented lesson','Sample only','Test','Test','Owned'),
             ($3,1,'assignment','curated','Invented assignment','Sample only','Test','Test','Owned')`,
      [firstId, nextId, projectId],
    );
    await pool.query(
      `INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at)
       VALUES($1,$2,1,CURRENT_TIMESTAMP-interval '20 days')`,
      [session.learner.id, firstId],
    );
    await pool.query(
      `INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at)
       SELECT member_id,$2,1,opened_at+interval '7 days'
       FROM lesson_activity WHERE member_id=$1 AND content_id=$3`,
      [session.learner.id, nextId, firstId],
    );
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO assignment_attempts
       (id,member_id,content_id,content_version,goal_at_start,response,saved_at,submitted_at,submission_count)
       SELECT $1::uuid,member_id,$2,1,'work',$4,opened_at+interval '1 day',
         opened_at+interval '8 days',1 FROM lesson_activity
       WHERE member_id=$3 AND content_id=$5`,
      [
        attemptId,
        projectId,
        session.learner.id,
        "An invented private response with sufficient detail.",
        firstId,
      ],
    );
    await pool.query(
      `INSERT INTO assignment_submission_snapshots(attempt_id,sequence,response,submitted_at)
       SELECT id,1,response,submitted_at FROM assignment_attempts WHERE id=$1`,
      [attemptId],
    );
    await page.context().addCookies([
      {
        name: "dne_preview",
        value: learnerToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    expect((await page.request.get("/operator/metrics")).status()).toBe(403);
    const response = await operator.request.get("/operator/metrics");
    expect(response.status()).toBe(200);
    const report = await response.json();
    expect(report.scope).toBe("synthetic-local-preview");
    expect(report.counts.members).toBe(before.counts.members + 1);
    expect(report.counts.submittedAssignment).toBe(
      before.counts.submittedAssignment + 1,
    );
    expect(report.counts.returnEligible).toBe(before.counts.returnEligible + 1);
    expect(report.counts.crossContentReturned).toBe(
      before.counts.crossContentReturned + 1,
    );
    expect(report.definitions.crossContentReturned).toContain("observed");
    expect(JSON.stringify(report)).not.toContain(session.learner.id);
    expect(JSON.stringify(report)).not.toContain("invented private response");
  } finally {
    await operator.close();
  }
});
