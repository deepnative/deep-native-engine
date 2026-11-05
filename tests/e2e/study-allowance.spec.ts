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
import { start } from "../../src/runtime.ts";
import { migrate } from "../../src/store.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";

const usable = (page: Page) =>
  page
    .locator('[data-test-unit-category="study_requests"]')
    .locator('[data-field="usable"]');
async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
test("[L299] ALLOW-01/02/03/08 a member claims a monthly test study allowance once and uses it", async ({
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
  const storage = await mkdtemp(join(tmpdir(), "dne199-browser-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    running = await start({
      DNE_DATABASE_URL: ownUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    });
    const origin = running.origin;
    const device =
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"];
    const context = await browser.newContext(device);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Sample learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page
      .getByRole("button", { name: "Start my learning path", exact: true })
      .click();

    await page.goto(origin + "/member/test-units");
    await expect(usable(page)).toHaveText("0");
    await page
      .getByRole("link", { name: "Your monthly study allowance", exact: true })
      .click();
    await expect(page.getByText("study-allowance-test-v1")).toBeVisible();
    await expect(
      page.getByText("5 study requests, each calendar month (UTC)"),
    ).toBeVisible();
    await noSidewaysScroll(page);
    await page.reload();
    await page.goto(origin + "/member/test-units");
    await expect(usable(page)).toHaveText("0");

    await page.goto(origin + "/member/study-allowance");
    const confirm = page.getByRole("checkbox", {
      name: "I want this month's 5 study requests.",
      exact: true,
    });
    await expect(confirm).not.toBeChecked();
    const stale = await context.newPage();
    await stale.goto(origin + "/member/study-allowance");
    await confirm.focus();
    await page.keyboard.press("Space");
    await page
      .getByRole("button", {
        name: "Claim this month's allowance",
        exact: true,
      })
      .click();
    await expect(page.locator('[data-field="available"]')).toHaveText("5");
    await page.reload();
    await expect(page.locator('[data-field="available"]')).toHaveText("5");
    await expect(
      page.getByRole("button", { name: "Claim this month's allowance" }),
    ).toHaveCount(0);
    await noSidewaysScroll(page);

    // The other tab's unsubmitted form still carries its own key.
    await stale
      .getByRole("checkbox", {
        name: "I want this month's 5 study requests.",
        exact: true,
      })
      .check();
    await stale
      .getByRole("button", {
        name: "Claim this month's allowance",
        exact: true,
      })
      .click();
    await expect(stale.locator('[data-field="available"]')).toHaveText("5");
    await stale.close();
    await page.goto(origin + "/member/test-units");
    await expect(usable(page)).toHaveText("5");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM synthetic_entitlement_grants",
        )
      ).rows[0].count,
    ).toBe(1);

    const title = "Invented allowance source.txt";
    await page.goto(origin + "/evidence");
    await page.getByLabel("Sample title").fill(title);
    await page
      .getByLabel("Invented text sample")
      .fill("An invented team checks each action against its sample notes.");
    await page.getByLabel("I created this invented sample").check();
    await page.getByLabel("I explicitly allow this sample").check();
    await page
      .getByRole("button", { name: "Save private text sample" })
      .click();
    const id = (
      await pool.query<{ id: string }>(
        "SELECT id FROM evidence_objects WHERE original_name=$1",
        [title],
      )
    ).rows[0]!.id;
    await evidenceStore(
      pool,
      fileObjectStorage(storage),
      "invented-browser-fixture",
    ).transitionQuarantine(id, "clean");
    await page.goto(origin + "/evidence/local-ai");
    const item = page.locator("li").filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
    await item
      .getByLabel("I permit this exact invented sample version")
      .check();
    await item
      .getByRole("button", { name: "Grant local simulation permission" })
      .click();
    await item.getByLabel("Hold one existing local test request").check();
    await item
      .getByRole("button", { name: "Use one local test request" })
      .click();
    await item.getByRole("button", { name: "Run local test request" }).click();
    await expect(
      item.getByText("One local test request: consumed.", { exact: true }),
    ).toBeVisible();
    await page.goto(origin + "/member/study-allowance");
    await expect(page.locator('[data-field="available"]')).toHaveText("4");
    await expect(page.locator('[data-field="consumed"]')).toHaveText("1");
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
