import { expect, it } from "vitest";
import {
  invoiceCompany,
  invoiceDate,
  invoiceEvidence,
  invoicePaymentStatus,
  invoicePeriod,
  invoiceText,
  invoiceUuid,
  invoiceCents,
  invoiceTotal,
  validInvoiceTerms,
  invoiceDigest,
  parseInvoiceMoney,
  type InvoiceTerms,
} from "../../src/simple-invoice-values.ts";
const terms: InvoiceTerms = {
  courses: [
    {
      id: "FND-001",
      version: 2,
      description: "Task selection",
      amountCents: 1000,
    },
    {
      id: "FND-002",
      version: 2,
      description: "Useful requests",
      amountCents: 2000,
    },
  ],
  cadence: "monthly",
  startsOn: "2026-01-31",
  taxCents: 390,
  issuer: "Invented issuer",
  instructions: "Sample, not payable",
  sample: true,
};
it("OFFPUR-08/09 validates a consolidated exact-course proposal and sums integer cents", () => {
  expect(validInvoiceTerms(terms)).toBe(true);
  expect(invoiceTotal(terms)).toBe(3390);
  expect(validInvoiceTerms({ ...terms, cadence: "one_time" })).toBe(true);
});
it.each([
  { courses: [] },
  { courses: Array(21).fill(terms.courses[0]) },
  { courses: [terms.courses[0], terms.courses[0]] },
  { courses: [{ ...terms.courses[0], id: "" }] },
  { courses: [{ ...terms.courses[0], version: 0 }] },
  { courses: [{ ...terms.courses[0], version: 1.5 }] },
  { courses: [{ ...terms.courses[0], description: "" }] },
  { courses: [{ ...terms.courses[0], amountCents: -1 }] },
  {
    courses: [{ ...terms.courses[0], amountCents: 1_000_000_000 }],
    taxCents: 1,
  },
  { cadence: "weekly" },
  { startsOn: "2026-02-30" },
  { taxCents: 0.5 },
  { issuer: "" },
  { instructions: "" },
  { sample: "yes" },
  { courses: [{ ...terms.courses[0], amountCents: 0 }], taxCents: 0 },
])(
  "OFFPUR-01/08 refuses malformed, duplicate, unbounded or zero-price terms %#",
  (bad) => {
    expect(validInvoiceTerms({ ...terms, ...bad } as InvoiceTerms)).toBe(false);
  },
);
it("OFFPUR-05 rejects malformed identifiers, text and minor units at the boundary", () => {
  expect(invoiceUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  for (const value of [null, "bad", 4]) expect(invoiceUuid(value)).toBe(false);
  for (const value of [-1, NaN, Infinity, 0.1, "100", 1_000_000_001])
    expect(invoiceCents(value)).toBe(false);
  for (const value of [null, "", " ", "\0", "\ud800", "a".repeat(11)])
    expect(invoiceText(value, 10)).toBe(false);
  expect(invoiceText("陳\nToronto", 10)).toBe(true);
  for (const value of [null, "2026-1-01", "2026-13-01", "2026-02-30"])
    expect(invoiceDate(value)).toBe(false);
  expect(invoiceDate("2024-02-29")).toBe(true);
});
it("OFFPUR-10 anchors month-end recurrence without leap-year or short-month drift", () => {
  expect(invoicePeriod("2026-01-31", 0)).toEqual({
    start: "2026-01-31",
    end: "2026-02-28",
  });
  expect(invoicePeriod("2026-01-31", 1)).toEqual({
    start: "2026-02-28",
    end: "2026-03-31",
  });
  expect(invoicePeriod("2024-01-31", 1)).toEqual({
    start: "2024-02-29",
    end: "2024-03-31",
  });
  expect(invoicePeriod("2026-12-15", 1)).toEqual({
    start: "2027-01-15",
    end: "2027-02-15",
  });
  for (const [date, cycle] of [
    ["bad", 0],
    ["2026-01-01", -1],
    ["2026-01-01", 1.5],
    ["2026-01-01", 1201],
  ] as const)
    expect(() => invoicePeriod(date, cycle)).toThrow("Invalid invoice period");
});
it("OFFPUR-03 fingerprints the original intent without retaining it in a receipt key", () => {
  expect(invoiceDigest(terms)).toMatch(/^[a-f0-9]{64}$/);
  expect(invoiceDigest(terms)).toBe(invoiceDigest(terms));
  expect(invoiceDigest({ ...terms, taxCents: 391 })).not.toBe(
    invoiceDigest(terms),
  );
});
it("OFFPUR-05 rejects malformed persisted terms without throwing", () => {
  for (const value of [
    null,
    {},
    { ...terms, courses: [null] },
    { ...terms, courses: [1] },
  ])
    expect(validInvoiceTerms(value as InvoiceTerms)).toBe(false);
});

it("OFFPUR-04 parses only bounded decimal money without floating point rounding", () => {
  for (const [text, cents] of [
    ["0", 0],
    ["0.1", 10],
    ["10.01", 1001],
    ["10000000.00", 1000000000],
  ] as const)
    expect(parseInvoiceMoney(text)).toBe(cents);
  for (const text of [
    null,
    1,
    "",
    " 1",
    "01",
    "-1",
    "1e2",
    "1,000",
    "1.001",
    "10000000.01",
    "99999999",
  ])
    expect(parseInvoiceMoney(text)).toBeNull();
});

it("MANPAY-02 accepts one line of ordinary proof but not card-like numbers", () => {
  expect(invoiceEvidence("Interac invented-1234567")).toBe(true);
  expect(invoiceEvidence("123456789012")).toBe(true);
  for (const value of [
    "",
    "  ",
    "x".repeat(201),
    "4242424242424242",
    "4242 4242 4242 4242",
    "4242-4242-4242-4242",
    "two\nlines",
    7,
    null,
  ])
    expect(invoiceEvidence(value)).toBe(false);
});
it("MANPAY-04 words refunds separately and never as unpaid", () => {
  const base = { voidReason: null, totalCents: 100, paidCents: 100 };
  expect(invoicePaymentStatus({ ...base, paidCents: 0 })).toBe(
    "Awaiting offline payment",
  );
  expect(invoicePaymentStatus({ ...base, paidCents: 40 })).toBe(
    "Partially paid",
  );
  expect(invoicePaymentStatus(base)).toBe("Paid");
  expect(invoicePaymentStatus({ ...base, refundedCents: 40 })).toBe(
    "Partly refunded",
  );
  expect(invoicePaymentStatus({ ...base, refundedCents: 100 })).toBe(
    "Refunded",
  );
  expect(
    invoicePaymentStatus({ ...base, voidReason: "Wrong", paidCents: 0 }),
  ).toBe("Void");
});

it("RECIPIENT-04 reads an optional one-line company, blank as none", () => {
  expect(invoiceCompany(undefined)).toBeNull();
  expect(invoiceCompany(null)).toBeNull();
  expect(invoiceCompany("   ")).toBeNull();
  expect(invoiceCompany("  陳 Invented Co  ")).toBe("陳 Invented Co");
  expect(invoiceCompany("a".repeat(200))).toBe("a".repeat(200));
  for (const value of [3, "a".repeat(201), "Two\nlines", "Bad\u0000Co"])
    expect(invoiceCompany(value)).toBeUndefined();
});
