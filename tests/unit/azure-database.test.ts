import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  options: vi.fn(),
  token: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@azure/core-rest-pipeline", () => ({
  createDefaultHttpClient: () => ({ sendRequest: sdk.send }),
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) {
      sdk.options(options);
    }
    getToken = sdk.token;
  },
}));
import { azureDatabasePassword } from "../../src/azure-database.ts";
beforeEach(() => vi.clearAllMocks());
it("HOSTED-11 acquires valid database-scoped tokens on new connections using only the selected identity", async () => {
  const password = azureDatabasePassword(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  sdk.token
    .mockResolvedValueOnce({
      token: "invented-first",
      expiresOnTimestamp: Date.now() + 600_000,
    })
    .mockResolvedValueOnce({
      token: "invented-next",
      expiresOnTimestamp: Date.now() + 600_000,
    });
  expect(await password()).toBe("invented-first");
  expect(await password()).toBe("invented-next");
  expect(sdk.options).toHaveBeenCalledExactlyOnceWith({
    clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    retryOptions: { maxRetries: 0 },
    httpClient: { sendRequest: expect.any(Function) },
  });
  expect(sdk.token).toHaveBeenCalledTimes(2);
  expect(sdk.token).toHaveBeenCalledWith(
    "https://ossrdbms-aad.database.windows.net/.default",
    { abortSignal: expect.any(AbortSignal) },
  );
  const request = { timeout: 0 };
  await sdk.options.mock.calls[0]![0].httpClient.sendRequest(request);
  expect(request.timeout).toBe(5_000);
  expect(sdk.send).toHaveBeenCalledExactlyOnceWith(request);
});
it.each([
  null,
  { token: "invalid-expiry", expiresOnTimestamp: Number.NaN },
  { token: "", expiresOnTimestamp: Date.now() + 600_000 },
  { token: "expired-private-token", expiresOnTimestamp: 0 },
])(
  "HOSTED-11 refuses missing or expired credentials without disclosing tokens %#",
  async (value) => {
    sdk.token.mockResolvedValue(value);
    await expect(azureDatabasePassword("selected-identity")()).rejects.toThrow(
      "Database identity authentication is unavailable.",
    );
  },
);
it("HOSTED-11 fails closed without echoing an identity response or using a static password", async () => {
  sdk.token.mockRejectedValue(Error("private-token-response"));
  await expect(azureDatabasePassword("selected-identity")()).rejects.toThrow(
    /^Database identity authentication is unavailable\.$/,
  );
  expect(sdk.token).toHaveBeenCalledTimes(1);
});
