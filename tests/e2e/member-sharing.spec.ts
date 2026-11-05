import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool);
test.afterAll(async () => pool.end());

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L295] WHOSEES-01..03 a member sees what they share and the moment it changes", async ({
  page,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-who-can-see-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_CIRCLE_DISCUSSION: "enabled",
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    // WHOSEES-01: reached from My account, and nothing is shared yet.
    await page.goto(`${origin}/account`);
    await page.getByRole("link", { name: "Who can see my work" }).click();
    await expect(
      page.getByRole("heading", { name: "Who can see my work", level: 1 }),
    ).toBeVisible();
    const shared = page.getByRole("region", { name: "Other members" });
    await expect(shared).toContainText("You haven't joined a circle");
    await expect(
      page.getByRole("region", { name: "Work you sent for review" }),
    ).toContainText("You haven't sent anything for review");
    await expect(
      page.getByRole("region", { name: "Coaches and administrators" }),
    ).toContainText("No coach is assigned to you");
    expect(await noSidewaysScroll(page)).toBe(true);

    // WHOSEES-02: joining alone shares nothing.
    await shared.getByRole("link", { name: "Explore circles" }).click();
    await page
      .getByRole("button", { name: "Join Everyday AI practice", exact: true })
      .click();
    await page.goto(`${origin}/account/sharing`);
    await expect(shared).toContainText("Everyday AI practice");
    await expect(shared).toContainText("Discussion sharing is off");

    // Sharing on, from the link on this page.
    await shared.getByRole("link", { name: "Change sharing" }).click();
    await page
      .getByLabel(
        "I choose invented local discussion sharing under this exact circle policy.",
      )
      .check();
    await page
      .getByRole("button", { name: "Enable invented circle sharing" })
      .click();
    await page.goto(`${origin}/account/sharing`);
    await expect(shared).toContainText(
      "Sharing is on, but you have no posts they can read",
    );

    await page.goto(`${origin}/circles/everyday-ai/discussion`);
    await page
      .getByLabel("Your invented question (up to 2,000 characters)")
      .fill("An invented question for the sharing page");
    await page
      .getByLabel(
        "I used only invented information and choose to share it with this circle.",
      )
      .check();
    await page
      .getByRole("button", { name: "Share question", exact: true })
      .click();
    await page.goto(`${origin}/account/sharing`);
    await expect(shared).toContainText("can read 1 of your posts");
    await expect(page.locator("body")).not.toContainText(
      "An invented question for the sharing page",
    );
    expect(await noSidewaysScroll(page)).toBe(true);

    // WHOSEES-03: withdrawing sharing shows at once.
    await shared.getByRole("link", { name: "Change sharing" }).click();
    await page.getByLabel("Withdraw this circle's sharing permission.").check();
    await page
      .getByRole("button", { name: "Withdraw sharing permission" })
      .click();
    await page.goto(`${origin}/account/sharing`);
    await expect(shared).toContainText("Discussion sharing is off");
    await expect(shared).not.toContainText("can read");
  } finally {
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      if (owner) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});
