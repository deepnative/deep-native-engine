import {
  test,
  expect,
  devices,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { start } from "../../src/runtime.ts";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
// Trusted bootstrap credentials never enter retained network traces/captures.
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
async function explicitConfirmation(page: Page, kind: string) {
  const checkbox = page.getByRole("checkbox", {
    name: `I explicitly confirm this exact ${kind} instruction.`,
    exact: true,
  });
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("button", { name: `Confirm ${kind}`, exact: true })
    .click();
}
test("[L199] TESTISSUE-01/02/03/05/08 three audiences request, receive, use and withdraw finite study fixtures through normal member/admin browsers", async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const adminUrl = new URL(original),
    ownUrl = new URL(original),
    name = `dne_test_${randomBytes(16).toString("hex")}`;
  adminUrl.pathname = "/postgres";
  ownUrl.pathname = `/${name}`;
  const control = new Pool({ connectionString: adminUrl.href }),
    pool = new Pool({ connectionString: ownUrl.href });
  const storage = await mkdtemp(join(tmpdir(), "dne494-browser-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    running = await start({
      DNE_DATABASE_URL: ownUrl.href,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_STAFF_ENTRY: "enabled",
      DNE_LOCAL_TEST_UNIT_ISSUANCE: "enabled",
    });
    const origin = running.origin;
    const device =
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
      .getByRole("link", { name: "Issue local study test units", exact: true })
      .click();
    const administratorId = await staff.locator("code").innerText();
    expect(administratorId).not.toBe(credential);
    for (const [background, goal] of [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ]) {
      const context = await browser.newContext(device);
      contexts.push(context);
      const page = await context.newPage();
      await onboard(page, origin, background!, goal!);
      await page.goto(origin + "/member/test-units");
      const row = page.locator('[data-test-unit-category="study_requests"]');
      await expect(row.locator('[data-field="usable"]')).toHaveText("0");
      await page
        .getByRole("link", {
          name: "Request or withdraw your one-time local study fixture",
          exact: true,
        })
        .click();
      await page.getByLabel("Administrator reference").fill(administratorId);
      await page
        .getByRole("button", { name: "Review request", exact: true })
        .click();
      await explicitConfirmation(page, "request");
      await expect(
        page.getByRole("heading", {
          name: "Saved local test fixture",
          exact: true,
        }),
      ).toBeVisible();
      const requestId = await page
        .locator("dt")
        .filter({ hasText: /^Request reference$/ })
        .locator("+ dd")
        .innerText();
      await staff.goto(origin + "/operator/study-test-units");
      await staff
        .getByLabel("Member-supplied request reference")
        .fill(requestId);
      await staff
        .getByRole("button", { name: "Review exact request", exact: true })
        .click();
      await explicitConfirmation(staff, "issue");
      await page
        .getByRole("link", { name: "Current local balances", exact: true })
        .click();
      await expect(row.locator('[data-field="usable"]')).toHaveText("3");
      const title = `Invented-study-${randomUUID()}.txt`;
      await page.goto(origin + "/evidence");
      await page.getByLabel("Sample title").fill(title);
      await page
        .getByLabel("Invented text sample")
        .fill(
          "An invented team checks each action against its original sample notes.",
        );
      await page.getByLabel("I created this invented sample").check();
      await page.getByLabel("I explicitly allow this sample").check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const id = (
        await pool.query(
          "SELECT id FROM evidence_objects WHERE original_name=$1",
          [title],
        )
      ).rows[0].id;
      // Existing deterministic invented-source quarantine boundary; never seed
      // fixture requests, grants, balances or jobs to manufacture this flow.
      await evidenceStore(
        pool,
        fileObjectStorage(storage),
        "invented-browser-fixture",
      ).transitionQuarantine(id, "clean");
      await page.goto(origin + "/evidence/local-ai");
      const item = page.locator("li").filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      });
      await item
        .getByLabel("I permit this exact invented sample version")
        .check();
      await item
        .getByRole("button", { name: "Grant local simulation permission" })
        .click();
      await item.getByLabel("Hold one existing local test request").check();
      await item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await expect(
        item.getByText("One local test request: held.", { exact: true }),
      ).toBeVisible();
      await item
        .getByRole("button", { name: "Run local test request" })
        .click();
      await expect(
        item.getByText("One local test request: consumed.", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        item.getByText("One local test request: consumed.", { exact: true }),
      ).toBeVisible();
      await page.goto(origin + "/member/test-unit-request");
      await page
        .getByRole("button", { name: "Review fixture withdrawal", exact: true })
        .click();
      await explicitConfirmation(page, "withdraw");
      await expect(
        page
          .locator("dt")
          .filter({ hasText: /^State$/ })
          .locator("+ dd"),
      ).toHaveText("withdrawn");
      await page
        .getByRole("link", { name: "Current local balances", exact: true })
        .click();
      await expect(row.locator('[data-field="usable"]')).toHaveText("0");
      await expect(row.locator('[data-field="consumed"]')).toHaveText("1");
      await expect(row.locator('[data-field="expired"]')).toHaveText("2");
      await expect(row.locator('[data-field="held"]')).toHaveText("0");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`study-fixture-${background}.png`),
        fullPage: true,
      });
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM browser_study_fixture_requests",
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
        )
      ).rows[0].n,
    ).toBe(3);
  } finally {
    for (const context of contexts) await context.close();
    await running?.close();
    await pool.end();
    if (created) {
      const active = (
        await control.query(
          "SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=$1",
          [name],
        )
      ).rows[0].n;
      expect(
        active,
        "Owned browser database remains active; do not force deletion",
      ).toBe(0);
      await control.query(`DROP DATABASE "${name}"`);
    }
    await control.end();
    await rm(storage, { recursive: true, force: true });
  }
});
