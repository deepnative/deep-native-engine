import { ManagedIdentityCredential } from "@azure/identity";
import { createDefaultHttpClient } from "@azure/core-rest-pipeline";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { Readable } from "node:stream";
import { MAX_EVIDENCE_BYTES, type ObjectStorage } from "./evidence.ts";
import type { HostedConfig } from "./hosted-config.ts";
import { sampleUuid } from "./sample-feedback-values.ts";

const unavailable = () =>
  Error("Private object operation could not be confirmed.");
const keyFor = (key: string) => {
  if (!sampleUuid(key)) throw Error("Invalid private object key.");
  return key.toLowerCase();
};

/** No container creation, public links, fallback files or SDK write retries. */
export function blobObjectStorage(container: ContainerClient): ObjectStorage {
  return {
    requiresWriteRecovery: true,
    async abandon(key) {
      const blob = container.getBlockBlobClient(keyFor(key));
      try {
        // Never delete this empty fence: an outstanding create-only private
        // upload must not be able to recreate bytes after reconciliation.
        await blob.uploadData(Buffer.alloc(0), {
          metadata: {},
          blobHTTPHeaders: { blobContentType: "application/octet-stream" },
          abortSignal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw unavailable();
      }
    },
    async put(key, data) {
      const blob = container.getBlockBlobClient(keyFor(key));
      if (
        !Buffer.isBuffer(data) ||
        data.length < 1 ||
        data.length > MAX_EVIDENCE_BYTES
      )
        throw Error("Invalid private object bytes.");
      try {
        await blob.uploadData(data, {
          conditions: { ifNoneMatch: "*" },
          abortSignal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw unavailable();
      }
    },
    async get(key) {
      const blob = container.getBlobClient(keyFor(key));
      let body: Readable | undefined;
      try {
        const response = await blob.download(0, undefined, {
          maxRetryRequests: 0,
          abortSignal: AbortSignal.timeout(5_000),
        });
        body = response.readableStreamBody as Readable | undefined;
        if (!body) throw unavailable();
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk as Uint8Array);
          length += bytes.length;
          if (length > MAX_EVIDENCE_BYTES) throw unavailable();
          chunks.push(bytes);
        }
        if (length === 0) throw unavailable();
        return Buffer.concat(chunks, length);
      } catch {
        throw unavailable();
      } finally {
        body?.destroy();
      }
    },
    async remove(key) {
      const blob = container.getBlobClient(keyFor(key));
      try {
        await blob.deleteIfExists({ abortSignal: AbortSignal.timeout(5_000) });
      } catch {
        throw unavailable();
      }
    },
  };
}

export function azureObjectStorage(settings: HostedConfig): ObjectStorage {
  const identityTransport = createDefaultHttpClient();
  const credential = new ManagedIdentityCredential({
    clientId: settings.managedIdentityClientId,
    retryOptions: { maxRetries: 0 },
    httpClient: {
      sendRequest(request) {
        request.timeout = 5_000;
        return identityTransport.sendRequest(request);
      },
    },
  });
  const client = new BlobServiceClient(settings.blobAccountUrl, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 5_000 },
  });
  return blobObjectStorage(client.getContainerClient(settings.blobContainer));
}
