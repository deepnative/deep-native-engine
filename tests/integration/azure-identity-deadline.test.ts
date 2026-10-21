import { expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { azureObjectStorage } from "../../src/azure-object-storage.ts";

it("HOSTED-03 bounds a stalled managed-identity exchange without a Blob request or authentication retry", async () => {
  const responses: ServerResponse[] = [];
  const server = createServer((_req, res) => responses.push(res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Identity fixture has no TCP address.");
  vi.stubEnv("IDENTITY_ENDPOINT", `http://127.0.0.1:${address.port}/token`);
  vi.stubEnv("IDENTITY_HEADER", "invented-native-identity-header");
  for (const key of [
    "IDENTITY_SERVER_THUMBPRINT",
    "IMDS_ENDPOINT",
    "AZURE_FEDERATED_TOKEN_FILE",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
  ])
    vi.stubEnv(key, undefined);
  const objects = azureObjectStorage({
    origin: "https://engine.deepnative.io",
    blobAccountUrl: "https://dnenativenevercontact.blob.core.windows.net",
    blobContainer: "private-evidence",
    managedIdentityClientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const operation = objects.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").then(
    () => "unexpected-bytes",
    () => "unavailable",
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("still-pending"), 6_500);
      }),
    ]);
    expect(responses).toHaveLength(1);
    expect(outcome).toBe("unavailable");
  } finally {
    clearTimeout(timeout);
    for (const response of responses)
      response.writeHead(400).end('{"error":"invalid_request"}');
    await operation;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  }
}, 15_000);
