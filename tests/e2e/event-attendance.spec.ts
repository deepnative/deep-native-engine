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
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
// Staff credentials must not appear in retained network traces.
async function dropOwnedDatabase(control: Pool, name: string) {
  const active = (
    await control.query(
      "SELECT COUNT(*)::integer count FROM pg_stat_activity WHERE datname=$1",
      [name],
    )
  ).rows[0].count;
  if (active !== 0)
    throw Error("Owned browser database still active; no forced deletion");
  await control.query(`DROP DATABASE "${name}"`);
}

test.use({ trace: "off" });
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
  await page
    .getByRole("button", { name: "Start my learning path", exact: true })
    .click();
}
test("[L197] ATTEND-01/02/03/04/07/08 three audiences deliberately permit genuine-window presence, retain withdrawal and remove their own observation", async ({
  browser,
}, info) => {
  // The actual trusted scheduler requires at least two minutes of lead time.
  test.setTimeout(240000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const name = `dne_test_${randomBytes(16).toString("hex")}`,
    adminUrl = new URL(original),
    ownUrl = new URL(original);
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href }),
    storage = await mkdtemp(join(tmpdir(), "dne490-browser-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
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
    DNE_EVENT_ATTENDANCE: "enabled",
  };
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    running = await start(environment);
    const origin = running.origin,
      device =
        info.project.name === "mobile-chromium"
          ? devices["Pixel 7"]
          : devices["Desktop Chrome"];
    const staffContext = await browser.newContext(device);
    contexts.push(staffContext);
    const staff = await staffContext.newPage(),
      credential = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      credential,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    await staff.goto(origin + "/staff/sign-in");
    await staff.getByLabel("Trusted local staff credential").fill(credential);
    await staff
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    await staff
      .getByRole("link", { name: "Private rehearsal attendance", exact: true })
      .click();
    const administrator = await staff.locator("code").innerText();
    expect(administrator).toMatch(/^[a-f0-9-]{36}$/);
    expect(administrator).not.toBe(credential);
    const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
      .now as Date;
    const startsAt = new Date(+now + 150000).toISOString();
    const owners: {
      page: Page;
      receipt: string;
      permission: string;
      registration: string;
    }[] = [];
    for (const [background, goal] of [
      ["technical", "build"],
      ["professional", "work"],
      ["explorer", "everyday"],
    ]) {
      const context = await browser.newContext(device);
      contexts.push(context);
      const page = await context.newPage();
      await onboard(page, origin, background!, goal!);
      await staff.goto(origin + "/staff");
      await staff
        .getByRole("link", {
          name: "Schedule a private rehearsal",
          exact: true,
        })
        .click();
      const scheduling = staff.locator(
        'form[action="/operator/event-rehearsals/check"]',
      );
      await scheduling
        .getByLabel("Start in UTC", { exact: true })
        .fill(startsAt);
      await scheduling
        .getByRole("button", { name: "Check proposed schedule", exact: true })
        .click();
      const schedule = staff.getByLabel(
        "I deliberately confirm this exact invented rehearsal schedule.",
        { exact: true },
      );
      await expect(schedule).not.toBeChecked();
      await schedule.check();
      await staff
        .getByRole("button", {
          name: "Schedule private rehearsal",
          exact: true,
        })
        .click();
      const detail = await staff
        .getByRole("link", {
          name: "Open member event detail with your learner access",
          exact: true,
        })
        .getAttribute("href");
      if (!detail) throw Error("Missing normal scheduled event link");
      await page.goto(origin + detail);
      await page
        .getByRole("link", {
          name: "Try local registration rehearsal",
          exact: true,
        })
        .click();
      const enroll = page.getByLabel(
        "I want to save an invented-data registration; this is not a real appointment.",
        { exact: true },
      );
      await expect(enroll).not.toBeChecked();
      await enroll.check();
      await page
        .getByRole("button", { name: "Enroll in local rehearsal", exact: true })
        .click();
      const registration = new URL(page.url()).pathname.split("/").at(-1)!;
      await page
        .getByRole("link", {
          name: "My private attendance receipt",
          exact: true,
        })
        .click();
      const receipt = page.url();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "No observation recorded." }),
      ).toBeVisible();
      await page
        .getByLabel("Selected administrator reference", { exact: true })
        .fill(administrator);
      await page
        .getByRole("button", {
          name: "Check attendance permission",
          exact: true,
        })
        .click();
      const consent = page.getByLabel(
        "Permit only this selected administrator to record a present observation for this exact registration during this window.",
        { exact: true },
      );
      await expect(consent).not.toBeChecked();
      await consent.check();
      await page
        .getByRole("button", {
          name: "Save this attendance permission",
          exact: true,
        })
        .focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("link", { name: "Open my attendance receipt", exact: true })
        .click();
      const permission = await page.locator("code").innerText();
      owners.push({ page, receipt, permission, registration });
    }
    // Early admission is denied by the actual database clock, not a changed fixture date.
    await staff.goto(origin + "/operator/event-attendance");
    await staff
      .getByLabel("Member-supplied permission reference", { exact: true })
      .fill(owners[0]!.permission);
    await staff
      .getByRole("button", {
        name: "Check exact attendance permission",
        exact: true,
      })
      .click();
    await expect(
      staff.getByRole("heading", {
        name: "Attendance needs attention",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      staff.getByRole("button", {
        name: "Record present observation",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          +(await pool.query("SELECT clock_timestamp() AS now")).rows[0].now,
        { timeout: 160000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(Date.parse(startsAt));
    for (const owner of owners) {
      await staff.goto(origin + "/staff");
      await staff
        .getByRole("link", {
          name: "Private rehearsal attendance",
          exact: true,
        })
        .click();
      await staff
        .getByLabel("Member-supplied permission reference", { exact: true })
        .fill(owner.permission);
      await staff
        .getByRole("button", {
          name: "Check exact attendance permission",
          exact: true,
        })
        .click();
      const observed = staff.getByLabel(
        "I personally observed this member present in this exact invented local rehearsal. This is not a qualified assessment.",
        { exact: true },
      );
      await expect(observed).not.toBeChecked();
      await observed.check();
      await staff
        .getByRole("button", {
          name: "Record present observation",
          exact: true,
        })
        .focus();
      await staff.keyboard.press("Enter");
      await expect(staff.getByRole("status")).toContainText(
        "Present observation recorded at",
      );
      await owner.page.goto(owner.receipt);
      await expect(
        owner.page
          .getByRole("status")
          .filter({ hasText: "Present observation recorded" }),
      ).toContainText("Local platform administrator");
      const ownExport = await (
        await owner.page.request.get(origin + "/api/member/export")
      ).json();
      expect(ownExport.records.eventAttendanceObservations).toHaveLength(1);
      expect(ownExport.records.eventAttendancePermissions).toHaveLength(1);
      expect(JSON.stringify(ownExport)).not.toContain(administrator);
      await owner.page
        .getByRole("link", {
          name: "My private attendance history",
          exact: true,
        })
        .click();
      await expect(owner.page.locator("body")).toContainText(
        "Present observation recorded",
      );
      const foreign = owners.find((x) => x !== owner)!;
      expect((await foreign.page.request.get(owner.receipt)).status()).toBe(
        403,
      );
      await owner.page.goto(owner.receipt);
      const withdrawal = owner.page.getByLabel(
        "Withdraw this attendance permission. Keep my registration and any saved observation.",
        { exact: true },
      );
      await expect(withdrawal).not.toBeChecked();
      await withdrawal.check();
      await owner.page
        .getByRole("button", {
          name: "Withdraw attendance permission",
          exact: true,
        })
        .click();
      await owner.page
        .getByRole("link", { name: "Open my attendance receipt", exact: true })
        .click();
      await expect(owner.page.locator("body")).toContainText(
        "Attendance sharing withdrawn.",
      );
      await expect(owner.page.locator("body")).toContainText(
        "Present observation recorded",
      );
      await staff.goto(origin + "/operator/event-attendance");
      await staff
        .getByLabel("Inspect an existing permission", { exact: true })
        .fill(owner.permission);
      await staff
        .getByRole("button", { name: "Inspect permitted scope", exact: true })
        .click();
      await expect(
        staff.getByRole("heading", {
          name: "Attendance needs attention",
          exact: true,
        }),
      ).toBeVisible();
      await owner.page
        .getByRole("button", {
          name: "Check removal of my observation",
          exact: true,
        })
        .click();
      const remove = owner.page.getByLabel(
        "Remove my exact private observation and its attendance permission links.",
        { exact: true },
      );
      await expect(remove).not.toBeChecked();
      await remove.check();
      await owner.page
        .getByRole("button", { name: "Remove my observation", exact: true })
        .focus();
      await owner.page.keyboard.press("Enter");
      await owner.page
        .getByRole("link", { name: "Open my attendance receipt", exact: true })
        .click();
      await expect(owner.page.locator("body")).toContainText(
        "No observation recorded.",
      );
      await expect(owner.page.locator("body")).toContainText(
        "No attendance permission saved.",
      );
      const removed = await (
        await owner.page.request.get(origin + "/api/member/export")
      ).json();
      expect(removed.records.eventAttendanceObservations).toHaveLength(0);
      expect(removed.records.eventAttendancePermissions).toHaveLength(0);
      expect(removed.records.eventEnrollments).toHaveLength(1);
      expect(removed.records.eventEnrollments[0].id).toBe(owner.registration);
      expect(
        await owner.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(
      await staff.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    for (const context of contexts) await context.close();
    if (running) await running.close();
    await pool.end();
    if (created) {
      await dropOwnedDatabase(control, name);
    }
    await control.end();
    await rm(storage, { recursive: true, force: true });
  }
});
