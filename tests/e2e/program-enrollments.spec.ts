import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { programEnrollmentFixture } from "../support/program-enrollment-recovery-server.ts";
import { COOKIE } from "../../src/session.ts";
import { PROGRAM_PATH } from "../../src/program-values.ts";

// Finite staff entry and one-use email capabilities never enter saved traces.
test.use({ trace: "off" });
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
async function account(page: Page, background: string, goal: string) {
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByRole("button", { name: "Start my learning path" }).click();
}
async function bearer(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  );
  if (!cookie) throw Error("Owned browser session missing");
  return cookie.value;
}
async function choose(page: Page, origin: string) {
  await page.goto(origin + PROGRAM_PATH);
  await page.getByLabel(/Choose this exact local program and term/).check();
  await page
    .getByRole("button", { name: "Choose local program", exact: true })
    .click();
}
async function confirm(page: Page) {
  await page
    .getByLabel(/Enroll this current account in the local simulation/)
    .check();
  await page
    .getByRole("button", { name: "Confirm local enrollment", exact: true })
    .click();
}
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${254 + index}] PROGRAM-01..03/05/15 ${background} explicitly enrolls, recovers saved work and inspects uncertain completion without replay`, async ({
    page,
    browser,
  }, info) => {
    const f = await programEnrollmentFixture();
    const contexts: BrowserContext[] = [];
    const device =
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]!
        : devices["Desktop Chrome"]!;
    async function otherPage() {
      const context = await browser.newContext(device);
      contexts.push(context);
      return context.newPage();
    }
    try {
      await f.publish();
      const admin = await f.staff("platform_admin");
      const operator = await otherPage();
      await operator.goto(f.origin + "/staff/sign-in");
      await operator
        .getByLabel("Trusted local staff credential")
        .fill(admin.token);
      await operator
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      await operator.goto(f.origin + "/operator/programs");
      await operator
        .getByLabel("Open this exact local inventory only.")
        .check();
      await operator
        .getByRole("button", { name: "Open local term", exact: true })
        .click();
      await expect(operator.getByText(/State: open/)).toBeVisible();

      await choose(page, f.origin);
      await expect(
        page.getByRole("heading", { name: "Return to your learning account" }),
      ).toBeVisible();
      await page
        .getByRole("link", {
          name: "create a new learning account deliberately",
        })
        .click();
      await account(page, background, goal);
      await expect(page).toHaveURL(f.origin + PROGRAM_PATH + "/confirm");
      const newToken = await bearer(page);
      expect(await f.programs.mine(newToken)).toEqual({
        kind: "ready",
        value: null,
      });
      await confirm(page);
      await expect(
        page.getByRole("heading", { name: "My courses", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("No self-assessed activity recorded", { exact: false }),
      ).toHaveCount(6);
      await expect(
        page.getByText("Local enrollment simulation", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("new-student-my-courses.png"),
        fullPage: true,
      });
      const newReceipt = await f.programs.mine(newToken);
      await page.reload();
      expect(await f.programs.mine(newToken)).toEqual(newReceipt);

      const returning = await otherPage();
      await returning.goto(f.origin);
      await account(returning, background, goal);
      await expect(returning).toHaveURL(f.origin + "/learn");
      const originalToken = await bearer(returning);
      await returning
        .getByRole("link", { name: "Open lesson", exact: true })
        .click();
      const instruction = `Invented ${background} first work, kept on the same account.`;
      await returning.getByLabel("Your instruction to AI").fill(instruction);
      await returning
        .getByLabel("How will you check the result?")
        .fill("Compare the invented result with the exact source.");
      await returning
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      const originalWork = await f.members.withExerciseRead(
        originalToken,
        (rows) => rows,
      );
      expect(originalWork).toHaveLength(1);
      await returning.goto(f.origin + "/email/attach");
      const email = `program-${background}@example.com`;
      await returning.getByLabel("Email address").fill(email);
      await returning
        .getByRole("button", { name: "Send verification link" })
        .click();
      await expect.poll(() => f.state.delivered.length).toBe(1);
      await returning.goto(f.state.delivered[0]!.link);
      await returning
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        returning.getByRole("heading", { name: "Email linked" }),
      ).toBeVisible();
      await returning.context().clearCookies();
      await choose(returning, f.origin);
      await returning
        .getByRole("link", { name: "Recover existing saved learning" })
        .click();
      await returning.getByLabel("Email address").fill(email);
      await returning
        .getByRole("button", { name: "Send sign-in link" })
        .click();
      await expect.poll(() => f.state.delivered.length).toBe(2);
      await returning.goto(f.state.delivered[1]!.link);
      await returning
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(returning).toHaveURL(f.origin + PROGRAM_PATH + "/confirm");
      const recoveredToken = await bearer(returning);
      expect(recoveredToken !== originalToken).toBe(true);
      expect(await f.programs.mine(originalToken)).toEqual({ kind: "denied" });
      expect(await f.programs.mine(recoveredToken)).toEqual({
        kind: "ready",
        value: null,
      });
      expect(
        await f.members.withExerciseRead(recoveredToken, (rows) => rows),
      ).toEqual(originalWork);
      await confirm(returning);
      await expect(
        returning.getByRole("heading", { name: "My courses", exact: true }),
      ).toBeVisible();
      const receiptPath = await returning
        .getByRole("link", { name: "Download private enrollment JSON" })
        .getAttribute("href");
      if (!receiptPath) throw Error("Owned supplemental export link missing");
      expect((await page.request.get(f.origin + receiptPath)).status()).toBe(
        404,
      );
      const [download] = await Promise.all([
        returning.waitForEvent("download"),
        returning
          .getByRole("link", { name: "Download private enrollment JSON" })
          .click(),
      ]);
      expect(download.suggestedFilename()).toBe("program-enrollment.json");
      const file = await download.path();
      if (!file) throw Error("Owned browser download missing");
      const payload = JSON.parse(await readFile(file, "utf8"));
      expect(payload.programEnrollmentsVersion).toBe(1);
      expect(payload.enrollment.manifest.lessons).toHaveLength(6);
      expect(Object.keys(payload.enrollment).sort()).toEqual([
        "activity",
        "digest",
        "enrolledAt",
        "id",
        "manifest",
      ]);
      await expect(returning.locator("body")).toBeVisible();
      expect(
        await returning.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await returning.screenshot({
        path: info.outputPath("returning-student-retained-program.png"),
        fullPage: true,
      });
      await returning.goto(f.origin + "/lesson");
      await expect(returning.getByLabel("Your instruction to AI")).toHaveValue(
        instruction,
      );

      const uncertain = await otherPage();
      await choose(uncertain, f.origin);
      await uncertain
        .getByRole("link", {
          name: "create a new learning account deliberately",
        })
        .click();
      await account(uncertain, background, goal);
      f.state.fault = "commit_after";
      await confirm(uncertain);
      await expect(
        uncertain.getByRole("heading", { name: "Inspect local enrollment" }),
      ).toBeVisible();
      await expect(uncertain.getByRole("alert")).toContainText("unconfirmed");
      const writes = f.state.inserts;
      await uncertain
        .getByRole("button", {
          name: "Inspect original enrollment",
          exact: true,
        })
        .click();
      await expect(
        uncertain.getByRole("heading", { name: "My courses", exact: true }),
      ).toBeVisible();
      await uncertain.reload();
      expect(f.state.inserts).toBe(writes);
      expect(f.state.lostReplies).toBe(1);
      expect(f.state.rollbacksAfterCommit).toBe(0);

      const stale = await otherPage();
      await choose(stale, f.origin);
      await stale
        .getByRole("link", {
          name: "create a new learning account deliberately",
        })
        .click();
      await account(stale, background, goal);
      const staleToken = await bearer(stale);
      await operator.reload();
      await operator
        .getByLabel("Close this exact local inventory only.")
        .check();
      await operator
        .getByRole("button", { name: "Close local term", exact: true })
        .click();
      await expect(operator.getByText(/State: closed/)).toBeVisible();
      await confirm(stale);
      await expect(stale.getByRole("alert")).toContainText(
        "Enrollment was not accepted",
      );
      expect(await f.programs.mine(staleToken)).toEqual({
        kind: "ready",
        value: null,
      });
      expect(f.state.inserts).toBe(writes);
      await returning.goto(f.origin + "/my-courses");
      await expect(
        returning.getByText(/Current enrollment availability: closed/),
      ).toBeVisible();
      await returning.goto(f.origin + "/learn");
      await returning.getByLabel("Delete my local preview").check();
      await returning
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      await expect(
        returning.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      const erased = await returning.request.get(f.origin + receiptPath, {
        maxRedirects: 0,
      });
      expect(erased.status()).toBe(401);
      expect(erased.headers()["content-disposition"]).toBeUndefined();
      expect(await f.programs.mine(recoveredToken)).toEqual({ kind: "denied" });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await f.close();
    }
  });
}
