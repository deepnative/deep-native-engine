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
import { azureEmailSender } from "../../src/azure-email-sender.ts";

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
