import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";

const pool = testPool();
const members = store(pool);
test.beforeAll(async () => {
  await migrate(pool);
});
test.afterAll(async () => {
  await pool.end();
});

test("[L213] email verification restores the exact saved member in another browser", async ({
  page,
  browser,
}) => {
  const token = randomBytes(32).toString("hex");
  const emailAddress = `member-${token.slice(0, 12)}@example.com`;
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Synthetic member was not created");
  await members.save(token, {
    revision: 0,
    instruction: "My invented learning plan has three careful steps.",
    verification: "I will compare each invented detail with the source.",
    complete: true,
  });
  let origin = "http://127.0.0.1:0";
  const messages: { address: string; link: string }[] = [];
  const email = memberEmailAccess(
    pool,
    {
      async send(address, link) {
        messages.push({
          address,
          link: link.replace("http://127.0.0.1:0", origin),
        });
      },
    },
    origin,
  );
  let completedRequests = 0;
  const settings = {
    get origin() {
      return origin;
    },
    secret: "synthetic-browser-email-secret",
    memberEmail: {
      ...email,
      async requestAttach(token: string, address: string) {
        const result = await email.requestAttach(token, address);
        completedRequests++;
        return result;
      },
      async requestSignIn(address: string) {
        await email.requestSignIn(address);
        completedRequests++;
      },
    },
  };
  const server = await listenLoopback(app(members, settings));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Loopback address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  let returning;
  try {
    await page
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
    await page.goto(`${origin}/learn`);
    await expect(page.getByText("1 / 1")).toBeVisible();
    // MON-05/06: account access and browser-only state are visible at the top.
    await expect(page.locator(".dashboard-head")).toContainText("Signed in");
    await page.getByRole("link", { name: "My account", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "My account", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This browser only" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your starting point")).toHaveValue(
      "explorer",
    );
    await page
      .getByRole("link", { name: "Link an email", exact: true })
      .click();
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]?.address).toBe(emailAddress);
    await page.goto(`${origin}/email/attach`);
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(
      page.getByText(/wait 15 minutes before requesting again/),
    ).toBeVisible();
    await expect.poll(() => completedRequests).toBe(2);
    expect(messages).toHaveLength(1);
    const stale = await page.context().newPage();
    await stale.goto(`${origin}/email/attach`);
    await stale
      .getByLabel("Email address")
      .fill("different-invented@example.com");
    returning = await browser.newContext();
    const fresh = await returning.newPage();
    // MON-07: a returning visitor can find sign-in before starting another account.
    await fresh.goto(origin);
    await expect(
      fresh
        .locator("#main")
        .getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await fresh.goto(`${origin}/account`);
    await expect(fresh).toHaveURL(`${origin}/`);
    await expect(
      fresh.getByRole("heading", { name: "My account", exact: true }),
    ).toHaveCount(0);
    await fresh.goto(messages[0]!.link);
    await expect(
      fresh.getByRole("heading", { name: "Confirm email link" }),
    ).toBeVisible();
    await fresh.getByRole("button", { name: "Continue" }).click();
    await expect(
      fresh.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();
    // EMAIL-ACCESS-05A/B: only the owning session sees linked status; its
    // previously opened attachment form cannot request another message.
    await page.goto(`${origin}/learn`);
    await page.getByRole("link", { name: "Email access" }).click();
    await expect(
      page.getByRole("heading", { name: "Email already linked" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Email sign-in" }),
    ).toHaveAttribute("href", "/email/sign-in");
    await stale.getByRole("button", { name: "Send verification link" }).click();
    await expect(
      stale.getByRole("heading", { name: "Email already linked" }),
    ).toBeVisible();
    await expect(stale.getByLabel("Email address")).toHaveCount(0);
    expect(completedRequests).toBe(2);
    expect(messages).toHaveLength(1);
    await stale.close();
    await page.screenshot({
      path: `artifacts/email-owned-status-${test.info().project.name}.png`,
      fullPage: true,
    });
    await fresh.goto(`${origin}/email/sign-in`);
    await fresh.getByLabel("Email address").fill(emailAddress);
    await fresh.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => messages.length).toBe(2);
    await fresh.goto(`${origin}/email/sign-in`);
    await fresh.getByLabel("Email address").fill(emailAddress);
    await fresh.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(
      fresh.getByText(/wait 15 minutes before requesting again/),
    ).toBeVisible();
    await expect.poll(() => completedRequests).toBe(4);
    expect(messages).toHaveLength(2);
    await fresh.goto(messages[1]!.link);
    await fresh.getByRole("button", { name: "Continue" }).click();
    await expect(fresh).toHaveURL(`${origin}/learn`);
    await expect(fresh.getByText("1 / 1")).toBeVisible();
    await expect(fresh.locator(".dashboard-head")).toContainText("Signed in");
    await fresh.getByRole("link", { name: "My account", exact: true }).click();
    await expect(
      fresh.getByRole("heading", { name: "Verified email linked" }),
    ).toBeVisible();
    await expect(
      fresh.getByRole("link", { name: "Link an email", exact: true }),
    ).toHaveCount(0);
    await expect(fresh.getByLabel("Your starting point")).toHaveValue(
      "explorer",
    );
    await expect(
      fresh.locator('select[name="goal"], input[name="goal"]:checked'),
    ).toHaveValue("everyday");
    await expect(fresh.getByText(emailAddress)).toHaveCount(0);
    // ACCT-PLAIN-01: the checkbox follows its heading, with no second divider.
    // ERASE-06 (#40): what stays after deletion sits between them, without gaps.
    const deleteHeading = (await fresh
      .getByRole("heading", { name: "Delete your account", exact: true })
      .boundingBox())!;
    // #846 ACCOUNT-01: two periods beside the control, the full list one
    // click away, still ahead of the confirmation.
    const summary = (await fresh.locator(".account-delete > p").boundingBox())!;
    const deletionKept = (await fresh
      .locator(".account-delete .deletion-details")
      .boundingBox())!;
    const deleteCheck = (await fresh
      .locator(".account-delete .check")
      .boundingBox())!;
    expect(
      summary.y - (deleteHeading.y + deleteHeading.height),
    ).toBeLessThanOrEqual(24);
    expect(deletionKept.y - (summary.y + summary.height)).toBeLessThanOrEqual(
      24,
    );
    expect(
      deleteCheck.y - (deletionKept.y + deletionKept.height),
    ).toBeLessThanOrEqual(24);
    await expect(fresh.locator(".account-delete > p")).toHaveText(
      "This cannot be undone. Issued invoices stay for 6 years for tax records, and backup copies for up to 30 days.",
    );
    await expect(fresh.locator("#deletion-kept")).toBeHidden();
    await fresh.getByText("What stays after deletion").click();
    await expect(
      fresh.locator("#deletion-kept").getByRole("listitem"),
    ).toHaveCount(5);
    await fresh.getByText("What stays after deletion").click();
    await expect(fresh.locator(".account-delete .delete-form")).toHaveCSS(
      "border-top-style",
      "none",
    );
    // ACCT-LAYOUT-01/02: phones read one column with one left edge; wide
    // screens use the page width, with the profile beside email and sign-out.
    const box = async (name: string) =>
      (await fresh.getByRole("heading", { name, exact: true }).boundingBox())!;
    const title = await box("My account"),
      email = await box("Verified email linked"),
      data = await box("Your data"),
      profile = await box("Your learning profile");
    // #846 ACCOUNT-01: the header signs out; the page has no second control.
    await expect(
      fresh.locator("#main").getByText("Sign out", { exact: false }),
    ).toHaveCount(0);
    const accountWidth = (await fresh.locator(".account-page").boundingBox())!
      .width;
    expect(new Set([title.x, email.x, data.x]).size).toBe(1);
    if (fresh.viewportSize()!.width >= 1000) {
      expect(accountWidth).toBeGreaterThan(1000);
      expect(profile.x).toBeGreaterThan(email.x + accountWidth / 3);
      expect(Math.abs(profile.y - email.y)).toBeLessThan(4);
      expect(data.y - email.y).toBeLessThan(400);
      // ACCT-PLAIN-01: the left column has no empty space before Delete, even
      // though the profile beside it is much taller.
      expect((await box("Delete your account")).y - data.y).toBeLessThan(250);
      // ACCT-LAYOUT-03/04: the intro uses the page width, so each paragraph
      // stays on one line and the account links share one row.
      const introLines = await fresh
        .locator(".account-intro > p:not(.eyebrow, .account-links)")
        .evaluateAll((paragraphs) =>
          paragraphs.map(
            (paragraph) =>
              paragraph.getBoundingClientRect().height /
              parseFloat(getComputedStyle(paragraph).lineHeight),
          ),
        );
      expect(introLines.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...introLines)).toBeLessThan(1.5);
      // #846 ACCOUNT-01: the header carries the destinations; no button row.
      await expect(fresh.locator(".account-links")).toHaveCount(0);
    } else {
      // #846 ACCOUNT-01: who you are, the profile, then your data.
      expect(profile.x).toBe(title.x);
      expect(profile.y).toBeGreaterThan(email.y);
      expect(data.y).toBeGreaterThan(profile.y);
    }
    expect(
      await fresh.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await fresh.screenshot({
      path: `artifacts/member-account-${test.info().project.name}.png`,
      fullPage: true,
    });
    await fresh
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Learning", exact: true })
      .click();
    // #846 PROFILE-01: the learning page has no delete form or profile form.
    await expect(fresh.locator(".delete-form")).toHaveCount(0);
    await expect(
      fresh.getByRole("link", { name: "Change your learning profile" }),
    ).toHaveAttribute("href", "/account#profile");
    await fresh.getByRole("link", { name: "Review your work" }).click();
    await expect(
      fresh.getByText("My invented learning plan has three careful steps."),
    ).toBeVisible();
    // MULTISESSION-01 (#695): the first browser stays signed in too.
    expect((await members.session(token)).kind).toBe("active");
  } finally {
    await returning?.close();
    await closeLoopback(server);
  }
});
