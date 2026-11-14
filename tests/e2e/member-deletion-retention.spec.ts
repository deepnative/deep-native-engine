import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";

// #40 ERASE-06: before deleting, a member can read what stays afterwards.
const pool = testPool(),
  members = store(pool);
test.afterAll(async () => pool.end());

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L318] ERASE-06 a member reads what stays after deletion, then deletes their account", async ({
  page,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-deletion-kept-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented deleting learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    // #846 ACCOUNT-01: My account names the two periods beside the delete
    // control and opens the full list in place.
    await page.goto(`${origin}/learn`);
    await expect(page.locator(".delete-form")).toHaveCount(0);
    await page.goto(`${origin}/account`);
    await expect(page.locator(".account-delete > p")).toHaveText(
      "This cannot be undone. Issued invoices stay for 6 years for tax records, and backup copies for up to 30 days.",
    );
    const kept = page.locator("#deletion-kept");
    await expect(kept).toBeHidden();
    await page.getByText("What stays after deletion").click();
    await expect(kept).toBeVisible();
    await expect(kept).toContainText(
      "Deleting removes your profile, learning records, saved work, files and sharing choices",
    );
    await expect(kept.getByRole("listitem")).toHaveCount(5);
    await expect(kept.getByRole("listitem").first()).toContainText(
      "Issued invoices",
    );
    await expect(kept).toContainText(
      "Copies in service backups are kept for up to 30 days, then they expire.",
    );
    expect(await noSidewaysScroll(page)).toBe(true);

    await page.locator('.account-delete input[name="confirm"]').check();
    await page.locator(".account-delete button").click();
    await expect(
      page.getByRole("status").filter({ hasText: "were deleted" }),
    ).toBeVisible();
    expect(
      (await pool.query("SELECT id FROM principals WHERE id=$1", [owner]))
        .rowCount,
    ).toBe(0);
    owner = undefined;
  } finally {
    if (owner) await members.remove(owner).catch(() => undefined);
    await running?.close();
    await rm(storage, { recursive: true, force: true });
  }
});
