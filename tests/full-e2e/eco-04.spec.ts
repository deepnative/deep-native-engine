import { createHash, randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function learnerId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

async function publishSample(id: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    editor,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: `Invented circle source ${id}`,
    body: "Check an invented example against the original sample before applying it.",
    owner: "Synthetic test editor",
    sources: "Original invented lesson",
    rights: "Owned synthetic sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
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

test("[F-ECO-04-A] joining one local circle does not share a private versioned sample", async ({
  page,
  context,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "ECA-401" : "ECA-402";
  const response = `Private invented practice for ${id}; never show this in a circle.`;
  await publishSample(id);
  await onboard(page);
  const ownerId = await learnerId(context);
  await page.goto(`/library/${id}/practice`);
  await page.getByLabel("Your sample response").fill(response);
  await page
    .getByLabel(
      "I used only invented or sample information and want to save this private note.",
    )
    .check();
  await page.getByRole("button", { name: "Save private practice" }).click();
  await expect(page.getByText(response, { exact: false })).toBeVisible();

  await requiredCheck(1, async () => {
    await page.goto("/circles");
    const selected = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Everyday AI practice" }),
    });
    await selected
      .getByRole("button", { name: "Join Everyday AI practice" })
      .click();
    await expect(selected).toContainText("You joined this local circle.");
    const separate = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Clearer professional work" }),
    });
    await expect(
      separate.getByRole("button", { name: "Join Clearer professional work" }),
    ).toBeVisible();
    await expect(page.getByText(response)).toHaveCount(0);
    const memberships = await pool.query(
      "SELECT circle_id FROM preview_circle_memberships WHERE member_id=$1 AND left_at IS NULL",
      [ownerId],
    );
    expect(memberships.rows).toEqual([{ circle_id: "everyday-ai" }]);
    await page.goto("/practice");
    await expect(page.getByText(response, { exact: false })).toBeVisible();
  });

  await requiredCheck(2, async () => {
    const outsider = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await outsider.newPage();
      await onboard(otherPage);
      const outsiderId = await learnerId(outsider);
      expect(outsiderId).not.toBe(ownerId);
      await otherPage.goto("/circles");
      await otherPage
        .getByRole("button", { name: "Join Everyday AI practice" })
        .click();
      await expect(
        otherPage.getByText("You joined this local circle."),
      ).toBeVisible();
      await expect(otherPage.getByText(response)).toHaveCount(0);
      await otherPage.goto(`/practice?member_id=${ownerId}`);
      await expect(
        otherPage.getByText("No private practice is saved yet."),
      ).toBeVisible();
      await expect(otherPage.getByText(response)).toHaveCount(0);
      await otherPage.goto(`/library/${id}/practice?member_id=${ownerId}`);
      await expect(
        otherPage.getByRole("heading", { name: "Private sample practice" }),
      ).toBeVisible();
      await expect(
        otherPage.getByRole("button", { name: "Save private practice" }),
      ).toBeVisible();
      await expect(otherPage.getByText(response)).toHaveCount(0);
      const rows = await pool.query(
        "SELECT member_id,content_id,content_version,response FROM private_practice WHERE content_id=$1",
        [id],
      );
      expect(rows.rows).toEqual([
        {
          member_id: ownerId,
          content_id: id,
          content_version: 1,
          response,
        },
      ]);
    } finally {
      await outsider.close();
    }
  });
});
