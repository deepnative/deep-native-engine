import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  credential: vi.fn(),
  service: vi.fn(),
  container: vi.fn(),
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) {
      sdk.credential(options);
    }
  },
}));
vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: class {
    constructor(...options: unknown[]) {
      sdk.service(...options);
    }
    getContainerClient = sdk.container;
  },
}));
import {
  azureObjectStorage,
  blobObjectStorage,
} from "../../src/azure-object-storage.ts";
import { MAX_EVIDENCE_BYTES } from "../../src/evidence.ts";

const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const data = Buffer.from("Invented private evidence.");
const blob = {
  uploadData: vi.fn(),
  download: vi.fn(),
  deleteIfExists: vi.fn(),
};
const container = {
  getBlockBlobClient: vi.fn(() => blob),
  getBlobClient: vi.fn(() => blob),
};
const store = () => blobObjectStorage(container as unknown as ContainerClient);
beforeEach(() => {
  vi.clearAllMocks();
  blob.uploadData.mockResolvedValue({});
  blob.download.mockImplementation(async () => ({
    readableStreamBody: Readable.from([data]),
  }));
  blob.deleteIfExists.mockResolvedValue({ succeeded: true });
  sdk.container.mockReturnValue(container);
});

it("HOSTED-03 uses only the selected managed identity and existing private container, with SDK retries disabled", async () => {
  const hosted = {
    origin: "https://engine.deepnative.io",
    blobAccountUrl: "https://deepnative.blob.core.windows.net",
    blobContainer: "private-evidence",
    managedIdentityClientId: key,
  };
  const objects = azureObjectStorage(hosted);
  expect(sdk.credential).toHaveBeenCalledExactlyOnceWith({ clientId: key });
  expect(sdk.service).toHaveBeenCalledExactlyOnceWith(
    hosted.blobAccountUrl,
    expect.anything(),
    {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 5_000 },
    },
  );
  expect(sdk.container).toHaveBeenCalledExactlyOnceWith("private-evidence");
  await objects.put(key, data);
  expect(blob.uploadData).toHaveBeenCalledExactlyOnceWith(data, {
    conditions: { ifNoneMatch: "*" },
    abortSignal: expect.any(AbortSignal),
  });
});

it("HOSTED-03 reads bounded private bytes and closes the response stream", async () => {
  const body = Readable.from([data.subarray(0, 8), data.subarray(8)]);
  blob.download.mockResolvedValue({ readableStreamBody: body });
  expect(await store().get(key)).toEqual(data);
  expect(blob.download).toHaveBeenCalledExactlyOnceWith(0, undefined, {
    maxRetryRequests: 0,
    abortSignal: expect.any(AbortSignal),
  });
  expect(body.destroyed).toBe(true);
});

it("HOSTED-03 removes the exact private object idempotently without listing or public capabilities", async () => {
  await store().remove(key);
  blob.deleteIfExists.mockResolvedValue({ succeeded: false });
  await store().remove(key);
  expect(container.getBlobClient.mock.calls).toEqual([[key], [key]]);
  expect(blob.deleteIfExists).toHaveBeenCalledTimes(2);
});

it.each(["../secret", "https://other.example/blob", "", "not-an-object-key"])(
  "HOSTED-03 rejects object-key traversal or URL injection: %s",
  async (invalid) => {
    await expect(store().put(invalid, data)).rejects.toThrow(
      "Invalid private object key.",
    );
    await expect(store().get(invalid)).rejects.toThrow(
      "Invalid private object key.",
    );
    await expect(store().remove(invalid)).rejects.toThrow(
      "Invalid private object key.",
    );
    expect(blob.uploadData).not.toHaveBeenCalled();
    expect(blob.download).not.toHaveBeenCalled();
    expect(blob.deleteIfExists).not.toHaveBeenCalled();
  },
);

it.each([Buffer.alloc(0), Buffer.alloc(MAX_EVIDENCE_BYTES + 1), "not bytes"])(
  "HOSTED-03 refuses invalid private bytes before a write %#",
  async (invalid) => {
    await expect(store().put(key, invalid as Buffer)).rejects.toThrow(
      "Invalid private object bytes.",
    );
    expect(blob.uploadData).not.toHaveBeenCalled();
  },
);

it("HOSTED-03 does not expose provider errors or retry uncertain writes/deletes", async () => {
  blob.uploadData.mockRejectedValue(
    Error("secret provider token and private response"),
  );
  await expect(store().put(key, data)).rejects.toThrow(
    /^Private object operation could not be confirmed\.$/,
  );
  expect(blob.uploadData).toHaveBeenCalledTimes(1);
  blob.deleteIfExists.mockRejectedValue(Error("private deletion details"));
  await expect(store().remove(key)).rejects.toThrow(
    /^Private object operation could not be confirmed\.$/,
  );
  expect(blob.deleteIfExists).toHaveBeenCalledTimes(1);
});

it("HOSTED-03 rejects a failed or absent download without filesystem fallback", async () => {
  blob.download.mockRejectedValue(Error("private download URL"));
  await expect(store().get(key)).rejects.toThrow(
    /^Private object operation could not be confirmed\.$/,
  );
  blob.download.mockResolvedValue({});
  await expect(store().get(key)).rejects.toThrow(
    /^Private object operation could not be confirmed\.$/,
  );
});

it.each([Buffer.alloc(0), Buffer.alloc(MAX_EVIDENCE_BYTES + 1)])(
  "HOSTED-03 rejects empty or oversized provider bodies and destroys the stream %#",
  async (invalid) => {
    const body = Readable.from([invalid]);
    blob.download.mockResolvedValue({ readableStreamBody: body });
    await expect(store().get(key)).rejects.toThrow(
      /^Private object operation could not be confirmed\.$/,
    );
    expect(body.destroyed).toBe(true);
  },
);

it("HOSTED-03 propagates a streaming failure as unavailable without partial private bytes", async () => {
  const body = new Readable({
    read() {
      this.destroy(Error("private stream detail"));
    },
  });
  blob.download.mockResolvedValue({ readableStreamBody: body });
  await expect(store().get(key)).rejects.toThrow(
    /^Private object operation could not be confirmed\.$/,
  );
  expect(body.destroyed).toBe(true);
});
