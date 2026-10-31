import { expect, it } from "vitest";
import {
  simpleInvoiceDocument,
  type SimpleInvoiceDocument,
} from "../../src/simple-invoice-views.ts";

const invoice: SimpleInvoiceDocument = {
  number: "SAMPLE-001",
  issuedOn: "2026-10-31",
  issuer: "Invented preview issuer",
  billedTo: "陳 · Invented learner",
  lines: [{ description: "Invented learning course", amountCents: 10001 }],
  billing: { kind: "one_time" },
  currency: "CAD",
  taxCents: 0,
  paidCents: 2500,
  instructions: "Do not send money for this sample.",
  sample: true,
};

it("OFFPUR-08/09 lists consolidated courses on one individual one-time invoice", () => {
  const consolidated = {
    ...invoice,
    lines: [
      { description: "Claim checking · version 2", amountCents: 7000 },
      { description: "Workflow studio · version 1", amountCents: 3001 },
    ],
    billing: { kind: "one_time" as const },
  };
  const html = simpleInvoiceDocument(consolidated);
  expect(html).toContain("Claim checking · version 2");
  expect(html).toContain("Workflow studio · version 1");
  expect(html).toContain("CAD 70.00");
  expect(html).toContain("CAD 30.01");
  expect(html).toContain("One-time billing");
  expect(html).toContain("<dt>Total</dt><dd>CAD 100.01</dd>");
});

it("OFFPUR-10 shows the recurring invoice's own billing period and offline settlement", () => {
  const recurring = {
    ...invoice,
    billing: {
      kind: "recurring" as const,
      periodStart: "2026-11-01",
      periodEnd: "2026-12-01",
    },
  };
  const html = simpleInvoiceDocument(recurring);
  expect(html).toContain("Recurring billing");
  expect(html).toContain("2026-11-01");
  expect(html).toContain("2026-12-01");
  expect(html).toContain("No automatic payment is taken");
});

it("OFFPUR-02/04/07 renders an individual nonpayable sample with exact amounts and printable Unicode billing identity", () => {
  const html = simpleInvoiceDocument(invoice);
  expect(html).toContain("SAMPLE · NOT PAYABLE");
  expect(html).toContain(invoice.billedTo);
  expect(html).toContain("<dt>Total</dt><dd>CAD 100.01</dd>");
  expect(html).toContain("<dt>Recorded payment</dt><dd>CAD 25.00</dd>");
  expect(html).toContain("<dt>Balance</dt><dd>CAD 75.01</dd>");
  expect(html).toContain("issuer, amounts and tax are invented");
  expect(html).toContain("Print command");
  expect(html).not.toContain("Zoho");
});

it("OFFPUR-02/05 escapes billing data and describes an issued invoice without claiming payment receipt", () => {
  const html = simpleInvoiceDocument({
    ...invoice,
    number: '<img src=x onerror="bad()">',
    issuer: "<script>bad()</script>",
    billedTo: "<b>陳</b>",
    lines: [{ description: "<svg onload=bad()>", amountCents: 10001 }],
    instructions: "<iframe src=bad>",
    sample: false,
  });
  for (const tag of ["<img", "<script", "<b>", "<svg", "<iframe"])
    expect(html).not.toContain(tag);
  expect(html).toContain("&lt;b&gt;陳&lt;/b&gt;");
  expect(html).toContain("after staff records received funds");
  expect(html).not.toContain("SAMPLE · NOT PAYABLE");
});

it("OFFPUR-06 keeps the original invoice visible after an unpaid void and requires no payment", () => {
  const html = simpleInvoiceDocument({
    ...invoice,
    voidReason: "Wrong <course>",
  });
  expect(html).toContain("VOID · No payment due");
  expect(html).toContain("Wrong &lt;course&gt;");
  expect(html).toContain("<dt>Balance</dt><dd>CAD 0.00</dd>");
  expect(html).toContain("<dt>Total</dt><dd>CAD 100.01</dd>");
});
