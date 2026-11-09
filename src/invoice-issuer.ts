import type { InvoiceTax } from "./simple-invoice-values.ts";
/**
 * ISSUER-01 (#32): the owner's 9 November 2026 decision, the one record of
 * who issues real (configured) invoices. Sample invoices never use it.
 */
export const DEEP_NATIVE_INVOICE_ISSUER: {
  issuer: string;
  instructions: string;
  tax: InvoiceTax;
} = {
  issuer: "Deep Native Inc. · Ontario, Canada",
  instructions:
    "Pay by Interac e-Transfer to info@deepnative.io or by cheque to Deep Native Inc.",
  tax: { label: "HST", registration: "713254472RT0001", rateBasisPoints: 1300 },
};
