import { startEventCancellationRecoveryServer } from "../support/event-cancellation-recovery-server.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import {
  test,
  expect,
  devices,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE } from "../../src/session.ts";
// Password staff fixtures must never be retained in network traces.
test.use({ trace: "off" });
const base = "/operator/event-cancellations";
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
  return (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
}
for (const [index, [background, goal]] of (
  [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const
).entries()) {
  test(`[L${185 + index}] EVCANCEL-01/02/03/05/06/07 ${background} retains an owned registration after exact administrator cancellation and separate withdrawal`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    // Canonical cancellations cannot be undone for cleanup. Each journey owns an
    // entirely separate generated database, leaving other event journeys intact.
    const original = process.env.DNE_TEST_DATABASE_URL;
    if (
      !original ||
      !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
    )
      throw Error("Missing generated browser database");
    const dbName = `dne_test_${randomBytes(16).toString("hex")}`,
      adminUrl = new URL(original),
      ownUrl = new URL(original);
    adminUrl.pathname = "/postgres";
    ownUrl.pathname = `/${dbName}`;
    const control = new Pool({ connectionString: adminUrl.href }),
      pool = new Pool({ connectionString: ownUrl.href }),
      storage = await mkdtemp(join(tmpdir(), "dne482-browser-"));
    let running: Awaited<ReturnType<typeof start>> | undefined,
      created = false;
    let recovery:
      | Awaited<ReturnType<typeof startEventCancellationRecoveryServer>>
      | undefined;
    const contexts: BrowserContext[] = [];
    try {
      await control.query(`CREATE DATABASE "${dbName}"`);
      created = true;
      await migrate(pool);
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: ownUrl.href,
        DNE_PORT: "0",
        DNE_APP_MODE: "test",
        DNE_PRIVATE_STORAGE_ROOT: storage,
        DNE_LOCAL_STAFF_ENTRY: "enabled",
        DNE_EVENT_REGISTRATION: "enabled",
        DNE_LOCAL_EVENT_ADMIN: "enabled",
      });
      const origin = running.origin,
        device =
          testInfo.project.name === "mobile-chromium"
            ? devices["Pixel 7"]
            : devices["Desktop Chrome"];
      const staffContext = await browser.newContext(device),
        peerContext = await browser.newContext(device);
      contexts.push(staffContext, peerContext);
      const admin = await staffContext.newPage(),
        peer = await peerContext.newPage();
      const memberToken = await onboard(page, origin, background, goal);
      await onboard(peer, origin, background, goal);
      await page.goto(origin + "/events/local-registration-rehearsal/1");
      await page
        .getByRole("link", { name: "Try local registration rehearsal" })
        .click();
      const rehearsal = page.url();
      await page
        .getByLabel(
          "I want to save an invented-data registration; this is not a real appointment.",
        )
        .check();
      await page
        .getByRole("button", { name: "Enroll in local rehearsal" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Private registration receipt",
          exact: true,
        }),
      ).toBeVisible();
      const receiptUrl = page.url(),
        receiptId = new URL(receiptUrl).pathname.split("/").at(-1)!;
      expect((await peer.goto(receiptUrl))?.status()).toBe(404);
      const credential = randomBytes(32).toString("hex");
      await authorizationStore(pool).provisionStaff(
        credential,
        "platform_admin",
        new Date(Date.now() + 3600000),
      );
      await admin.goto(origin + "/staff/sign-in");
      await admin.getByLabel("Trusted local staff credential").fill(credential);
      await admin
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      await admin
        .getByRole("link", { name: "Event cancellation", exact: true })
        .click();
      const check = admin.locator(`form[action="${base}/check"]`);
      await check
        .getByLabel("Exact event ID", { exact: true })
        .fill("local-registration-rehearsal");
      await check.getByLabel("Exact version", { exact: true }).fill("1");
      await check.getByRole("button", { name: "Check exact event" }).click();
      await expect(
        admin.getByRole("heading", {
          name: "Confirm event cancellation",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        admin.getByLabel("Checked title", { exact: true }),
      ).toHaveAttribute("readonly", "");
      const key = await admin
        .getByLabel("Original submission key", { exact: true })
        .inputValue();
      const confirmation = admin.getByLabel(
        "I confirm cancelling this exact invented event version.",
        { exact: true },
      );
      await expect(confirmation).not.toBeChecked();
      await confirmation.check();
      await admin
        .getByRole("button", { name: "Cancel this event version", exact: true })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Event cancellation receipt",
          exact: true,
        }),
      ).toBeVisible();
      await expect(admin.locator("body")).toContainText(
        "New registrations are closed",
      );
      expect(new URL(admin.url()).search).toBe("");
      await page.goto(receiptUrl);
      await expect(page.locator("body")).toContainText(/event cancelled/i);
      await expect(
        page.getByRole("button", { name: "Withdraw registration" }),
      ).toBeVisible();
      await page.goto(origin + "/events/registrations");
      await expect(page.locator("body")).toContainText(/event cancelled/i);
      await peer.goto(rehearsal);
      await expect(
        peer.getByRole("button", { name: "Enroll in local rehearsal" }),
      ).toHaveCount(0);
      await peer.goto(origin + "/events/local-registration-rehearsal/1");
      await expect(peer.locator("body")).toContainText(/event cancelled/i);
      await expect(
        peer.getByRole("link", { name: "Try local registration rehearsal" }),
      ).toHaveCount(0);
      const exported = await (
        await page.request.get(origin + "/api/member/export")
      ).json();
      expect(exported.records.eventEnrollments).toHaveLength(1);
      expect(exported.records.eventEnrollments[0]).toMatchObject({
        id: receiptId,
        withdrawnAt: null,
      });
      expect(exported.records.eventEnrollments[0].cancelledAt).toBeTruthy();
      expect(JSON.stringify(exported)).not.toContain(key);
      expect(JSON.stringify(exported)).not.toContain(credential);
      await page.goto(receiptUrl);
      await page
        .getByLabel(
          "Withdraw this exact sample registration and release its seat.",
        )
        .check();
      await page.getByRole("button", { name: "Withdraw registration" }).click();
      const withdrawn = await (
        await page.request.get(origin + "/api/member/export")
      ).json();
      expect(withdrawn.records.eventEnrollments[0].id).toBe(receiptId);
      expect(withdrawn.records.eventEnrollments[0].withdrawnAt).toBeTruthy();
      expect(withdrawn.records.eventEnrollments[0].cancelledAt).toBe(
        exported.records.eventEnrollments[0].cancelledAt,
      );
      const recoveryEvent = {
        ...EVENT_PREVIEWS.find((e) => e.localRegistration === true)!,
        id: "invented-recovery-event",
        version: 2,
      };
      recovery = await startEventCancellationRecoveryServer(
        pool,
        recoveryEvent,
      );
      await admin.goto(recovery.origin + "/staff/sign-in");
      await admin.getByLabel("Trusted local staff credential").fill(credential);
      await admin
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      await admin.goto(recovery.origin + base);
      const recoveryCheck = admin.locator(`form[action="${base}/check"]`);
      await recoveryCheck
        .getByLabel("Exact event ID", { exact: true })
        .fill(recoveryEvent.id);
      await recoveryCheck
        .getByLabel("Exact version", { exact: true })
        .fill("2");
      await recoveryCheck
        .getByRole("button", { name: "Check exact event" })
        .click();
      const originalKey = await admin
        .getByLabel("Original submission key", { exact: true })
        .inputValue();
      await admin
        .getByLabel("I confirm cancelling this exact invented event version.", {
          exact: true,
        })
        .check();
      const uncertainResponse = admin.waitForResponse(
        (response) =>
          response.url().endsWith(base + "/cancel") &&
          response.request().method() === "POST",
      );
      await admin
        .getByRole("button", { name: "Cancel this event version", exact: true })
        .click();
      expect((await uncertainResponse).status()).toBe(503);
      await expect(admin.locator("body")).toContainText(
        "Cancellation may already have committed",
      );
      await admin
        .getByText("Repeat the exact original instruction manually", {
          exact: true,
        })
        .click();
      const repeat = admin.locator(`form[action="${base}/cancel"]`);
      await expect(
        repeat.getByLabel("Original submission key", { exact: true }),
      ).toHaveValue(originalKey);
      await expect(
        repeat.getByLabel("Original submission key", { exact: true }),
      ).toHaveAttribute("readonly", "");
      await expect(
        admin.getByLabel(
          "I confirm repeating this exact original instruction.",
          { exact: true },
        ),
      ).not.toBeChecked();
      const popupPromise = admin.waitForEvent("popup");
      await admin
        .getByRole("button", {
          name: "Inspect saved cancellation in a new tab",
          exact: true,
        })
        .click();
      const inspected = await popupPromise;
      await expect(
        inspected.getByRole("heading", {
          name: "Event cancellation receipt",
          exact: true,
        }),
      ).toBeVisible();
      await expect(inspected.locator("body")).toContainText(originalKey);
      expect(new URL(inspected.url()).search).toBe("");
      await inspected.close();
      await admin
        .getByLabel("I confirm repeating this exact original instruction.", {
          exact: true,
        })
        .check();
      await admin
        .getByRole("button", {
          name: "Repeat original cancellation",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Event cancellation receipt",
          exact: true,
        }),
      ).toBeVisible();
      expect(recovery.observation).toEqual({
        cancellationCommits: 1,
        lostReplies: 1,
        rollbacksAfterCommit: 0,
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM private_event_cancellations WHERE event_id=$1",
            [recoveryEvent.id],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM private_event_cancellation_operations WHERE event_id=$1",
            [recoveryEvent.id],
          )
        ).rows[0].count,
      ).toBe(1);
      const session = await store(pool).session(memberToken);
      if (session.kind !== "active")
        throw Error("Missing owned invented member");
      await store(pool).remove(session.learner.id);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM private_event_cancellations",
          )
        ).rows[0].count,
      ).toBe(2);
      await peer.goto(rehearsal);
      await expect(
        peer.getByRole("button", { name: "Enroll in local rehearsal" }),
      ).toHaveCount(0);
      expect(
        await peer.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      for (const context of contexts) await context.close();
      if (recovery) await recovery.close();
      if (running) await running.close();
      await pool.end();
      if (created) await control.query(`DROP DATABASE "${dbName}"`);
      await control.end();
      await rm(storage, { recursive: true, force: true });
    }
  });
}
