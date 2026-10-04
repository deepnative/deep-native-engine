import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());
const sampleText = `An invented team checks every factual claim.
  Keep indentation and line breaks.
${"invented".repeat(70)}`;
const feedbackText = `Explain how each claim is checked. ${"reference".repeat(30)}`;
async function readableFeedback(page: Page) {
  await expect(page.locator("details pre")).toHaveText(sampleText, {
    useInnerText: false,
  });
  expect(await page.locator("details pre").textContent()).toBe(sampleText);
  const size = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport);
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${139 + index}] ${background} receives source-bound private feedback, clarifies, revises and withdraws without sharing authority`, async ({
    page,
    browser,
  }) => {
    const staffContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const outsiderContext = await browser.newContext({ baseURL: origin });
    const staff = await staffContext.newPage();
    const reviewerToken = randomBytes(32).toString("hex");
    const auth = authorizationStore(pool);
    const evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "feedback-browser-secret",
    );
    const name = `feedback-${randomBytes(8).toString("hex")}.txt`;
    const expiry = new Date(Date.now() + 3600000);
    let adminId: string | undefined, reviewerId: string | undefined;
    try {
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await page.goto("/evidence");
      await page.getByLabel("Sample title").fill(name);
      await page.getByLabel("Invented text sample").fill(sampleText);
      await page.getByLabel("I created this invented sample").check();
      await page.getByLabel("I explicitly allow this sample").check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const source = (
        await pool.query<{ id: string; owner: string }>(
          "SELECT id,owner_principal_id AS owner FROM evidence_objects WHERE original_name=$1",
          [name],
        )
      ).rows[0]!;
      expect(await evidence.transitionQuarantine(source.id, "clean")).toBe(
        true,
      );
      await page.reload();
      await page
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await page
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      const submission = (
        await pool.query<{ id: string }>(
          "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
          [source.id],
        )
      ).rows[0]!.id;
      adminId = await auth.provisionStaff(
        randomBytes(32).toString("hex"),
        "platform_admin",
        expiry,
      );
      reviewerId = await auth.provisionStaff(reviewerToken, "reviewer", expiry);
      const assignment = await auth.grantAssignment(
        adminId,
        reviewerId,
        source.owner,
        "reviewer",
        "Invented browser feedback",
        expiry,
      );
      const staffPath = `/review/evidence/${source.id}/feedback`,
        ownerPath = `/evidence/${source.id}/feedback`;
      await staffContext.addCookies([
        {
          name: COOKIE,
          value: reviewerToken,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      expect((await staff.goto(staffPath))!.status()).toBe(403);
      await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignment,
        submission,
        "private_sample_feedback_v1",
        expiry,
      );
      await staff.goto(staffPath);
      await readableFeedback(staff);
      await staff
        .getByLabel("Criterion 1 label", { exact: true })
        .fill("Claim checks");
      await staff
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill(feedbackText);
      await staff
        .getByLabel("Criterion 1 exact source quote", { exact: true })
        .fill("An invented");
      await staff
        .getByRole("button", { name: "Save private feedback draft" })
        .focus();
      await staff.keyboard.press("Enter");
      await expect(
        staff.getByRole("button", { name: "Publish saved feedback" }),
      ).toBeVisible();
      await staff
        .locator('form[action$="/draft"] input[name="revision"]')
        .evaluate((input) => {
          (input as HTMLInputElement).value = "0";
        });
      await staff
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill("Keep this attempted correction");
      await staff
        .getByRole("button", { name: "Save private feedback draft" })
        .click();
      await expect(staff.getByRole("alert")).toContainText(
        "saved feedback changed",
      );
      await expect(
        staff.getByRole("textbox", { name: "comment0", exact: true }),
      ).toHaveValue("Keep this attempted correction");
      await staff.getByRole("link", { name: "Inspect saved feedback" }).click();
      await expect(
        staff.getByLabel("Criterion 1 comment", { exact: true }),
      ).toHaveValue(feedbackText);
      await page.goto(ownerPath);
      await expect(
        page.getByText("No published feedback is available for this sample."),
      ).toBeVisible();
      const forbidden = await staff.request.post(staffPath + "/publish", {
        headers: { Origin: origin },
        form: { csrf: "forged", revision: "1", confirm: "yes" },
      });
      expect(forbidden.status()).toBe(403);
      await staff.getByRole("checkbox").check();
      await staff
        .getByRole("button", { name: "Publish saved feedback" })
        .click();
      await expect(
        staff.getByRole("heading", { name: "Published sample feedback" }),
      ).toBeVisible();
      const outsiderToken = randomBytes(32).toString("hex");
      await store(pool).create(outsiderToken, { background, goal });
      await outsiderContext.addCookies([
        { name: COOKIE, value: outsiderToken, url: origin },
      ]);
      const outsider = await outsiderContext.newPage();
      expect((await outsider.goto(ownerPath))!.status()).toBe(403);
      await expect(outsider.getByText(feedbackText)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(feedbackText)).toBeVisible();
      await readableFeedback(page);
      await readableFeedback(staff);
      await page
        .getByLabel("One clarification", { exact: true })
        .fill("Which claim comes first?");
      await page.getByRole("button", { name: "Send clarification" }).click();
      await expect(page.getByText("Which claim comes first?")).toBeVisible();
      await staff.reload();
      await staff
        .getByLabel("One reviewer answer", { exact: true })
        .fill("Start with the first factual statement.");
      await staff.getByRole("button", { name: "Send answer" }).click();
      await expect(
        staff.getByText("Start with the first factual statement."),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("Start with the first factual statement."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Send clarification" }),
      ).toHaveCount(0);
      await page.goto("/evidence");
      await page
        .getByRole("link", { name: `Create a new private revision of ${name}` })
        .click();
      await page.getByLabel("Revised sample title").fill(name + "-v2");
      await page
        .getByLabel("New invented text", { exact: true })
        .fill("A separately revised invented sample.");
      await page.getByLabel("I created this new invented text").check();
      await page.getByLabel("I separately allow this revision").check();
      await page
        .getByRole("button", { name: "Save new private revision" })
        .click();
      const revised = (
        await pool.query<{ id: string }>(
          "SELECT id FROM evidence_objects WHERE original_name=$1",
          [name + "-v2"],
        )
      ).rows[0]!.id;
      expect(
        (await staff.goto(`/review/evidence/${revised}/feedback`))!.status(),
      ).toBe(403);
      await page
        .getByLabel(`Stop private-review access to ${name}`, { exact: true })
        .check();
      await page
        .locator(`form[action="/evidence/${source.id}/revoke-private-review"]`)
        .getByRole("button", { name: "Revoke review consent" })
        .click();
      expect((await staff.goto(staffPath))!.status()).toBe(403);
      await page.goto(ownerPath);
      await expect(
        page.getByText("Start with the first factual statement."),
      ).toBeVisible();
      await expect(
        page.getByText("Consent withdrawn:", { exact: false }),
      ).toBeVisible();
      await page.goto("/evidence");
      await page
        .getByLabel(`Delete ${name} and its configured active derivatives`, {
          exact: true,
        })
        .check();
      await page
        .locator(`form[action="/evidence/${source.id}/delete"]`)
        .getByRole("button", { name: "Delete sample", exact: true })
        .click();
      expect((await page.goto(ownerPath))!.status()).toBe(403);
      expect(
        (
          await pool.query(
            "SELECT id FROM private_sample_feedback WHERE submission_id=$1",
            [submission],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await staffContext.close();
      await outsiderContext.close();
      if (reviewerId)
        await pool.query("DELETE FROM principals WHERE id=$1", [reviewerId]);
      if (adminId)
        await pool.query("DELETE FROM principals WHERE id=$1", [adminId]);
    }
  });
}
