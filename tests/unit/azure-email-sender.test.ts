import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  credential: vi.fn(),
  client: vi.fn(),
  beginSend: vi.fn(),
  pollUntilDone: vi.fn(),
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) {
      sdk.credential(options);
    }
  },
}));
vi.mock("@azure/communication-email", () => ({
  EmailClient: class {
    constructor(...args: unknown[]) {
      sdk.client(...args);
    }
    beginSend = sdk.beginSend;
  },
}));
import {
  azureEmailSender,
  azureInvoiceSender,
} from "../../src/azure-email-sender.ts";

beforeEach(() => {
  vi.clearAllMocks();
  sdk.beginSend.mockResolvedValue({ pollUntilDone: sdk.pollUntilDone });
  sdk.pollUntilDone.mockResolvedValue({ status: "Succeeded" });
});

it("sends one private sign-in link using only the selected hosted managed identity", async () => {
  const sender = azureEmailSender(
    "https://synthetic.communication.azure.com",
    "noreply@example.com",
    "invented-identity",
  );
  await sender.send(
    "member@example.com",
    "https://engine.deepnative.io/email/confirm?code=invented",
  );
  expect(sdk.credential).toHaveBeenCalledExactlyOnceWith({
    clientId: "invented-identity",
  });
  expect(sdk.client).toHaveBeenCalledExactlyOnceWith(
    "https://synthetic.communication.azure.com",
    expect.anything(),
  );
  expect(sdk.beginSend).toHaveBeenCalledExactlyOnceWith(
    {
      senderAddress: "noreply@example.com",
      content: {
        subject: "Your Deep Native Engine sign-in link",
        plainText: expect.stringContaining(
          "https://engine.deepnative.io/email/confirm?code=invented",
        ),
      },
      recipients: { to: [{ address: "member@example.com" }] },
    },
    { abortSignal: expect.any(AbortSignal) },
  );
  expect(sdk.pollUntilDone).toHaveBeenCalledExactlyOnceWith({
    abortSignal: expect.any(AbortSignal),
  });
});

it("does not report delivery when the provider does not confirm it", async () => {
  sdk.pollUntilDone.mockResolvedValue({ status: "Failed" });
  await expect(
    azureEmailSender(
      "https://synthetic.communication.azure.com",
      "noreply@example.com",
      "invented-identity",
    ).send("member@example.com", "private-link"),
  ).rejects.toThrow("Email send was not confirmed");
});

it("OFFPUR-02 sends individual course invoices using a separate message from sign-in", async () => {
  const sender = azureInvoiceSender(
    "https://synthetic.communication.azure.com",
    "noreply@example.com",
    "invented-identity",
  );
  const doc = {
    number: "DN-invented",
    issuedOn: "2026-10-31",
    issuer: "Invented issuer",
    billedTo: "陳",
    lines: [
      { description: "Course A version 2", amountCents: 1000 },
      { description: "Course B version 1", amountCents: 2001 },
    ],
    billing: { kind: "one_time" as const },
    currency: "CAD" as const,
    taxCents: 390,
    paidCents: 0,
    instructions: "Invented instructions",
    sample: false,
  };
  await sender.send(
    "invented@example.invalid",
    doc,
    "https://example.invalid/account/purchases/invoices/invented",
  );
  const message = sdk.beginSend.mock.calls[0]![0];
  expect(message.recipients).toEqual({
    to: [{ address: "invented@example.invalid" }],
  });
  expect(message.content.subject).toBe("Deep Native invoice DN-invented");
  expect(message.content.plainText).toContain("Total: CAD 33.91");
  expect(message.content.plainText).toContain("Course A version 2: CAD 10.00");
  expect(message.content.plainText).toContain("陳");
  expect(message.content.plainText).not.toContain("15 minutes");
  expect(message.content.plainText).toContain("No automatic payment");
  await sender.send(
    "invented@example.invalid",
    { ...doc, sample: true },
    "private-invoice",
  );
  expect(sdk.beginSend.mock.calls[1]![0].content.plainText).toContain(
    "NOT PAYABLE",
  );
  sdk.pollUntilDone.mockResolvedValueOnce({ status: "Failed" });
  await expect(
    sender.send("invented@example.invalid", doc, "private-invoice"),
  ).rejects.toThrow("not confirmed");
  sdk.beginSend.mockRejectedValueOnce(Error("Provider unavailable"));
  await expect(
    sender.send("invented@example.invalid", doc, "private-invoice"),
  ).rejects.toThrow("Provider unavailable");
});
