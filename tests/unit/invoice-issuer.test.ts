import { expect, it } from "vitest";
import { DEEP_NATIVE_INVOICE_ISSUER } from "../../src/invoice-issuer.ts";
import { simpleInvoiceSettings } from "../../src/simple-invoice-config.ts";
import {
  salesTaxCents,
  validInvoiceTerms,
} from "../../src/simple-invoice-values.ts";
import {
  simpleInvoiceDocument,
  type SimpleInvoiceDocument,
} from "../../src/simple-invoice-views.ts";

// #32 owner decision, 9 Nov 2026. Invented members and amounts only.
const configured = {
  DNE_INVOICE_MODE: "configured",
  DNE_INVOICE_CURRENCY: "CAD",
};
const owner = {
  issuer: "Deep Native Inc. · Ontario, Canada",
  instructions:
    "Pay by Interac e-Transfer to info@deepnative.io or by cheque to Deep Native Inc.",
  tax: {
    label: "HST" as const,
    registration: "713254472RT0001",
    rateBasisPoints: 1300,
  },
};

it("ISSUER-01 reads the owner's issuer, HST and instructions from one record", () => {
  expect(DEEP_NATIVE_INVOICE_ISSUER).toEqual(owner);
  expect(simpleInvoiceSettings(configured, true)).toEqual({
    sample: false,
    ...owner,
  });
  for (const leftover of [
    { DNE_INVOICE_ISSUER: "Someone else" },
    { DNE_INVOICE_PAYMENT_INSTRUCTIONS: "Pay somewhere else" },
  ])
    expect(() =>
      simpleInvoiceSettings({ ...configured, ...leftover }, true),
    ).toThrow("issuer record");
  expect(() =>
    simpleInvoiceSettings({ ...configured, DNE_INVOICE_CURRENCY: "USD" }, true),
  ).toThrow("CAD");
  expect(() =>
    simpleInvoiceSettings({ DNE_INVOICE_MODE: "configured" }, true),
  ).toThrow("CAD");
});

it("ISSUER-07 leaves sample invoices invented, with no HST record", () => {
  const sample = simpleInvoiceSettings({ DNE_INVOICE_MODE: "sample" }, false)!;
  expect(sample.sample).toBe(true);
  expect(sample.issuer).toContain("Invented");
  expect(sample).not.toHaveProperty("tax");
});

it("ISSUER-02/03 charges 13% HST on the subtotal, rounded half up to the cent", () => {
  expect(salesTaxCents(10000, owner.tax)).toBe(1300);
  expect(salesTaxCents(1999, owner.tax)).toBe(260); // 259.87
  expect(salesTaxCents(50, owner.tax)).toBe(7); // 6.5 rounds up
  expect(salesTaxCents(1, owner.tax)).toBe(0);
  expect(salesTaxCents(1_000_000_000, owner.tax)).toBe(130_000_000);
});

it("ISSUER-02 accepts terms whose HST matches the subtotal and refuses any other tax", () => {
  const terms = {
    courses: [
      { id: "FND-001", version: 1, description: "Invented", amountCents: 7000 },
      { id: "FND-002", version: 1, description: "Invented", amountCents: 3001 },
    ],
    cadence: "one_time" as const,
    startsOn: "2026-11-30",
    taxCents: 1300,
    sample: false,
    ...owner,
  };
  expect(validInvoiceTerms(terms)).toBe(true);
  expect(validInvoiceTerms({ ...terms, taxCents: 1299 })).toBe(false);
  expect(validInvoiceTerms({ ...terms, taxCents: 0 })).toBe(false);
  expect(
    validInvoiceTerms({ ...terms, tax: { ...owner.tax, rateBasisPoints: -1 } }),
  ).toBe(false);
  expect(
    validInvoiceTerms({ ...terms, tax: { ...owner.tax, registration: "" } }),
  ).toBe(false);
});

const real: SimpleInvoiceDocument = {
  number: "DN-invented",
  issuedOn: "2026-11-09",
  issuer: owner.issuer,
  billedTo: "Invented learner",
  lines: [{ description: "Invented course", amountCents: 10000 }],
  billing: { kind: "one_time" },
  currency: "CAD",
  taxCents: 1300,
  paidCents: 0,
  instructions: owner.instructions,
  sample: false,
  tax: owner.tax,
};

it("ISSUER-04 prints the issuer, HST registration, HST line and instructions with no address", () => {
  for (const admin of [false, true]) {
    const html = simpleInvoiceDocument(real, admin);
    expect(html).toContain("Deep Native Inc. · Ontario, Canada");
    expect(html).toContain("HST registration number 713254472RT0001");
    expect(html).toContain("<dt>HST (13%)</dt><dd>CAD 13.00</dd>");
    expect(html).toContain("<dt>Total</dt><dd>CAD 113.00</dd>");
    expect(html).toContain(
      "Pay by Interac e-Transfer to info@deepnative.io or by cheque to Deep Native Inc.",
    );
    expect(html).not.toMatch(/mailing address|PO Box|Suite \d/i);
  }
  // An invoice issued before the decision keeps its own snapshot.
  const old = simpleInvoiceDocument({ ...real, tax: undefined, taxCents: 500 });
  expect(old).toContain("<dt>Tax</dt><dd>CAD 5.00</dd>");
  expect(old).not.toContain("HST registration");
});

it("ISSUER-05 describes manual payments as recorded by staff, never mentioning a provider", () => {
  const html = simpleInvoiceDocument({ ...real, paidCents: 11300 }, false, [
    {
      kind: "receipt",
      amountCents: 11300,
      on: "2026-11-09",
      evidence: "Invented e-Transfer reference",
      verification: "manual_unverified",
    },
  ]);
  expect(html).toContain(
    "Recorded manually by staff when the offline payment was received.",
  );
  expect(html).not.toMatch(/payment provider/i);
});
