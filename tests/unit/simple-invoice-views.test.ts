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

it("HOUR04/08 #844 PLAIN-01 prints the coaching quantity and rate, no version or revision number, and the preserved replacement reference", () => {
  for (const replacesInvoiceId of [null, "invented-original"]) {
    const html = simpleInvoiceDocument({
      ...invoice,
      coaching: {
        month: "2026-10",
        minutes: 90,
        rateCents: 12000,
        rateVersion: 2,
        rateId: "invented-rate",
        submissionRevision: 4,
        replacesInvoiceId,
      },
    });
    expect(html).toContain("1 hour 30 minutes");
    expect(html).toContain(
      "<p>Month: October 2026 · 1 hour 30 minutes · CAD 120.00 per hour</p>",
    );
    expect(html).not.toMatch(/rate version|revision/i);
    expect(html).toContain("Coaching charges");
    expect(html.includes("Replaces void invoice")).toBe(
      replacesInvoiceId !== null,
    );
  }
});

it("PERIOD832-03 a coaching invoice for a defined billing period names its dates; a calendar month reads as before", () => {
  const coaching = {
    month: "2026-10-19",
    minutes: 90,
    rateCents: 12000,
    rateVersion: 2,
    rateId: "invented-rate",
    submissionRevision: 4,
    replacesInvoiceId: null,
  };
  const period = simpleInvoiceDocument({
    ...invoice,
    coaching: {
      ...coaching,
      periodStart: "2026-10-19",
      periodEnd: "2026-11-01",
    },
  });
  expect(period).toContain(
    "<h2>Coaching hours</h2><p>Billing period: 19 Oct 2026 to 1 Nov 2026 · 1 hour 30 minutes",
  );
  expect(period).not.toContain("Monthly coaching");
  expect(
    simpleInvoiceDocument({
      ...invoice,
      coaching: { ...coaching, month: "2026-10" },
    }),
  ).toContain("<h2>Monthly coaching</h2><p>Month: October 2026 · ");
});

it("TERMSINV318-01 #844 PLAIN-01 an invoice issued from coaching terms names the period, not a version number", () => {
  const html = simpleInvoiceDocument({
    ...invoice,
    coachingTerms: {
      version: 3,
      startsOn: "2026-12-01",
      endsOn: "2027-05-31",
    },
  });
  expect(html).toContain("<h2>Coaching terms</h2>");
  expect(html).toContain("<p>Coaching period 2026-12-01 to 2027-05-31</p>");
  expect(html).not.toMatch(/version/i);
  expect(html).toContain("Coaching charges");
  expect(simpleInvoiceDocument(invoice)).not.toContain("Coaching terms");
});

it("TESTPAY-10 labels signed test entries as simulated and keeps manual wording to manual entries", () => {
  const entry = {
    amountCents: 100,
    on: "2026-11-01",
    evidence: "Test event evt-1",
    verification: "signed_test_event" as const,
  };
  const all = simpleInvoiceDocument({ ...invoice }, false, [
    { ...entry, kind: "receipt" },
    { ...entry, kind: "refund" },
    { ...entry, kind: "failure" },
    { ...entry, kind: "held" },
  ]);
  for (const label of [
    "Test receipt",
    "Test refund",
    "Test payment failed",
    "Test event not applied",
    "No payment provider checked them and no money moved",
  ])
    expect(all).toContain(label);
  expect(all).not.toContain("Recorded manually by staff");
  const mixed = simpleInvoiceDocument({ ...invoice }, true, [
    { ...entry, kind: "receipt", recordedBy: "Signed test event" },
    {
      ...entry,
      kind: "refund",
      verification: "manual_unverified",
      recordedBy: "Staff account 12345678",
    },
  ]);
  expect(mixed).toContain("Recorded manually by staff");
  expect(mixed).toContain("No payment provider checked them");
  expect(mixed).toContain("Signed test event");
  const manual = simpleInvoiceDocument({ ...invoice }, false, [
    { ...entry, kind: "receipt", verification: "manual_unverified" },
  ]);
  expect(manual).not.toContain("No payment provider checked them");
});

it("SVC-07 shows the simulated service state only when one is given, saying nothing is provided", () => {
  expect(simpleInvoiceDocument(invoice)).not.toContain("Service (simulated)");
  for (const [service, words] of [
    [{ state: "awaiting_payment" }, "Awaiting payment"],
    [{ state: "ready", since: "2026-11-01" }, "Ready since 2026-11-01"],
    [
      { state: "withdrawn", since: "2026-11-02" },
      "Withdrawn after a test refund on 2026-11-02",
    ],
  ] as const) {
    const html = simpleInvoiceDocument(invoice, false, [], service);
    expect(html).toContain("<h2>Service (simulated)</h2>");
    expect(html).toContain(words);
    expect(html).toContain("It provides nothing and grants no access");
    expect(html).toContain("No payment provider checked it and no money moved");
  }
});

it("RECIPIENT-05 shows an optional company under Bill to only when it is set", () => {
  const html = simpleInvoiceDocument({
    ...invoice,
    billedToCompany: "<i>Invented</i> Co",
  });
  expect(html).toContain(
    `<h2>Bill to</h2><p>${invoice.billedTo}</p><p>&lt;i&gt;Invented&lt;/i&gt; Co</p>`,
  );
  expect(simpleInvoiceDocument(invoice)).toContain(
    `<h2>Bill to</h2><p>${invoice.billedTo}</p>${invoice.billing.kind === "one_time" ? "<p>One-time" : "<p>Recurring"}`,
  );
});

it("TERMS856-10 prints the payment terms and the due date under Issued", () => {
  const html = simpleInvoiceDocument({
    ...invoice,
    terms: "net_15",
    dueOn: "2026-11-15",
  });
  expect(html).toContain(
    "<p>Issued 31 Oct 2026</p><p>Payment terms: Net 15</p><p>Due 15 Nov 2026</p>",
  );
  expect(
    simpleInvoiceDocument({
      ...invoice,
      terms: "due_on_receipt",
      dueOn: "2026-10-31",
    }),
  ).toContain("<p>Payment terms: Due on receipt</p><p>Due 31 Oct 2026</p>");
});

it("TERMS856-11 an invoice issued before payment terms prints neither line", () => {
  const html = simpleInvoiceDocument(invoice);
  expect(html).not.toContain("Payment terms");
  expect(html).not.toMatch(/<p>Due /);
});

it("TERMS856-12 an invoice issued from the student's saved draft says so, without the reason", () => {
  const coaching = {
    month: "2026-10",
    minutes: 90,
    rateCents: 12000,
    rateVersion: 1,
    rateId: "invented-rate",
    submissionRevision: 3,
    replacesInvoiceId: null,
  };
  const line =
    "<p>Issued by the administrator from the student's saved hours.</p>";
  expect(
    simpleInvoiceDocument({
      ...invoice,
      coaching: { ...coaching, issuedFromDraft: true },
    }),
  ).toContain(line);
  expect(simpleInvoiceDocument({ ...invoice, coaching })).not.toContain(
    "Issued by the administrator",
  );
});

it("TERMS856-13 the replacement line names the replaced invoice's number when the store supplies it", () => {
  const coaching = {
    month: "2026-10",
    minutes: 90,
    rateCents: 12000,
    rateVersion: 1,
    rateId: "invented-rate",
    submissionRevision: 3,
    replacesInvoiceId: "invented-original",
  };
  expect(
    simpleInvoiceDocument({
      ...invoice,
      coaching,
      replacesNumber: "INV-0042",
    }),
  ).toContain(
    "<p>Replaces void invoice INV-0042. The original remains retained.</p>",
  );
  expect(simpleInvoiceDocument({ ...invoice, coaching })).toContain(
    "<p>Replaces void invoice DN-invented-original. The original remains retained.</p>",
  );
});
