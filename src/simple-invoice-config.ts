import { DEEP_NATIVE_INVOICE_ISSUER } from "./invoice-issuer.ts";
import type { InvoiceSettings } from "./simple-invoice-store.ts";
export function simpleInvoiceSettings(
  env: NodeJS.ProcessEnv,
  hosted: boolean,
): InvoiceSettings | undefined {
  const mode = env.DNE_INVOICE_MODE ?? "disabled";
  if (!["disabled", "sample", "configured"].includes(mode))
    throw Error("DNE_INVOICE_MODE must be disabled, sample or configured.");
  if (mode === "disabled") return undefined;
  if (mode === "sample") {
    // DEMOSITE-01: a host may issue samples only while it says it is a demo.
    if (hosted && env.DNE_DEMO_SITE !== "enabled")
      throw Error("Sample invoicing requires an isolated local preview.");
    return {
      sample: true,
      issuer: "Invented Deep Native preview issuer",
      instructions: "Sample invoice only. Do not send money.",
    };
  }
  // ISSUER-01 (#32): the issuer facts come from one reviewed record, not env.
  if (
    env.DNE_INVOICE_ISSUER !== undefined ||
    env.DNE_INVOICE_PAYMENT_INSTRUCTIONS !== undefined
  )
    throw Error(
      "Configured invoicing uses the Deep Native Inc. issuer record; remove DNE_INVOICE_ISSUER and DNE_INVOICE_PAYMENT_INSTRUCTIONS.",
    );
  if (env.DNE_INVOICE_CURRENCY !== "CAD")
    throw Error("Configured invoicing requires explicit CAD currency.");
  return { sample: false, ...DEEP_NATIVE_INVOICE_ISSUER };
}
/** TESTPAY-01/02: off unless set, and never on a host, including the demo site. */
export function testProviderEventKey(
  env: NodeJS.ProcessEnv,
  hosted: boolean,
  invoices: InvoiceSettings | undefined,
): string | undefined {
  const mode = env.DNE_TEST_PROVIDER_EVENTS ?? "disabled";
  if (!["enabled", "disabled"].includes(mode))
    throw Error("DNE_TEST_PROVIDER_EVENTS must be enabled or disabled.");
  if (mode === "disabled") return undefined;
  if (hosted) throw Error("Signed test events cannot run on a hosted site.");
  if (!invoices?.sample)
    throw Error("Signed test events require sample invoicing.");
  const key = env.DNE_TEST_PROVIDER_EVENT_KEY;
  if (!key || !/^[A-Za-z0-9_-]{32,200}$/.test(key))
    throw Error(
      "Signed test events require an invented key of 32+ characters.",
    );
  return key;
}
