import { EmailClient } from "@azure/communication-email";
import { ManagedIdentityCredential } from "@azure/identity";
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
        throw new Error("Email send was not confirmed");
    },
  };
}
