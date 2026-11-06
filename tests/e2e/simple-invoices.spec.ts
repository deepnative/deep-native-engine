import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
// Staff credentials remain outside browser traces and captures.
test.use({ trace: "off" });
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;
async function offer(f: Fixture, member: Page, cadence = "one_time") {
  await f.publishFixture();
  const admin = await f.staff("platform_admin");
  await member.goto(f.origin + "/account");
  const reference = await member.locator("code").first().textContent();
  if (!reference) throw Error("Student reference missing");
  await admin.page.goto(f.origin + "/staff");
  await admin.page
    .getByRole("link", { name: "Course billing and invoices", exact: true })
    .click();
  await admin.page
    .getByLabel("Learner", { exact: true })
    .selectOption(reference);
  for (const [id, amount] of [
    ["FND-001", "10.00"],
    ["FND-002", "20.00"],
  ]) {
    await admin.page
      .locator(`input[name="courses"][value='["${id}",2]']`)
      .check();
    await admin.page.locator(`input[name="amount_${id}_2"]`).fill(amount!);
  }
  await admin.page.getByLabel("Billing", { exact: true }).selectOption(cadence);
  const date = (
    await f.pool.query<{ day: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
  await admin.page.getByLabel("Starts on (UTC date)").fill(date);
  await admin.page
    .getByLabel("Configured tax amount per invoice (CAD)")
    .fill("0.00");
  await admin.page
    .getByRole("button", { name: "Prepare course billing proposal" })
    .click();
  await member
    .getByRole("link", { name: "Courses and invoices", exact: true })
    .click();
  await expect(
    member.getByRole("heading", { name: "Course bundle" }),
  ).toBeVisible();
  return { admin, date, reference };
}
async function accept(member: Page, cadence = "one-time") {
  await member
    .getByLabel("Invoice recipient name")
    .fill("陳 · Invented student");
  await member
    .getByLabel("Invoice email")
    .fill("invented-student@example.invalid");
  await member
    .getByRole("checkbox", {
      name: new RegExp(`I accept these exact courses and ${cadence}`),
    })
    .check();
  await member
    .getByRole("button", { name: "Accept courses and create invoice" })
    .click();
  await expect(
    member.getByRole("heading", { name: "Invoice", exact: true }),
  ).toBeVisible();
  return member.url().split("/").at(-1)!;
}
test("[L266] registered student accepts two courses on one printable individual invoice and staff records offline funds", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    const { admin, date } = await offer(f, member);
    await expect(
      member.getByText("Total: CAD 30.00", { exact: true }),
    ).toBeVisible();
    await member.screenshot({
      path: info.outputPath("course-proposal.png"),
      fullPage: true,
    });
    const invoiceId = await accept(member);
    await expect(
      member.getByRole("table", { name: "Included courses" }),
    ).toContainText("FND-001 version 2");
    await expect(
      member.getByRole("table", { name: "Included courses" }),
    ).toContainText("FND-002 version 2");
    await expect(
      member.getByText("SAMPLE · NOT PAYABLE", { exact: true }),
    ).toBeVisible();
    await member.emulateMedia({ media: "print" });
    await expect(member.locator(".invoice-controls")).toBeHidden();
    await expect(member.locator(".invoice-document")).toBeVisible();
    await member.emulateMedia({ media: "screen" });
    await admin.page.goto(f.origin + "/operator/invoices/" + invoiceId);
    for (const amount of ["10.00", "20.00"]) {
      await admin.page.getByLabel("Amount received (CAD)").fill(amount);
      await admin.page.getByLabel("Received on", { exact: true }).fill(date);
      await admin.page
        .getByLabel("Evidence reference")
        .first()
        .fill("Invented bank reference");
      await admin.page
        .getByRole("checkbox", {
          name: "I verified these funds were received for this exact invoice.",
        })
        .check();
      await admin.page
        .getByRole("button", { name: "Record offline payment" })
        .click();
      await member.reload();
      const paid = member
        .locator("dt")
        .filter({ hasText: "Recorded payment" })
        .locator("+ dd");
      await expect(paid).toHaveText(
        amount === "10.00" ? "CAD 10.00" : "CAD 30.00",
      );
    }
    await member.screenshot({
      path: info.outputPath("individual-invoice.png"),
      fullPage: true,
    });
    await member
      .getByRole("link", { name: "Courses and invoices", exact: true })
      .click();
    await expect(member.getByText(/CAD 30.00 · Paid/)).toBeVisible();
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
test("[L267] monthly course agreement requires explicit acceptance and cancellation stops future invoices", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    await offer(f, member, "monthly");
    await expect(
      member.getByText("Total each month: CAD 30.00", { exact: true }),
    ).toBeVisible();
    await accept(member, "monthly recurring invoices");
    await expect(
      member.getByText(/Recurring billing · Period starts/),
    ).toBeVisible();
    await member
      .getByRole("link", { name: "Courses and invoices", exact: true })
      .click();
    await member
      .getByRole("checkbox", {
        name: "Stop future invoices; retain already issued invoices.",
      })
      .check();
    await member.getByRole("button", { name: "Cancel future billing" }).click();
    await expect(
      member.getByText("SAMPLE · NOT PAYABLE · cancelled", { exact: true }),
    ).toBeVisible();
    expect(
      await simpleInvoiceStore(f.pool, {
        sample: true,
        issuer: "Unused",
        instructions: "Unused",
      }).generateScheduled(),
    ).toEqual({ kind: "ready", value: { created: 0 } });
    await expect(member.getByRole("link", { name: /^DN-/ })).toHaveCount(1);
  } finally {
    await f.close();
  }
});
test("[L268] private invoices deny outsiders and unpaid corrections retain the original document", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    const { admin } = await offer(f, member);
    const invoiceId = await accept(member);
    const outsider = await f.member();
    await outsider.goto(member.url());
    await expect(
      outsider.getByRole("heading", { name: "Invoice request not confirmed" }),
    ).toBeVisible();
    await expect(outsider.locator(".invoice-document")).toHaveCount(0);
    await member.goto(f.origin + "/operator/invoices/" + invoiceId);
    await expect(member.locator(".invoice-document")).toHaveCount(0);
    await admin.page.goto(f.origin + "/operator/invoices/" + invoiceId);
    await admin.page
      .getByLabel("Reason", { exact: true })
      .fill("Wrong course bundle");
    await admin.page
      .getByRole("checkbox", { name: /Void this unpaid invoice/ })
      .check();
    await admin.page
      .getByRole("button", { name: "Void unpaid invoice" })
      .click();
    await member.goto(f.origin + "/account/purchases/invoices/" + invoiceId);
    await expect(
      member.getByText("VOID · No payment due", { exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole("table", { name: "Included courses" }),
    ).toContainText("FND-001 version 2");
  } finally {
    await f.close();
  }
});

test("[L304] staff records offline funds and refunds that the member sees as manual and unverified", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    const { admin, date } = await offer(f, member);
    const invoiceId = await accept(member);
    const staffPage = admin.page;
    await staffPage.goto(f.origin + "/operator/invoices/" + invoiceId);
    await expect(
      staffPage.getByRole("button", { name: "Record offline refund" }),
    ).toHaveCount(0);
    await staffPage.getByLabel("Amount received (CAD)").fill("30.00");
    await staffPage.getByLabel("Received on", { exact: true }).fill(date);
    await staffPage
      .getByLabel("Evidence reference")
      .fill("Invented transfer reference");
    await staffPage
      .getByRole("checkbox", { name: /I verified these funds/ })
      .check();
    await staffPage
      .getByRole("button", { name: "Record offline payment" })
      .click();
    await member.reload();
    const record = member.getByRole("table", {
      name: "Recorded receipts and refunds",
    });
    await expect(record).toContainText("Invented transfer reference");
    await expect(
      member.getByText("Not verified by a payment provider."),
    ).toBeVisible();
    await expect(member.getByText("Recorded by")).toHaveCount(0);
    await expect(
      staffPage.getByRole("table", {
        name: "Recorded receipts and refunds",
      }),
    ).toContainText("Staff account");
    for (const [amount, status] of [
      ["10.00", "Partly refunded"],
      ["20.00", "Refunded"],
    ] as const) {
      await staffPage.getByLabel("Amount refunded (CAD)").fill(amount);
      await staffPage.getByLabel("Refunded on").fill(date);
      await staffPage
        .locator('form[action$="/refund"]')
        .getByLabel("Evidence reference")
        .fill("Invented refund " + amount);
      await staffPage
        .getByRole("checkbox", { name: /I confirm this refund was sent/ })
        .check();
      await staffPage
        .getByRole("button", { name: "Record offline refund" })
        .click();
      await member.goto(f.origin + "/account/purchases");
      await expect(
        member.getByRole("listitem").filter({ hasText: status }),
      ).toBeVisible();
      await member.goto(f.origin + "/account/purchases/invoices/" + invoiceId);
      await expect(
        member
          .locator("dt")
          .filter({ hasText: "Recorded payment" })
          .locator("+ dd"),
      ).toHaveText("CAD 30.00");
      await expect(
        member.locator("dt").filter({ hasText: "Balance" }).locator("+ dd"),
      ).toHaveText("CAD 0.00");
    }
    await expect(
      member
        .locator("dt")
        .filter({ hasText: "Recorded refund" })
        .locator("+ dd"),
    ).toHaveText("CAD 30.00");
    await expect(
      staffPage.getByRole("button", { name: "Record offline refund" }),
    ).toHaveCount(0);
    expect(
      await member.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    for (const reader of [staffPage, member]) {
      await expect(
        reader.getByRole("cell", { name: "Refund", exact: true }).first(),
      ).toHaveCSS("white-space", "nowrap");
    }
    expect(
      await staffPage.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await member.screenshot({
      path: info.outputPath("manual-refund-invoice.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test("[L308] administrator reconciles an invoice against recorded cash and a reversal, and other roles are refused", async ({
  browser,
}, info) => {
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
  });
  try {
    const member = await f.member();
    const { admin, date } = await offer(f, member);
    const invoiceId = await accept(member);
    const staffPage = admin.page;
    await staffPage.goto(f.origin + "/operator/invoices/" + invoiceId);
    await staffPage.getByLabel("Amount received (CAD)").fill("20.00");
    await staffPage.getByLabel("Received on", { exact: true }).fill(date);
    await staffPage
      .getByLabel("Evidence reference")
      .first()
      .fill("Invented private reference");
    await staffPage
      .getByRole("checkbox", { name: /I verified these funds/ })
      .check();
    await staffPage
      .getByRole("button", { name: "Record offline payment" })
      .click();
    await staffPage.getByLabel("Amount refunded (CAD)").fill("5.00");
    await staffPage.getByLabel("Refunded on").fill(date);
    await staffPage
      .locator('form[action$="/refund"]')
      .getByLabel("Evidence reference")
      .fill("Invented private refund");
    await staffPage
      .getByRole("checkbox", { name: /I confirm this refund was sent/ })
      .check();
    await staffPage
      .getByRole("button", { name: "Record offline refund" })
      .click();
    await staffPage.goto(f.origin + "/staff");
    await staffPage
      .getByRole("link", {
        name: "Invoice and cash reconciliation",
        exact: true,
      })
      .click();
    await expect(
      staffPage.getByRole("heading", {
        name: "Invoice and cash reconciliation",
      }),
    ).toBeVisible();
    const sample = staffPage.locator('[data-invoice-group="sample"]'),
      field = (name: string) => sample.locator(`[data-field="${name}"]`);
    await expect(
      sample.getByRole("heading", { name: "Sample invoices · Test data" }),
    ).toBeVisible();
    await expect(field("invoiced")).toHaveText("CAD 30.00");
    await expect(field("receipts")).toHaveText("CAD 20.00");
    await expect(field("refunds")).toHaveText("CAD 5.00");
    await expect(field("net")).toHaveText("CAD 15.00");
    await expect(field("unpaid")).toHaveText("CAD 10.00");
    await expect(field("mismatched")).toHaveText("0");
    await expect(
      staffPage
        .locator('[data-invoice-group="configured"]')
        .locator('[data-field="share"]'),
    ).toHaveText("Not applicable: nothing invoiced");
    const row = staffPage.locator(`[data-flagged-invoice="${invoiceId}"]`);
    await expect(row).toContainText("Reversal: partly refunded");
    await expect(staffPage.locator("body")).not.toContainText(
      "Invented private",
    );
    expect(
      await staffPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await staffPage.screenshot({
      path: info.outputPath("invoice-reconciliation.png"),
      fullPage: true,
    });
    await row.getByRole("link").click();
    await expect(staffPage).toHaveURL(new RegExp(invoiceId));
    const operator = await f.staff("operator");
    for (const denied of [operator.page, member]) {
      const response = await denied.goto(
        f.origin + "/operator/invoice-reconciliation",
      );
      expect(response?.status()).toBe(403);
      await expect(denied.locator("main")).not.toContainText("CAD");
    }
  } finally {
    await f.close();
  }
});
