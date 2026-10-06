import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  members = store(pool);
// Staff sign-in sends a protected local credential; do not retain network traces.
test.use({ trace: "off" });
test.afterAll(() => pool.end());
async function signIn(page: Page, credential: string) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
const audiences = [
  ["professional", "work"],
  ["technical", "build"],
  ["explorer", "everyday"],
] as const;
for (const [index, [background, goal]] of audiences.entries())
  test(`[L${174 + index}] SUPADM-01-REFERENCES SUPADM-02-ASSIGN SUPADM-04-REVOKE ${background} actual private browser assignment retains the learner`, async ({
    page,
  }) => {
    const ids: string[] = [],
      admin = randomBytes(32).toString("hex"),
      operator = randomBytes(32).toString("hex"),
      expires = new Date(Date.now() + 3600000);
    try {
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const owner = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!.value;
      const member = await members.session(owner);
      if (member.kind !== "active") throw Error("Missing invented learner");
      ids.push(member.learner.id);
      await page.getByRole("link", { name: "Open lesson" }).click();
      await page
        .getByLabel("Your instruction to AI")
        .fill(
          "Use the invented details to make a short plan and flag any gaps.",
        );
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Check every action against the invented source and remove unsupported claims.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      await page.goto("/support/new");
      await page
        .getByLabel("Subject (up to 120 characters)")
        .fill("Private invented assignment request");
      await page
        .getByLabel("Your sample request (up to 2,000 characters)")
        .fill("PRIVATE-ASSIGNMENT-BROWSER-CONTENT");
      await page
        .getByLabel(
          "I used only invented or sample information and want to send this private request.",
        )
        .check();
      await page
        .getByRole("button", { name: "Send private sample request" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Private sample support receipt",
          exact: true,
        }),
      ).toBeVisible();
      const requestId = (
        await page
          .locator("dt")
          .filter({ hasText: /^Request receipt$/ })
          .locator("xpath=following-sibling::dd[1]")
          .innerText()
      ).trim();
      expect(new URL(page.url()).pathname).toBe(`/support/${requestId}`);
      await expect(page.getByText(requestId, { exact: true })).toBeVisible();
      const adminId = await auth.provisionStaff(
          admin,
          "platform_admin",
          expires,
        ),
        staffId = await auth.provisionStaff(operator, "operator", expires);
      ids.push(staffId, adminId);
      await signIn(page, operator);
      await expect(
        page.getByRole("link", { name: "My local assignment ID", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "My local assignment ID", exact: true })
        .click();
      const displayedStaffId = (
        await page.locator("[data-assignment-id]").innerText()
      ).trim();
      expect(displayedStaffId).toBe(staffId);
      await expect(
        page.getByText(expires.toISOString(), { exact: true }),
      ).toBeVisible();
      await signIn(page, admin);
      await page
        .getByRole("link", { name: "Support request assignments", exact: true })
        .click();
      await page.getByLabel("Exact request receipt ID").fill(requestId);
      await page
        .getByLabel("Exact operator assignment ID")
        .fill(displayedStaffId);
      await page
        .getByRole("button", { name: "Check exact references", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Confirm support assignment",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText(
        "PRIVATE-ASSIGNMENT-BROWSER-CONTENT",
      );
      await page
        .getByLabel("Starts at (UTC)")
        .fill(new Date(Date.now() - 60000).toISOString());
      await page
        .getByLabel("Expires at (UTC)")
        .fill(new Date(+expires - 1000).toISOString());
      await page
        .getByLabel(
          "I confirm this exact request, operator and finite UTC window.",
        )
        .check();
      await page
        .getByRole("button", { name: "Assign this request", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Support assignment recorded",
          exact: true,
        }),
      ).toBeVisible();
      const grantId = await page.locator("[data-assignment-grant]").innerText();
      await signIn(page, operator);
      await page
        .getByRole("link", {
          name: "Your granted support requests",
          exact: true,
        })
        .click();
      await page
        .locator(`a[href="/operator/support/${requestId}?grant=${grantId}"]`)
        .click();
      await expect(page.locator("body")).toContainText(
        "PRIVATE-ASSIGNMENT-BROWSER-CONTENT",
      );
      await signIn(page, admin);
      await page.goto(
        `/operator/support-assignment/history?requestId=${requestId}`,
      );
      const grant = page.locator(`[data-grant="${grantId}"]`);
      await grant
        .getByLabel("I confirm revoking this exact grant only.")
        .check();
      await grant
        .getByRole("button", { name: "Revoke this grant", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Support assignment revoked",
          exact: true,
        }),
      ).toBeVisible();
      await signIn(page, operator);
      const denied = await page.goto(
        `/operator/support/${requestId}?grant=${grantId}`,
      );
      expect(denied!.status()).toBe(403);
      await expect(page.locator("body")).not.toContainText(
        "PRIVATE-ASSIGNMENT-BROWSER-CONTENT",
      );
      await page.goto("/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      expect(
        (await page.context().cookies()).find((c) => c.name === COOKIE)!.value,
      ).toBe(owner);
    } finally {
      for (const id of ids)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
