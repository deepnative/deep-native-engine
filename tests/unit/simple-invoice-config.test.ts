import { expect, it } from "vitest";
import {
  simpleInvoiceSettings,
  testProviderEventKey,
} from "../../src/simple-invoice-config.ts";
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

it("DEMOSITE-01 allows nonpayable sample invoices on a host only when it is a visible demo site", () => {
  expect(() =>
    simpleInvoiceSettings({ DNE_INVOICE_MODE: "sample" }, true),
  ).toThrow("isolated local preview");
  expect(
    simpleInvoiceSettings(
      { DNE_INVOICE_MODE: "sample", DNE_DEMO_SITE: "enabled" },
      true,
    ),
  ).toEqual({
    sample: true,
    issuer: expect.stringContaining("Invented"),
    instructions: expect.stringContaining("Do not send money"),
  });
});
it("TESTPAY-01/02 keeps signed test events off by default, off every host and tied to samples", () => {
  const sample = { sample: true, issuer: "Invented", instructions: "Invented" };
  const on = {
    DNE_TEST_PROVIDER_EVENTS: "enabled",
    DNE_TEST_PROVIDER_EVENT_KEY: "invented-test-provider-key-0123456789",
  };
  expect(testProviderEventKey({}, false, sample)).toBeUndefined();
  // A leftover key alone turns nothing on.
  expect(
    testProviderEventKey(
      { DNE_TEST_PROVIDER_EVENT_KEY: on.DNE_TEST_PROVIDER_EVENT_KEY },
      true,
      sample,
    ),
  ).toBeUndefined();
  expect(testProviderEventKey(on, false, sample)).toBe(
    on.DNE_TEST_PROVIDER_EVENT_KEY,
  );
  expect(() => testProviderEventKey(on, true, sample)).toThrow("hosted");
  expect(() =>
    testProviderEventKey({ ...on, DNE_DEMO_SITE: "enabled" }, true, sample),
  ).toThrow("hosted");
  expect(() => testProviderEventKey(on, false, undefined)).toThrow("sample");
  expect(() =>
    testProviderEventKey(on, false, { ...sample, sample: false }),
  ).toThrow("sample");
  expect(() =>
    testProviderEventKey(
      { DNE_TEST_PROVIDER_EVENTS: "enabled" },
      false,
      sample,
    ),
  ).toThrow("invented key");
  expect(() =>
    testProviderEventKey(
      { ...on, DNE_TEST_PROVIDER_EVENT_KEY: "short" },
      false,
      sample,
    ),
  ).toThrow("invented key");
  expect(() =>
    testProviderEventKey({ DNE_TEST_PROVIDER_EVENTS: "yes" }, false, sample),
  ).toThrow("must be");
});
