import { EmailClient } from "@azure/communication-email";
import { ManagedIdentityCredential } from "@azure/identity";
import type { InvoiceSender } from "./simple-invoice-routes.ts";
import { taxRate } from "./simple-invoice-values.ts";
import type { MemberEmailSender } from "./member-email-access.ts";

/** Only configured hosted previews can send; no fallback to local logs or files. */
export function azureEmailSender(
  endpoint: string,
  senderAddress: string,
  managedIdentityClientId: string,
): MemberEmailSender {
  const credential = new ManagedIdentityCredential({
    clientId: managedIdentityClientId,
  });
  const client = new EmailClient(endpoint, credential);
  return {
    async send(address, link) {
      const poller = await client.beginSend(
        {
          senderAddress,
          content: {
            subject: "Your Deep Native Engine sign-in link",
            plainText: `Open this private link to confirm your email or return to your saved learning:\n${link}\n\nThe link expires after 15 minutes and can be used once. If you did not request it, ignore this message.`,
          },
          recipients: { to: [{ address }] },
        },
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      const result = await poller.pollUntilDone({
        abortSignal: AbortSignal.timeout(30_000),
      });
      if (result.status !== "Succeeded")
        throw Object.assign(new Error("Email send was not confirmed"), {
          code: result.error?.code,
        });
    },
    async sendNoAccount(address, startLink) {
      const poller = await client.beginSend(
        {
          senderAddress,
          content: {
            subject: "No Deep Native Engine account uses this email yet",
            plainText: `Someone asked for a sign-in link for this address, but no Deep Native Engine account uses it yet. You don't need to sign in first.\n\nTo start, open ${startLink} and fill in the start form. If it asks for an email and password, use this address. Otherwise, after you start, open My account and choose Link an email to keep access on any device.\n\nIf you did not ask for this, ignore this message. Nothing has been created.`,
          },
          recipients: { to: [{ address }] },
        },
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      const result = await poller.pollUntilDone({
        abortSignal: AbortSignal.timeout(30_000),
      });
      if (result.status !== "Succeeded")
        throw Object.assign(new Error("Email send was not confirmed"), {
          code: result.error?.code,
        });
    },
  };
}

/** Invoice correspondence has its own content; it is never an authentication link. */
export function azureInvoiceSender(
  endpoint: string,
  senderAddress: string,
  managedIdentityClientId: string,
): InvoiceSender {
  const credential = new ManagedIdentityCredential({
    clientId: managedIdentityClientId,
  });
  const client = new EmailClient(endpoint, credential);
  return {
    async send(address, invoice, link) {
      const total = invoice.lines.reduce(
        (sum, line) => sum + line.amountCents,
        invoice.taxCents,
      );
      const poller = await client.beginSend(
        {
          senderAddress,
          content: {
            subject: `Deep Native invoice ${invoice.number}`,
            plainText: `Invoice ${invoice.number}\nFrom: ${invoice.issuer}\n${invoice.tax ? `${invoice.tax.label} registration number ${invoice.tax.registration}\n` : ""}Bill to: ${invoice.billedTo}${invoice.billedToCompany ? ` · ${invoice.billedToCompany}` : ""}\n${invoice.lines.map((line) => `${line.description}: CAD ${(line.amountCents / 100).toFixed(2)}`).join("\n")}\n${invoice.tax ? `${invoice.tax.label} (${taxRate(invoice.tax)}): CAD ${(invoice.taxCents / 100).toFixed(2)}\n` : ""}Total: CAD ${(total / 100).toFixed(2)}\n\n${invoice.instructions}\n\nOpen your own signed-in account to inspect and print/save this invoice as PDF:\n${link}\n\n${invoice.sample ? "SAMPLE ONLY — NOT PAYABLE." : "Pay offline using the instructions above. No automatic payment is taken."}`,
          },
          recipients: { to: [{ address }] },
        },
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      const result = await poller.pollUntilDone({
        abortSignal: AbortSignal.timeout(30_000),
      });
      if (result.status !== "Succeeded")
        throw Error("Invoice email send was not confirmed");
    },
  };
}
