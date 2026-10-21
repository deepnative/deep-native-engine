import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { blobObjectStorage } from "../../src/azure-object-storage.ts";
import { evidenceStore } from "../../src/evidence.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// This owned protocol fixture proves storage semantics, not Azure identity or
// cloud durability. Service-version validation stays enabled.
const name = `dne-hosted-objects-${randomBytes(12).toString("hex")}`;
const account = "dneprotocol";
const key = randomBytes(64).toString("base64");
let directory = "";
let created = false;
let endpoint = "";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const client = () =>
  new BlobServiceClient(
    endpoint,
    new StorageSharedKeyCredential(account, key),
    {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 5_000 },
    },
  );
function currentEndpoint() {
  const port = docker("port", name, "10000/tcp");
  if (!/^127\.0\.0\.1:\d+$/.test(port))
    throw Error("Owned Blob fixture did not bind loopback.");
  endpoint = `http://${port}/${account}`;
}
async function ready() {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await client().getProperties();
      return;
    } catch {
      if (Date.now() >= deadline)
        throw Error("Owned Blob fixture did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dne-hosted-blob-"));
  const envFile = join(directory, "emulator.env");
  await writeFile(envFile, `AZURITE_ACCOUNTS=${account}:${key}\n`, {
    mode: 0o600,
  });
  docker(
    "create",
    "--name",
    name,
    "--publish",
    "127.0.0.1::10000",
    "--env-file",
    envFile,
    "mcr.microsoft.com/azure-storage/azurite:3.37.0",
    "azurite-blob",
    "--blobHost",
    "0.0.0.0",
    "--location",
    "/data",
    "--silent",
  );
  created = true;
  docker("start", name);
  currentEndpoint();
  await ready();
}, 60_000);
afterAll(async () => {
  try {
    if (created) docker("rm", "--force", name);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it("HOSTED-03/04 preserves owned PostgreSQL evidence and private Blob bytes across client and storage-process restart", async () => {
  let pool: Pool | undefined = testPool();
  const token = randomBytes(32).toString("hex");
  const bytes = Buffer.from(
    "Invented private hosted-storage acceptance sample.",
  );
  const containerName = `evidence-${randomBytes(8).toString("hex")}`;
  const container = client().getContainerClient(containerName);
  await container.create();
  try {
    expect((await container.getProperties()).blobPublicAccess).toBeUndefined();
    await migrate(pool);
    const db = store(pool);
    await db.create(token, { background: "explorer", goal: "everyday" });
    const objects = blobObjectStorage(container);
    const evidence = evidenceStore(pool, objects, "protocol-test-only");
    const uploaded = await evidence.upload(token, {
      name: "invented.txt",
      mediaType: "text/plain",
      data: bytes,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (uploaded.kind !== "created")
      throw Error("Owned protocol evidence was not created.");
    // Quarantine is controlled only as a native test fixture, never as hosted
    // member activity or a claim that a real scan ran.
    expect(await evidence.transitionQuarantine(uploaded.id, "clean")).toBe(
      true,
    );
    const row = (
      await pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM evidence_objects WHERE id=$1",
        [uploaded.id],
      )
    ).rows[0]!;
    await expect(
      objects.put(row.storage_key, Buffer.from("replacement")),
    ).rejects.toThrow("could not be confirmed");
    expect(await objects.get(row.storage_key)).toEqual(bytes);
    const anonymous = new BlobServiceClient(endpoint).getContainerClient(
      containerName,
    );
    await expect(
      anonymous.getBlobClient(row.storage_key).download(),
    ).rejects.toMatchObject({ statusCode: 403 });
    await pool.end();
    pool = undefined;
    docker("restart", name);
    currentEndpoint();
    await ready();
    pool = testPool();
    const resumedObjects = blobObjectStorage(
      client().getContainerClient(containerName),
    );
    const resumed = evidenceStore(pool, resumedObjects, "protocol-test-only");
    expect((await store(pool).session(token)).kind).toBe("active");
    const issued = await resumed.issueDownload(token, uploaded.id);
    if (issued.kind !== "issued")
      throw Error("Persisted owner could not issue download.");
    const downloaded = await resumed.download(
      token,
      uploaded.id,
      issued.capability,
    );
    expect(downloaded).toMatchObject({ kind: "allowed", data: bytes });
    expect(
      await resumed.issueDownload(randomBytes(32).toString("hex"), uploaded.id),
    ).toEqual({ kind: "denied" });
    expect(await resumed.remove(token, uploaded.id)).toBe(true);
    await resumedObjects.remove(row.storage_key);
    await expect(resumedObjects.get(row.storage_key)).rejects.toThrow(
      "could not be confirmed",
    );
  } finally {
    await pool?.end();
  }
}, 60_000);
