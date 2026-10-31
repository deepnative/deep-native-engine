import { invoiceText } from "./simple-invoice-values.ts";
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
    if (hosted)
      throw Error("Sample invoicing requires an isolated local preview.");
    return {
      sample: true,
      issuer: "Invented Deep Native preview issuer",
      instructions: "Sample invoice only. Do not send money.",
    };
  }
  const issuer = env.DNE_INVOICE_ISSUER,
    instructions = env.DNE_INVOICE_PAYMENT_INSTRUCTIONS;
  if (
    !invoiceText(issuer, 500) ||
    !invoiceText(instructions, 2000) ||
    env.DNE_INVOICE_CURRENCY !== "CAD"
  )
    throw Error(
      "Configured invoicing requires issuer, offline instructions and explicit CAD currency.",
    );
  return { sample: false, issuer, instructions };
}
