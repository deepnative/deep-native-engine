import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());
const sampleText = `An invented team checks every factual claim.
  Keep indentation and line breaks.
${"invented".repeat(70)}`;
const feedbackText = `Explain how each claim is checked. ${"reference".repeat(30)}`;
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${148 + index}] ${background} has exact-granted reviewer discovery with active and completed feedback`, async ({
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
    const name = `feedback-${randomBytes(8).toString("hex")}-${"x".repeat(170)}.txt`;
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
      const memberSize = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(memberSize.content).toBeLessThanOrEqual(memberSize.viewport);
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
      await staff.goto("/editor/library");
      await staff
        .getByRole("link", { name: "Your sample feedback worklist" })
        .click();
      await expect(
        staff.getByText("No active sample feedback is available to you."),
      ).toBeVisible();
      const exact = await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignment,
        submission,
        "private_sample_feedback_v1",
        expiry,
      );
      await staff.reload();
      await expect(
        staff.getByRole("link", { name, exact: true }),
      ).toBeVisible();
      await expect(staff.getByText(sampleText, { exact: true })).toHaveCount(0);
      await expect(
        staff.getByText("Source version 1 · Not started", { exact: true }),
      ).toBeVisible();
      await staff.getByRole("link", { name, exact: true }).focus();
      await staff.keyboard.press("Enter");
      await expect(staff).toHaveURL(origin + staffPath);
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
        .click();
      await staff
        .getByRole("link", { name: "Your sample feedback worklist" })
        .click();
      await expect(
        staff.getByText("Source version 1 · Your private draft", {
          exact: true,
        }),
      ).toBeVisible();
      await staff.getByRole("link", { name, exact: true }).click();
      await staff
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      await staff
        .getByRole("button", { name: "Publish saved feedback" })
        .click();
      await staff
        .getByRole("link", { name: "Your sample feedback worklist" })
        .click();
      await expect(staff.getByRole("link", { name, exact: true })).toHaveCount(
        0,
      );
      await staff
        .getByRole("link", { name: "Completed feedback", exact: true })
        .click();
      await expect(
        staff.getByRole("link", { name, exact: true }),
      ).toBeVisible();
      await page.goto(ownerPath);
      await expect(page.getByText(feedbackText, { exact: true })).toBeVisible();
      await page
        .getByLabel("One clarification", { exact: true })
        .fill("Which claim should I check?");
      await page.getByRole("button", { name: "Send clarification" }).click();
      await staff.reload();
      await expect(staff.getByRole("link", { name, exact: true })).toHaveCount(
        0,
      );
      await staff
        .getByRole("link", { name: "Active feedback", exact: true })
        .click();
      await expect(
        staff.getByText("Source version 1 · Clarification needs your answer", {
          exact: true,
        }),
      ).toBeVisible();
      const size = await staff.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(size.content).toBeLessThanOrEqual(size.viewport);
      await staff.getByRole("link", { name, exact: true }).click();
      await staff
        .getByLabel("One reviewer answer", { exact: true })
        .fill("Start with the first claim.");
      await staff.getByRole("button", { name: "Send answer" }).click();
      await staff.goto("/review/worklist?view=completed");
      await expect(
        staff.getByRole("link", { name, exact: true }),
      ).toBeVisible();
      await auth.revokeEvidenceReview(adminId, exact);
      await staff.reload();
      await expect(staff.getByRole("link", { name, exact: true })).toHaveCount(
        0,
      );
      expect((await staff.goto(staffPath))!.status()).toBe(403);
      expect((await page.goto("/review/worklist"))!.status()).toBe(403);
      expect(
        (
          await outsiderContext.request.get(origin + "/review/worklist")
        ).status(),
      ).toBe(403);
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
