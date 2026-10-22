import { ManagedIdentityCredential } from "@azure/identity";
import { createDefaultHttpClient } from "@azure/core-rest-pipeline";

/** pg calls this for each new physical connection; no stored password fallback. */
export function azureDatabasePassword(clientId: string): () => Promise<string> {
  const transport = createDefaultHttpClient();
  const credential = new ManagedIdentityCredential({
    clientId,
    retryOptions: { maxRetries: 0 },
    httpClient: {
      sendRequest(request) {
        request.timeout = 5_000;
        return transport.sendRequest(request);
      },
    },
  });
  return async () => {
    try {
      const value = await credential.getToken(
        "https://ossrdbms-aad.database.windows.net/.default",
        { abortSignal: AbortSignal.timeout(5_000) },
      );
      if (
        !value?.token ||
        !Number.isFinite(value.expiresOnTimestamp) ||
        value.expiresOnTimestamp <= Date.now() + 30_000
      )
        throw Error();
      return value.token;
    } catch {
      throw Error("Database identity authentication is unavailable.");
    }
  };
}
