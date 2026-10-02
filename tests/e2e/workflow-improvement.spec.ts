import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.use({ trace: "on" });
test.afterAll(async () => pool.end());

async function onboard(page: Page, background: "explorer" | "professional") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page
    .getByLabel("What would you like to do?")
    .selectOption(background === "explorer" ? "everyday" : "work");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L74] member submits and withdraws a version-pinned private workflow improvement", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await page.goto("/workflows/WF-001");
  await page
    .getByRole("link", { name: "private version-pinned sample proposal" })
    .click();
  await expect(page).toHaveURL(origin + "/");
  await onboard(page, "explorer");
  await page.goto("/workflows/WF-001");
  await page
    .getByRole("link", { name: "private version-pinned sample proposal" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private improvement for WF-001 version 1",
    }),
  ).toBeVisible();
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const title = `Invented workflow improvement ${testInfo.project.name}`;
  const body = "Add one plain-language check using only invented requirements.";
  const invalid = await context.request.post("/contribute", {
    headers: { origin },
    form: {
      csrf,
      title,
      body,
      sources: "Original invented suggestion",
      sample_confirmed: "yes",
      workflow_id: "WF-001",
      workflow_version: "2",
    },
  });
  expect(invalid.status()).toBe(422);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Original sample").fill(body);
  await page
    .getByLabel("Sources and rights notes")
    .fill("Original invented suggestion");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(
    page.getByText("Workflow reference: WF-001 version 1"),
  ).toBeVisible();
  const exportBefore = await context.request.get("/api/member/export");
  expect(exportBefore.status()).toBe(200);
  expect((await exportBefore.json()).records.proposals).toMatchObject([
    { id, workflowId: "WF-001", workflowVersion: 1, state: "draft" },
  ]);
  const other = await browser.newContext({ baseURL: origin });
  const reviewer = await browser.newContext({ baseURL: origin });
  const moderator = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await onboard(otherPage, "professional");
    await otherPage.goto(`/contribute/${id}`);
    await expect(
      otherPage.getByRole("heading", { name: "Proposal unavailable" }),
    ).toBeVisible();
    const reviewerToken = randomBytes(32).toString("hex");
    const moderatorToken = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      reviewerToken,
      "reviewer",
      new Date(Date.now() + 86_400_000),
    );
    await authorizationStore(pool).provisionStaff(
      moderatorToken,
      "moderator",
      new Date(Date.now() + 86_400_000),
    );
    for (const [staffContext, token] of [
      [reviewer, reviewerToken],
      [moderator, moderatorToken],
    ] as const)
      await staffContext.addCookies([
        {
          name: "dne_preview",
          value: token,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
    const reviewerPage = await reviewer.newPage();
    await reviewerPage.goto("/moderate/proposals");
    await expect(
      reviewerPage.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();
    await page.getByLabel("I created this sample or have the rights").check();
    await page
      .getByRole("button", { name: "Submit to private moderation" })
      .click();
    await expect(page.getByText("PRIVATE SAMPLE · SUBMITTED")).toBeVisible();
    const beforeReplay = (
      await pool.query("SELECT * FROM member_proposals WHERE id=$1", [id])
    ).rows[0];
    expect(beforeReplay).toMatchObject({
      revision: 1,
      rights_attested_revision: 1,
      rights_attested_at: expect.any(Date),
      submitted_at: expect.any(Date),
    });
    const replay = await context.request.post(`/contribute/${id}/submit`, {
      headers: { origin },
      form: { csrf, rights_confirmed: "yes", revision: "1" },
      maxRedirects: 0,
    });
    expect(replay.status()).toBe(303);
    expect(replay.headers().location).toBe(`/contribute/${id}`);
    expect(
      (await pool.query("SELECT * FROM member_proposals WHERE id=$1", [id]))
        .rows[0],
    ).toEqual(beforeReplay);
    const moderatorPage = await moderator.newPage();
    await moderatorPage.goto("/moderate/proposals");
    const queueItem = moderatorPage
      .locator("main li")
      .filter({ hasText: title });
    await expect(queueItem).toContainText(
      "Workflow reference: WF-001 version 1",
    );
    await expect(
      queueItem.getByRole("button", { name: /publish|approve/i }),
    ).toHaveCount(0);
    await page
      .getByLabel("Remove the proposal text and stop moderation")
      .check();
    await page.getByRole("button", { name: "Withdraw and redact" }).click();
    await expect(
      page.getByText("The proposal text has been removed"),
    ).toBeVisible();
    await moderatorPage.reload();
    await expect(moderatorPage.getByText(title)).toHaveCount(0);
    const record = await pool.query(
      "SELECT title,body,sources,workflow_id,workflow_version,state FROM member_proposals WHERE id=$1",
      [id],
    );
    expect(record.rows[0]).toEqual({
      title: null,
      body: null,
      sources: null,
      workflow_id: null,
      workflow_version: null,
      state: "withdrawn",
    });
    const exportAfter = await context.request.get("/api/member/export");
    expect((await exportAfter.json()).records.proposals).toMatchObject([
      {
        id,
        body: null,
        workflowId: null,
        workflowVersion: null,
        state: "withdrawn",
      },
    ]);
    await otherPage.goto("/workflows/WF-001");
    await expect(otherPage.getByText(body)).toHaveCount(0);
  } finally {
    await other.close();
    await reviewer.close();
    await moderator.close();
  }
});
