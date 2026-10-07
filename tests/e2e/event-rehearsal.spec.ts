import { startEventRehearsalRecoveryServer } from "../support/event-rehearsal-recovery-server.ts";
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
const base = "/operator/event-rehearsals";
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
  test(`[L${188 + index}] REHSCHED-01/02/03/07/08 ${background} schedules, discovers, registers and retains cancellation after scheduling pause`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
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
      storage = await mkdtemp(join(tmpdir(), "dne487-browser-"));
    let running: Awaited<ReturnType<typeof start>> | undefined,
      created = false;
    const contexts: BrowserContext[] = [];
    const environment = {
      ...process.env,
      DNE_DATABASE_URL: ownUrl.href,
      DNE_PORT: "0",
      DNE_APP_MODE: "test",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_STAFF_ENTRY: "enabled",
      DNE_EVENT_REGISTRATION: "enabled",
      DNE_LOCAL_EVENT_ADMIN: "enabled",
      DNE_LOCAL_EVENT_SCHEDULING: "enabled",
    };
    try {
      await control.query(`CREATE DATABASE "${dbName}"`);
      created = true;
      await migrate(pool);
      running = await start(environment);
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
        .getByRole("link", {
          name: "Schedule a private rehearsal",
          exact: true,
        })
        .click();
      const check = admin.locator(`form[action="${base}/check"]`),
        startsAt = new Date(Date.now() + 3600000).toISOString();
      await check.getByLabel("Start in UTC", { exact: true }).fill(startsAt);
      await check
        .getByRole("button", { name: "Check proposed schedule", exact: true })
        .click();
      const confirmation = admin.locator(`form[action="${base}/schedule"]`);
      await expect(
        confirmation.getByLabel("startsAt", { exact: true }),
      ).toHaveValue(startsAt);
      await expect(
        confirmation.getByLabel("title", { exact: true }),
      ).toHaveAttribute("readonly", "");
      const key = await confirmation
        .getByLabel("Original submission key", { exact: true })
        .inputValue();
      const consent = confirmation.getByLabel(
        "I deliberately confirm this exact invented rehearsal schedule.",
        { exact: true },
      );
      await expect(consent).not.toBeChecked();
      await consent.check();
      await confirmation
        .getByRole("button", {
          name: "Schedule private rehearsal",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Private rehearsal receipt",
          exact: true,
        }),
      ).toBeVisible();
      await expect(admin.locator("body")).not.toContainText(key);
      const link = admin.getByRole("link", {
        name: "Open member event detail with your learner access",
        exact: true,
      });
      const detailPath = await link.getAttribute("href");
      if (!detailPath) throw Error("Missing scheduled member reference");
      const eventId = detailPath.split("/")[2]!;
      await page.goto(origin + "/events");
      await expect(page.locator(`a[href="${detailPath}"]`)).toBeVisible();
      await page.locator(`a[href="${detailPath}"]`).click();
      await expect(page.locator("body")).toContainText(startsAt);
      await expect(
        page.getByRole("link", {
          name: "Try local registration rehearsal",
          exact: true,
        }),
      ).toHaveAttribute("href", `${detailPath}/rehearsal`);
      await page
        .getByRole("link", {
          name: "Try local registration rehearsal",
          exact: true,
        })
        .click();
      const rehearsal = page.url();
      await page
        .getByLabel(
          "I want to save an invented-data registration; this is not a real appointment.",
        )
        .check();
      await page
        .getByRole("button", { name: "Enroll in local rehearsal", exact: true })
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
      await running.close();
      running = undefined;
      running = await start({
        ...environment,
        DNE_PORT: new URL(origin).port,
        DNE_LOCAL_EVENT_SCHEDULING: "disabled",
      });
      expect(running.origin).toBe(origin);
      await admin.goto(origin + base);
      await expect(admin.locator("body")).toContainText(
        "New scheduling is paused",
      );
      await expect(
        admin.getByRole("button", { name: "Check proposed schedule" }),
      ).toHaveCount(0);
      await page.goto(origin + detailPath);
      await expect(page.locator("body")).toContainText(startsAt);
      await expect(
        page.getByRole("link", {
          name: "Try local registration rehearsal",
          exact: true,
        }),
      ).toHaveAttribute("href", `${detailPath}/rehearsal`);
      await page.goto(receiptUrl);
      await expect(
        page.getByRole("heading", {
          name: "Private registration receipt",
          exact: true,
        }),
      ).toBeVisible();
      await admin.goto(origin + "/operator/event-cancellations");
      const cancelCheck = admin.locator(
        'form[action="/operator/event-cancellations/check"]',
      );
      await cancelCheck
        .getByLabel("Exact event ID", { exact: true })
        .fill(eventId);
      await cancelCheck.getByLabel("Exact version", { exact: true }).fill("1");
      await cancelCheck
        .getByRole("button", { name: "Check exact event" })
        .click();
      const cancelConsent = admin.getByLabel(
        "I confirm cancelling this exact invented event version.",
        { exact: true },
      );
      await expect(cancelConsent).not.toBeChecked();
      await cancelConsent.check();
      await admin
        .getByRole("button", { name: "Cancel this event version", exact: true })
        .click();
      await expect(admin.locator("body")).toContainText(
        "New registrations are closed",
      );
      await page.goto(receiptUrl);
      await expect(page.locator("body")).toContainText(/event cancelled/i);
      await peer.goto(rehearsal);
      await expect(
        peer.getByRole("button", { name: "Enroll in local rehearsal" }),
      ).toHaveCount(0);
      const exported = await (
        await page.request.get(origin + "/api/member/export")
      ).json();
      expect(exported.records.eventEnrollments).toHaveLength(1);
      expect(exported.records.eventEnrollments[0]).toMatchObject({
        id: receiptId,
        eventId,
        withdrawnAt: null,
      });
      expect(exported.records.eventEnrollments[0].cancelledAt).toBeTruthy();
      expect(JSON.stringify(exported)).not.toContain(key);
      expect(JSON.stringify(exported)).not.toContain(credential);
      await page
        .getByLabel(
          "Withdraw this exact sample registration and release its seat.",
        )
        .check();
      await page
        .getByRole("button", { name: "Withdraw registration", exact: true })
        .click();
      const withdrawn = await (
        await page.request.get(origin + "/api/member/export")
      ).json();
      expect(withdrawn.records.eventEnrollments[0].withdrawnAt).toBeTruthy();
      expect(withdrawn.records.eventEnrollments[0].cancelledAt).toBe(
        exported.records.eventEnrollments[0].cancelledAt,
      );
      const session = await store(pool).session(memberToken);
      if (session.kind !== "active") throw Error("Missing invented member");
      await store(pool).remove(session.learner.id);
      expect(
        (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
      ).toHaveLength(1);
      expect(
        await admin.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      for (const context of contexts) await context.close();
      if (running) await running.close();
      await pool.end();
      if (created) await control.query(`DROP DATABASE "${dbName}"`);
      await control.end();
      await rm(storage, { recursive: true, force: true });
    }
  });
}
test("[L191] REHSCHED-06 administrator manually recovers an actual committed schedule with a lost acknowledgement", async ({
  page,
}) => {
  test.setTimeout(60000);
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
    pool = new Pool({ connectionString: ownUrl.href });
  let recovery:
      Awaited<ReturnType<typeof startEventRehearsalRecoveryServer>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${dbName}"`);
    created = true;
    await migrate(pool);
    const credential = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      credential,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    recovery = await startEventRehearsalRecoveryServer(pool);
    await page.goto(recovery.origin + "/staff/sign-in");
    await page.getByLabel("Trusted local staff credential").fill(credential);
    await page
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    await page.goto(recovery.origin + base);
    await page
      .getByLabel("Start in UTC", { exact: true })
      .first()
      .fill(new Date(Date.now() + 3600000).toISOString());
    await page
      .getByRole("button", { name: "Check proposed schedule", exact: true })
      .click();
    const confirmation = page.locator(`form[action="${base}/schedule"]`);
    const key = await confirmation
      .getByLabel("Original submission key", { exact: true })
      .inputValue();
    await confirmation
      .getByLabel(
        "I deliberately confirm this exact invented rehearsal schedule.",
        { exact: true },
      )
      .check();
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith(base + "/schedule") &&
        reply.request().method() === "POST",
    );
    await confirmation
      .getByRole("button", { name: "Schedule private rehearsal", exact: true })
      .click();
    expect((await response).status()).toBe(503);
    await expect(
      page.getByRole("heading", {
        name: "Rehearsal scheduling needs attention",
        exact: true,
      }),
    ).toBeVisible();
    expect(recovery.observation).toEqual({
      schedulingCommits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    await page
      .getByText("Repeat the exact original instruction manually", {
        exact: true,
      })
      .click();
    const repeat = page.locator(`form[action="${base}/schedule"]`);
    await expect(
      repeat.getByLabel("Original submission key", { exact: true }),
    ).toHaveValue(key);
    await expect(
      repeat.getByLabel("Original submission key", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(
      repeat.getByLabel("I confirm repeating the exact original instruction.", {
        exact: true,
      }),
    ).not.toBeChecked();
    const popup = page.waitForEvent("popup");
    await page
      .getByRole("button", {
        name: "Inspect saved result in a new tab",
        exact: true,
      })
      .click();
    const inspected = await popup;
    await expect(
      inspected.getByRole("heading", {
        name: "Private rehearsal receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(inspected.locator("body")).not.toContainText(key);
    expect(new URL(inspected.url()).search).toBe("");
    await inspected.close();
    await repeat
      .getByLabel("I confirm repeating the exact original instruction.", {
        exact: true,
      })
      .check();
    await repeat
      .getByRole("button", { name: "Repeat original schedule", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Private rehearsal receipt",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);
    expect(recovery.observation).toEqual({
      schedulingCommits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    for (const table of [
      "private_event_inventory",
      "private_event_rehearsals",
      "private_event_rehearsal_operations",
    ])
      expect(
        (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0]
          .n,
      ).toBe(1);
  } finally {
    // Dispose this test's browser connections before waiting for its listener.
    // Node 24 can retain an unused preconnection while server.close() waits.
    await page.context().close();
    await recovery?.close();
    await pool.end();
    if (created) {
      // A lost-ack client leaves the pool before PostgreSQL necessarily sees
      // its socket close. Observe that disconnect instead of forcibly killing it.
      const until = performance.now() + 3000;
      let remaining = 1;
      while (remaining && performance.now() < until) {
        remaining = Number(
          (
            await control.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=$1",
              [dbName],
            )
          ).rows[0].n,
        );
        if (remaining) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(remaining).toBe(0);
      await control.query(`DROP DATABASE "${dbName}"`);
    }
    await control.end();
  }
});
