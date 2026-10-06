import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { startCircleGrantRecoveryServer } from "../support/circle-grant-recovery-server.ts";

// Protected staff credentials must not be retained in network traces.
test.use({ trace: "off" });
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
test.afterAll(() => pool.end());
const base = "/operator/circle-grants";
const audiences = [
  ["professional", "work", "professional-work", "Clearer professional work"],
  ["technical", "build", "technical-practice", "Technical AI practice"],
  ["explorer", "everyday", "everyday-ai", "Everyday AI practice"],
] as const;

async function onboard(
  page: Page,
  origin: string,
  background: string,
  goal: string,
) {
  await page.goto(origin);
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await page.context().cookies()).find(
    (c) => c.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Missing invented browser learner");
  return { token, id: session.learner.id };
}
async function signIn(page: Page, origin: string, credential: string) {
  await page.goto(origin + "/staff/sign-in");
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
async function grant(
  page: Page,
  origin: string,
  target: string,
  circle: string,
  expires: Date,
  privateText: string,
) {
  await page.goto(origin + base);
  const check = page
    .locator(`form[action="${base}/check"]`)
    .filter({ has: page.locator('input[type="text"][name="staffId"]') });
  await check.getByLabel("Exact staff reference", { exact: true }).fill(target);
  await check.getByLabel("Exact circle", { exact: true }).selectOption(circle);
  await check
    .getByRole("button", { name: "Check exact references", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm circle moderation grant",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Exact staff reference", { exact: true }),
  ).toHaveValue(target);
  await expect(page.getByLabel("Exact circle ID", { exact: true })).toHaveValue(
    circle,
  );
  await expect(
    page.getByLabel("Original submission key", { exact: true }),
  ).toHaveAttribute("readonly", "");
  const key = await page
    .getByLabel("Original submission key", { exact: true })
    .inputValue();
  const confirmation = page.getByLabel(
    "I confirm this exact staff reference, circle and finite expiry.",
    { exact: true },
  );
  await expect(confirmation).not.toBeChecked();
  await expect(page.locator("body")).toContainText("circle-discussion-test-v1");
  await expect(page.locator("body")).not.toContainText(privateText);
  await page
    .getByLabel("Expires at (UTC)", { exact: true })
    .fill(expires.toISOString());
  await confirmation.check();
  await page
    .getByRole("button", { name: "Create this circle grant", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Circle grant receipt", exact: true }),
  ).toBeVisible();
  const id = (await page.locator("[data-circle-grant]").innerText()).trim();
  await expect(page.locator("body")).toContainText(key);
  expect(new URL(page.url()).search).toBe("");
  return { id, key };
}
async function history(
  page: Page,
  origin: string,
  target: string,
  circle: string,
) {
  await page.goto(origin + base);
  const form = page.locator(`form[action="${base}/history"]`);
  await form.getByLabel("Exact staff reference", { exact: true }).fill(target);
  await form.getByLabel("Exact circle ID", { exact: true }).fill(circle);
  await form
    .getByRole("button", { name: "Inspect grant history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Circle grant history", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
}
async function revoke(
  page: Page,
  origin: string,
  target: string,
  circle: string,
  id: string,
) {
  await history(page, origin, target, circle);
  const row = page.locator(`[data-grant="${id}"]`);
  const confirm = row.getByLabel("I confirm revoking this exact grant only.", {
    exact: true,
  });
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await row
    .getByRole("button", { name: "Revoke this grant", exact: true })
    .click();
  await expect(page.locator(`[data-grant="${id}"]`)).toContainText(
    "already been revoked",
  );
}

for (const [index, [background, goal, circle, title]] of audiences.entries()) {
  test(`[L${182 + index}] CIRADM-01/02/03/04/06/07 ${background} uses browser-created finite circle grants, exact overlapping revocation and structural erased-source history`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    const storage = await mkdtemp(join(tmpdir(), "dne483-e2e-"));
    let running: Awaited<ReturnType<typeof start>> | undefined;
    let recovery:
      Awaited<ReturnType<typeof startCircleGrantRecoveryServer>> | undefined;
    const contexts: BrowserContext[] = [],
      ownerIds: string[] = [],
      staffIds: string[] = [];
    try {
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_LOCAL_STAFF_ENTRY: "enabled",
        DNE_CIRCLE_DISCUSSION: "enabled",
        DNE_LOCAL_CIRCLE_ADMIN: "enabled",
        DNE_PRIVATE_STORAGE_ROOT: storage,
      });
      const origin = running.origin,
        discussion = `${origin}/circles/${circle}/discussion`,
        queue = `${origin}/moderate/circles/${circle}/reports`;
      const device =
        testInfo.project.name === "mobile-chromium"
          ? devices["Pixel 7"]!
          : devices["Desktop Chrome"]!;
      const peerContext = await browser.newContext(device),
        moderatorContext = await browser.newContext(device),
        adminContext = await browser.newContext(device);
      contexts.push(peerContext, moderatorContext, adminContext);
      const peer = await peerContext.newPage(),
        moderator = await moderatorContext.newPage(),
        admin = await adminContext.newPage();
      const author = await onboard(page, origin, background, goal),
        reporter = await onboard(peer, origin, background, goal);
      ownerIds.push(author.id, reporter.id);
      const privateText = `Invented ${background} private exercise must remain private`;
      await page.getByRole("link", { name: "Open lesson" }).click();
      await page.getByLabel("Your instruction to AI").fill(privateText);
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Compare each action to the invented source and flag missing evidence.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      for (const participant of [page, peer]) {
        await participant.goto(origin + "/circles");
        await participant
          .getByRole("button", { name: `Join ${title}`, exact: true })
          .click();
        await participant.goto(discussion + "/choice");
        await participant
          .getByLabel(
            "I choose invented local discussion sharing under this exact circle policy.",
          )
          .check();
        await participant
          .getByRole("button", { name: "Enable invented circle sharing" })
          .click();
        await participant.goto(discussion);
      }
      const question = `Invented ${background} circle question`;
      await page
        .getByLabel("Your invented question (up to 2,000 characters)")
        .fill(question);
      await page
        .getByLabel(
          "I used only invented information and choose to share it with this circle.",
        )
        .check();
      await page
        .getByRole("button", { name: "Share question", exact: true })
        .click();
      await peer.goto(discussion);
      await peer
        .getByRole("link", { name: "Open question and replies" })
        .click();
      const thread = peer.url();
      await peer
        .locator("article")
        .filter({ hasText: question })
        .getByLabel("Report this exact invented contribution")
        .selectOption("privacy");
      await peer
        .getByRole("button", { name: "Save private sample report" })
        .click();
      const adminToken = randomBytes(32).toString("hex"),
        modToken = randomBytes(32).toString("hex"),
        expires = new Date(Date.now() + 3600000);
      const adminId = await auth.provisionStaff(
          adminToken,
          "platform_admin",
          expires,
        ),
        modId = await auth.provisionStaff(modToken, "moderator", expires);
      staffIds.push(adminId, modId);
      await signIn(moderator, origin, modToken);
      await moderator
        .getByRole("link", { name: "My moderation reference", exact: true })
        .click();
      await expect(moderator.locator("[data-circle-reference]")).toHaveText(
        modId,
      );
      await expect(moderator.locator("body")).not.toContainText(modToken);
      expect((await moderator.goto(queue))?.status()).toBe(403);
      await signIn(admin, origin, adminToken);
      await admin
        .getByRole("link", { name: "Circle moderation grants", exact: true })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Circle moderation grants",
          exact: true,
        }),
      ).toBeVisible();
      expect((await admin.goto(queue))?.status()).toBe(403);
      const first = await grant(
        admin,
        origin,
        modId,
        circle,
        new Date(+expires - 1000),
        privateText,
      );
      const second = await grant(
        admin,
        origin,
        modId,
        circle,
        new Date(+expires - 2000),
        privateText,
      );
      expect(second.id).not.toBe(first.id);
      expect(second.key).not.toBe(first.key);
      const popup = adminContext.waitForEvent("page");
      await admin
        .getByRole("button", {
          name: "Inspect saved grant state in a new tab",
          exact: true,
        })
        .click();
      const inspected = await popup;
      await expect(inspected.locator("[data-circle-grant]")).toHaveText(
        second.id,
      );
      expect(await inspected.evaluate(() => window.opener === null)).toBe(true);
      expect(new URL(inspected.url()).search).toBe("");
      await inspected.close();
      await moderator.goto(origin + "/staff");
      await moderator
        .getByRole("link", {
          name: `${title}: granted sample reports`,
          exact: true,
        })
        .click();
      await expect(moderator).toHaveURL(queue);
      await expect(moderator.locator("pre.content-text")).toHaveText(question);
      await expect(moderator.locator("body")).not.toContainText(privateText);
      expect(
        await moderator.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const other = audiences.find((a) => a[2] !== circle)![2];
      expect(
        (
          await moderator.goto(`${origin}/moderate/circles/${other}/reports`)
        )?.status(),
      ).toBe(403);
      await moderator.goto(queue);
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await peer.goto(discussion);
      await expect(peer.locator("pre.content-text")).toHaveCount(0);
      await moderator.goto(queue);
      await moderator
        .getByRole("button", { name: "Restore invented contribution" })
        .click();
      await peer.goto(thread);
      await expect(peer.locator("pre.content-text")).toHaveText(question);
      await revoke(admin, origin, modId, circle, first.id);
      expect((await moderator.goto(queue))?.status()).toBe(200);
      await expect(moderator.locator("pre.content-text")).toHaveText(question);
      await revoke(admin, origin, modId, circle, second.id);
      expect((await moderator.goto(queue))?.status()).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(question);
      await page.goto(origin + "/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      expect(
        (await page.context().cookies()).find((c) => c.name === COOKIE)!.value,
      ).toBe(author.token);
      await peer.goto(thread);
      await expect(peer.locator("pre.content-text")).toHaveText(question);
      // Real COMMIT succeeds; only its acknowledgement is lost. Browser recovery
      // preserves the original instruction and requires a deliberate manual retry.
      recovery = await startCircleGrantRecoveryServer(pool);
      await signIn(admin, recovery.origin, adminToken);
      await admin.goto(recovery.origin + base);
      const recoveryCheck = admin
        .locator(`form[action="${base}/check"]`)
        .filter({ has: admin.locator('input[type="text"][name="staffId"]') });
      await recoveryCheck
        .getByLabel("Exact staff reference", { exact: true })
        .fill(modId);
      await recoveryCheck
        .getByLabel("Exact circle", { exact: true })
        .selectOption(circle);
      await recoveryCheck
        .getByRole("button", { name: "Check exact references", exact: true })
        .click();
      const originalKey = await admin
        .getByLabel("Original submission key", { exact: true })
        .inputValue();
      const originalExpiry = new Date(+expires - 3000).toISOString();
      await admin
        .getByLabel("Expires at (UTC)", { exact: true })
        .fill(originalExpiry);
      await admin
        .getByLabel(
          "I confirm this exact staff reference, circle and finite expiry.",
          { exact: true },
        )
        .check();
      const failedReply = admin.waitForResponse(
        (response) =>
          response.url() === recovery!.origin + base + "/create" &&
          response.request().method() === "POST",
      );
      await admin
        .getByRole("button", { name: "Create this circle grant", exact: true })
        .click();
      expect((await failedReply).status()).toBe(503);
      await expect(admin.locator("body")).toContainText(
        "Nothing is retried automatically",
      );
      const originalForm = admin.locator(`form[action="${base}/create"]`);
      for (const [field, value] of [
        ["staffId", modId],
        ["circleId", circle],
        ["idempotencyKey", originalKey],
        ["expiresAt", originalExpiry],
      ] as const) {
        await expect(
          originalForm.locator(`input[name="${field}"]`),
        ).toHaveValue(value);
        await expect(
          originalForm.locator(`input[name="${field}"]`),
        ).toHaveAttribute("readonly", "");
      }
      await expect(
        originalForm.getByLabel(
          "I confirm this exact staff reference, circle and finite expiry.",
          { exact: true },
        ),
      ).not.toBeChecked();
      expect(recovery.observation).toEqual({
        grantCommits: 1,
        lostReplies: 1,
        rollbacksAfterCommit: 0,
      });
      const originalSnapshot = async () => ({
        grants: (
          await pool.query(
            "SELECT id,staff_id,circle_id,idempotency_key,expires_at,revoked_at FROM preview_circle_moderator_grants WHERE idempotency_key=$1",
            [originalKey],
          )
        ).rows,
        audits: (
          await pool.query(
            "SELECT a.* FROM preview_circle_grant_audit a JOIN preview_circle_moderator_grants g ON g.id=a.grant_id WHERE g.idempotency_key=$1 ORDER BY a.id",
            [originalKey],
          )
        ).rows,
      });
      const committed = await originalSnapshot();
      expect(committed.grants).toHaveLength(1);
      expect(committed.audits).toHaveLength(1);
      const recoveredId = committed.grants[0].id as string;
      const inspectionPopup = adminContext.waitForEvent("page");
      await admin
        .getByRole("button", {
          name: "Inspect saved grant state in a new tab",
          exact: true,
        })
        .click();
      const recoveryInspection = await inspectionPopup;
      await expect(
        recoveryInspection.locator("[data-circle-grant]"),
      ).toHaveText(recoveredId);
      expect(
        await recoveryInspection.evaluate(() => window.opener === null),
      ).toBe(true);
      expect(new URL(recoveryInspection.url()).search).toBe("");
      await recoveryInspection.close();
      expect(await originalSnapshot()).toEqual(committed);
      await expect(
        originalForm.getByLabel(
          "I confirm this exact staff reference, circle and finite expiry.",
          { exact: true },
        ),
      ).not.toBeChecked();
      await originalForm
        .getByLabel(
          "I confirm this exact staff reference, circle and finite expiry.",
          { exact: true },
        )
        .check();
      await originalForm
        .getByRole("button", { name: "Retry this exact grant", exact: true })
        .click();
      await expect(admin.locator("[data-circle-grant]")).toHaveText(
        recoveredId,
      );
      expect(await originalSnapshot()).toEqual(committed);
      expect(recovery.observation.grantCommits).toBe(1);
      expect(new URL(admin.url()).search).toBe("");
      await revoke(admin, recovery.origin, modId, circle, recoveredId);
      expect((await moderator.goto(queue))?.status()).toBe(403);
      await recovery.close();
      recovery = undefined;
      await signIn(admin, origin, adminToken);
      // Staff erasure is a trusted fixture action, never a new browser staff-management claim.
      await pool.query("DELETE FROM principals WHERE id=$1", [modId]);
      await history(admin, origin, modId, circle);
      for (const id of [first.id, second.id]) {
        const row = admin.locator(`[data-grant="${id}"]`);
        await expect(row).toContainText("source is absent");
        await expect(row).not.toContainText("Recorded role");
        await expect(
          row.getByRole("button", { name: "Revoke this grant" }),
        ).toHaveCount(0);
      }
      await expect(admin.locator("body")).not.toContainText(question);
      await expect(admin.locator("body")).not.toContainText(privateText);
      await admin.goto(origin + base);
      const erasedInspection = admin.locator(`form[action="${base}/inspect"]`);
      await erasedInspection
        .getByLabel("Exact staff reference", { exact: true })
        .fill(modId);
      await erasedInspection
        .getByLabel("Exact circle ID", { exact: true })
        .fill(circle);
      await erasedInspection.getByLabel("Reference type").selectOption("key");
      await erasedInspection
        .getByLabel("Exact reference to inspect")
        .fill(second.key);
      await erasedInspection
        .getByRole("button", { name: "Inspect saved grant state", exact: true })
        .click();
      await expect(admin.locator("[data-circle-grant]")).toHaveCount(0);
      await expect(admin.locator("body")).toContainText(
        "does not prove that an earlier submission did not commit",
      );
      expect(new URL(admin.url()).search).toBe("");
      await page.goto(discussion + "/owned");
      await page
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await page.getByRole("button", { name: "Withdraw contribution" }).click();
      expect((await peer.goto(thread))?.status()).toBe(403);
      await page.goto(origin + "/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
    } finally {
      try {
        await Promise.all([
          page.context().close(),
          ...contexts.map((c) => c.close()),
        ]);
      } finally {
        try {
          await recovery?.close();
          if (running) await running.close();
        } finally {
          for (const id of ownerIds) await members.remove(id);
          for (const id of staffIds)
            await pool.query("DELETE FROM principals WHERE id=$1", [id]);
          await rm(storage, { recursive: true, force: true });
        }
      }
    }
  });
}
