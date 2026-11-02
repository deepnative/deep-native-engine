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
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
// Verified synthetic staff credentials stay out of traces; screenshots and resource reports contain only invented display data.
test.use({ trace: "off" });
async function fixture(browser: Browser, info: TestInfo, enabled = true) {
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
  async function member() {
    const p = await page();
    await p.goto(origin);
    await p.getByLabel("Your starting point").selectOption("explorer");
    await p.getByLabel("What would you like to do?").selectOption("everyday");
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
        if (info.status === info.expectedStatus)
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
  await p.getByRole("button", { name: "Save coaching draft" }).click();
}
async function submit(p: Page) {
  await p
    .getByRole("checkbox", { name: /I confirm this saved duration/ })
    .check();
  await p.getByRole("button", { name: "Submit monthly hours" }).click();
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
      await expect(p.getByText(`CAD ${total}`, { exact: true })).toBeVisible();
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
      m.page.getByRole("heading", { name: "Review monthly coaching" }),
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
      .getByRole("link", { name: "Monthly coaching hours", exact: true })
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
      .getByRole("link", { name: "Monthly coaching hours", exact: true })
      .click();
    await expect(
      m.page.getByText(/Coaching invoicing is not configured/),
    ).toBeVisible();
    await expect(
      m.page.getByRole("button", { name: "Submit monthly hours" }),
    ).toHaveCount(0);
    await m.page.getByRole("link", { name: "My account", exact: true }).click();
    await expect(m.page.locator("code").first()).toHaveText(m.id);
  } finally {
    await f.close();
  }
});
