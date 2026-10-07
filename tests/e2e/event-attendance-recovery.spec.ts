import { test, expect, devices, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { startAttendanceRecoveryServer } from "../support/event-attendance-recovery-server.ts";
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
test("[L198] ATTEND-06/08 member deliberately inspects and repeats original permission after an actual committed lost reply, with pause retaining inspection", async ({
  page,
  browser,
}, info) => {
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Generated browser database required");
  const name = `dne_test_${randomBytes(16).toString("hex")}`,
    adminUrl = new URL(original),
    ownUrl = new URL(original);
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href });
  let running:
      Awaited<ReturnType<typeof startAttendanceRecoveryServer>> | undefined,
    staffContext: BrowserContext | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    const credential = randomBytes(32).toString("hex"),
      now = (await pool.query("SELECT clock_timestamp() now")).rows[0]
        .now as Date;
    await authorizationStore(pool).provisionStaff(
      credential,
      "platform_admin",
      new Date(+now + 3600000),
    );
    const scheduled = await eventRehearsalStore(pool, {
      mode: "test",
      writes: true,
      registration: true,
    }).schedule(
      credential,
      randomUUID(),
      rehearsalSnapshot({
        templateId: "local-registration-rehearsal",
        templateVersion: 1,
        startsAt: new Date(+now + 180000).toISOString(),
      }),
    );
    if (scheduled.kind !== "ready")
      throw Error("Genuine future trusted event required");
    running = await startAttendanceRecoveryServer(pool);
    const origin = running.origin;
    staffContext = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    const staff = await staffContext.newPage();
    await staff.goto(origin + "/staff/sign-in");
    await staff.getByLabel("Trusted local staff credential").fill(credential);
    await staff
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    await staff
      .getByRole("link", { name: "Private rehearsal attendance", exact: true })
      .click();
    const reference = await staff.locator("code").innerText();
    await page.goto(origin);
    await page.getByLabel("Your starting point").selectOption("professional");
    await page.getByLabel("What would you like to do?").selectOption("work");
    await page.getByLabel("I'll use invented or sample information").check();
    await page
      .getByRole("button", { name: "Start my learning path", exact: true })
      .click();
    await page.goto(`${origin}/events/${scheduled.value.receipt.eventId}/1`);
    await page
      .getByRole("link", {
        name: "Try local registration rehearsal",
        exact: true,
      })
      .click();
    await page
      .getByLabel(
        "I want to save an invented-data registration; this is not a real appointment.",
        { exact: true },
      )
      .check();
    await page
      .getByRole("button", { name: "Enroll in local rehearsal", exact: true })
      .click();
    await page
      .getByRole("link", { name: "My private attendance receipt", exact: true })
      .click();
    const receipt = page.url();
    await page
      .getByLabel("Selected administrator reference", { exact: true })
      .fill(reference);
    await page
      .getByRole("button", { name: "Check attendance permission", exact: true })
      .click();
    const confirmation = page.locator('form[action$="/permit"]'),
      key = await confirmation.locator('input[name="key"]').inputValue(),
      instruction = await confirmation
        .locator('input[name="checked"]')
        .inputValue();
    const consent = confirmation.getByLabel(
      "Permit only this selected administrator to record a present observation for this exact registration during this window.",
      { exact: true },
    );
    await expect(consent).not.toBeChecked();
    await consent.check();
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/permit") && r.request().method() === "POST",
    );
    await confirmation
      .getByRole("button", {
        name: "Save this attendance permission",
        exact: true,
      })
      .click();
    expect((await response).status()).toBe(503);
    expect(running.evidence).toEqual({ permissionCommits: 1, lostReplies: 1 });
    const recovery = page.locator('form[action$="/recover"]');
    await expect(recovery.locator('input[name="key"]')).toHaveValue(key);
    await expect(recovery.locator('input[name="checked"]')).toHaveValue(
      instruction,
    );
    await expect(recovery.getByRole("checkbox")).toHaveCount(0);
    const opened = page.context().waitForEvent("page");
    await recovery
      .getByRole("button", {
        name: "Inspect original result in a new tab",
        exact: true,
      })
      .focus();
    await page.keyboard.press("Enter");
    const inspection = await opened;
    await expect(inspection.getByRole("status")).toContainText(
      "Exact finite attendance permission saved.",
    );
    const before = (
      await pool.query(
        "SELECT id,created_at,expires_at FROM private_event_attendance_permissions",
      )
    ).rows;
    expect(before).toHaveLength(1);
    expect(running.evidence.permissionCommits).toBe(1);
    await inspection.close();
    // The original uncertain form remains available without replaying a POST via Back.
    await page
      .getByText("Repeat the original instruction manually", { exact: true })
      .click();
    const repeat = page.getByLabel(
      "I inspected saved state and choose to repeat the exact original instruction with its original recovery reference.",
      { exact: true },
    );
    await expect(repeat).not.toBeChecked();
    await repeat.check();
    await page
      .getByRole("button", { name: "Repeat original instruction", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Exact finite attendance permission saved.",
    );
    expect(running.evidence.permissionCommits).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT id,created_at,expires_at FROM private_event_attendance_permissions",
        )
      ).rows,
    ).toEqual(before);
    await running.pause();
    await page.goto(receipt);
    await expect(page.locator("body")).toContainText(
      "No observation recorded.",
    );
    await expect(
      page.getByRole("button", {
        name: "Check attendance permission",
        exact: true,
      }),
    ).toHaveCount(0);
    // Recover the same checked instruction with the fresh current CSRF after pause.
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const inspected = await page.request.post(receipt + "/recover", {
      form: { csrf, key, kind: "permit", checked: instruction },
      headers: { Origin: origin },
    });
    expect(inspected.status()).toBe(200);
    expect(await inspected.text()).toContain(
      "Exact finite attendance permission saved.",
    );
    expect(
      (
        await pool.query(
          "SELECT id,created_at,expires_at FROM private_event_attendance_permissions",
        )
      ).rows,
    ).toEqual(before);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await staffContext?.close();
    await running?.close();
    await pool.end();
    if (created) {
      await dropOwnedDatabase(control, name);
    }
    await control.end();
  }
});
