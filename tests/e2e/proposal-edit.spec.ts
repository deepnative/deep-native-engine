import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L80] members correct a private draft and submit only the confirmed revision", async ({
  browser,
}, testInfo) => {
  const moderatorToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    moderatorToken,
    "moderator",
    new Date(Date.now() + 86_400_000),
  );
  const moderator = await browser.newContext({ baseURL: origin });
  await moderator.addCookies([
    {
      name: "dne_preview",
      value: moderatorToken,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const moderatorPage = await moderator.newPage();
  expect(moderatorPage.viewportSize()).toEqual(testInfo.project.use.viewport);
  try {
    for (const [index, background, goal] of [
      [0, "explorer", "everyday"],
      [1, "professional", "work"],
      [2, "technical", "build"],
    ] as const) {
      const member = await browser.newContext({ baseURL: origin });
      try {
        const page = await member.newPage();
        expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
        expect(page.viewportSize()!.width).toBe(
          testInfo.project.name === "mobile-chromium" ? 412 : 1280,
        );
        await onboard(page, background, goal);
        if (index === 1) {
          await page.goto("/workflows/WF-001");
          await page
            .getByRole("link", {
              name: "private version-pinned sample proposal",
            })
            .click();
        } else await page.goto("/contribute");
        const originalTitle =
          "Original " + background + " proposal " + testInfo.project.name;
        const correctedTitle =
          "Corrected " + background + " proposal " + testInfo.project.name;
        const correctedBody =
          "Corrected " + background + " invented text only.";
        await page.getByLabel("Title").fill(originalTitle);
        await page
          .getByLabel("Original sample")
          .fill("Original invented text.");
        await page
          .getByLabel("Sources and rights notes")
          .fill("Original invented note.");
        await page
          .getByLabel("I used only invented or sample information")
          .check();
        await page.getByRole("button", { name: "Save private draft" }).click();
        const id = new URL(page.url()).pathname.split("/").at(-1)!;
        await expect(page.getByText(/^Saved revision 1\./)).toBeVisible();
        const staleTab = await member.newPage();
        await staleTab.goto("/contribute/" + id);
        const staleCsrf = await staleTab
          .locator('input[name="csrf"]')
          .first()
          .inputValue();
        await moderatorPage.goto("/moderate/proposals");
        await expect(moderatorPage.getByText(originalTitle)).toHaveCount(0);

        await page.getByLabel("Title").fill(correctedTitle);
        await page.getByLabel("Original sample").fill(correctedBody);
        await page
          .getByLabel("Sources and rights notes")
          .fill("Corrected original invented source note.");
        await page.getByRole("button", { name: "Save corrections" }).click();
        await expect(page.getByText(/^Saved revision 2\./)).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("heading", { name: correctedTitle }),
        ).toBeVisible();
        await expect(
          page.locator("main p").filter({ hasText: correctedBody }),
        ).toBeVisible();
        expect(
          await page
            .locator('form[action$="/submit"] input[name="revision"]')
            .inputValue(),
        ).toBe("2");
        await expect(
          page.getByLabel("I created this sample or have the rights"),
        ).not.toBeChecked();
        const exportBefore = await member.request.get("/api/member/export");
        expect((await exportBefore.json()).records.proposals).toMatchObject([
          {
            id,
            title: correctedTitle,
            body: correctedBody,
            revision: 2,
            state: "draft",
          },
        ]);
        await moderatorPage.reload();
        await expect(moderatorPage.getByText(correctedTitle)).toHaveCount(0);

        await staleTab.getByLabel("Title").fill("Stale tab overwrite");
        await staleTab
          .getByRole("button", { name: "Save corrections" })
          .click();
        await expect(
          staleTab.getByRole("heading", {
            name: "Proposal corrections not saved",
          }),
        ).toBeVisible();
        await expect(
          staleTab.getByText("The saved draft changed", { exact: false }),
        ).toBeVisible();
        await expect(
          staleTab.getByRole("link", {
            name: "Open the current private preview",
          }),
        ).toBeVisible();
        const staleSubmit = await member.request.post(
          "/contribute/" + id + "/submit",
          {
            headers: { origin },
            form: { csrf: staleCsrf, revision: "1", rights_confirmed: "yes" },
          },
        );
        expect(staleSubmit.status()).toBe(409);
        expect(await staleSubmit.text()).toContain("Nothing was submitted");
        await moderatorPage.reload();
        await expect(moderatorPage.getByText(correctedTitle)).toHaveCount(0);

        await page
          .getByLabel("I created this sample or have the rights")
          .check();
        await page
          .getByRole("button", { name: "Submit to private moderation" })
          .click();
        await expect(
          page.getByText("PRIVATE SAMPLE · SUBMITTED"),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Save corrections" }),
        ).toHaveCount(0);
        await moderatorPage.reload();
        await expect(moderatorPage.getByText(correctedTitle)).toBeVisible();
        await expect(moderatorPage.getByText(originalTitle)).toHaveCount(0);
        await expect(moderatorPage.getByText(correctedBody)).toBeVisible();

        await page
          .getByLabel("Remove the proposal text and stop moderation")
          .check();
        await page.getByRole("button", { name: "Withdraw and redact" }).click();
        await expect(
          page.getByText("The proposal text has been removed"),
        ).toBeVisible();
        await moderatorPage.reload();
        await expect(moderatorPage.getByText(correctedTitle)).toHaveCount(0);
        const retained = await member.request.get("/api/member/export");
        expect((await retained.json()).records.proposals).toMatchObject([
          { id, title: null, body: null, sources: null, state: "withdrawn" },
        ]);
        expect(
          (
            await pool.query(
              "SELECT revision,title,body,sources,state FROM member_proposals WHERE id=$1",
              [id],
            )
          ).rows[0],
        ).toEqual({
          revision: 2,
          title: null,
          body: null,
          sources: null,
          state: "withdrawn",
        });
      } finally {
        await member.close();
      }
    }
  } finally {
    await moderator.close();
  }
});
