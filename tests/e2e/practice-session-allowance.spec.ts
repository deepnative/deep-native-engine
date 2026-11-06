import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { start } from "../../src/runtime.ts";
import { migrate } from "../../src/store.ts";

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function publishLessons(pool: Pool, ids: string[]) {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool),
    editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex"),
    until = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", until);
  await auth.provisionStaff(reviewer, "reviewer", until);
  for (const id of ids) {
    const draft: DraftContent = {
      id,
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: `Invented practice source ${id}`,
      body: "Use only invented details. Check every suggestion against the supplied sample.",
      owner: "Synthetic editor",
      sources: "Original invented sample",
      rights: "Owned sample",
      goals: [],
      backgrounds: [],
      domains: [],
      prerequisites: "None",
      rubric: null,
      rubricVersion: null,
    };
    expect(await catalog.createDraft(editor, draft)).toBe(true);
    expect(await catalog.submit(editor, id, 1)).toBe(true);
    expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
    expect(await catalog.publish(editor, id, 1)).toBe(true);
  }
}
test("[L300] MOCK-01/02/03/05/09 a member claims monthly practice sessions, uses them and is refused one more", async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const adminUrl = new URL(original),
    ownUrl = new URL(original),
    name = `dne_test_${randomBytes(16).toString("hex")}`;
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href });
  const storage = await mkdtemp(join(tmpdir(), "dne199-practice-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    const ids = ["SYN-701", "SYN-702", "SYN-703", "SYN-704"];
    await publishLessons(pool, ids);
    running = await start({
      DNE_DATABASE_URL: ownUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
      DNE_PRACTICE_SESSION_ALLOWANCE: "enabled",
    });
    const origin = running.origin;
    const context = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Sample learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page
      .getByRole("button", { name: "Start my learning path", exact: true })
      .click();

    const begin = async (id: string) => {
      await page.goto(`${origin}/library/${id}/practice-session`);
      await expect(
        page.getByRole("link", { name: "your monthly practice sessions" }),
      ).toBeVisible();
      await page.getByLabel("I want to start private sample practice").check();
      await page
        .getByRole("button", { name: "Start or return to private session" })
        .click();
    };
    const left = page.locator('[data-field="practice-available"]');

    // No claim yet: refused, nothing created, and the refusal leads to the claim.
    await begin(ids[0]!);
    await expect(
      page.getByRole("heading", { name: "Session not started" }),
    ).toBeVisible();
    await noSidewaysScroll(page);
    await page
      .getByRole("link", { name: "Check your monthly allowance" })
      .click();
    await expect(page.getByText("mock-allowance-test-v1")).toBeVisible();
    await expect(
      page.getByText("3 practice sessions, each calendar month (UTC)"),
    ).toBeVisible();
    await noSidewaysScroll(page);

    const confirm = page.getByRole("checkbox", {
      name: "I want this month's 3 practice sessions.",
      exact: true,
    });
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await page
      .getByRole("button", {
        name: "Claim this month's practice sessions",
        exact: true,
      })
      .click();
    await expect(left).toHaveText("3");

    // Each new session uses one; returning to the first uses none.
    await begin(ids[0]!);
    await expect(
      page.getByRole("heading", {
        name: "Private practice session",
        exact: true,
      }),
    ).toBeVisible();
    await page.goto(`${origin}/member/study-allowance`);
    await expect(left).toHaveText("2");
    await begin(ids[0]!);
    await expect(
      page.getByRole("heading", {
        name: "Private practice session",
        exact: true,
      }),
    ).toBeVisible();
    await page.goto(`${origin}/member/study-allowance`);
    await expect(left).toHaveText("2");
    await begin(ids[1]!);
    await begin(ids[2]!);
    await page.goto(`${origin}/member/study-allowance`);
    await expect(left).toHaveText("0");
    await expect(page.locator('[data-field="practice-consumed"]')).toHaveText(
      "3",
    );

    // None left: a fourth is refused, the earlier one still opens.
    await begin(ids[3]!);
    await expect(
      page.getByRole("heading", { name: "Session not started" }),
    ).toBeVisible();
    await begin(ids[0]!);
    await expect(
      page.getByRole("heading", {
        name: "Private practice session",
        exact: true,
      }),
    ).toBeVisible();
    await noSidewaysScroll(page);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM private_practice_sessions",
        )
      ).rows[0].count,
    ).toBe(3);
  } finally {
    for (const context of contexts) await context.close();
    await running?.close();
    await pool.end();
    try {
      if (created) await dropAttendanceBrowserDatabase(control, name);
    } finally {
      await control.end();
      await rm(storage, { recursive: true, force: true });
    }
  }
});
