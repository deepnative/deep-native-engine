import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withAccountView, type AccountRole } from "../../src/account-view.ts";
import {
  adminMenu,
  withAdministration,
} from "../../src/administration-presentation.ts";
import { agreementOutcomesUnavailablePage } from "../../src/agreement-outcomes-views.ts";
import { invoiceReconciliationUnavailablePage } from "../../src/invoice-reconciliation-views.ts";
import { withMembership } from "../../src/membership-presentation.ts";
import { withCurrentPath } from "../../src/navigation-presentation.ts";
import { simpleInvoiceDocument } from "../../src/simple-invoice-views.ts";
import { staffCapacityUnavailablePage } from "../../src/staff-capacity-views.ts";
import { page } from "../../src/views.ts";
import { mainHtml } from "../support/portal-layout.ts";

// #850: the three UI-review changes (#844, #845, #846) read as one system.
const id = "11111111-1111-4111-8111-111111111111";
const invoice = {
  number: `DN-${id}`,
  issuedOn: "2026-11-14",
  issuer: "Invented issuer",
  billedTo: "Mei Tanaka",
  lines: [{ description: "Coaching · 2026-09", amountCents: 72000 }],
  billing: { kind: "one_time" as const },
  currency: "CAD" as const,
  taxCents: 0,
  paidCents: 0,
  instructions: "Sample invoice only.",
  sample: true,
};

it("NAMES-02 no page text uses the old names for Students, Invoices, Coaching or My account", () => {
  const root = join(import.meta.dirname, "../../src");
  const old = [
    "Administration console",
    "Courses and invoices",
    "Course billing",
    "Billing recipient page",
    "Coaching administration",
    "Review coaching hours",
    "Choose another student",
    "My learning account",
    "(UTC date)",
    "Download a member's records",
  ];
  const found: string[] = [];
  for (const file of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
    // Comments explain history and may name what a page used to be called.
    const code = readFileSync(join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const name of old)
      if (code.includes(name)) found.push(`${file}: ${name}`);
  }
  expect(found).toEqual([]);
});

it("MENUALL-01/BACK-01 an administrator's invoice carries the menu and one All invoices link", () => {
  const menu = adminMenu("invoices");
  const html = mainHtml(
    simpleInvoiceDocument(invoice, true, [], undefined, menu),
  );
  expect(html).toContain(
    `<main id="main">${menu}<article class="invoice-document">`,
  );
  expect(html).toContain(
    '<p class="back-link"><a href="/operator/invoices">All invoices</a></p>',
  );
  expect(html.match(/All invoices/g)).toHaveLength(1);
  expect(html).not.toContain('class="button');
  expect(html.split("</nav>")[1]).not.toContain('href="/operator"');
});

it("BACK-01/SEAM-01 a student's invoice keeps one All invoices link, a readable date and a short title", () => {
  const full = simpleInvoiceDocument(invoice);
  const html = mainHtml(full);
  expect(html).not.toContain("admin-menu");
  expect(html).toContain(
    '<p class="back-link"><a href="/account/purchases">All invoices</a></p>',
  );
  expect(html).not.toContain('class="button');
  expect(html).not.toContain('href="/account"');
  expect(html).toContain("<p>Issued 14 Nov 2026</p>");
  // The document keeps its full number; the browser tab reads the short one.
  expect(html).toContain(`<p class="invoice-reference">DN-${id}</p>`);
  expect(full).toContain("<title>Invoice DN-11111111 · Deep Native Engine");
  // An issue date that is not a calendar day is shown as written, escaped.
  expect(simpleInvoiceDocument({ ...invoice, issuedOn: "<soon>" })).toContain(
    "<p>Issued &lt;soon&gt;</p>",
  );
});

it.each([
  ["invoice reconciliation", invoiceReconciliationUnavailablePage],
  ["course agreements", agreementOutcomesUnavailablePage],
  ["staff capacity", staffCapacityUnavailablePage],
] as const)(
  "NAMES-02 the %s refusal page links back to Students by that name",
  (_name, unavailable) => {
    const html = mainHtml(unavailable("denied"));
    expect(html).toContain(
      '<a href="/operator" class="button secondary">Students</a>',
    );
  },
);

const as = (view: AccountRole, path: string) =>
  withMembership({ signedIn: true, signInAvailable: true }, () =>
    withAdministration(true, () =>
      withAccountView(
        { roles: ["student", "coach", "admin"], view, csrf: "c".repeat(64) },
        () => withCurrentPath(path, () => page("Page", "")),
      ),
    ),
  );
it("SEAM-01 the header marks Coaching on a coach's page and Admin on More tools and moderation", () => {
  const coach = as("coach", "/coach");
  expect(coach).toContain('<a href="/coach" aria-current="page">Coaching</a>');
  expect(coach.match(/aria-current/g)).toHaveLength(1);
  for (const path of ["/staff", "/moderate/proposals"]) {
    const admin = as("admin", path);
    expect(admin).toContain('<a href="/admin" aria-current="page">Admin</a>');
    expect(admin.match(/aria-current/g)).toHaveLength(1);
  }
  expect(as("admin", "/staffing")).not.toContain("aria-current");
  expect(as("coach", "/coaching")).not.toContain("aria-current");
});
