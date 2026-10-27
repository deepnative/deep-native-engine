import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { start } from "../../src/runtime.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { COOKIE } from "../../src/session.ts";

// Aggregate fixtures require their own database even inside the full browser
// gate, whose other scenarios intentionally retain unrelated member records.
const control = testPool(),
  database = `dne_test_${randomBytes(16).toString("hex")}`;
let created = false,
  pool: Pool,
  running: Awaited<ReturnType<typeof start>>,
  storage: string;
test.use({ trace: "off" });
test.beforeAll(async () => {
  await control.query(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  url.pathname = database;
  pool = new Pool({ connectionString: url.href });
  storage = await mkdtemp(join(tmpdir(), "dne121-browser-"));
  running = await start({
    DNE_DATABASE_URL: url.href,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
  console.log(
    JSON.stringify({
      fixture: "metrics-report",
      database,
      origin: running.origin,
      created: true,
    }),
  );
});
test.beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
test.afterAll(async () => {
  try {
    await running?.close();
    await pool?.end();
    if (created) {
      await control.query(`DROP DATABASE "${database}"`);
      const remaining = await control.query(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS present",
        [database],
      );
      expect(remaining.rows[0].present).toBe(false);
      console.log(
        JSON.stringify({
          fixture: "metrics-report",
          database,
          cleanupConfirmed: true,
        }),
      );
    }
    if (storage) await rm(storage, { recursive: true, force: true });
  } finally {
    await control.end();
  }
});
async function staff(role: StaffRole) {
  const credential = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    credential,
    role,
    new Date(Date.now() + 3600000),
  );
  return { credential, id };
}
async function signIn(page: Page, credential: string) {
  await page.goto(running.origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function member(index: number) {
  const token = randomBytes(32).toString("hex");
  const [background, goal] = (
    [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ] as const
  )[index % 3]!;
  await store(pool).create(token, { background, goal });
  const result = await store(pool).session(token);
  if (result.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: result.learner.id, goal };
}
const reportPath = "/operator/metrics/report";
const heading = "Learning and participation snapshot";
test("[L222] MR-01-02-04 staff reads three-audience retained learning, return and usefulness with plain limits and fresh deletion suppression", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const admin = await staff("platform_admin");
  await signIn(page, admin.credential);
  await page.getByRole("link", { name: heading, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-metric="members"]')).toHaveText("0");
  await expect(
    page.getByText("No eligible members yet; a return rate is undefined.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-usefulness="suppressed"]')).toContainText(
    "Suppressed to protect small groups",
  );

  // Invented retained source rows exercise all three backgrounds and an
  // explicitly historical return window; no enrollment date is reconstructed.
  await pool.query(`INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
    VALUES('MRP-121',1,'lesson','curated','Private fixture lesson','PRIVATE_FIXTURE_BODY','Test','Test','Owned'),
          ('MRP-122',1,'lesson','curated','Private later lesson','PRIVATE_LATER_BODY','Test','Test','Owned'),
          ('MRP-123',1,'assignment','curated','Private fixture assignment','PRIVATE_ASSIGNMENT_BODY','Test','Test','Owned')`);
  const people: Awaited<ReturnType<typeof member>>[] = [];
  for (let index = 0; index < 20; index += 1) {
    const person = await member(index);
    people.push(person);
    await pool.query(
      `INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at,started_at,self_assessed_at)
      VALUES($1,'MRP-121',1,CURRENT_TIMESTAMP-interval '20 days',CURRENT_TIMESTAMP-interval '19 days',CURRENT_TIMESTAMP-interval '18 days')`,
      [person.id],
    );
    await pool.query(
      `INSERT INTO lesson_usefulness(member_id,content_id,content_version,choice) VALUES($1,'MRP-121',1,$2)`,
      [person.id, index < 10 ? "helpful" : "not_yet"],
    );
    if (index < 5)
      await pool.query(
        `INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at) VALUES($1,'MRP-122',1,CURRENT_TIMESTAMP-interval '12 days')`,
        [person.id],
      );
    if (index < 3) {
      const attemptId = randomUUID();
      await pool.query(
        `INSERT INTO assignment_attempts(id,member_id,content_id,content_version,goal_at_start,response,saved_at,submitted_at,submission_count)
        VALUES($1,$2,'MRP-123',1,$3,'PRIVATE_EXACT_RESPONSE_121',CURRENT_TIMESTAMP-interval '13 days',CURRENT_TIMESTAMP-interval '11 days',2)`,
        [attemptId, person.id, person.goal],
      );
      await pool.query(
        `INSERT INTO assignment_submission_snapshots(attempt_id,sequence,response,submitted_at) VALUES($1,1,'PRIVATE_EXACT_RESPONSE_121',CURRENT_TIMESTAMP-interval '12 days'),($1,2,'PRIVATE_EXACT_RESPONSE_121',CURRENT_TIMESTAMP-interval '11 days')`,
        [attemptId],
      );
      await pool.query(
        `INSERT INTO preview_circle_memberships(circle_id,member_id,joined_at,left_at) VALUES('invented-circle',$1,CURRENT_TIMESTAMP-interval '1 day',$2)`,
        [person.id, index === 2 ? new Date() : null],
      );
    }
  }
  await page
    .getByRole("link", { name: "Reload snapshot", exact: true })
    .first()
    .click();
  for (const [name, value] of Object.entries({
    members: 20,
    activated: 20,
    selfAssessed: 20,
    submittedAssignment: 3,
    participated: 3,
    activeCircle: 2,
    returnEligible: 20,
    crossContentReturned: 5,
  }))
    await expect(page.locator(`[data-metric="${name}"]`)).toHaveText(
      String(value),
    );
  await expect(page.locator('[data-usefulness="coarse-band"]')).toContainText(
    "50-74%",
  );
  await expect(
    page.getByText(
      "The completion count covers versioned library lessons. The separate starter exercise is not counted here.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Measures overlap and must not be added together", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("at or after 7 full days and before 14 full days", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText("synthetic local preview");
  for (const secret of [
    people[0]!.id,
    "PRIVATE_EXACT_RESPONSE_121",
    "MRP-121",
    "PRIVATE_FIXTURE_BODY",
  ])
    expect(await page.content()).not.toContain(secret);
  await info.attach("invented-readable-learning-snapshot", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page
    .getByRole("link", { name: "View aggregate JSON", exact: true })
    .first()
    .click();
  const json = JSON.parse(await page.locator("body").innerText());
  expect(json.counts.members).toBe(20);
  expect(json.scope).toBe("synthetic-local-preview");
  await store(pool).remove(people[0]!.id);
  await page.goto(running.origin + reportPath);
  await expect(page.locator('[data-metric="members"]')).toHaveText("19");
  await expect(page.locator('[data-metric="submittedAssignment"]')).toHaveText(
    "2",
  );
  await expect(page.locator('[data-metric="crossContentReturned"]')).toHaveText(
    "4",
  );
  await expect(page.locator('[data-usefulness="suppressed"]')).toBeVisible();
  expect(await page.content()).not.toContain("Helpful-share band:");
  await expect(page.locator("body")).not.toContainText("left_at");
  await expect(page.locator("body")).not.toContainText("Of returnEligible");
});
test("[L223] MR-03 current staff role and session protect the report, and an actual database failure recovers only after a deliberate reload", async ({
  page,
}) => {
  const operator = await staff("operator"),
    reviewer = await staff("reviewer"),
    person = await member(0);
  await signIn(page, operator.credential);
  await page.getByRole("link", { name: heading, exact: true }).click();
  expect(
    (await page.goto(
      running.origin + reportPath + "?member_id=" + person.id,
    ))!.status(),
  ).toBe(400);
  expect(await page.content()).not.toContain('data-metric="members"');
  let renamed = false;
  try {
    await pool.query(
      "ALTER TABLE lesson_activity RENAME TO metrics_report_fault_source",
    );
    renamed = true;
    expect((await page.goto(running.origin + reportPath))!.status()).toBe(503);
    await expect(page.getByRole("alert")).toContainText(
      "No partial counts are shown",
    );
    expect(await page.content()).not.toContain('data-metric="members"');
    expect(await page.content()).not.toContain("metrics_report_fault_source");
  } finally {
    if (renamed)
      await pool.query(
        "ALTER TABLE metrics_report_fault_source RENAME TO lesson_activity",
      );
  }
  await page
    .getByRole("link", { name: "Reload snapshot", exact: true })
    .click();
  await expect(page.locator('[data-metric="members"]')).toHaveText("1");
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [operator.id],
  );
  expect((await page.goto(running.origin + reportPath))!.status()).toBe(403);
  expect(await page.content()).not.toContain('data-metric="members"');
  await signIn(page, reviewer.credential);
  await expect(
    page.getByRole("link", { name: heading, exact: true }),
  ).toHaveCount(0);
  expect((await page.goto(running.origin + reportPath))!.status()).toBe(403);
  const expiring = await staff("platform_admin");
  await signIn(page, expiring.credential);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
    [expiring.id],
  );
  expect((await page.goto(running.origin + reportPath))!.status()).toBe(403);
  const fresh = await staff("operator");
  await signIn(page, fresh.credential);
  await page
    .getByRole("button", { name: "Sign out of staff tools", exact: true })
    .click();
  expect((await page.goto(running.origin + reportPath))!.status()).toBe(403);
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: person.token,
      url: running.origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  expect((await page.goto(running.origin + reportPath))!.status()).toBe(403);
  expect(await page.content()).not.toContain('data-metric="members"');
});
