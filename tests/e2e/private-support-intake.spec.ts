import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  auth = authorizationStore(pool),
  members = store(pool);
let running: Awaited<ReturnType<typeof start>>, root: string;
test.use({ trace: "off" });
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne195-browser-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_PRIVATE_SUPPORT_INTAKE: "enabled",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_LOCAL_SUPPORT_ASSIGNMENT: "enabled",
  });
});
test.afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function signIn(page: Page, origin: string, credential: string) {
  await page.goto(origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function download(page: Page, origin: string) {
  await page.goto(origin + "/member/export");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download page 1", exact: true })
    .click();
  const file = await downloading;
  return JSON.parse(await readFile((await file.path())!, "utf8"));
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries())
  test(`[L${219 + index}] SI-01-02-03 ${background} sends private support, receives a deliberately assigned reply without internal notes, and controls withdrawal and deletion`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(90000);
    const origin = running.origin,
      expires = new Date(Date.now() + 3600000);
    const options = {
      baseURL: origin,
      viewport: page.viewportSize(),
      userAgent: info.project.use.userAgent,
      deviceScaleFactor: info.project.use.deviceScaleFactor,
      isMobile: info.project.use.isMobile,
      hasTouch: info.project.use.hasTouch,
    };
    const adminContext = await browser.newContext(options),
      operatorContext = await browser.newContext(options);
    const admin = await adminContext.newPage(),
      operator = await operatorContext.newPage();
    const adminCredential = randomBytes(32).toString("hex"),
      operatorCredential = randomBytes(32).toString("hex");
    const staffIds: string[] = [];
    let memberId: string | undefined;
    const subject = `Invented ${background} private learning question`,
      body = `Please help me check the source for an invented ${background} learning project.`,
      note = `INTERNAL-ONLY-${background}-CHECK`,
      reply = `Compare each claim in your ${background} project with the source and mark anything unsupported.`;
    try {
      staffIds.push(
        await auth.provisionStaff(adminCredential, "platform_admin", expires),
        await auth.provisionStaff(operatorCredential, "operator", expires),
      );
      await page.goto(origin + "/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path", exact: true })
        .click();
      const token = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!.value;
      const member = await members.session(token);
      if (member.kind !== "active")
        throw Error("Missing invented browser member");
      memberId = member.learner.id;
      await page
        .getByRole("link", { name: "Private support", exact: true })
        .click();
      await page
        .getByRole("link", { name: "New private request", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "New private support request",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator('input[name="synthetic"]')).toHaveCount(0);
      await page.getByLabel("Subject (up to 120 characters)").fill(subject);
      await page.getByLabel("Your request (up to 2,000 characters)").fill(body);
      const consent = page.getByLabel(
        "Send this private support request. I understand there is no guaranteed response time.",
        { exact: true },
      );
      await expect(consent).not.toBeChecked();
      await consent.check();
      await page
        .getByRole("button", { name: "Send private request", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Private support receipt",
          exact: true,
        }),
      ).toBeVisible();
      const requestId = new URL(page.url()).pathname.split("/").at(-1)!;
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
      const ownerPath = origin + `/support/${requestId}`;
      await expect(page.locator("body")).toContainText(
        "No separate acknowledgement recorded",
      );
      await expect(page.locator("body")).toContainText(
        "Open; no resolution recorded",
      );
      await expect(
        page.getByRole("button", {
          name: "Hold support test minutes",
          exact: true,
        }),
      ).toHaveCount(0);
      await signIn(operator, origin, operatorCredential);
      await operator
        .getByRole("link", { name: "My local assignment ID", exact: true })
        .click();
      const staffId = (
        await operator.locator("[data-assignment-id]").innerText()
      ).trim();
      expect(
        (await operator.goto(
          origin + "/operator/support-assignment/inbox",
        ))!.status(),
      ).toBe(403);
      await operator.goto(origin + "/operator/support");
      await expect(operator.locator("body")).not.toContainText(subject);
      expect(
        (await page.goto(
          origin + "/operator/support-assignment/inbox",
        ))!.status(),
      ).toBe(403);
      await signIn(admin, origin, adminCredential);
      await admin
        .getByRole("link", { name: "Support request assignments", exact: true })
        .click();
      await admin
        .getByRole("link", { name: "Open support intake inbox", exact: true })
        .click();
      const item = admin.locator(`[data-intake-request="${requestId}"]`);
      await expect(item).toBeVisible();
      for (const hidden of [subject, body, memberId])
        await expect(admin.locator("body")).not.toContainText(hidden);
      await info.attach(`invented-${background}-metadata-inbox`, {
        body: await admin.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      await item.getByRole("textbox").fill(staffId);
      await item
        .getByRole("button", {
          name: "Check operator for this request",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Confirm support assignment",
          exact: true,
        }),
      ).toBeVisible();
      await admin
        .getByLabel("Starts at (UTC)")
        .fill(new Date(Date.now() - 60000).toISOString());
      await admin
        .getByLabel("Expires at (UTC)")
        .fill(new Date(+expires - 1000).toISOString());
      const grantConsent = admin.getByLabel(
        "I confirm this exact request, operator and finite UTC window.",
        { exact: true },
      );
      await expect(grantConsent).not.toBeChecked();
      await grantConsent.check();
      await admin
        .getByRole("button", { name: "Assign this request", exact: true })
        .click();
      const grantId = (
        await admin.locator("[data-assignment-grant]").innerText()
      ).trim();
      const operatorPath =
        origin + `/operator/support/${requestId}?grant=${grantId}`;
      await operator.goto(origin + "/staff");
      await operator
        .getByRole("link", {
          name: "Your granted support requests",
          exact: true,
        })
        .click();
      await operator
        .locator(`a[href="/operator/support/${requestId}?grant=${grantId}"]`)
        .click();
      await expect(
        operator.getByRole("heading", {
          name: "Granted support request",
          exact: true,
        }),
      ).toBeVisible();
      await expect(operator.locator("body")).toContainText(body);
      const acknowledge = operator.locator('form[action$="/acknowledge"]');
      await acknowledge.getByRole("checkbox").check();
      await acknowledge
        .getByRole("button", { name: "Acknowledge request", exact: true })
        .click();
      await page.goto(ownerPath);
      await expect(page.locator("body")).not.toContainText(
        "No separate acknowledgement recorded",
      );
      await expect(page.locator("body")).toContainText(
        "Open; no resolution recorded",
      );
      const privateNote = operator.locator('form[action$="/notes"]');
      await privateNote
        .getByLabel("Internal note (up to 2,000 characters)")
        .fill(note);
      await privateNote.getByRole("checkbox").check();
      await privateNote
        .getByRole("button", { name: "Save internal note", exact: true })
        .click();
      await page.reload();
      await expect(page.locator("body")).not.toContainText(note);
      await expect(page.locator("[data-support-reply]")).toHaveCount(0);
      const response = operator.locator('form[action$="/replies"]');
      await response
        .getByLabel("Member-visible reply (up to 2,000 characters)")
        .fill(reply);
      await response.getByRole("checkbox").check();
      await response
        .getByRole("button", { name: "Send member-visible reply", exact: true })
        .click();
      await page.reload();
      await expect(page.locator("[data-support-reply]")).toHaveText(reply);
      await expect(page.locator("body")).toContainText("Support operator");
      await expect(page.locator("body")).not.toContainText(note);
      await expect(page.locator("body")).toContainText(
        "Open; no resolution recorded",
      );
      await info.attach(`invented-${background}-member-visible-reply`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      const exported = await download(page, origin);
      expect(exported.records.supportReplies).toMatchObject([
        { requestId, body: reply, attribution: "Support operator" },
      ]);
      expect(JSON.stringify(exported)).not.toContain(note);
      const resolution = operator.locator('form[action$="/resolve"]');
      await resolution.getByRole("checkbox").check();
      await resolution
        .getByRole("button", { name: "Resolve request", exact: true })
        .click();
      await expect(operator.getByRole("status")).toContainText(
        "No further acknowledgement, note or reply is accepted",
      );
      await page.goto(ownerPath);
      await expect(page.locator("body")).not.toContainText(
        "Open; no resolution recorded",
      );
      await expect(page.locator("[data-support-reply]")).toHaveText(reply);
      await admin
        .getByRole("link", {
          name: "Inspect saved assignment state",
          exact: true,
        })
        .click();
      const grant = admin.locator(`[data-grant="${grantId}"]`);
      await grant
        .getByLabel("I confirm revoking this exact grant only.")
        .check();
      await grant
        .getByRole("button", { name: "Revoke this grant", exact: true })
        .click();
      expect((await operator.goto(operatorPath))!.status()).toBe(403);
      await expect(operator.locator("body")).not.toContainText(body);
      await page
        .getByLabel(
          "Withdraw this request and remove its subject, body and all associated messages. Keep a content-free receipt.",
          { exact: true },
        )
        .check();
      await page
        .getByRole("button", { name: "Withdraw request text", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("Request withdrawn");
      const withdrawn = await download(page, origin);
      expect(withdrawn.records.supportReplies).toEqual([]);
      for (const secret of [subject, body, note, reply])
        expect(JSON.stringify(withdrawn)).not.toContain(secret);
      await admin.goto(origin + "/operator/support-assignment/inbox");
      await expect(item).toContainText("Withdrawn");
      await expect(
        item.getByRole("button", {
          name: "Check operator for this request",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.goto(origin + "/learn");
      await page
        .getByLabel("Delete my local preview and all its saved work.", {
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      await admin.reload();
      await expect(item).toHaveCount(0);
    } finally {
      await adminContext.close();
      await operatorContext.close();
      if (memberId) await members.remove(memberId);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
