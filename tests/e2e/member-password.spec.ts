import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { migrate, store } from "../../src/store.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";

const pool = testPool();
const members = store(pool);
test.beforeAll(() => migrate(pool));
test.afterAll(() => pool.end());

async function friendly(p: Page, step: string) {
  await p.waitForLoadState("load");
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${step} scrolls sideways`,
  ).toBe(true);
  const cramped = await p.evaluate(() =>
    [
      ...document.querySelectorAll(
        "main button, main a.button, main input:not([type=hidden]):not([type=checkbox]):not([type=radio])",
      ),
    ]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height < 40;
      })
      .map((e) => e.outerHTML.slice(0, 90)),
  );
  expect(cramped, `${step} has controls under 40px`).toEqual([]);
  await p.screenshot({
    path: test.info().outputPath(`${step}.png`),
    fullPage: true,
  });
}

test("[L285] PWD-01/02/06 a verified member sets a password, signs out and signs back in with it", async ({
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  const address = `password-${token.slice(0, 12)}@example.com`;
  const password = "invented browser passphrase 2026";
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  await members.save(token, {
    revision: 0,
    instruction: "My invented password-return plan.",
    verification: "Compare every invented detail.",
    complete: false,
  });
  let origin = "http://127.0.0.1:0";
  const links: string[] = [];
  const email = memberEmailAccess(
    pool,
    {
      async send(_to, link) {
        links.push(link.replace("http://127.0.0.1:0", origin));
      },
    },
    origin,
  );
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-browser-password-secret",
      memberEmail: email,
      memberPassword: memberPasswordAccess(pool),
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string") throw Error("No loopback");
  origin = `http://127.0.0.1:${binding.port}`;
  try {
    await page
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
    await page.goto(`${origin}/account`);
    await page
      .getByRole("link", { name: "Link an email", exact: true })
      .click();
    await page.getByLabel("Email address").fill(address);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect.poll(() => links.length).toBe(1);
    await page.goto(links[0]!);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();

    await page.goto(`${origin}/account`);
    await page
      .getByRole("link", { name: "Password sign-in", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Choose a password" }),
    ).toBeVisible();
    await friendly(page, "password-choose");
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password").fill(`${password}x`);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("alert")).toContainText("do not match");
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password").fill(password);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(
      page.getByRole("heading", { name: "Password set" }),
    ).toBeVisible();

    await page.goto(`${origin}/account`);
    await page
      .locator("form[action='/account/sign-out']")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();

    await page.goto(`${origin}/email/sign-in`);
    await friendly(page, "sign-in-choices");
    const form = page.locator("form[action='/password/sign-in']");
    await form.getByLabel("Email address").fill(address);
    await form
      .getByLabel("Password", { exact: true })
      .fill("not the invented passphrase");
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Email or password is incorrect",
    );
    await friendly(page, "sign-in-refused");
    const retry = page.locator("form[action='/password/sign-in']");
    await retry.getByLabel("Email address").fill(address.toUpperCase());
    await retry.getByLabel("Password", { exact: true }).fill(password);
    await retry.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${origin}/learn`);
    await page.goto(`${origin}/account`);
    await expect(
      page.getByRole("heading", { name: "My account", exact: true }),
    ).toBeVisible();
    expect(await members.progress(session.learner.id)).toMatchObject({
      instruction: "My invented password-return plan.",
    });
    expect((await members.session(token)).kind).not.toBe("active");
  } finally {
    await closeLoopback(server);
    await pool.query("DELETE FROM principals WHERE id=$1", [
      session.learner.id,
    ]);
  }
});

test("[L286] SIGNUP-01/02/04/06 a visitor signs up with email and password, signs back in at once and verifies later", async ({
  page,
}) => {
  const address = `signup-${randomBytes(6).toString("hex")}@example.com`;
  const password = "invented signup passphrase 2026";
  let origin = "http://127.0.0.1:0";
  const links: string[] = [];
  let deliver: (() => void) | undefined;
  const email = memberEmailAccess(
    pool,
    {
      async send(_to, link) {
        // A slow provider: the visitor never waits for this.
        await new Promise<void>((resolve) => (deliver = resolve));
        links.push(link.replace("http://127.0.0.1:0", origin));
      },
    },
    origin,
  );
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-browser-signup-secret",
      memberEmail: email,
      memberPassword: memberPasswordAccess(pool),
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string") throw Error("No loopback");
  origin = `http://127.0.0.1:${binding.port}`;
  let id: string | undefined;
  try {
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented Signup");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    // #12 Hosted signup is offered to people living in Canada for now.
    await page.getByLabel("Country where you live").selectOption("CA");
    await page.getByLabel("Email address").fill(address);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    // The browser itself holds a too-short password on the form.
    await expect(page).toHaveURL(`${origin}/`);
    expect(
      await page
        .getByLabel("Password", { exact: true })
        .evaluate((input: HTMLInputElement) => input.validity.valid),
    ).toBe(false);
    await expect(page.getByLabel("Display name")).toHaveValue(
      "Invented Signup",
    );
    await expect(page.getByLabel("Country where you live")).toHaveValue("CA");
    await friendly(page, "signup-correction");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(`${origin}/learn`);
    const token = (await page.context().cookies()).find(
      (c) => c.name === "dne_preview",
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Signup did not sign in");
    id = session.learner.id;

    await page.goto(`${origin}/account`);
    await expect(
      page.getByRole("heading", { name: "Email not yet verified" }),
    ).toBeVisible();
    await friendly(page, "signup-account-unverified");
    await page
      .locator("form[action='/account/sign-out']")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();

    const form = page.locator("form[action='/password/sign-in']");
    await page.goto(`${origin}/email/sign-in`);
    await form.getByLabel("Email address").fill(address);
    await form.getByLabel("Password", { exact: true }).fill(password);
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${origin}/learn`);

    // The verification email arrives later and still verifies this account.
    await expect.poll(() => deliver !== undefined).toBe(true);
    deliver!();
    await expect.poll(() => links.length).toBe(1);
    await page.goto(links[0]!);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();
    await page.goto(`${origin}/account`);
    await expect(
      page.getByRole("heading", { name: "Verified email linked" }),
    ).toBeVisible();
  } finally {
    deliver?.();
    await closeLoopback(server);
    if (id) await pool.query("DELETE FROM principals WHERE id=$1", [id]);
  }
});
