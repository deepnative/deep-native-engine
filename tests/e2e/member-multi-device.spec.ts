import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { migrate, store } from "../../src/store.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

// #695 MULTISESSION: each browser keeps its own sign-in. This spec owns a
// private database and drops it afterwards.
const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({ connectionString: root.toString() });
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({ connectionString: scoped.toString() });
const members = store(pool);
test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
test.afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});

async function signedIn(page: Page, origin: string) {
  await page.goto(`${origin}/account`);
  return (
    (await page
      .getByRole("heading", { name: "My account", exact: true })
      .count()) === 1
  );
}

async function device(browser: Browser, page: Page) {
  const context = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  return context.newPage();
}

test("[L329] MULTISESSION-01/02 each browser keeps its own sign-in through password, email link and sign-out", async ({
  page,
  browser,
}) => {
  const token = randomBytes(32).toString("hex");
  const address = `devices-${token.slice(0, 12)}@example.com`;
  const password = "invented multi-device passphrase 2026";
  await members.create(token, { background: "explorer", goal: "everyday" });
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
      secret: "synthetic-browser-multi-device-secret",
      memberEmail: email,
      memberPassword: memberPasswordAccess(pool),
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string") throw Error("No loopback");
  origin = `http://127.0.0.1:${binding.port}`;
  const laptop = page;
  const phone = await device(browser, page);
  const tablet = await device(browser, page);
  try {
    // The first browser links an email and chooses a password.
    await laptop
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
    await laptop.goto(`${origin}/account`);
    await laptop
      .getByRole("link", { name: "Link an email", exact: true })
      .click();
    await laptop.getByLabel("Email address").fill(address);
    await laptop
      .getByRole("button", { name: "Send verification link" })
      .click();
    await expect.poll(() => links.length).toBe(1);
    await laptop.goto(links[0]!);
    await laptop.getByRole("button", { name: "Continue" }).click();
    await expect(
      laptop.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();
    await laptop.goto(`${origin}/account`);
    await laptop
      .getByRole("link", { name: "Password sign-in", exact: true })
      .click();
    await laptop.getByLabel("New password", { exact: true }).fill(password);
    await laptop.getByLabel("Confirm new password").fill(password);
    await laptop.getByRole("button", { name: "Set password" }).click();
    await expect(
      laptop.getByRole("heading", { name: "Password set" }),
    ).toBeVisible();

    // A second browser signs in with the password.
    await phone.goto(`${origin}/email/sign-in`);
    const form = phone.locator("form[action='/password/sign-in']");
    await form.getByLabel("Email address").fill(address);
    await form.getByLabel("Password", { exact: true }).fill(password);
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(phone).toHaveURL(`${origin}/learn`);

    // A third browser signs in with an email link.
    await tablet.goto(`${origin}/email/sign-in`);
    const link = tablet.locator("form[action='/email/sign-in']");
    await link.getByLabel("Email address").fill(address);
    await link.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => links.length).toBe(2);
    await tablet.goto(links[1]!);
    await tablet.getByRole("button", { name: "Continue" }).click();
    await expect(tablet).toHaveURL(`${origin}/learn`);

    // Signing in elsewhere left every earlier browser signed in.
    expect(await signedIn(laptop, origin)).toBe(true);
    expect(await signedIn(phone, origin)).toBe(true);
    expect(await signedIn(tablet, origin)).toBe(true);

    // The Sign out page explains it, and ends only this browser.
    await phone.goto(`${origin}/account/sign-out`);
    await expect(
      phone.getByText(
        "This signs out this browser only, including any copies of its sign-in cookie. Other browsers where you signed in stay signed in.",
        { exact: false },
      ),
    ).toBeVisible();
    await phone
      .locator("form[action='/account/sign-out']")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(
      phone.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByText("Other browsers where you signed in stay signed in.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(await signedIn(phone, origin)).toBe(false);
    expect(await signedIn(laptop, origin)).toBe(true);
    expect(await signedIn(tablet, origin)).toBe(true);

    // Signing out from the header's page ends that browser too, and only it.
    await laptop.goto(`${origin}/account`);
    await laptop
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Sign out", exact: true })
      .click();
    await expect(
      laptop.getByText("Other browsers where you signed in stay signed in.", {
        exact: false,
      }),
    ).toBeVisible();
    await laptop
      .locator("form[action='/account/sign-out']")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(
      laptop.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    expect(await signedIn(laptop, origin)).toBe(false);
    expect(await signedIn(tablet, origin)).toBe(true);

    // Signing back in on a signed-out browser keeps the other one.
    await phone.goto(`${origin}/email/sign-in`);
    const again = phone.locator("form[action='/password/sign-in']");
    await again.getByLabel("Email address").fill(address);
    await again.getByLabel("Password", { exact: true }).fill(password);
    await again.getByRole("button", { name: "Sign in" }).click();
    await expect(phone).toHaveURL(`${origin}/learn`);
    expect(await signedIn(phone, origin)).toBe(true);
    expect(await signedIn(tablet, origin)).toBe(true);
  } finally {
    await phone.context().close();
    await tablet.context().close();
    await closeLoopback(server);
  }
});
