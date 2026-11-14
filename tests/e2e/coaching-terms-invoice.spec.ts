import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type Browser,
  type TestInfo,
} from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { coachingTermsStore } from "../../src/coaching-terms.ts";
import { billingProfileStore } from "../../src/billing-profile.ts";
import { DEEP_NATIVE_INVOICE_ISSUER } from "../../src/invoice-issuer.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";

// #318 under the owner's 9 Nov 2026 decisions. Synthetic staff credentials stay
// out of traces; every person, amount and reference is invented.
test.use({ trace: "off" });
async function fixture(browser: Browser, info: TestInfo) {
  const base = process.env.DNE_TEST_DATABASE_URL;
  if (!base || !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(base).pathname))
    throw Error("Generated browser database required");
  const name = "dne_test_" + randomBytes(16).toString("hex"),
    marker = "terms318-" + randomBytes(16).toString("hex"),
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
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(store(pool), {
      get origin() {
        return origin;
      },
      secret: "invented-terms-invoice-browser",
      mode: "test",
      localStaffEntry: true,
      staffEntry: staffEntryStore(pool),
      // A configured (not sample) store: Deep Native Inc. with 13% HST.
      simpleInvoices: simpleInvoiceStore(pool, {
        sample: false,
        ...DEEP_NATIVE_INVOICE_ISSUER,
      }),
      coachingTerms: coachingTermsStore(pool),
      billingProfiles: billingProfileStore(pool),
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
  await info.attach("terms-invoice-owned-resource", {
    body: JSON.stringify({ name, marker, oid, origin }),
    contentType: "application/json",
  });
  return {
    origin,
    page,
    async admin() {
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
    },
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
        await dropAttendanceBrowserDatabase(control, name);
      } finally {
        await control.end();
      }
    },
  };
}

test("[L331] TERMSINV318-01/03/05 an administrator invoices a student's coaching terms with HST; the student sees it due, then paid", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    // 1. The student registers; their reference is on My account.
    const s = await f.page();
    await s.goto(f.origin);
    await s.getByLabel("Display name").fill("Invented terms student");
    await s.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(s, "everyday");
    await s.getByRole("button", { name: "Start my learning path" }).click();
    await s.goto(f.origin + "/account");
    const id = await s.locator("code").first().innerText();

    // 2. The administrator sets terms; with no recipient, nothing can be issued.
    const a = await f.admin();
    await a.goto(`${f.origin}/operator/coaching/${id}/package`);
    await a.getByLabel("Price (CAD)").fill("1200.00");
    await a.getByLabel("Start date").fill("2026-12-01");
    await a.getByLabel("End date").fill("2027-05-31");
    await a.getByLabel("Renewal date").fill("2027-06-01");
    await a.getByLabel("Expert review minutes").fill("120");
    await a.getByLabel("Coaching sessions").fill("6");
    await a.getByLabel("AI requests").fill("200");
    await a.getByRole("button", { name: "Save coaching terms" }).click();
    const section = a.getByRole("region", {
      name: "Invoice these coaching terms",
    });
    await expect(section).toContainText(
      "This student hasn't saved a billing recipient yet.",
    );
    await expect(
      section.getByRole("button", { name: "Issue invoice for these terms" }),
    ).toHaveCount(0);

    // 3. The student saves a billing recipient from My account.
    await s
      .getByRole("link", { name: "Billing recipient", exact: true })
      .click();
    await s.getByLabel("Invoice recipient name").fill("Invented Student");
    await s
      .getByLabel("Invoice email")
      .fill("invented.student@example.invalid");
    await s.getByRole("button", { name: "Save billing recipient" }).click();

    // 4. The administrator reviews the amount and recipient, and issues it.
    await a.reload();
    await expect(section).toContainText(
      "Issue an invoice for terms version 1: CAD 1,200.00 plus HST (13%) CAD 156.00, total CAD 1,356.00, to Invented Student · invented.student@example.invalid.",
    );
    await section
      .getByRole("checkbox", {
        name: "I checked this terms version, amount and recipient.",
      })
      .check();
    await section
      .getByRole("button", { name: "Issue invoice for these terms" })
      .click();
    await expect(
      a.getByRole("heading", { name: "Invoice", exact: true }),
    ).toBeVisible();
    const invoiceId = a.url().split("/").at(-1)!;
    await expect(
      a.getByText("Deep Native Inc. · Ontario, Canada"),
    ).toBeVisible();
    await expect(
      a.getByText("Coaching period 2026-12-01 to 2027-05-31"),
    ).toBeVisible();

    // 5. The student sees it due, with the offline payment instructions.
    await s.goto(`${f.origin}/account/purchases`);
    await s.getByRole("link", { name: `DN-${invoiceId}` }).click();
    await expect(
      s.locator("dt").filter({ hasText: "Balance" }).locator("+ dd"),
    ).toHaveText("CAD 1356.00");
    await expect(
      s.getByText(
        "Pay by Interac e-Transfer to info@deepnative.io or by cheque to Deep Native Inc.",
      ),
    ).toBeVisible();
    await expect(
      s.getByText("HST registration number 713254472RT0001"),
    ).toBeVisible();

    // 6. The administrator records the offline payment; the student sees it paid.
    await a.getByLabel("Amount received (CAD)").fill("1356.00");
    await a
      .getByLabel("Received on", { exact: true })
      .fill(new Date().toISOString().slice(0, 10));
    await a
      .getByLabel("Evidence reference")
      .first()
      .fill("Invented e-Transfer");
    await a
      .getByRole("checkbox", {
        name: "I verified these funds were received for this exact invoice.",
      })
      .check();
    await a.getByRole("button", { name: "Record offline payment" }).click();
    await s.reload();
    await expect(
      s.locator("dt").filter({ hasText: "Balance" }).locator("+ dd"),
    ).toHaveText("CAD 0.00");
    await s
      .getByRole("link", { name: "Courses and invoices", exact: true })
      .click();
    await expect(s.getByText(/CAD 1356\.00 · Paid/)).toBeVisible();

    // 7. Back on the coaching page the version shows as invoiced, with no form.
    await a.goto(`${f.origin}/operator/coaching/${id}/package`);
    await expect(section).toContainText("Terms version 1 is invoiced.");
    await expect(
      section.getByRole("button", { name: "Issue invoice for these terms" }),
    ).toHaveCount(0);
  } finally {
    await f.close();
  }
});
