import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { COOKIE } from "../../src/session.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { reviewTimeGrants } from "../../src/review-time-grants.ts";
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
  test(`[L${145 + index}] ${background} reserves review minutes and receives atomically settled private feedback`, async ({
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
    const faultName = "review_fault_" + randomBytes(8).toString("hex");
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
      const adminToken = randomBytes(32).toString("hex");
      adminId = await auth.provisionStaff(adminToken, "platform_admin", expiry);
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

      await syntheticLedger(pool).grant(
        source.owner,
        "review_minutes",
        20,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      await page.goto(`/evidence/${source.id}/review-allocation`);
      await page.getByLabel("Maximum minutes").fill("20");
      await page.getByRole("button", { name: "Reserve test minutes" }).click();
      await expect(
        page.getByRole("heading", { name: "Your review-minute receipt" }),
      ).toBeVisible();
      const cancelledPath = new URL(page.url()).pathname;
      await page
        .getByRole("button", { name: "Cancel unused allocation" })
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("dl")).toContainText(
        "StatecancelledReserved0Consumed0Returned20",
      );
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Cancel unused allocation" }),
      ).toHaveCount(0);
      await page.goto(`/evidence/${source.id}/review-allocation`);
      await page.getByLabel("Maximum minutes").fill("20");
      await page.getByRole("button", { name: "Reserve test minutes" }).click();
      await expect(
        page.getByRole("heading", { name: "Your review-minute receipt" }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).not.toBe(cancelledPath);
      const receiptPath = new URL(page.url()).pathname;
      const allocationId = receiptPath.split("/").at(-1)!;
      const grant = await reviewTimeGrants(pool, {
        enabled: true,
        mode: "test",
      }).grant(
        adminToken,
        allocationId,
        reviewerId,
        new Date(Date.now() - 60000),
        expiry,
        randomUUID(),
      );
      expect(grant.kind).toBe("applied");
      await staff.goto(staffPath);
      await expect(
        staff.getByRole("heading", { name: "Reserved review test minutes" }),
      ).toBeVisible();
      await staff
        .getByRole("button", { name: "Begin reserved review" })
        .focus();
      await staff.keyboard.press("Enter");
      await expect(
        staff.getByText("State: begun.", { exact: false }),
      ).toBeVisible();
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
      const end = Math.floor(Date.now() / 60000) * 60000 - 60000;
      await staff
        .getByLabel("review Start (UTC)", { exact: true })
        .fill(new Date(end - 600000).toISOString());
      await staff
        .getByLabel("review End (UTC)", { exact: true })
        .fill(new Date(end).toISOString());
      await staff
        .getByLabel("preparation Start (UTC)", { exact: true })
        .fill(new Date(end - 900000).toISOString());
      await staff
        .getByLabel("preparation End (UTC)", { exact: true })
        .fill(new Date(end - 600000).toISOString());
      await staff
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      // A real database failure rolls back publication and settlement. The
      // rendered recovery form must preserve the original operation for an
      // explicit keyboard submission after the owned fault is removed.
      await pool.query(
        `CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.allocation_id='${allocationId}'::uuid THEN RAISE EXCEPTION 'Invented publication outage'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${faultName} BEFORE INSERT ON review_time_entries FOR EACH ROW EXECUTE FUNCTION ${faultName}()`,
      );
      await staff
        .getByRole("button", { name: "Publish saved feedback" })
        .click();
      await expect(
        staff.getByRole("heading", { name: "Feedback needs attention" }),
      ).toBeVisible();
      await expect(
        staff.getByText("Invented publication outage", { exact: false }),
      ).toHaveCount(0);
      await page.goto(receiptPath);
      await expect(page.locator("dl")).toContainText(
        "Reserved20Consumed0Returned0",
      );
      await pool.query(`DROP TRIGGER ${faultName} ON review_time_entries`);
      await pool.query(`DROP FUNCTION ${faultName}()`);
      const recovery = staff.locator(`form[action="${staffPath}/publish"]`);
      const original = (await recovery.evaluate((form) =>
        Object.fromEntries(new FormData(form as HTMLFormElement).entries()),
      )) as Record<string, string>;
      await staff
        .getByRole("button", { name: "Reconcile original publication" })
        .focus();
      await staff.keyboard.press("Enter");
      await expect(
        staff.getByRole("heading", { name: "Published sample feedback" }),
      ).toBeVisible();
      await readableFeedback(staff);
      const replay = await staffContext.request.post(staffPath + "/publish", {
        form: original,
        headers: { Origin: origin },
        maxRedirects: 0,
      });
      expect(replay.status()).toBe(303);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_entries WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      await page.goto("/member/test-units");
      const balance = page.locator(
        '[data-test-unit-category="review_minutes"]',
      );
      await expect(balance.locator('[data-field="usable"]')).toHaveText("5");
      await expect(balance.locator('[data-field="held"]')).toHaveText("0");
      await expect(balance.locator('[data-field="consumed"]')).toHaveText("15");
      await page.goto(receiptPath);
      await page.reload();
      await expect(page.locator("dl")).toContainText("Consumed15Returned5");
      await page
        .getByRole("link", { name: "Your review-minute history" })
        .click();
      await expect(
        page.getByText("consumed 15, returned 5.", { exact: false }),
      ).toBeVisible();
      await page.goto(ownerPath);
      await expect(page.getByText(feedbackText, { exact: true })).toBeVisible();
      await readableFeedback(page);
      const anonymous = await outsiderContext.request.get(receiptPath, {
        maxRedirects: 0,
      });
      expect(anonymous.status()).toBe(303);
      expect(anonymous.headers().location).toBe("/");
      expect(await anonymous.text()).not.toContain(allocationId);
      // A second sample uses only the five returned units. Withdrawal after
      // explicit begin must retain them, rather than inventing a refund.
      const secondName = "withdraw-" + name;
      await page.goto("/evidence");
      await page.getByLabel("Sample title").fill(secondName);
      await page
        .getByLabel("Invented text sample")
        .fill("Another invented private review sample.");
      await page.getByLabel("I created this invented sample").check();
      await page.getByLabel("I explicitly allow this sample").check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const secondId = (
        await pool.query(
          "SELECT id FROM evidence_objects WHERE original_name=$1",
          [secondName],
        )
      ).rows[0].id as string;
      expect(await evidence.transitionQuarantine(secondId, "clean")).toBe(true);
      await page.reload();
      // Select the exact second sample rather than the already reviewed one.
      const queueForm = page.locator(
        `form[action="/evidence/${secondId}/queue"]`,
      );
      await queueForm
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await queueForm
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      const secondSubmission = (
        await pool.query(
          "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
          [secondId],
        )
      ).rows[0].id as string;
      await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignment,
        secondSubmission,
        "private_sample_feedback_v1",
        expiry,
      );
      await page.goto(`/evidence/${secondId}/review-allocation`);
      await page.getByLabel("Maximum minutes").fill("5");
      await page.getByRole("button", { name: "Reserve test minutes" }).click();
      await expect(
        page.getByRole("heading", { name: "Your review-minute receipt" }),
      ).toBeVisible();
      const unresolvedPath = new URL(page.url()).pathname;
      const secondGrant = await reviewTimeGrants(pool, {
        enabled: true,
        mode: "test",
      }).grant(
        adminToken,
        unresolvedPath.split("/").at(-1)!,
        reviewerId,
        new Date(Date.now() - 60000),
        expiry,
        randomUUID(),
      );
      expect(secondGrant.kind).toBe("applied");
      const secondStaffPath = `/review/evidence/${secondId}/feedback`;
      await staff.goto(secondStaffPath);
      await staff
        .getByRole("button", { name: "Begin reserved review" })
        .click();
      await expect(
        staff.getByText("State: begun.", { exact: false }),
      ).toBeVisible();
      await page.goto("/evidence");
      await page
        .getByLabel(`Stop private-review access to ${secondName}`, {
          exact: true,
        })
        .check();
      await page
        .locator(`form[action="/evidence/${secondId}/revoke-private-review"]`)
        .getByRole("button", { name: "Revoke review consent" })
        .click();
      expect((await staff.goto(secondStaffPath))!.status()).toBe(403);
      await page.goto(unresolvedPath);
      await expect(page.locator("dl")).toContainText(
        "Stateneeds_reconciliationReserved5Consumed0Returned0",
      );
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Cancel unused allocation" }),
      ).toHaveCount(0);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${faultName} ON review_time_entries`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${faultName}()`);
      await staffContext.close();
      await outsiderContext.close();
      if (reviewerId)
        await pool.query("DELETE FROM principals WHERE id=$1", [reviewerId]);
      if (adminId)
        await pool.query("DELETE FROM principals WHERE id=$1", [adminId]);
    }
  });
}
