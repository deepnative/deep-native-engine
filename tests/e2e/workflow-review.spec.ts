import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
import { startWorkflowReviewRecoveryServer } from "../support/workflow-review-recovery-server.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
// Staff credential submissions must not be captured in network traces.
test.use({ trace: "off" });
test.afterAll(() => pool.end());
async function signin(page: Page, origin: string, credential: string) {
  await page.goto(origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function requestReview(page: Page, origin: string) {
  await page.goto(origin + "/workflow-feedback/WF-001");
  await page
    .getByRole("link", { name: "Request private review of this exact note" })
    .click();
  const confirmation = page.getByLabel(
    "Allow an individually assigned local moderator to read only this exact note until the shown deadline",
  );
  await expect(confirmation).not.toBeChecked();
  await confirmation.focus();
  await confirmation.press("Space");
  await page
    .getByRole("button", { name: "Request private review", exact: true })
    .press("Enter");
  const request = await page
    .locator("[data-request-id]")
    .getAttribute("data-request-id");
  expect(request).toBeTruthy();
  return request!;
}
async function assign(
  page: Page,
  origin: string,
  requestId: string,
  moderatorId: string,
  note: string,
) {
  await page.goto(origin + "/operator/workflow-reviews");
  await page.getByLabel("Member request reference").fill(requestId);
  await page.getByLabel("Moderator reference").fill(moderatorId);
  await page.getByRole("button", { name: "Check exact assignment" }).click();
  await expect(page.locator("body")).not.toContainText(note);
  const confirmation = page.getByLabel(
    "Assign only this exact private note to the checked moderator until the fixed deadline",
  );
  await expect(confirmation).not.toBeChecked();
  await confirmation.focus();
  await confirmation.press("Space");
  await page
    .getByRole("button", {
      name: "Assign private workflow review",
      exact: true,
    })
    .press("Enter");
  const grant = await page
    .locator("[data-grant-id]")
    .getAttribute("data-grant-id");
  expect(grant).toBeTruthy();
  return grant!;
}
for (const [index, [background, goal]] of [
  ["technical", "build"],
  ["professional", "work"],
  ["explorer", "everyday"],
].entries()) {
  test(`[L${192 + index}] WFREV-01/02/03/04/05/07/08 ${background} requests exact private reading and withdraws permission while keeping the note`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    const storage = await mkdtemp(join(tmpdir(), "dne489-browser-"));
    let running: Awaited<ReturnType<typeof start>> | undefined;
    let paused: Awaited<ReturnType<typeof start>> | undefined;
    const contexts: BrowserContext[] = [],
      staffIds: string[] = [];
    let ownerId: string | undefined;
    try {
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_LOCAL_STAFF_ENTRY: "enabled",
        DNE_WORKFLOW_REVIEW_REQUESTS: "enabled",
        DNE_PRIVATE_STORAGE_ROOT: storage,
      });
      const origin = running.origin;
      await page.goto(origin);
      await page.getByLabel("Your starting point").selectOption(background!);
      await page.getByLabel("What would you like to do?").selectOption(goal!);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const credential = (await page.context().cookies()).find(
          (c) => c.name === "dne_preview",
        )!.value,
        session = await members.session(credential);
      if (session.kind !== "active")
        throw Error("Owned browser member required");
      ownerId = session.learner.id;
      const note = `Invented ${background} note about clearer workflow steps <script>`;
      await page.goto(origin + "/workflow-feedback/WF-001");
      await page.getByLabel("Your private feedback on version 1").fill(note);
      await page
        .getByLabel("I am saving private feedback using only invented text")
        .check();
      await page
        .getByRole("button", { name: "Save private feedback", exact: true })
        .click();
      await page.reload();
      const memberRequest = await requestReview(page, origin);
      const adminToken = randomBytes(32).toString("hex"),
        moderatorToken = randomBytes(32).toString("hex"),
        otherToken = randomBytes(32).toString("hex"),
        expiry = new Date(Date.now() + 3600000);
      staffIds.push(
        await auth.provisionStaff(adminToken, "platform_admin", expiry),
        await auth.provisionStaff(moderatorToken, "moderator", expiry),
        await auth.provisionStaff(otherToken, "moderator", expiry),
      );
      const device = testInfo.project.name.startsWith("mobile")
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"];
      const adminContext = await browser.newContext({ ...device }),
        moderatorContext = await browser.newContext({ ...device }),
        otherContext = await browser.newContext({ ...device });
      contexts.push(adminContext, moderatorContext, otherContext);
      const admin = await adminContext.newPage(),
        moderator = await moderatorContext.newPage(),
        other = await otherContext.newPage();
      await signin(moderator, origin, moderatorToken);
      await moderator.goto(origin + "/moderate/workflow-review-reference");
      await expect(moderator.locator("body")).toContainText(staffIds[1]!);
      await signin(admin, origin, adminToken);
      const granted = await assign(
        admin,
        origin,
        memberRequest,
        staffIds[1]!,
        note,
      );
      await moderator.goto(origin + "/moderate/workflow-reviews");
      await moderator
        .getByRole("link", {
          name: "WF-001 · version 1 · revision 1",
          exact: true,
        })
        .click();
      await expect(moderator.locator("pre")).toHaveText(note);
      await expect(moderator.locator("body")).toContainText(
        "WF-001 · version 1 · revision 1",
      );
      await expect(moderator.locator("body")).toContainText(
        "does not establish qualified review",
      );
      await signin(other, origin, otherToken);
      expect(
        (
          await other.goto(origin + `/moderate/workflow-reviews/${granted}`)
        )?.status(),
      ).toBe(403);
      await expect(other.locator("body")).not.toContainText(note);
      expect(
        (
          await page.goto(origin + `/moderate/workflow-reviews/${granted}`)
        )?.status(),
      ).toBe(403);
      await expect(page.locator("body")).not.toContainText(note);
      await page.goto(
        origin + `/workflow-feedback/review/receipts/${memberRequest}`,
      );
      const withdraw = page.getByLabel(
        "Withdraw this review permission while keeping my own note",
      );
      await expect(withdraw).not.toBeChecked();
      await withdraw.check();
      await page
        .getByRole("button", { name: "Withdraw review permission" })
        .click();
      await expect(page.locator("body")).toContainText(
        "Your permission is withdrawn",
      );
      expect(
        (
          await moderator.goto(origin + `/moderate/workflow-reviews/${granted}`)
        )?.status(),
      ).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(note);
      await page.goto(origin + "/workflow-feedback/WF-001");
      await expect(
        page.getByLabel("Your private feedback on version 1"),
      ).toHaveValue(note);
      await page
        .getByRole("link", { name: "My private review request history" })
        .click();
      await expect(page.locator("body")).toContainText("withdrawn");
      await expect(page.locator("body")).not.toContainText(note);
      // A new request is bound to the exact source instance and revision.
      const beforeCorrection = await requestReview(page, origin);
      const correctedGrant = await assign(
        admin,
        origin,
        beforeCorrection,
        staffIds[1]!,
        note,
      );
      const correctedNote = note + " corrected";
      await page.goto(origin + "/workflow-feedback/WF-001");
      await page
        .getByLabel("Your private feedback on version 1")
        .fill(correctedNote);
      await page
        .getByLabel("I am saving private feedback using only invented text")
        .check();
      await page
        .getByRole("button", { name: "Save private feedback", exact: true })
        .click();
      expect(
        (
          await moderator.goto(
            origin + `/moderate/workflow-reviews/${correctedGrant}`,
          )
        )?.status(),
      ).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(correctedNote);
      await page.goto(origin + "/workflow-feedback/WF-001");
      const beforeRemoval = await requestReview(page, origin);
      const removedGrant = await assign(
        admin,
        origin,
        beforeRemoval,
        staffIds[1]!,
        correctedNote,
      );
      await page.goto(origin + "/workflow-feedback/WF-001");
      const removal = page.getByLabel("Remove my private note for version 1");
      await expect(removal).not.toBeChecked();
      await removal.check();
      await page
        .getByRole("button", {
          name: "Withdraw version 1 feedback",
          exact: true,
        })
        .click();
      await page.goto(origin + "/workflow-feedback/WF-001");
      await page
        .getByLabel("Your private feedback on version 1")
        .fill(correctedNote);
      await page
        .getByLabel("I am saving private feedback using only invented text")
        .check();
      await page
        .getByRole("button", { name: "Save private feedback", exact: true })
        .click();
      expect(
        (
          await moderator.goto(
            origin + `/moderate/workflow-reviews/${removedGrant}`,
          )
        )?.status(),
      ).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(correctedNote);
      const recreatedRequest = await requestReview(page, origin);
      const recreatedGrant = await assign(
        admin,
        origin,
        recreatedRequest,
        staffIds[1]!,
        correctedNote,
      );
      await moderator.goto(
        origin + `/moderate/workflow-reviews/${recreatedGrant}`,
      );
      await expect(moderator.locator("pre")).toHaveText(correctedNote);
      paused = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_LOCAL_STAFF_ENTRY: "enabled",
        DNE_WORKFLOW_REVIEW_REQUESTS: "disabled",
        DNE_PRIVATE_STORAGE_ROOT: storage,
      });
      const pausedOrigin = paused.origin;
      await page.goto(pausedOrigin + "/workflow-feedback/WF-001");
      await expect(
        page.getByRole("link", {
          name: "Request private review of this exact note",
        }),
      ).toHaveCount(0);
      expect(
        (
          await page.goto(pausedOrigin + "/workflow-feedback/WF-001/review")
        )?.status(),
      ).toBe(503);
      await moderator.goto(
        pausedOrigin + `/moderate/workflow-reviews/${recreatedGrant}`,
      );
      await expect(moderator.locator("pre")).toHaveText(correctedNote);
      await admin.goto(pausedOrigin + "/operator/workflow-reviews");
      await expect(admin.locator("body")).toContainText(
        "New private review assignments are paused",
      );
      await expect(
        admin.getByRole("button", { name: "Check exact assignment" }),
      ).toHaveCount(0);
      await admin.getByLabel("Exact grant reference").fill(recreatedGrant);
      const revoke = admin.getByLabel("Revoke this exact reading grant");
      await expect(revoke).not.toBeChecked();
      await revoke.check();
      await admin
        .getByRole("button", {
          name: "Revoke private workflow review",
          exact: true,
        })
        .click();
      await expect(admin.locator("body")).toContainText("revoked");
      expect(
        (
          await moderator.goto(
            origin + `/moderate/workflow-reviews/${recreatedGrant}`,
          )
        )?.status(),
      ).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(correctedNote);
      await page.goto(origin + "/workflow-feedback/WF-001");
      await expect(
        page.getByLabel("Your private feedback on version 1"),
      ).toHaveValue(correctedNote);
      await page.goto(
        pausedOrigin + `/workflow-feedback/review/receipts/${recreatedRequest}`,
      );
      const pausedWithdrawal = page.getByLabel(
        "Withdraw this review permission while keeping my own note",
      );
      await expect(pausedWithdrawal).not.toBeChecked();
      await pausedWithdrawal.check();
      await page
        .getByRole("button", {
          name: "Withdraw review permission",
          exact: true,
        })
        .click();
      await expect(page.locator("body")).toContainText(
        "Your permission is withdrawn",
      );
      await page.goto(pausedOrigin + "/workflow-feedback/WF-001");
      await expect(
        page.getByLabel("Your private feedback on version 1"),
      ).toHaveValue(correctedNote);
      await page
        .getByRole("link", { name: "My private review request history" })
        .click();
      await expect(page.locator("body")).toContainText("withdrawn");
      await page.goto(origin + "/member/export");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page
          .getByRole("button", { name: "Download page 1", exact: true })
          .click(),
      ]);
      const records = JSON.parse(
        await readFile((await download.path())!, "utf8"),
      );
      expect(records.records.workflowReviewRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: memberRequest }),
        ]),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await page.context().close();
      for (const c of contexts) await c.close();
      await paused?.close();
      await running?.close();
      if (ownerId) await members.remove(ownerId);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
      await rm(storage, { recursive: true, force: true });
    }
  });
}

for (const [index, fault] of (["request", "assign"] as const).entries()) {
  test(`[L${195 + index}] WFREV-06 ${fault} actual committed lost reply is inspected before deliberate exact repeat`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    const running = await startWorkflowReviewRecoveryServer(pool, fault);
    const origin = running.origin;
    const contexts: BrowserContext[] = [];
    const staffIds: string[] = [];
    let ownerId: string | undefined;
    try {
      await page.goto(origin);
      await page.getByLabel("Your starting point").selectOption("professional");
      await page.getByLabel("What would you like to do?").selectOption("work");
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const token = (await page.context().cookies()).find(
        (c) => c.name === "dne_preview",
      )!.value;
      const session = await members.session(token);
      if (session.kind !== "active")
        throw Error("Owned recovery member required");
      ownerId = session.learner.id;
      const note = "Invented recovery note; no member or customer data";
      await page.goto(origin + "/workflow-feedback/WF-001");
      await page.getByLabel("Your private feedback on version 1").fill(note);
      await page
        .getByLabel("I am saving private feedback using only invented text")
        .check();
      await page
        .getByRole("button", { name: "Save private feedback", exact: true })
        .click();
      let actor = page;
      if (fault === "assign") {
        const requestId = await requestReview(page, origin);
        const adminToken = randomBytes(32).toString("hex"),
          moderatorToken = randomBytes(32).toString("hex");
        const expiry = new Date(Date.now() + 3600000);
        staffIds.push(
          await auth.provisionStaff(adminToken, "platform_admin", expiry),
          await auth.provisionStaff(moderatorToken, "moderator", expiry),
        );
        const device = testInfo.project.name.startsWith("mobile")
          ? devices["Pixel 7"]
          : devices["Desktop Chrome"];
        const context = await browser.newContext({ ...device });
        contexts.push(context);
        actor = await context.newPage();
        await signin(actor, origin, adminToken);
        await actor.goto(origin + "/operator/workflow-reviews");
        await actor.getByLabel("Member request reference").fill(requestId);
        await actor.getByLabel("Moderator reference").fill(staffIds[1]!);
        await actor
          .getByRole("button", { name: "Check exact assignment" })
          .click();
        await actor
          .getByLabel(
            "Assign only this exact private note to the checked moderator until the fixed deadline",
          )
          .check();
      } else {
        await page.goto(origin + "/workflow-feedback/WF-001/review");
        await page
          .getByLabel(
            "Allow an individually assigned local moderator to read only this exact note until the shown deadline",
          )
          .check();
      }
      const action = fault === "request" ? "/request" : "/assign";
      const originalKey = await actor
        .locator(`form[action$="${action}"] input[name="operationId"]`)
        .inputValue();
      const response = actor.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.endsWith(action) &&
          r.request().method() === "POST",
      );
      await actor
        .getByRole("button", {
          name:
            fault === "request"
              ? "Request private review"
              : "Assign private workflow review",
          exact: true,
        })
        .click();
      expect((await response).status()).toBe(503);
      const repeat = actor.getByLabel(
        fault === "request"
          ? "Deliberately repeat the exact original request without extending its deadline"
          : "Deliberately repeat this exact original assignment without extending its deadline",
      );
      await expect(repeat).not.toBeChecked();
      await expect(
        actor.locator(`form[action$="${action}"] input[name="operationId"]`),
      ).toHaveValue(originalKey);
      expect(running.observation).toEqual({
        operationCommits: 1,
        lostReplies: 1,
        rollbacksAfterCommit: 0,
      });
      const inspect = actor.locator('form[action$="/inspect"]');
      // Inspection must preserve the original recovery form without navigation
      // through a failed POST or an automatic replacement instruction.
      const popup = actor
        .context()
        .waitForEvent("page", { timeout: 5000 })
        .catch(() => null);
      await inspect
        .getByRole("button", {
          name: "Inspect the original operation",
          exact: true,
        })
        .click();
      const receipt = await popup;
      expect(
        receipt,
        "Manual inspection opens a separate receipt while preserving original recovery controls",
      ).not.toBeNull();
      if (!receipt) throw Error("Separate inspection receipt required");
      const reference =
        fault === "request" ? "data-request-id" : "data-grant-id";
      const receiptId = await receipt
        .locator(`[${reference}]`)
        .getAttribute(reference);
      expect(receiptId).toBeTruthy();
      expect(await receipt.evaluate(() => window.opener === null)).toBe(true);
      await expect(receipt.locator("body")).not.toContainText(note);
      await receipt.close();
      await expect(repeat).not.toBeChecked();
      await repeat.check();
      await actor
        .getByRole("button", {
          name:
            fault === "request"
              ? "Repeat exact request"
              : "Repeat exact assignment",
          exact: true,
        })
        .click();
      await expect(actor.locator(`[${reference}]`)).toHaveAttribute(
        reference,
        receiptId!,
      );
      expect(running.observation).toEqual({
        operationCommits: 1,
        lostReplies: 1,
        rollbacksAfterCommit: 0,
      });
      const rows = await pool.query(
        "SELECT count(*)::int AS count FROM workflow_review_operations WHERE operation_id=$1",
        [originalKey],
      );
      expect(rows.rows[0].count).toBe(1);
      await actor
        .getByRole("link", {
          name:
            fault === "request"
              ? "Reload this request receipt"
              : "Reload this assignment receipt",
          exact: true,
        })
        .click();
      await expect(actor.locator(`[${reference}]`)).toHaveAttribute(
        reference,
        receiptId!,
      );
    } finally {
      await page.context().close();
      for (const context of contexts) await context.close();
      await running.close();
      if (ownerId) await members.remove(ownerId);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}
