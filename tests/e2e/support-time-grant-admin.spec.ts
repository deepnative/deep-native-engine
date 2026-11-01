import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { startSupportTimeGrantRecoveryServer } from "../support/support-time-grant-recovery-server.ts";
// The selected staff credential is sent only through the normal password form.
test.use({ trace: "off" });
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  base = "/operator/support-time-grants";
test.beforeAll(() => migrate(pool));
test.afterAll(() => pool.end());
async function signIn(page: Page, at: string, token: string) {
  await page.goto(at + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(token);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function check(
  page: Page,
  at: string,
  requestId: string,
  allocationId: string,
  operatorId: string,
  expiry: Date,
) {
  await page.goto(at + base);
  await page.getByLabel("Request reference", { exact: true }).fill(requestId);
  await page
    .getByLabel("Allocation reference", { exact: true })
    .fill(allocationId);
  await page.getByLabel("Operator reference", { exact: true }).fill(operatorId);
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
async function inspect(page: Page, context: BrowserContext, label: string) {
  const pending = context.waitForEvent("page");
  await page.getByRole("button", { name: label, exact: true }).click();
  const opened = await pending;
  await opened.waitForLoadState();
  expect(await opened.evaluate(() => window.opener === null)).toBe(true);
  expect(new URL(opened.url()).search).toBe("");
  return opened;
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries())
  test(`[L${207 + index}] SUPPORT-GRANT-01/02/03/04/05/06/07/08 ${background} uses normal administrator and operator browsers to recover exact support permissions and settle held minutes`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    const servers: Awaited<
        ReturnType<typeof startSupportTimeGrantRecoveryServer>
      >[] = [],
      contexts: BrowserContext[] = [],
      staffIds: string[] = [];
    let ownerId: string | undefined;
    const expiry = new Date(Date.now() + 3600000),
      administrator = randomBytes(32).toString("hex"),
      operator = randomBytes(32).toString("hex"),
      privateText = `PRIVATE-SUPPORT-GRANT-${randomBytes(8).toString("hex")} invented request only`;
    try {
      const server = await startSupportTimeGrantRecoveryServer(pool);
      servers.push(server);
      const at = server.origin;
      await page.goto(at + "/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const token = (await page.context().cookies()).find(
          (c) => c.name === COOKIE,
        )!.value,
        member = await members.session(token);
      if (member.kind !== "active") throw Error("Invented member required");
      ownerId = member.learner.id;
      await page.getByRole("link", { name: "Open lesson" }).click();
      await page
        .getByLabel("Your instruction to AI")
        .fill("Use invented details to make a short plan and flag gaps.");
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Compare every action with the invented source and remove unsupported claims.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      // Only this explicit existing finite test allowance and identities are fixtures.
      await syntheticLedger(pool).grant(
        ownerId,
        "support_minutes",
        20,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      staffIds.push(
        await auth.provisionStaff(administrator, "platform_admin", expiry),
        await auth.provisionStaff(operator, "operator", expiry),
      );
      await page.goto(at + "/support/new");
      await page
        .getByLabel("Subject (up to 120 characters)")
        .fill("Invented private support request");
      await page
        .getByLabel("Your sample request (up to 2,000 characters)")
        .fill(privateText);
      await page
        .getByLabel(
          "I used only invented or sample information and want to send this private request.",
        )
        .check();
      await page
        .getByRole("button", { name: "Send private sample request" })
        .click();
      const requestId = new URL(page.url()).pathname.split("/").at(-1)!;
      await page
        .getByLabel("Maximum support and preparation minutes")
        .fill("20");
      await page
        .getByLabel(
          "Hold this ceiling from my existing private support test minutes",
        )
        .check();
      await page
        .getByRole("button", { name: "Hold support test minutes", exact: true })
        .click();
      const allocationId = (
        await page
          .locator("[data-support-time-allocation-reference]")
          .innerText()
      ).trim();
      const adminContext = await browser.newContext({
          viewport: page.viewportSize(),
        }),
        operatorContext = await browser.newContext({
          viewport: page.viewportSize(),
        });
      contexts.push(adminContext, operatorContext);
      const adminPage = await adminContext.newPage(),
        operatorPage = await operatorContext.newPage();
      await signIn(operatorPage, at, operator);
      await operatorPage
        .getByRole("link", { name: "My local assignment ID", exact: true })
        .click();
      const operatorId = (
        await operatorPage.locator("[data-assignment-id]").innerText()
      ).trim();
      expect(operatorId).toBe(staffIds[1]);
      expect((await operatorPage.goto(at + base))!.status()).toBe(403);
      await signIn(adminPage, at, administrator);
      await adminPage
        .getByRole("link", {
          name: "Private support-minute permissions",
          exact: true,
        })
        .click();
      await expect(
        adminPage.getByText(privateText, { exact: true }),
      ).toHaveCount(0);
      let form = await check(
        adminPage,
        at,
        requestId,
        allocationId,
        operatorId,
        expiry,
      );
      await form
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await form
        .getByRole("button", {
          name: "Grant support-minute permission",
          exact: true,
        })
        .click();
      await expect(adminPage.getByRole("alert")).toContainText(
        "cannot be confirmed",
      );
      await expect(
        adminPage.getByText(privateText, { exact: true }),
      ).toHaveCount(0);
      const original = await inspect(
        adminPage,
        adminContext,
        "Inspect saved permission in a new tab",
      );
      const first = (
        await original
          .locator("[data-support-time-grant-reference]")
          .innerText()
      ).trim();
      await original.close();
      await expect(
        adminPage.getByRole("button", {
          name: "Retry this exact permission",
          exact: true,
        }),
      ).toBeVisible();
      await adminPage
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await adminPage
        .getByRole("button", {
          name: "Retry this exact permission",
          exact: true,
        })
        .click();
      expect(
        (
          await adminPage
            .locator("[data-support-time-grant-reference]")
            .innerText()
        ).trim(),
      ).toBe(first);
      form = await check(
        adminPage,
        at,
        requestId,
        allocationId,
        operatorId,
        expiry,
      );
      await form
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await form
        .getByRole("button", {
          name: "Grant support-minute permission",
          exact: true,
        })
        .click();
      const second = (
        await adminPage
          .locator("[data-support-time-grant-reference]")
          .innerText()
      ).trim();
      expect(second).not.toBe(first);
      await adminPage.goto(at + base + "/" + first);
      await adminPage
        .getByLabel("I confirm revoking this exact permission only.")
        .check();
      await adminPage
        .getByRole("button", {
          name: "Revoke this exact permission",
          exact: true,
        })
        .click();
      await expect(adminPage.getByRole("alert")).toContainText(
        "cannot be confirmed",
      );
      const revoked = await inspect(
        adminPage,
        adminContext,
        "Inspect saved revocation in a new tab",
      );
      await expect(
        revoked.getByText("Original revocation outcome: revoked", {
          exact: true,
        }),
      ).toBeVisible();
      const revokeReceipt = await revoked
        .locator("[data-support-time-revocation-reference]")
        .innerText();
      await revoked.close();
      await adminPage
        .getByLabel("I confirm revoking this exact permission only.")
        .check();
      await adminPage
        .getByRole("button", {
          name: "Retry this exact revocation",
          exact: true,
        })
        .click();
      await expect(
        adminPage.locator("[data-support-time-revocation-reference]"),
      ).toHaveText(revokeReceipt);
      await adminPage.goto(at + base + "/history");
      await expect(
        adminPage.locator("[data-support-time-history-grant]"),
      ).toHaveCount(2);
      await expect(
        adminPage.getByText(privateText, { exact: true }),
      ).toHaveCount(0);
      await operatorPage.goto(at + "/staff");
      await operatorPage
        .getByRole("link", {
          name: "Your granted support test effort",
          exact: true,
        })
        .click();
      await operatorPage
        .getByRole("link", {
          name: `Support test allocation · ${requestId}`,
          exact: true,
        })
        .click();
      await expect(
        operatorPage.getByText(privateText, { exact: true }),
      ).toHaveCount(0);
      await operatorPage
        .getByLabel("Begin this private invented support effort")
        .check();
      await operatorPage
        .getByRole("button", { name: "Begin support test effort", exact: true })
        .click();
      const start = new Date(Date.now() - 3600000),
        end = new Date(+start + 600000),
        prepEnd = new Date(+end + 300000);
      await operatorPage
        .getByLabel("Support start (UTC)", { exact: true })
        .fill(start.toISOString());
      await operatorPage
        .getByLabel("Support end (UTC)", { exact: true })
        .fill(end.toISOString());
      await operatorPage
        .getByLabel("Preparation start (UTC, optional)")
        .fill(end.toISOString());
      await operatorPage
        .getByLabel("Preparation end (UTC, optional)")
        .fill(prepEnd.toISOString());
      await operatorPage
        .getByLabel("Record these invented intervals once")
        .check();
      await operatorPage
        .getByRole("button", {
          name: "Record and settle test effort",
          exact: true,
        })
        .click();
      await expect(
        operatorPage.getByText(
          "Confirmed ceiling: 20. Consumed: 15. Released: 5.",
          { exact: true },
        ),
      ).toBeVisible();
      await operatorPage.reload();
      await expect(
        operatorPage.getByText(
          "Confirmed ceiling: 20. Consumed: 15. Released: 5.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("State: completed.", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Consumed: 15", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Released: 5", { exact: false }),
      ).toBeVisible();
      await testInfo.attach("invented-member-support-receipt", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      const recovery = await startSupportTimeGrantRecoveryServer(
        pool,
        "recovery-only",
        false,
      );
      servers.push(recovery);
      await signIn(adminPage, recovery.origin, administrator);
      await adminPage.goto(recovery.origin + base);
      await expect(
        adminPage.getByText("Recovery-only mode:", { exact: false }),
      ).toBeVisible();
      await expect(
        adminPage.getByRole("button", {
          name: "Check exact references",
          exact: true,
        }),
      ).toHaveCount(0);
      await adminPage.goto(recovery.origin + base + "/" + second);
      await expect(
        adminPage.getByText("Observed permission state", { exact: true }),
      ).toBeVisible();
      expect(server.observation).toMatchObject({
        grantLostReplies: 1,
        revokeLostReplies: 1,
        rollbacksAfterCommit: 0,
        databaseErrors: [],
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM support_time_grants WHERE allocation_id=$1",
            [allocationId],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      for (const server of servers.reverse()) await server.close();
      for (const context of contexts) await context.close();
      if (ownerId) await members.remove(ownerId);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
