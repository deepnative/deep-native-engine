import { formToken } from "../support/form-token.ts";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import {
  memberEmailAccess,
  signOutMember,
} from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

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
async function fixture(
  page: Page,
  mode: "normal" | "disabled" | "before-commit" | "lost-commit" = "normal",
  linked = true,
  independentLogout = false,
  administration = false,
) {
  const token = randomBytes(32).toString("hex"),
    address = `signout-${token.slice(0, 12)}@example.com`;
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  await members.save(token, {
    revision: 0,
    instruction: "My invented sign-out learning plan",
    verification: "Check the invented source",
    complete: true,
  });
  let origin = "http://127.0.0.1:0",
    mutations = 0;
  const messages: string[] = [];
  const sender = {
    async send(_address: string, link: string) {
      messages.push(link.replace("http://127.0.0.1:0", origin));
    },
  };
  const access = memberEmailAccess(pool, sender, origin);
  if (linked) {
    await access.requestAttach(token, address);
    await access.consume(
      new URL(messages.at(-1)!).searchParams.get("code")!,
      token,
    );
  }
  const boundary = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("UPDATE principals SET token_hash")) mutations++;
          if (mode === "before-commit" && sql.startsWith("UPDATE learners"))
            throw Error("Synthetic write failure");
          const result = await client.query(sql, values);
          if (mode === "lost-commit" && sql === "COMMIT")
            throw Error("Synthetic lost commit acknowledgement");
          return result;
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  const signout = memberEmailAccess(boundary, sender, origin);
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-signout-browser",
      // NAV-06: Administration is offered only where entry is configured.
      localStaffEntry: administration,
      memberSignOut: independentLogout
        ? (token, confirmed) => signOutMember(boundary, token, confirmed)
        : undefined,
      memberEmail:
        mode === "disabled"
          ? undefined
          : { ...access, signOut: signout.signOut },
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string")
    throw Error("Loopback unavailable");
  origin = `http://127.0.0.1:${binding.port}`;
  await page
    .context()
    .addCookies([{ name: "dne_preview", value: token, url: origin }]);
  return {
    origin,
    token,
    address,
    id: session.learner.id,
    messages,
    access,
    mutations: () => mutations,
    close: () => closeLoopback(server),
  };
}
async function returnByEmail(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await page.goto(`${f.origin}/email/sign-in`);
  await page.getByLabel("Email address").fill(f.address);
  const before = f.messages.length;
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect.poll(() => f.messages.length).toBe(before + 1);
  await page.goto(f.messages.at(-1)!);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${f.origin}/learn`);
  await expect(page.getByText("1 / 1")).toBeVisible();
  await page.getByRole("link", { name: "My account", exact: true }).click();
  await expect(page.getByLabel("Your starting point")).toHaveValue(
    "professional",
  );
  const next = (await page.context().cookies()).find(
    (c) => c.name === "dne_preview",
  )!.value;
  expect(await members.session(next)).toMatchObject({
    kind: "active",
    learner: { id: f.id },
  });
}

test("[L239] MOUT-01/02 a linked member signs out and deliberately returns by email to the same saved work", async ({
  page,
  browser,
}) => {
  const f = await fixture(page),
    copied = await browser.newContext();
  try {
    await copied.addCookies([
      { name: "dne_preview", value: f.token, url: f.origin },
    ]);
    await page
      .context()
      .addCookies([
        { name: "dne_staff", value: "c".repeat(64), url: f.origin },
      ]);
    // #846 ACCOUNT-01: My account has no second sign-out; the header's does it.
    await page.goto(`${f.origin}/account`);
    await expect(
      page.locator("#main").getByText("Sign out", { exact: false }),
    ).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Sign out", exact: true })
      .click();
    await expect(
      page.getByText("Other browsers where you signed in stay signed in.", {
        exact: false,
      }),
    ).toBeVisible();
    const sends = f.messages.length;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    expect(f.messages).toHaveLength(sends);
    expect(
      (await page.context().cookies()).find((c) => c.name === "dne_preview"),
    ).toBeUndefined();
    expect(
      (await page.context().cookies()).find((c) => c.name === "dne_staff")
        ?.value,
    ).toBe("signed-out");
    // NAV-09/10: the Signed out page itself already shows the signed-out
    // header and offers sign-in as a button.
    const outHeader = page.getByRole("navigation", { name: "Main navigation" });
    await expect(
      outHeader.getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      outHeader.getByRole("link", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator("#main").getByRole("link", { name: "Sign in", exact: true }),
    ).toHaveClass(/button/);
    // NAV-08: the header stops offering member tools once signed out,
    // including on the email sign-in page that sets a fresh visitor cookie.
    for (const path of ["/readiness", "/email/sign-in"]) {
      await page.goto(`${f.origin}${path}`);
      const header = page.getByRole("navigation", { name: "Main navigation" });
      await expect(
        header.getByRole("link", { name: "Sign in", exact: true }),
      ).toBeVisible();
      // #846 HEADER-01: Learning is a member page too, so it goes as well.
      for (const label of ["Learning", "Account", "Coaching", "Sign out"])
        await expect(
          header.getByRole("link", { name: label, exact: true }),
        ).toHaveCount(0);
      // CREATEACCT-01: newcomers see account creation beside sign-in, and
      // the header still fits a phone screen.
      await expect(
        header.getByRole("link", { name: "Create account", exact: true }),
      ).toHaveAttribute("href", "/#your-path");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    const stale = await copied.newPage();
    await stale.goto(`${f.origin}/account`);
    await expect(stale).toHaveURL(`${f.origin}/`);
    await page.screenshot({
      path: `artifacts/member-signout-${test.info().project.name}.png`,
      fullPage: true,
    });
    await returnByEmail(page, f);
    expect((await members.session(f.token)).kind).not.toBe("active");
    expect(await members.progress(f.id)).toMatchObject({
      instruction: "My invented sign-out learning plan",
    });
  } finally {
    await copied.close();
    await f.close();
  }
});

test("[L240] MOUT-03 browser-only, pending and unavailable recovery retain access and explain the next step", async ({
  page,
}) => {
  const f = await fixture(page, "normal", false);
  try {
    for (const pending of [false, true]) {
      if (pending) await f.access.requestAttach(f.token, f.address);
      await page.goto(`${f.origin}/account`);
      await expect(
        page.getByRole("heading", { name: "This browser only" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign out", exact: true }),
      ).toHaveCount(0);
      const csrf = await formToken(page);
      const denied = await page.request.post(`${f.origin}/account/sign-out`, {
        headers: { Origin: f.origin },
        form: { csrf },
      });
      expect(denied.status()).toBe(409);
      expect(await denied.text()).toContain("Link and verify");
      expect((await members.session(f.token)).kind).toBe("active");
    }
  } finally {
    await f.close();
  }
  const stale = await fixture(page);
  try {
    await page.goto(`${stale.origin}/account/sign-out`);
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await pool.query(
      "DELETE FROM member_email_identities WHERE principal_id=$1",
      [stale.id],
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign-out unavailable", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Link and verify an email before signing out.", {
        exact: false,
      }),
    ).toBeVisible();
    expect((await members.session(stale.token)).kind).toBe("active");
  } finally {
    await stale.close();
  }
  const disabled = await fixture(page, "disabled");
  try {
    await page.goto(`${disabled.origin}/account`);
    await expect(
      page.getByRole("heading", { name: "Email recovery is unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    const csrf = await formToken(page);
    expect(
      (
        await page.request.post(`${disabled.origin}/account/sign-out`, {
          headers: { Origin: disabled.origin },
          form: { csrf },
        })
      ).status(),
    ).toBe(503);
    expect((await members.session(disabled.token)).kind).toBe("active");
    expect(await members.progress(disabled.id)).toMatchObject({
      instruction: "My invented sign-out learning plan",
    });
  } finally {
    await disabled.close();
  }
});

test("[L241] MOUT-06 failed and lost-commit signout shows uncertainty without replay and email return recovers the same work", async ({
  page,
}) => {
  for (const failure of ["before-commit", "lost-commit"] as const) {
    const f = await fixture(page, failure);
    try {
      await page.goto(`${f.origin}/account/sign-out`);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Sign-out could not be confirmed" }),
      ).toBeVisible();
      await expect(
        page.getByText("Do not resend this form", { exact: false }),
      ).toBeVisible();
      expect(f.mutations()).toBe(1);
      expect(
        (await page.context().cookies()).find((c) => c.name === "dne_preview")
          ?.value,
      ).toBe(f.token);
      // A request looks the browser up again before reading anything.
      await members.browserSession!(f.token);
      expect((await members.session(f.token)).kind === "active").toBe(
        failure === "before-commit",
      );
      await page.getByRole("link", { name: "Check My account" }).click();
      await expect(page).toHaveURL(
        failure === "before-commit" ? `${f.origin}/account` : `${f.origin}/`,
      );
      await returnByEmail(page, f);
      expect(f.mutations()).toBe(1);
      expect(await members.progress(f.id)).toMatchObject({
        instruction: "My invented sign-out learning plan",
      });
    } finally {
      await f.close();
    }
  }
});

test("[L281] NAV-01/03/04 finds account tools and deliberately signs out without email while preserving records", async ({
  page,
}) => {
  const f = await fixture(page, "disabled", false, true, true);
  try {
    await page.goto(`${f.origin}/account`);
    const navigation = page.getByRole("navigation", {
      name: "Main navigation",
    });
    for (const label of ["Learning", "Coaching", "Account", "Sign out"])
      await expect(
        navigation.getByRole("link", { name: label, exact: true }),
      ).toBeVisible();
    // ADMINLINK-01: an ordinary member is not offered Administration.
    await expect(
      navigation.getByRole("link", { name: "Admin", exact: true }),
    ).toHaveCount(0);
    for (let index = 0; index < 5; index++) await page.keyboard.press("Tab");
    await expect(
      navigation.getByRole("link", { name: "Account", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "My account", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("navigation-account.png"),
      fullPage: true,
    });
    await navigation
      .getByRole("link", { name: "Coaching", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "How to enter coaching hours" }),
    ).toBeVisible();
    await expect(
      page.getByText("Hours entry is unavailable on this preview", {
        exact: false,
      }),
    ).toBeVisible();
    // ADMINLINK-01: opening it directly still refuses them.
    await page.goto(`${f.origin}/admin`);
    await expect(
      page.getByRole("heading", { name: "Administration unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByText("Administration is restricted", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Sign out", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("You may lose access", { exact: false }),
    ).toBeVisible();
    // NAV-CURRENT-01 (#793): the current page is marked by an underline only,
    // so it does not read as a filled button beside the outlined view switch.
    const current = page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Sign out", exact: true });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(current).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(current).toHaveCSS(
      "box-shadow",
      "rgb(36, 84, 214) 0px -2px 0px 0px inset",
    );
    // SOUT-LAYOUT-01/02 (#793): the heading starts below the header like other
    // task pages, and Stay signed in sits beside Sign out under the checkbox.
    const original = page.viewportSize()!;
    await page.setViewportSize({ width: 1280, height: 720 });
    const confirm = page.locator("main form"),
      leave = confirm.getByRole("button", { name: "Sign out", exact: true }),
      stay = confirm.getByRole("link", { name: "Stay signed in" }),
      box = async (l: typeof leave) => (await l.boundingBox())!;
    const header = await box(page.locator(".site-header")),
      heading = await box(
        page.getByRole("heading", { name: "Sign out", exact: true }),
      );
    expect(heading.y - (header.y + header.height)).toBeGreaterThanOrEqual(24);
    const [leaveBox, stayBox, check] = [
      await box(leave),
      await box(stay),
      await box(confirm.getByRole("checkbox")),
    ];
    expect(stayBox.y).toBe(leaveBox.y);
    expect(stayBox.height).toBe(leaveBox.height);
    expect(stayBox.x).toBeGreaterThan(leaveBox.x + leaveBox.width);
    expect(check.y + check.height).toBeLessThan(leaveBox.y);
    // SOUT-LAYOUT-03: at phone width both actions stack full width, no scroll.
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const [phoneLeave, phoneStay] = [await box(leave), await box(stay)];
    expect(phoneLeave.width).toBe(phoneStay.width);
    expect(phoneLeave.x).toBeGreaterThanOrEqual(16);
    expect(phoneStay.y).toBeGreaterThan(phoneLeave.y + phoneLeave.height);
    await page.screenshot({
      path: test.info().outputPath("sign-out-phone.png"),
      fullPage: true,
    });
    await page.setViewportSize(original);
    expect((await members.session(f.token)).kind).toBe("active");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await members.session(f.token)).kind).toBe("active");
    await page
      .getByRole("checkbox", {
        name: "I understand I may not be able to return to this account.",
      })
      .check();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    expect((await members.session(f.token)).kind).not.toBe("active");
    expect(await members.progress(f.id)).toMatchObject({
      instruction: "My invented sign-out learning plan",
    });
    expect(f.messages).toHaveLength(0);
    expect(f.mutations()).toBe(1);
    await page.screenshot({
      path: test.info().outputPath("navigation-signed-out.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});
