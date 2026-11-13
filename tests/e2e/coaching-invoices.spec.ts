import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { Pool, type PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { app } from "../../src/app.ts";
import { monthLabel } from "../../src/coaching-values.ts";
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { coachingTermsStore } from "../../src/coaching-terms.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
// Verified synthetic staff credentials stay out of traces; screenshots and resource reports contain only invented display data.
test.use({ trace: "off" });
async function fixture(
  browser: Browser,
  info: TestInfo,
  enabled = true,
  ownerEntry = false,
  terms = false,
) {
  const base = process.env.DNE_TEST_DATABASE_URL;
  if (!base || !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(base).pathname))
    throw Error("Generated browser database required");
  const name = "dne_test_" + randomBytes(16).toString("hex"),
    marker = "coaching576-" + randomBytes(16).toString("hex"),
    control = new Pool({ connectionString: base }),
    url = new URL(base);
  url.pathname = "/" + name;
  await control.query(`CREATE DATABASE "${name}"`);
  await control.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  const oid = (
    await control.query<{ oid: number }>(
      "SELECT oid FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0]!.oid;
  const pool = new Pool({ connectionString: url.href });
  await migrate(pool);
  const state = { lost: false, commits: 0 },
    messages: string[] = [];
  const fault = {
    connect: async () => {
      const c = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const result = await c.query(sql, args);
          if (sql === "COMMIT" && state.lost) {
            state.lost = false;
            state.commits++;
            throw Error("Invented committed response loss");
          }
          return result;
        },
        release: (error?: Error) => c.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  let origin = "http://127.0.0.1:0";
  const members = store(pool),
    email = memberEmailAccess(
      pool,
      {
        send: async (_address, link) => {
          messages.push(link.replace("http://127.0.0.1:0", origin));
        },
      },
      origin,
    );
  const invoices = simpleInvoiceStore(fault, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  });
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "invented-coaching-browser",
      mode: "test",
      localStaffEntry: true,
      staffEntry: staffEntryStore(pool),
      memberEmail: email,
      simpleInvoices: enabled ? invoices : undefined,
      // Matches runtime sample mode: delivery is simulated, nothing is sent.
      invoiceSender: enabled ? { send: async () => {} } : undefined,
      // L284 only: verified owners enter administration through the menu.
      ...(ownerEntry ? { administratorEntry: administratorEntry(pool) } : {}),
      // L330 only: per-student coaching terms and their allowance units.
      ...(terms ? { coachingTerms: coachingTermsStore(pool) } : {}),
    }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  origin = `http://127.0.0.1:${address.port}`;
  const contexts: Awaited<ReturnType<Browser["newContext"]>>[] = [];
  async function page() {
    const c = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    contexts.push(c);
    return c.newPage();
  }
  async function member(displayName = "Sample learner") {
    const p = await page();
    await p.goto(origin);
    await p.getByLabel("Display name").fill(displayName);
    await p.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(p, "everyday");
    await p.getByRole("button", { name: "Start my learning path" }).click();
    await p.goto(origin + "/account");
    const id = await p.locator("code").first().innerText();
    return { page: p, id };
  }
  async function admin() {
    const token = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      token,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    const p = await page();
    await p.goto(origin + "/staff/sign-in");
    await p.getByLabel("Trusted local staff credential").fill(token);
    await p
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    return p;
  }
  // An approved owner identity, verified through the ordinary email link.
  async function owner() {
    const o = await member("Invented owner");
    const sent = messages.length;
    await o.page
      .getByRole("link", { name: "Link an email", exact: true })
      .click();
    await o.page.getByLabel("Email address").fill("tom@deepnative.io");
    await o.page
      .getByRole("button", { name: "Send verification link" })
      .click();
    await expect.poll(() => messages.length).toBe(sent + 1);
    await o.page.goto(messages.at(-1)!);
    await o.page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      o.page.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();
    // ADMINLINK: the link appears from the first page after verification.
    await o.page.goto(origin + "/account");
    return o;
  }
  const month = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
  await info.attach("coaching-owned-resource", {
    body: JSON.stringify({ name, marker, oid, origin }),
    contentType: "application/json",
  });
  return {
    origin,
    pool,
    month,
    state,
    messages,
    page,
    member,
    admin,
    owner,
    async close() {
      await Promise.all(contexts.map((c) => c.close()));
      await closeLoopback(server);
      await pool.end();
      try {
        const actual = (
          await control.query(
            "SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
            [name],
          )
        ).rows[0];
        expect(actual).toEqual({ oid, marker });
        // Cleans up after a failed test too: traces, not this database, are the evidence.
        await dropAttendanceBrowserDatabase(control, name);
      } finally {
        await control.end();
      }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setRate(f: Fixture, admin: Page, id: string, rate: string) {
  await admin.goto(`${f.origin}/operator/coaching/${id}`);
  await admin.getByLabel("Hourly rate (CAD)").fill(rate);
  await admin.getByRole("button", { name: "Save hourly rate" }).click();
}
async function save(f: Fixture, p: Page, hours = "1", minutes = "30") {
  await p.goto(f.origin + "/account/coaching");
  await p.getByLabel("Whole hours").fill(hours);
  await p.getByLabel("Additional minutes").fill(minutes);
  await p.getByLabel("Invoice recipient name").fill("陳 · Invented learner");
  await p.getByLabel("Invoice email").fill("billing@example.invalid");
  // Confirm the redirected document before callers reload or submit it.
  await Promise.all([
    p.waitForURL(`${f.origin}/account/coaching?month=${f.month}&done=saved`, {
      waitUntil: "load",
    }),
    p.getByRole("button", { name: "Save draft" }).click(),
  ]);
  await expect(
    p.getByRole("heading", { name: "Coaching hours", exact: true }),
  ).toBeVisible();
}
async function submit(p: Page) {
  await p.getByRole("checkbox", { name: /I confirm these hours/ }).check();
  await p.getByRole("button", { name: "Save and request invoice" }).click();
}
async function issue(f: Fixture, p: Page, id: string) {
  await p.goto(`${f.origin}/operator/coaching/${id}`);
  await p.getByLabel("Invented sample tax (CAD)").fill("0.00");
  await p.getByRole("checkbox", { name: /I reviewed this exact/ }).check();
  await p.screenshot({
    path: test.info().outputPath(`coaching-review-${id}.png`),
    fullPage: true,
  });
  await p.getByRole("button", { name: "Issue coaching invoice" }).click();
  await expect(
    p.getByRole("heading", { name: "Invoice", exact: true }),
  ).toBeVisible();
  return p.url().split("/").at(-1)!;
}
test("[L273] HOUR01/02/03/04/09 recovered members submit their own rates and receive private printable monthly invoices", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const a = await f.member(),
      b = await f.member(),
      admin = await f.admin();
    await a.page
      .getByRole("link", { name: "Link an email", exact: true })
      .click();
    await a.page
      .getByLabel("Email address")
      .fill("coaching-member@example.invalid");
    await a.page
      .getByRole("button", { name: "Send verification link" })
      .click();
    await expect.poll(() => f.messages.length).toBe(1);
    await a.page.goto(f.messages[0]!);
    await a.page.getByRole("button", { name: "Continue", exact: true }).click();
    const recovered = await f.page();
    await recovered.goto(f.origin + "/email/sign-in");
    await recovered
      .getByLabel("Email address")
      .fill("coaching-member@example.invalid");
    await recovered.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => f.messages.length).toBe(2);
    await recovered.goto(f.messages[1]!);
    await recovered
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await recovered.goto(f.origin + "/account");
    await expect(recovered.locator("code").first()).toHaveText(a.id);
    await setRate(f, admin, a.id, "120.00");
    await setRate(f, admin, b.id, "80.00");
    for (const [p, id, total, rate] of [
      [recovered, a.id, "180.00", "120.00"],
      [b.page, b.id, "120.00", "80.00"],
    ] as const) {
      await save(f, p);
      await p.reload();
      // The month's detail shows the total; HOURTABLE-01 repeats it in the table.
      await expect(
        p.getByText(`CAD ${total}`, { exact: true }).first(),
      ).toBeVisible();
      await expect(p.locator(".coaching-months")).toContainText(`CAD ${total}`);
      await p.screenshot({
        path: info.outputPath(`coaching-draft-${rate}.png`),
        fullPage: true,
      });
      await submit(p);
      await expect(
        p.getByRole("heading", { name: "Submitted snapshot" }),
      ).toBeVisible();
      const invoiceId = await issue(f, admin, id);
      await p.goto(f.origin + "/account/purchases");
      await p
        .getByRole("link", { name: `DN-${invoiceId}`, exact: true })
        .click();
      await expect(
        p.getByRole("table", { name: "Coaching charges" }),
      ).toContainText(f.month);
      await expect(
        p.getByText(new RegExp(`1 hour 30 minutes.*CAD ${rate} per hour`)),
      ).toBeVisible();
      await expect(
        p.getByText("SAMPLE · NOT PAYABLE", { exact: true }),
      ).toBeVisible();
      await p.emulateMedia({ media: "print" });
      await expect(p.locator(".invoice-controls")).toBeHidden();
      await p.emulateMedia({ media: "screen" });
      expect(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await p.screenshot({
        path: info.outputPath(`coaching-${rate}-invoice.png`),
        fullPage: true,
      });
    }
    const previous = new Date(`${f.month}-01T00:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const pastMonth = previous.toISOString().slice(0, 7);
    await admin.goto(
      `${f.origin}/operator/coaching/${a.id}?month=${pastMonth}`,
    );
    await admin.getByLabel("Hourly rate (CAD)").fill("120.00");
    await admin.getByRole("button", { name: "Save hourly rate" }).click();
    await recovered.goto(`${f.origin}/account/coaching?month=${pastMonth}`);
    await expect(recovered.getByLabel("Calendar month (UTC)")).toHaveValue(
      pastMonth,
    );
    await recovered.getByLabel("Whole hours").fill("2");
    await recovered.getByLabel("Additional minutes").fill("0");
    await recovered
      .getByLabel("Invoice recipient name")
      .fill("Invented learner");
    await recovered.getByLabel("Invoice email").fill("billing@example.invalid");
    await recovered.getByRole("button", { name: "Save draft" }).click();
    await expect(
      recovered.locator(
        'form[action="/account/coaching/save"] input[name="revision"]',
      ),
    ).toHaveValue("1");
    await recovered.waitForLoadState("load");
    await submit(recovered);
    await expect(recovered.getByText("Status: Awaiting review")).toBeVisible();
    await recovered.screenshot({
      path: info.outputPath("coaching-past-month-request.png"),
      fullPage: true,
    });
    await admin.goto(`${f.origin}/operator/coaching`);
    // The dashboard row links to the same month; check the Pending periods list.
    const pending = admin.locator(
      `h2:text-is("Pending periods") + ul a[href="/operator/coaching/${a.id}?month=${pastMonth}"]`,
    );
    await expect(pending).toBeVisible();
    await expect(pending).toHaveText(
      `Sample learner · ${monthLabel(pastMonth)}`,
    );
  } finally {
    await f.close();
  }
});
// Layout checks shared by every L284 page: no sideways scrolling, and form
// controls tall enough to tap comfortably on the current device.
async function friendly(p: Page, step: string) {
  await p.waitForLoadState("load");
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${step} scrolls sideways`,
  ).toBe(true);
  const cramped = await p.evaluate(() =>
    [
      ...document.querySelectorAll(
        "main button, main a.button, main input:not([type=hidden]):not([type=checkbox]), main select",
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
    path: test.info().outputPath(`L284-${step}.png`),
    fullPage: true,
  });
}
test("[L284] HOUR01/03/04/07/09 a student registers, signs back in and reports a month; a verified owner approves, sends and records payment through menus", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info, true, true);
  try {
    const previous = new Date(`${f.month}-01T00:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const month = previous.toISOString().slice(0, 7);
    const menu = (p: Page) =>
      p.getByRole("navigation", { name: "Main navigation" });

    // 1. Register and verify an email so the student can sign in again.
    const student = await f.member("Coaching member"),
      s = student.page;
    await friendly(s, "student-account");
    await s.getByRole("link", { name: "Link an email", exact: true }).click();
    await s
      .getByLabel("Email address")
      .fill("coaching-student@example.invalid");
    await s.getByRole("button", { name: "Send verification link" }).click();
    await expect.poll(() => f.messages.length).toBe(1);
    await s.goto(f.messages[0]!);
    await s.getByRole("button", { name: "Continue", exact: true }).click();

    // 2. Sign out, then sign back in to the same account by email.
    await menu(s).getByRole("link", { name: "Account", exact: true }).click();
    await s.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      s.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    await friendly(s, "student-signed-out");
    await s.goto(f.origin + "/email/sign-in");
    await friendly(s, "student-sign-in");
    await s
      .getByLabel("Email address")
      .fill("coaching-student@example.invalid");
    await s.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => f.messages.length).toBe(2);
    await s.goto(f.messages[1]!);
    await s.getByRole("button", { name: "Continue", exact: true }).click();
    await menu(s).getByRole("link", { name: "Account", exact: true }).click();
    await expect(s.locator("code").first()).toHaveText(student.id);

    // 3. The owner enters administration and sets the rate for that month.
    const owner = await f.owner(),
      o = owner.page;
    await menu(o)
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await friendly(o, "owner-administration");
    await o.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      o.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    await friendly(o, "owner-console");
    await o.getByRole("link", { name: "Coaching member", exact: true }).click();
    await expect(
      o.getByRole("heading", { name: "Selected learner" }),
    ).toBeVisible();
    await o
      .getByRole("link", { name: "Coaching hours and rates", exact: true })
      .click();
    await o.getByLabel("Hourly rate (CAD)").fill("95.00");
    await o.getByLabel("Applies from").fill(month);
    await friendly(o, "owner-set-rate");
    await o.getByRole("button", { name: "Save hourly rate" }).click();

    // 4. The student reports last month's hours from Coaching hours.
    await menu(s)
      .getByRole("link", { name: "Coaching hours", exact: true })
      .click();
    await expect(s).toHaveURL(f.origin + "/account/coaching");
    await s.getByLabel("Calendar month (UTC)").fill(month);
    await s.getByRole("button", { name: "Open month" }).click();
    await expect(s.getByLabel("Calendar month (UTC)")).toHaveValue(month);
    await s.getByLabel("Whole hours").fill("2");
    await s.getByLabel("Additional minutes").fill("15");
    await s
      .getByLabel("Invoice recipient name")
      .fill("Invented coaching member");
    await s.getByLabel("Invoice email").fill("billing@example.invalid");
    await friendly(s, "student-hours-form");
    await Promise.all([
      s.waitForURL(`${f.origin}/account/coaching?month=${month}&done=saved`, {
        waitUntil: "load",
      }),
      s.getByRole("button", { name: "Save draft" }).click(),
    ]);
    await expect(
      s.getByText("CAD 213.75", { exact: true }).first(),
    ).toBeVisible();
    await expect(s.locator(".coaching-months")).toContainText("CAD 213.75");
    await submit(s);
    await expect(
      s.getByRole("heading", { name: "Submitted snapshot" }),
    ).toBeVisible();
    await friendly(s, "student-submitted");

    // 5. The owner finds the pending month, reviews it and issues the invoice.
    await menu(o)
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await o
      .getByRole("link", { name: "Coaching administration", exact: true })
      .click();
    await expect(
      o.getByRole("heading", { name: "Pending periods" }),
    ).toBeVisible();
    // DASH-04: the manager dashboard opens on last month by default.
    const figure = (label: string) =>
      o.locator(".hours-summary div").filter({ hasText: label }).locator("dd");
    const row = () => o.getByRole("row").filter({ hasText: "Coaching member" });
    await expect(o.getByLabel("Month", { exact: true })).toHaveValue(month);
    await expect(figure("Hours submitted")).toHaveText("2h 15m");
    await expect(figure("Awaiting review")).toHaveText("1");
    await expect(row()).toContainText("Awaiting review");
    await friendly(o, "owner-pending");
    await o
      .getByRole("link", {
        name: `Coaching member · ${monthLabel(month)}`,
        exact: true,
      })
      .click();
    await expect(o.getByText("CAD 213.75").first()).toBeVisible();
    await o.getByLabel("Invented sample tax (CAD)").fill("0.00");
    await o.getByRole("checkbox", { name: /I reviewed this exact/ }).check();
    await friendly(o, "owner-review");
    await o.getByRole("button", { name: "Issue coaching invoice" }).click();
    await expect(
      o.getByRole("heading", { name: "Invoice", exact: true }),
    ).toBeVisible();
    const invoiceId = o.url().split("/").at(-1)!;

    // 6. The owner sends it (simulated in sample mode).
    await o
      .getByRole("checkbox", {
        name: "Simulate delivery only; no email will be sent.",
      })
      .check();
    await o.getByRole("button", { name: "Simulate invoice email" }).click();
    await expect(
      o.getByText("Email status: Simulated; no email sent"),
    ).toBeVisible();
    await friendly(o, "owner-invoice");

    // 7. The student opens the invoice and sees what is due and how to pay.
    await menu(s).getByRole("link", { name: "Account", exact: true }).click();
    await s
      .getByRole("link", { name: "Courses and invoices", exact: true })
      .click();
    await friendly(s, "student-invoices");
    await s.getByRole("link", { name: `DN-${invoiceId}`, exact: true }).click();
    await expect(
      s.getByRole("table", { name: "Coaching charges" }),
    ).toContainText(month);
    await expect(
      s.getByText(/2 hours 15 minutes.*CAD 95\.00 per hour/),
    ).toBeVisible();
    await expect(s.getByText("Sample only; do not pay.")).toBeVisible();
    await expect(
      s.getByText("SAMPLE · NOT PAYABLE", { exact: true }),
    ).toBeVisible();
    await friendly(s, "student-invoice-due");

    // 8. The owner records the offline payment; the student sees it paid.
    await o.getByLabel("Amount received (CAD)").fill("213.75");
    await o
      .getByLabel("Received on", { exact: true })
      .fill(new Date().toISOString().slice(0, 10));
    await o.getByLabel("Evidence reference").first().fill("Invented reference");
    await o
      .getByRole("checkbox", {
        name: "I verified these funds were received for this exact invoice.",
      })
      .check();
    await o.getByRole("button", { name: "Record offline payment" }).click();
    await s.reload();
    await expect(
      s.locator("dt").filter({ hasText: "Recorded payment" }).locator("+ dd"),
    ).toHaveText("CAD 213.75");
    await friendly(s, "student-invoice-paid");
    await s
      .getByRole("link", { name: "Courses and invoices", exact: true })
      .click();
    await expect(s.getByText(/CAD 213\.75 · Paid/)).toBeVisible();
    // DASH-04: invoiced, sent and fully paid on the manager dashboard.
    await menu(o)
      .getByRole("link", { name: "Administration", exact: true })
      .click();
    await o
      .getByRole("link", { name: "Coaching administration", exact: true })
      .click();
    await expect(figure("Invoiced")).toHaveText("CAD 213.75");
    await expect(
      o.locator(".hours-summary div").filter({ hasText: "Invoiced" }),
    ).toContainText("All sent");
    await expect(figure("Outstanding")).toHaveText("CAD 0.00");
    await expect(figure("Awaiting review")).toHaveText("0");
    await expect(row()).toContainText("Invoiced");
    await expect(row()).toContainText("Sent");
    await expect(row()).toContainText("Paid");
    await friendly(o, "owner-dashboard-paid");
  } finally {
    await f.close();
  }
});
test("[L274] HOUR05/07/08 stale forms deny changes and unpaid correction retains a linked original invoice", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const m = await f.member(),
      other = await f.member(),
      admin = await f.admin();
    await setRate(f, admin, m.id, "120.00");
    await save(f, m.page);
    await setRate(f, admin, m.id, "80.00");
    await submit(m.page);
    await expect(m.page.getByRole("alert")).toContainText("out of date");
    await m.page.goto(f.origin + "/account/coaching");
    await expect(m.page.getByText(/Applicable rate: CAD 80.00/)).toBeVisible();
    await submit(m.page);
    await admin.goto(`${f.origin}/operator/coaching/${m.id}`);
    await admin
      .getByLabel("Correction reason")
      .fill("Correct the reported hours");
    await admin
      .getByRole("button", { name: "Return month for correction" })
      .click();
    await save(f, m.page, "1", "0");
    await submit(m.page);
    const first = await issue(f, admin, m.id);
    await other.page.goto(`${f.origin}/account/purchases/invoices/${first}`);
    await expect(
      other.page.getByRole("heading", { name: "Invoice", exact: true }),
    ).toHaveCount(0);
    await m.page.goto(`${f.origin}/operator/coaching/${m.id}`);
    await expect(
      m.page.getByRole("heading", { name: "Review coaching hours" }),
    ).toHaveCount(0);
    await admin
      .getByLabel("Reason", { exact: true })
      .fill("Wrong original duration");
    await admin
      .getByRole("checkbox", { name: /Void this unpaid invoice/ })
      .check();
    await admin.getByRole("button", { name: "Void unpaid invoice" }).click();
    await admin.goto(`${f.origin}/operator/coaching/${m.id}`);
    await admin
      .getByLabel("Correction reason")
      .fill("Please confirm corrected hours");
    await admin
      .getByRole("button", { name: "Return month for correction" })
      .click();
    await save(f, m.page, "0", "30");
    await submit(m.page);
    const second = await issue(f, admin, m.id);
    await expect(
      admin.getByText(
        `Replaces void invoice DN-${first}. The original remains retained.`,
      ),
    ).toBeVisible();
    expect(second).not.toBe(first);
    await admin.getByLabel("Amount received (CAD)").fill("1.00");
    await admin
      .getByLabel("Received on")
      .fill(new Date().toISOString().slice(0, 10));
    await admin
      .getByLabel("Evidence reference")
      .first()
      .fill("Invented reference");
    await admin
      .getByRole("checkbox", { name: /I verified these funds/ })
      .check();
    await admin.getByRole("button", { name: "Record offline payment" }).click();
    await admin.goto(`${f.origin}/operator/coaching/${m.id}`);
    await expect(
      admin.getByText(
        /Paid or partially paid invoices cannot be corrected here/,
      ),
    ).toBeVisible();
    await admin
      .getByLabel("Correction reason")
      .fill("Cannot change paid record");
    await admin
      .getByRole("button", { name: "Return month for correction" })
      .click();
    await expect(admin.getByRole("alert")).toContainText(
      "does not allow this action",
    );
  } finally {
    await f.close();
  }
});
test("[L275] HOUR03/06/09 committed submission recovery preserves zero totals without another submission or invoice", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const m = await f.member(),
      admin = await f.admin();
    await m.page
      .locator("#main")
      .getByRole("link", { name: "Coaching hours", exact: true })
      .click();
    await expect(m.page.getByText(/No rate is set/)).toBeVisible();
    await setRate(f, admin, m.id, "0.01");
    await save(f, m.page, "0", "1");
    await expect(
      m.page.getByText(/A zero-total submission creates no invoice/),
    ).toBeVisible();
    f.state.lost = true;
    await submit(m.page);
    await expect(m.page.getByRole("alert")).toContainText(
      "outcome is uncertain",
    );
    await m.page
      .getByRole("link", { name: "Inspect original operation" })
      .click();
    await expect(
      m.page.getByRole("heading", { name: "Original invoice operation" }),
    ).toBeVisible();
    await expect(m.page.locator("pre")).toContainText('"revision": 2');
    await m.page.goto(f.origin + "/account/coaching");
    await expect(
      m.page.getByRole("heading", { name: "Submitted snapshot" }),
    ).toBeVisible();
    expect(f.state.commits).toBe(1);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM coaching_submissions WHERE owner_id=$1",
          [m.id],
        )
      ).rowCount,
    ).toBe(1);
    await admin.goto(`${f.origin}/operator/coaching/${m.id}`);
    await expect(
      admin.getByText(/This zero-total submission is retained/),
    ).toBeVisible();
    await expect(
      admin.getByRole("button", { name: "Issue coaching invoice" }),
    ).toHaveCount(0);
    expect(
      (
        await f.pool.query("SELECT 1 FROM simple_invoices WHERE owner_id=$1", [
          m.id,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
test("[L276] HOUR09 disabled invoicing keeps monthly entry honest and learning accessible", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info, false);
  try {
    const m = await f.member();
    await m.page
      .locator("#main")
      .getByRole("link", { name: "Coaching hours", exact: true })
      .click();
    await expect(
      m.page.getByText(/Coaching invoicing is not configured/),
    ).toBeVisible();
    await expect(
      m.page.getByRole("button", { name: "Save and request invoice" }),
    ).toHaveCount(0);
    await m.page.getByRole("link", { name: "My account", exact: true }).click();
    await expect(m.page.locator("code").first()).toHaveText(m.id);
  } finally {
    await f.close();
  }
});

test("[L330] ALLOW27-01/03/07 an administrator sets a student's allowances and the student sees the units left this period", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info, true, false, true);
  try {
    const m = await f.member("Invented allowance learner");
    const a = await f.admin();
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    async function setTerms(aiRequests: string) {
      await a.goto(`${f.origin}/operator/coaching/${m.id}/package`);
      await a.getByLabel("Price (CAD)").fill("1500.00");
      await a.getByLabel("Start date").fill(day(-1));
      await a.getByLabel("End date").fill(day(60));
      await a.getByLabel("Renewal date").fill(day(61));
      await a.getByLabel("Expert review minutes").fill("90");
      await a.getByLabel("Coaching sessions").fill("4");
      await a.getByLabel("AI requests").fill(aiRequests);
      await a.getByRole("button", { name: "Save coaching terms" }).click();
      await expect(
        a.getByRole("heading", { name: "Allowances left this period" }),
      ).toBeVisible();
    }
    await setTerms("25");
    const staffList = a.locator("dl.coaching-allowances");
    await expect(staffList).toContainText(
      "90 of 90 minutes left, 0 held, 0 used",
    );
    await expect(staffList).toContainText("25 of 25 left, 0 held, 0 used");
    await m.page.goto(f.origin + "/account/coaching");
    const own = m.page.locator("dl.coaching-allowances");
    await expect(own).toContainText("90 of 90 minutes left, 0 held, 0 used");
    await expect(own).toContainText("25 of 25 left, 0 held, 0 used");
    await expect(
      m.page.getByText(
        "Coaching sessions are arranged with your coach and aren't counted here.",
      ),
    ).toBeVisible();
    // A lower number writes off unused units; the student sees the new total.
    await setTerms("10");
    await m.page.reload();
    await expect(own).toContainText("10 of 10 left, 0 held, 0 used");
    expect(
      await m.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await m.page.screenshot({
      path: info.outputPath("coaching-allowances-student.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});
