import { expect, it } from "vitest";
import { simpleInvoiceSettings } from "../../src/simple-invoice-config.ts";
it("OFFPUR-07 keeps invoices off until explicitly configured and isolates nonpayable samples", () => {
  expect(simpleInvoiceSettings({}, false)).toBeUndefined();
  expect(
    simpleInvoiceSettings({ DNE_INVOICE_MODE: "disabled" }, true),
  ).toBeUndefined();
  expect(simpleInvoiceSettings({ DNE_INVOICE_MODE: "sample" }, false)).toEqual({
    sample: true,
    issuer: expect.stringContaining("Invented"),
    instructions: expect.stringContaining("Do not send money"),
  });
  expect(() =>
    simpleInvoiceSettings({ DNE_INVOICE_MODE: "sample" }, true),
  ).toThrow("isolated local preview");
  expect(() =>
    simpleInvoiceSettings({ DNE_INVOICE_MODE: "unknown" }, false),
  ).toThrow("must be");
});
it("OFFPUR-07 requires explicit issuer, offline instructions and currency before payable issuance", () => {
  const env = {
    DNE_INVOICE_MODE: "configured",
    DNE_INVOICE_ISSUER: "Configured test issuer",
    DNE_INVOICE_PAYMENT_INSTRUCTIONS: "Configured test instructions",
    DNE_INVOICE_CURRENCY: "CAD",
  };
  expect(simpleInvoiceSettings(env, true)).toEqual({
    sample: false,
    issuer: env.DNE_INVOICE_ISSUER,
    instructions: env.DNE_INVOICE_PAYMENT_INSTRUCTIONS,
  });
  for (const change of [
    { DNE_INVOICE_ISSUER: "" },
    { DNE_INVOICE_PAYMENT_INSTRUCTIONS: "" },
    { DNE_INVOICE_CURRENCY: "USD" },
  ])
    expect(() => simpleInvoiceSettings({ ...env, ...change }, true)).toThrow(
      "requires issuer",
    );
});
