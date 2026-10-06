import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { startSampleAssignmentRecoveryServer } from "../support/sample-assignment-recovery-server.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
// Real staff entry sends a protected credential; never retain network traces.
test.use({ trace: "off" });
test.afterAll(() => pool.end());
async function signIn(page: Page, credential: string) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function assign(
  page: Page,
  evidenceId: string,
  version: string,
  reviewerId: string,
  expires: Date,
) {
  await page.goto("/operator/sample-assignments");
  await page.getByLabel("Exact sample ID", { exact: true }).fill(evidenceId);
  await page.getByLabel("Exact source version", { exact: true }).fill(version);
  await page.getByLabel("Reviewer reference", { exact: true }).fill(reviewerId);
  await page
    .getByRole("button", { name: "Check exact sample references", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm private sample assignment",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE-BROWSER-SAMPLE-CONTENT",
  );
  const confirmation = page.getByLabel(
    "I confirm this exact sample, reviewer and finite UTC window.",
    { exact: true },
  );
  await expect(confirmation).not.toBeChecked();
  await page
    .getByLabel("Starts at (UTC)", { exact: true })
    .fill(new Date(Date.now() - 60000).toISOString());
  await page
    .getByLabel("Expires at (UTC)", { exact: true })
    .fill(new Date(+expires - 1000).toISOString());
  await confirmation.check();
  await page
    .getByRole("button", {
      name: "Assign private sample feedback",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private sample assignment receipt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-receipt]")).toHaveCount(1);
  return (
    await page
      .locator("dt")
      .filter({ hasText: /^Exact sample grant ID$/ })
      .locator("xpath=following-sibling::dd[1]")
      .innerText()
  ).trim();
}
async function revoke(
  page: Page,
  evidenceId: string,
  version: string,
  exactGrantId: string,
) {
  await page.goto(
    `/operator/sample-assignments/history?evidenceId=${evidenceId}&sourceRevision=${version}`,
  );
  const row = page.locator(`[data-exact-grant="${exactGrantId}"]`);
  const confirmation = row.getByLabel(
    "I confirm revoking this exact sample grant only.",
    { exact: true },
  );
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await row
    .getByRole("button", {
      name: "Revoke this exact sample grant",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private sample assignment receipt",
      exact: true,
    }),
  ).toBeVisible();
}

const audiences = [
  ["professional", "work"],
  ["technical", "build"],
  ["explorer", "everyday"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${179 + index}] REVADM-01-04 ${background} assigns overlapping exact sample feedback through normal browsers and retains owner feedback after revocation`, async ({
    page,
    browser,
  }) => {
    const reviewerContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const administratorContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const reviewer = await reviewerContext.newPage(),
      administrator = await administratorContext.newPage();
    const adminToken = randomBytes(32).toString("hex"),
      reviewerToken = randomBytes(32).toString("hex");
    const auth = authorizationStore(pool),
      expires = new Date(Date.now() + 3600000);
    const ids: string[] = [];
    let recoveryServer:
      | Awaited<ReturnType<typeof startSampleAssignmentRecoveryServer>>
      | undefined;
    const title = `Invented assignment ${randomBytes(8).toString("hex")}`;
    const feedback = "Check each invented claim against its provided source.";
    try {
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const ownerToken = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!.value;
      const member = await store(pool).session(ownerToken);
      if (member.kind !== "active") throw Error("Invented learner unavailable");
      ids.push(member.learner.id);
      await page.getByRole("link", { name: "Open lesson" }).click();
      await page
        .getByLabel("Your instruction to AI")
        .fill("Use invented source details to make a plan and flag gaps.");
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Check every action against the invented source and remove unsupported claims.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      await page.goto("/evidence");
      await page.getByLabel("Sample title").fill(title);
      await page
        .getByLabel("Invented text sample")
        .fill(
          "PRIVATE-BROWSER-SAMPLE-CONTENT: an invented team checks claims.",
        );
      await page.getByLabel("I created this invented sample").check();
      await page.getByLabel("I explicitly allow this sample").check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const source = page.locator("li").filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      });
      const displayed = await source.locator("p").first().innerText();
      const references =
        /^Private evidence version (\d+) · original · ([a-f0-9-]{36})$/.exec(
          displayed,
        );
      expect(references).not.toBeNull();
      const version = references![1]!,
        evidenceId = references![2]!;
      const evidence = evidenceStore(
        pool,
        fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
        "invented-browser-assignment-secret",
      );
      expect(await evidence.transitionQuarantine(evidenceId, "clean")).toBe(
        true,
      );
      await page.reload();
      await source
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await source
        .getByRole("button", {
          name: "Queue for local review consideration",
          exact: true,
        })
        .click();
      ids.push(
        await auth.provisionStaff(adminToken, "platform_admin", expires),
      );
      const staffId = await auth.provisionStaff(
        reviewerToken,
        "reviewer",
        expires,
      );
      ids.push(staffId);
      await signIn(reviewer, reviewerToken);
      await reviewer
        .getByRole("link", { name: "My reviewer reference", exact: true })
        .click();
      const reviewerId = (
        await reviewer.locator("[data-reviewer-reference]").innerText()
      ).trim();
      expect(reviewerId).toBe(staffId);
      await expect(
        reviewer.getByText(expires.toISOString(), { exact: true }),
      ).toBeVisible();
      await signIn(administrator, adminToken);
      await administrator
        .getByRole("link", { name: "Private sample assignments", exact: true })
        .click();
      const first = await assign(
        administrator,
        evidenceId,
        version,
        reviewerId,
        expires,
      );
      const second = await assign(
        administrator,
        evidenceId,
        version,
        reviewerId,
        expires,
      );
      expect(first).not.toBe(second);
      await reviewer.goto("/staff");
      await reviewer
        .getByRole("link", {
          name: "Your sample feedback worklist",
          exact: true,
        })
        .click();
      await reviewer.getByRole("link", { name: title, exact: true }).click();
      await expect(reviewer.locator("details pre")).toContainText(
        "PRIVATE-BROWSER-SAMPLE-CONTENT",
      );
      await reviewer
        .getByLabel("Criterion 1 label", { exact: true })
        .fill("Claim checking");
      await reviewer
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill(feedback);
      await reviewer
        .getByLabel("Criterion 1 exact source quote", { exact: true })
        .fill("an invented team");
      await reviewer
        .getByRole("button", {
          name: "Save private feedback draft",
          exact: true,
        })
        .click();
      await reviewer
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      await reviewer
        .getByRole("button", { name: "Publish saved feedback", exact: true })
        .click();
      await expect(
        reviewer.getByRole("heading", {
          name: "Published sample feedback",
          exact: true,
        }),
      ).toBeVisible();
      const staffPath = `/review/evidence/${evidenceId}/feedback`,
        ownerPath = `/evidence/${evidenceId}/feedback`;
      await page.goto(ownerPath);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await revoke(administrator, evidenceId, version, first);
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await expect(reviewer.getByText(feedback, { exact: true })).toBeVisible();
      await revoke(administrator, evidenceId, version, second);
      expect((await reviewer.goto(staffPath))!.status()).toBe(403);
      await expect(reviewer.locator("body")).not.toContainText(
        "PRIVATE-BROWSER-SAMPLE-CONTENT",
      );
      await page.reload();
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await page.goto("/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      expect(
        (await page.context().cookies()).find((c) => c.name === COOKIE)!.value,
      ).toBe(ownerToken);
      recoveryServer = await startSampleAssignmentRecoveryServer(
        pool,
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
      );
      await administrator.goto(
        recoveryServer.origin + "/operator/sample-assignments",
      );
      await administrator
        .getByLabel("Exact sample ID", { exact: true })
        .fill(evidenceId);
      await administrator
        .getByLabel("Exact source version", { exact: true })
        .fill(version);
      await administrator
        .getByLabel("Reviewer reference", { exact: true })
        .fill(reviewerId);
      await administrator
        .getByRole("button", {
          name: "Check exact sample references",
          exact: true,
        })
        .click();
      const attemptedStart = new Date(Date.now() - 60000).toISOString(),
        attemptedEnd = new Date(+expires - 1000).toISOString();
      await administrator
        .getByLabel("Starts at (UTC)", { exact: true })
        .fill(attemptedStart);
      await administrator
        .getByLabel("Expires at (UTC)", { exact: true })
        .fill(attemptedEnd);
      const originalKey = await administrator
        .locator('form[action$="/assign"] input[name="operationId"]')
        .inputValue();
      await administrator
        .getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        )
        .check();
      const lostReply = administrator.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/operator/sample-assignments/assign" &&
          response.request().method() === "POST",
      );
      await administrator
        .getByRole("button", {
          name: "Assign private sample feedback",
          exact: true,
        })
        .click();
      expect((await lostReply).status()).toBe(503);
      await expect(
        administrator.getByRole("heading", {
          name: "Private sample assignment unavailable",
          exact: true,
        }),
      ).toBeVisible();
      const originalForm = administrator.locator('form[action$="/assign"]');
      await expect(
        originalForm.locator('input[name="operationId"]'),
      ).toHaveValue(originalKey);
      await expect(
        originalForm.getByLabel("Starts at (UTC)", { exact: true }),
      ).toHaveValue(attemptedStart);
      await expect(
        originalForm.getByLabel("Expires at (UTC)", { exact: true }),
      ).toHaveValue(attemptedEnd);
      await expect(
        originalForm.getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        ),
      ).not.toBeChecked();
      await expect(
        originalForm.getByLabel("Starts at (UTC)", { exact: true }),
      ).toHaveAttribute("readonly", "");
      const receiptTab = administratorContext.waitForEvent("page");
      await administrator
        .getByRole("button", {
          name: "Inspect saved assignment in a new tab",
          exact: true,
        })
        .click();
      const receiptPage = await receiptTab;
      await expect(
        receiptPage.getByRole("heading", {
          name: "Private sample assignment receipt",
          exact: true,
        }),
      ).toBeVisible();
      expect(await receiptPage.evaluate(() => window.opener === null)).toBe(
        true,
      );
      expect(new URL(receiptPage.url()).search).toBe("");
      expect(recoveryServer.observation).toEqual({
        assignmentCommits: 1,
        lostReplies: 1,
        rollbacksAfterCommit: 0,
      });
      await receiptPage.close();
      await expect(
        originalForm.locator('input[name="operationId"]'),
      ).toHaveValue(originalKey);
      await expect(
        originalForm.getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        ),
      ).not.toBeChecked();
      // Owner erasure is a deliberate final action, after retained feedback and
      // progress were observed. An absent receipt must not imply no prior commit.
      await page.getByLabel("Delete my local preview").check();
      await page
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      const absentTab = administratorContext.waitForEvent("page");
      await administrator
        .getByRole("button", {
          name: "Inspect saved assignment in a new tab",
          exact: true,
        })
        .click();
      const absentPage = await absentTab;
      await expect(absentPage.getByRole("alert")).toContainText(
        "does not establish that no write committed",
      );
      expect(await absentPage.evaluate(() => window.opener === null)).toBe(
        true,
      );
      await absentPage.close();
      await expect(
        originalForm.locator('input[name="operationId"]'),
      ).toHaveValue(originalKey);
      await expect(
        originalForm.getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        ),
      ).not.toBeChecked();
      expect(recoveryServer.observation.assignmentCommits).toBe(1);
    } finally {
      await reviewerContext.close();
      await administratorContext.close();
      await recoveryServer?.close();
      for (const id of ids)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}
