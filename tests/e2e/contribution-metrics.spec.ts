import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { proposalStore } from "../../src/proposals.ts";
import { publicationStore } from "../../src/proposal-publication.ts";
import {
  authorizationStore,
  type StaffRole,
} from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// Aggregate thresholds need their own database even inside the full gate.
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
  storage = await mkdtemp(join(tmpdir(), "dne122-browser-"));
  running = await start({
    DNE_DATABASE_URL: url.href,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_MEMBER_CONTRIBUTIONS: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
  console.log(
    JSON.stringify({
      fixture: "contribution-metrics",
      database,
      origin: running.origin,
      created: true,
    }),
  );
});
test.beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
test.afterAll(async () => {
  try {
    await running?.close();
    await pool?.end();
    if (created) {
      await control.query(`DROP DATABASE "${database}"`);
      expect(
        (
          await control.query(
            "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) present",
            [database],
          )
        ).rows[0].present,
      ).toBe(false);
      console.log(
        JSON.stringify({
          fixture: "contribution-metrics",
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

async function credential(role: StaffRole) {
  const value = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    value,
    role,
    new Date(Date.now() + 3600000),
  );
  return { value, id };
}
async function signIn(browser: Browser, role: StaffRole) {
  const staff = await credential(role);
  const page = await (await browser.newContext()).newPage();
  await page.goto(running.origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(staff.value);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  return { page, ...staff };
}
async function contribute(
  browser: Browser,
  background: string,
  goal: string,
  title: string,
) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(running.origin + "/");
  await page.getByLabel("Display name").fill("Invented contributor");
  await page.getByLabel("Your starting point").selectOption(background);
  await chooseLearningGoal(page, goal);
  await page
    .getByRole("button", { name: "Start my learning path", exact: true })
    .click();
  await expect(page).toHaveURL(/\/learn$/);
  await page.goto(running.origin + "/contribute");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Original contribution", { exact: true })
    .fill("An invented club compares three activities against its notes.");
  await page
    .getByLabel("Sources and rights notes", { exact: true })
    .fill("Original invented example; platform display only.");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await page
    .getByLabel("I created this contribution or have the rights")
    .check();
  await page
    .getByRole("button", { name: "Submit to private moderation", exact: true })
    .click();
  return { page, id };
}
async function accept(moderator: Page, id: string) {
  await moderator.goto(running.origin + "/moderate/proposals");
  const item = moderator.locator(`[data-proposal-id="${id}"]`);
  await item.getByLabel("I reviewed this exact revision").check();
  await item
    .getByRole("button", {
      name: "Accept this revision privately",
      exact: true,
    })
    .click();
  await expect(
    moderator.locator('[data-publication-state="accepted"]'),
  ).toBeVisible();
}
async function share(owner: Page, id: string) {
  await owner.goto(running.origin + `/contribute/${id}/publication`);
  await owner
    .getByLabel("Display attribution", { exact: true })
    .fill("Invented club contributor");
  await owner
    .getByLabel("Sharing audience", { exact: true })
    .selectOption("members");
  await owner
    .getByLabel(
      "I permit this platform to display this exact accepted revision",
    )
    .check();
  await owner
    .getByRole("button", { name: "Share this accepted revision", exact: true })
    .click();
}
const report = "/operator/metrics/report";
const cell = (page: Page, key: string) =>
  page.locator(`[data-contribution="member-${key}"]`);

test("[L283] CM122-01..06 three audiences contribute through the browser and staff read only suppressed or coarse contribution bands", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const operator = await signIn(browser, "operator");
  await operator.page.goto(running.origin + report);
  await expect(
    operator.page.getByRole("heading", { name: "Reviewed contributions" }),
  ).toBeVisible();
  await expect(
    operator.page.locator('[data-contributions="member-suppressed"]'),
  ).toContainText("Suppressed to protect small groups");

  const moderator = await signIn(browser, "moderator");
  const owners = [];
  for (const [n, [background, goal]] of (
    [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ] as const
  ).entries()) {
    const owner = await contribute(
      browser,
      background,
      goal,
      `Invented club method ${n}`,
    );
    await accept(moderator.page, owner.id);
    await share(owner.page, owner.id);
    owners.push(owner);
  }

  // Seventeen more invented owners reach the 20-contributor threshold.
  const db = store(pool),
    proposals = proposalStore(pool, undefined, { ordinaryEnabled: true }),
    publications = publicationStore(pool, { enabled: true });
  const ids: string[] = [];
  for (let n = 0; n < 17; n++) {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "explorer", goal: "everyday" });
    const id = (await proposals.createDraft(
      token,
      {
        title: `Invented seeded method ${n}`,
        body: "Original invented seeded text.",
        sources: "Original invented source.",
      },
      false,
    ))!;
    expect(await proposals.submit(token, id, true, 1)).toBe("submitted");
    ids.push(id);
  }
  const moderatorToken = (await credential("moderator")).value;
  for (const id of ids.slice(0, 3))
    expect((await publications.accept(moderatorToken, id, 1, true)).kind).toBe(
      "ready",
    );
  for (const id of ids.slice(3, 8))
    expect(await proposals.moderate(moderatorToken, id, "reject")).toBe(true);

  await operator.page.goto(running.origin + report);
  await expect(
    operator.page.locator('[data-contributions="member"]'),
  ).toBeVisible();
  for (const [key, band] of Object.entries({
    submitted: "20-49",
    reviewed: "5-19",
    accepted: "5-19",
    published: "Suppressed",
    sourceWithdrawn: "Suppressed",
    share: "50-74%",
  }))
    await expect(cell(operator.page, key)).toHaveText(band);
  await expect(
    operator.page.locator('[data-contributions="sample-suppressed"]'),
  ).toBeVisible();
  await expect(operator.page.locator("body")).not.toContainText(
    "Invented club method",
  );
  await expect(operator.page.locator("body")).not.toContainText(
    "Invented club contributor",
  );

  const json = await operator.page.request.get(
    running.origin + "/operator/metrics",
  );
  expect(json.status()).toBe(200);
  const contributions = (await json.json()).contributions;
  expect(contributions.groups[0]).toMatchObject({
    origin: "member",
    disclosure: "disclosed",
    volumes: { submitted: "20-49", published: null },
    firstDecisionAcceptanceBand: "50-74%",
  });
  expect(JSON.stringify(contributions)).not.toMatch(
    /"(revisions|owners|contributors)"/,
  );

  const owner = owners[0]!.page;
  await owner.goto(running.origin + "/member/export");
  const [download] = await Promise.all([
    owner.waitForEvent("download"),
    owner.getByRole("button", { name: "Download page 1", exact: true }).click(),
  ]);
  const records = JSON.parse(await readFile((await download.path())!, "utf8"))
    .records.contributionEvents;
  expect(records.map((r: { kind: string }) => r.kind)).toEqual([
    "submitted",
    "reviewed",
    "accepted",
    "published",
  ]);
  expect(JSON.stringify(records)).not.toContain(moderator.id);

  for (const owner of owners) {
    const denied = await owner.page.request.get(running.origin + report);
    expect(denied.status()).toBe(403);
  }
  expect(
    (await moderator.page.request.get(running.origin + report)).status(),
  ).toBe(403);
});
