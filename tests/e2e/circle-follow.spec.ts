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

const circle = "professional-work",
  title = "Clearer professional work";
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function joinAndShare(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByLabel("Display name").fill("Invented learner");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "work");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await page.context().cookies()).find(
    (c) => c.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  await page.goto(`${origin}/circles`);
  await page
    .getByRole("button", { name: `Join ${title}`, exact: true })
    .click();
  await page.goto(`${origin}/circles/${circle}/discussion/choice`);
  await page
    .getByLabel(
      "I choose invented local discussion sharing under this exact circle policy.",
    )
    .check();
  await page
    .getByRole("button", { name: "Enable invented circle sharing" })
    .click();
  return session.learner.id;
}
async function share(page: Page, label: string, body: string, button: string) {
  await page.getByLabel(label).fill(body);
  await page
    .getByLabel(
      "I used only invented information and choose to share it with this circle.",
    )
    .check();
  await page.getByRole("button", { name: button, exact: true }).click();
}

test("[L296] FOLLOW-01..04, 06 a member can follow a circle conversation", async ({
  page,
  browser,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-circle-follow-"));
  const owners: string[] = [];
  const other = await browser.newContext({ viewport: page.viewportSize() });
  const replier = await other.newPage();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_CIRCLE_DISCUSSION: "enabled",
    });
    const origin = running.origin,
      questions = `${origin}/circles/${circle}/discussion`;
    owners.push(await joinAndShare(page, origin));
    owners.push(await joinAndShare(replier, origin));

    // FOLLOW-01: asked in this order, read newest first.
    await page.goto(questions);
    const askLabel = "Your invented question (up to 2,000 characters)";
    await share(page, askLabel, "First invented question", "Share question");
    await page.goto(questions);
    await share(page, askLabel, "Second invented question", "Share question");

    // FOLLOW-04: asked, with nothing back yet.
    await page.goto(`${origin}/circles`);
    await expect(page.locator("body")).toContainText(
      "No replies to your questions yet.",
    );

    await replier.goto(questions);
    const asked = replier.locator("pre.content-text");
    await expect(asked).toHaveText([
      "Second invented question",
      "First invented question",
    ]);
    // FOLLOW-03: nothing yet.
    await expect(replier.locator("body")).toContainText("No replies yet");

    // FOLLOW-02: replies stay in the order they were written.
    const firstQuestion = replier
      .locator("article")
      .filter({ hasText: "First invented question" });
    await firstQuestion
      .getByRole("link", { name: "Open question and replies" })
      .click();
    const conversation = replier.url(),
      replyLabel = "Your invented reply (up to 2,000 characters)";
    for (const reply of ["Reply A", "Reply B", "Reply C"]) {
      await replier.goto(conversation);
      await share(replier, replyLabel, reply, "Share reply");
    }
    await replier.goto(conversation);
    await expect(replier.locator("pre.content-text")).toHaveText([
      "First invented question",
      "Reply A",
      "Reply B",
      "Reply C",
    ]);

    // FOLLOW-03: the list says how many, for everyone who can read it.
    await replier.goto(questions);
    await expect(
      replier.locator("article").filter({ hasText: "First invented question" }),
    ).toContainText("3 replies · latest");
    expect(await noSidewaysScroll(replier)).toBe(true);

    // FOLLOW-04: the asker finds out from Circles and follows the link.
    await page.goto(`${origin}/circles`);
    await expect(page.locator("body")).toContainText(
      "3 replies to your questions · latest",
    );
    await expect(page.locator("body")).not.toContainText("Reply A");
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByRole("link", { name: "See your questions" }).click();
    const mine = page
      .locator("article")
      .filter({ hasText: "First invented question" });
    await expect(mine).toContainText("3 replies · latest");
    await mine.getByRole("link", { name: "Open question and replies" }).click();
    await expect(page.locator("pre.content-text")).toHaveText([
      "First invented question",
      "Reply A",
      "Reply B",
      "Reply C",
    ]);

    // FOLLOW-06: a withdrawn reply stops counting at once.
    await replier.goto(`${questions}/owned`);
    const replyB = replier.locator("article").filter({ hasText: "Reply B" });
    await replyB
      .getByLabel(
        "Withdraw this contribution's text; a content-free marker remains until account deletion.",
      )
      .check();
    await replyB.getByRole("button", { name: "Withdraw contribution" }).click();
    await page.goto(`${origin}/circles`);
    await expect(page.locator("body")).toContainText(
      "2 replies to your questions · latest",
    );
  } finally {
    await other.close();
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      for (const owner of owners) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});
