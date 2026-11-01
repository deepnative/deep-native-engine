import { browserOrigin } from "../support/browser-origin.js";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { startReviewTimeGrantRecoveryServer } from "../support/review-time-grant-recovery-server.ts";

// The normal staff form sends a protected credential. Never retain its trace.
test.use({ trace: "off" });
const pool = testPool();
test.afterAll(() => pool.end());
const origin = browserOrigin;
const base = "/operator/review-time-grants";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;

async function signIn(page: Page, credential: string, at = origin) {
  await page.goto(at + "/staff/sign-in");
  await expect(
    page.getByLabel("Trusted local staff credential"),
  ).toHaveAttribute("type", "password");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function checkedPermission(
  page: Page,
  at: string,
  allocation: string,
  reviewer: string,
  expiry: Date,
) {
  await page.goto(at + base);
  await page
    .getByLabel("Allocation reference", { exact: true })
    .fill(allocation);
  await page.getByLabel("Reviewer reference", { exact: true }).fill(reviewer);
  await page
    .getByRole("button", { name: "Check exact references", exact: true })
    .click();
  await page
    .getByLabel("Starts at (UTC)", { exact: true })
    .fill(new Date(Date.now() - 60000).toISOString());
  await page
    .getByLabel("Expires at (UTC)", { exact: true })
    .fill(new Date(+expiry - 1000).toISOString());
  const form = page.locator(`form[action="${base}/grant"]`);
  await expect(
    form.getByLabel("I confirm this exact finite permission", { exact: true }),
  ).not.toBeChecked();
  return form;
}
async function fields(form: ReturnType<Page["locator"]>) {
  return form.evaluate((node) =>
    Object.fromEntries(new FormData(node as HTMLFormElement).entries()),
  ) as Promise<Record<string, string>>;
}
async function grantReference(page: Page) {
  await expect(
    page.getByRole("heading", {
      name: "Review-minute permission receipt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-review-time-grant-reference]")).toHaveCount(
    1,
  );
  expect(new URL(page.url()).search).toBe("");
  return (
    await page.locator("[data-review-time-grant-reference]").innerText()
  ).trim();
}
async function inspected(page: Page, context: BrowserContext, label: string) {
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: label, exact: true }).click();
  const receipt = await opened;
  await receipt.waitForLoadState();
  expect(await receipt.evaluate(() => window.opener === null)).toBe(true);
  expect(new URL(receipt.url()).search).toBe("");
  return receipt;
}

for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${201 + index}] REVIEW-GRANT-01/02/03/04/05/06/07 ${background} deliberately recovers original permission and revocation while overlapping access, privacy and creation rollback remain bounded`, async ({
    page,
    browser,
  }, testInfo) => {
    // This journey includes separate member, reviewer and administrator screens,
    // two actual post-COMMIT faults, exact revocation and rollback-mode listeners.
    test.setTimeout(60000);
    const contexts: BrowserContext[] = [];
    const staffIds: string[] = [];
    const servers: Awaited<
      ReturnType<typeof startReviewTimeGrantRecoveryServer>
    >[] = [];
    const expiry = new Date(Date.now() + 3600000);
    const privateText = `PRIVATE-REVIEW-GRANT-${randomBytes(8).toString("hex")} invented source only.`;
    let memberId: string | undefined;
    const stages: { stage: string; at: string }[] = [];
    const observed = (stage: string) => {
      stages.push({ stage, at: new Date().toISOString() });
    };
    try {
      const adminContext = await browser.newContext({
        baseURL: origin,
        viewport: page.viewportSize(),
      });
      const reviewerContext = await browser.newContext({
        baseURL: origin,
        viewport: page.viewportSize(),
      });
      const otherContext = await browser.newContext({ baseURL: origin });
      const anonymousContext = await browser.newContext({ baseURL: origin });
      contexts.push(
        adminContext,
        reviewerContext,
        otherContext,
        anonymousContext,
      );
      const admin = await adminContext.newPage();
      const reviewer = await reviewerContext.newPage();
      const other = await otherContext.newPage();
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await page.goto("/evidence");
      const name = `permission-${randomBytes(8).toString("hex")}.txt`;
      await page.getByLabel("Sample title").fill(name);
      await page.getByLabel("Invented text sample").fill(privateText);
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
      memberId = source.owner;
      const evidence = evidenceStore(
        pool,
        fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
        "invented-grant-source",
      );
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
      const auth = authorizationStore(pool);
      const adminToken = randomBytes(32).toString("hex");
      const reviewerToken = randomBytes(32).toString("hex");
      const otherToken = randomBytes(32).toString("hex");
      const administratorId = await auth.provisionStaff(
        adminToken,
        "platform_admin",
        expiry,
      );
      const reviewerId = await auth.provisionStaff(
        reviewerToken,
        "reviewer",
        expiry,
      );
      const otherId = await auth.provisionStaff(
        otherToken,
        "platform_admin",
        expiry,
      );
      staffIds.push(administratorId, reviewerId, otherId);
      // Separate workspace/source permission and allowance are explicit premises.
      // The allocation-specific time permission itself is created only by UI.
      const assignment = await auth.grantAssignment(
        administratorId,
        reviewerId,
        source.owner,
        "reviewer",
        "Invented browser review permission",
        expiry,
      );
      await auth.grantEvidenceReview(
        administratorId,
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
      const memberReceipt = new URL(page.url()).pathname;
      const allocationId = memberReceipt.split("/").at(-1)!;
      await expect(
        page.locator("[data-review-allocation-reference]"),
      ).toHaveText(allocationId);
      await signIn(admin, adminToken);
      await signIn(reviewer, reviewerToken);
      await signIn(other, otherToken);
      await reviewer.goto("/review/review-time-reference");
      await expect(reviewer.locator("[data-reviewer-reference]")).toHaveText(
        reviewerId,
      );
      const staffPath = `/review/evidence/${source.id}/feedback`;
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await expect(
        reviewer.getByRole("button", {
          name: "Begin reserved review",
          exact: true,
        }),
      ).toHaveCount(0);

      const recovery = await startReviewTimeGrantRecoveryServer(
        pool,
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
      );
      servers.push(recovery);
      await signIn(admin, adminToken, recovery.origin);
      const grantForm = await checkedPermission(
        admin,
        recovery.origin,
        allocationId,
        reviewerId,
        expiry,
      );
      await expect(admin.locator("body")).not.toContainText(privateText);
      await expect(admin.locator("body")).not.toContainText(name);
      const originalGrant = await fields(grantForm);
      const lostGrant = admin.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === base + "/grant" &&
          r.request().method() === "POST",
      );
      await grantForm
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await grantForm
        .getByRole("button", {
          name: "Grant review-minute permission",
          exact: true,
        })
        .click();
      expect((await lostGrant).status()).toBe(503);
      const retryGrant = admin.locator(`form[action="${base}/grant"]`);
      await expect(retryGrant.locator('input[name="operationId"]')).toHaveValue(
        originalGrant.operationId!,
      );
      await expect(
        retryGrant.getByLabel("I confirm this exact finite permission", {
          exact: true,
        }),
      ).not.toBeChecked();
      const savedGrantPage = await inspected(
        admin,
        adminContext,
        "Inspect saved permission in a new tab",
      );
      const firstId = await grantReference(savedGrantPage);
      await savedGrantPage.close();
      expect(recovery.observation.grantCommits).toBe(1);
      expect(recovery.observation.grantLostReplies).toBe(1);
      const canonical = (
        await pool.query(
          "SELECT id,starts_at,expires_at,created_at FROM review_time_grants WHERE allocation_id=$1 ORDER BY id",
          [allocationId],
        )
      ).rows;
      expect(canonical).toHaveLength(1);
      await retryGrant
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await retryGrant
        .getByRole("button", {
          name: "Retry this exact permission",
          exact: true,
        })
        .click();
      expect(await grantReference(admin)).toBe(firstId);
      expect(
        (
          await pool.query(
            "SELECT id,starts_at,expires_at,created_at FROM review_time_grants WHERE allocation_id=$1 ORDER BY id",
            [allocationId],
          )
        ).rows,
      ).toEqual(canonical);
      const changed = await adminContext.request.post(
        recovery.origin + base + "/grant",
        {
          form: {
            ...originalGrant,
            confirm: "yes",
            startsAt: new Date(Date.now() - 30000).toISOString(),
          },
          headers: { Origin: recovery.origin },
          maxRedirects: 0,
        },
      );
      expect(changed.status()).toBe(409);
      expect(recovery.observation.grantCommits).toBe(1);

      const overlapping = await checkedPermission(
        admin,
        origin,
        allocationId,
        reviewerId,
        expiry,
      );
      await overlapping
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await overlapping
        .getByRole("button", {
          name: "Grant review-minute permission",
          exact: true,
        })
        .click();
      const secondId = await grantReference(admin);
      expect(secondId).not.toBe(firstId);
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await admin.goto(recovery.origin + base + "/" + firstId);
      const revokeForm = admin.locator(`form[action="${base}/revoke"]`);
      const originalRevoke = await fields(revokeForm);
      const confirmation = revokeForm.getByLabel(
        "I confirm revoking this exact permission only.",
        { exact: true },
      );
      await expect(confirmation).not.toBeChecked();
      await confirmation.check();
      const lostRevoke = admin.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === base + "/revoke" &&
          r.request().method() === "POST",
      );
      await revokeForm
        .getByRole("button", {
          name: "Revoke this exact permission",
          exact: true,
        })
        .click();
      expect((await lostRevoke).status()).toBe(503);
      expect(recovery.observation.revokeCommits).toBe(1);
      expect(recovery.observation.revokeLostReplies).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_grant_revocations WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      const retryRevoke = admin.locator(`form[action="${base}/revoke"]`);
      await expect(
        retryRevoke.locator('input[name="operationId"]'),
      ).toHaveValue(originalRevoke.operationId!);
      await expect(
        retryRevoke.getByLabel(
          "I confirm revoking this exact permission only.",
          { exact: true },
        ),
      ).not.toBeChecked();
      const savedRevoke = await inspected(
        admin,
        adminContext,
        "Inspect saved revocation in a new tab",
      );
      await expect(savedRevoke.locator("body")).toContainText(
        "Original revocation outcome: revoked",
      );
      const revocationId = (
        await savedRevoke
          .locator("[data-review-time-revocation-reference]")
          .innerText()
      ).trim();
      await savedRevoke.close();
      await retryRevoke
        .getByLabel("I confirm revoking this exact permission only.", {
          exact: true,
        })
        .check();
      await retryRevoke
        .getByRole("button", {
          name: "Retry this exact revocation",
          exact: true,
        })
        .click();
      await expect(
        admin.locator("[data-review-time-revocation-reference]"),
      ).toHaveText(revocationId);
      expect(recovery.observation.revokeCommits).toBe(1);
      expect(recovery.observation.rollbacksAfterCommit).toBe(0);
      const conflictingRevoke = await adminContext.request.post(
        recovery.origin + base + "/revoke",
        {
          form: { ...originalRevoke, confirm: "yes", grantId: secondId },
          headers: { Origin: recovery.origin },
          maxRedirects: 0,
        },
      );
      expect(conflictingRevoke.status()).toBe(409);
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      const secondBegin = await fields(
        reviewer.locator(`form[action="${staffPath}/begin"]`),
      );
      await admin.goto(origin + base + "/" + secondId);
      await admin
        .getByLabel("I confirm revoking this exact permission only.", {
          exact: true,
        })
        .check();
      await admin
        .getByRole("button", {
          name: "Revoke this exact permission",
          exact: true,
        })
        .focus();
      await admin.keyboard.press("Enter");
      await expect(admin.locator("body")).toContainText(
        "Original revocation outcome: revoked",
      );
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await expect(
        reviewer.getByRole("button", {
          name: "Begin reserved review",
          exact: true,
        }),
      ).toHaveCount(0);
      const secondDenied = await reviewerContext.request.post(
        staffPath + "/begin",
        {
          form: secondBegin,
          headers: { Origin: origin },
          maxRedirects: 0,
        },
      );
      expect(secondDenied.status()).toBe(403);
      await page.goto(memberReceipt);
      await expect(page.locator("dl")).toContainText(
        "Reserved20Consumed0Returned0",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_entries WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_grant_revocations WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 2 }]);
      await admin.goto(origin + base + "/history");
      await expect(admin.locator("body")).toContainText(firstId);
      await expect(admin.locator("body")).toContainText(secondId);
      await expect(admin.locator("body")).not.toContainText(privateText);
      for (const context of [otherContext, reviewerContext, anonymousContext]) {
        const denied = await context.request.get(
          origin + base + "/" + firstId,
          { maxRedirects: 0 },
        );
        expect([303, 403, 404]).toContain(denied.status());
        const body = await denied.text();
        expect(body).not.toContain(firstId);
        expect(body).not.toContain(privateText);
      }

      // Create one retained active permission before a creation rollback. This
      // is an explicit browser action, not a refund or restoration of old grants.
      const thirdForm = await checkedPermission(
        admin,
        origin,
        allocationId,
        reviewerId,
        expiry,
      );
      await thirdForm
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await thirdForm
        .getByRole("button", {
          name: "Grant review-minute permission",
          exact: true,
        })
        .click();
      const thirdId = await grantReference(admin);
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      const thirdBegin = await fields(
        reviewer.locator(`form[action="${staffPath}/begin"]`),
      );
      const rollback = await startReviewTimeGrantRecoveryServer(
        pool,
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
        "recovery-only",
        false,
      );
      servers.push(rollback);
      await signIn(admin, adminToken, rollback.origin);
      await admin
        .getByRole("link", {
          name: "Private review-minute permissions",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("button", {
          name: "Check exact references",
          exact: true,
        }),
      ).toHaveCount(0);
      await admin
        .getByLabel("Original permission operation key", { exact: true })
        .fill(originalGrant.operationId!);
      const pausedGrant = await inspected(
        admin,
        adminContext,
        "Inspect saved permission in a new tab",
      );
      expect(await grantReference(pausedGrant)).toBe(firstId);
      await pausedGrant.close();
      await admin
        .getByLabel("Original revocation operation key", { exact: true })
        .fill(originalRevoke.operationId!);
      const pausedRevoke = await inspected(
        admin,
        adminContext,
        "Inspect saved revocation in a new tab",
      );
      await expect(
        pausedRevoke.locator("[data-review-time-revocation-reference]"),
      ).toHaveText(revocationId);
      await expect(pausedRevoke.locator("body")).toContainText(
        "Original revocation outcome: revoked",
      );
      await pausedRevoke.close();
      const pausedCsrf = await admin
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const pausedCreate = await adminContext.request.post(
        rollback.origin + base + "/grant",
        {
          form: {
            ...originalGrant,
            csrf: pausedCsrf,
            operationId: randomUUID(),
            confirm: "yes",
          },
          headers: { Origin: rollback.origin },
          maxRedirects: 0,
        },
      );
      expect(pausedCreate.status()).toBe(503);
      expect(rollback.observation.grantCommits).toBe(0);
      await admin.goto(rollback.origin + base + "/" + thirdId);
      await expect(
        admin.locator("[data-review-time-grant-reference]"),
      ).toHaveText(thirdId);
      await admin
        .getByLabel("I confirm revoking this exact permission only.", {
          exact: true,
        })
        .check();
      await admin
        .getByRole("button", {
          name: "Revoke this exact permission",
          exact: true,
        })
        .click();
      await expect(admin.locator("body")).toContainText(
        "Original revocation outcome: revoked",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_grant_revocations WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 3 }]);
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await expect(
        reviewer.getByRole("button", {
          name: "Begin reserved review",
          exact: true,
        }),
      ).toHaveCount(0);
      const thirdDenied = await reviewerContext.request.post(
        staffPath + "/begin",
        {
          form: thirdBegin,
          headers: { Origin: origin },
          maxRedirects: 0,
        },
      );
      expect(thirdDenied.status()).toBe(403);
      await page.reload();
      await expect(page.locator("dl")).toContainText(
        "Reserved20Consumed0Returned0",
      );
      observed("recovery-only-exact-revoke-complete");
      const disabled = await startReviewTimeGrantRecoveryServer(
        pool,
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
        "disabled",
        false,
      );
      servers.push(disabled);
      await signIn(admin, adminToken, disabled.origin);
      await expect(
        admin.getByRole("link", {
          name: "Private review-minute permissions",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(
        (await admin.goto(disabled.origin + base + "/" + firstId))!.status(),
      ).toBe(404);
      observed("disabled-denial-complete");
      // Erasure is deliberately offered on the member learning dashboard, not
      // on an accounting receipt. Keep the normal member browser flow.
      await page.goto("/learn");
      await expect(
        page.getByRole("heading", {
          name: "Adjust your direction",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByLabel("Delete my local preview").check();
      const erasedMemberReply = page.waitForResponse(
        (reply) =>
          new URL(reply.url()).pathname === "/delete" &&
          reply.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      const deletionReply = await erasedMemberReply;
      expect(deletionReply.status()).toBe(303);
      await expect(
        page.getByRole("button", {
          name: "Start my learning path",
          exact: false,
        }),
      ).toBeVisible();
      observed("member-erasure-complete");
      await signIn(admin, adminToken, recovery.origin);
      await admin.goto(recovery.origin + base);
      const csrf = await admin
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const erased = await adminContext.request.post(
        recovery.origin + base + "/recover",
        {
          form: { operationId: originalGrant.operationId!, csrf },
          headers: { Origin: recovery.origin },
          maxRedirects: 0,
        },
      );
      expect(await erased.text()).toContain(
        "does not establish that no write committed",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_grants WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM review_time_grant_revocations WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      observed("all-behavior-assertions-complete");
    } finally {
      observed("cleanup-start");
      await testInfo.attach("review-permission-stages", {
        body: JSON.stringify(stages),
        contentType: "application/json",
      });
      await testInfo.attach("review-permission-fault-observations", {
        body: JSON.stringify(servers.map((server) => server.observation)),
        contentType: "application/json",
      });
      for (const [index, context] of contexts.entries()) {
        observed(`context-${index}-close-start`);
        await context.close();
        observed(`context-${index}-close-end`);
      }
      for (const [index, server] of servers.entries()) {
        observed(`server-${index}-close-start`);
        await server.close();
        observed(`server-${index}-close-end`);
      }
      if (memberId)
        await pool.query("DELETE FROM principals WHERE id=$1", [memberId]);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}
