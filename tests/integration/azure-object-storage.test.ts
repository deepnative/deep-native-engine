import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
import { recoverPendingMemberDeletions } from "../../src/deletion-recovery.ts";
import {
  objectWriteJournal,
  recoverPendingObjectWrites,
} from "../../src/object-write-recovery.ts";

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

it.each(["upload", "derivative"] as const)(
  "HOSTED-06 owner deletion recovers private %s bytes after a lost object acknowledgement",
  async (kind) => {
    const pool = testPool();
    const token = randomBytes(32).toString("hex");
    const container = client().getContainerClient(
      `uncertain-${randomBytes(8).toString("hex")}`,
    );
    await container.create();
    const actual = blobObjectStorage(container);
    let loseAcknowledgement = false;
    let uncertainKey = "";
    const objects = {
      ...actual,
      async put(key: string, data: Buffer) {
        await actual.put(key, data);
        if (loseAcknowledgement) {
          uncertainKey = key;
          throw Error("Controlled lost object acknowledgement.");
        }
      },
    };
    const evidence = evidenceStore(pool, objects, "uncertain-protocol-test");
    const bytes = Buffer.from("Invented uncertain private object.");
    const input = {
      name: "uncertain.txt",
      mediaType: "text/plain",
      data: bytes,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    };
    try {
      await migrate(pool);
      const db = store(pool);
      await db.create(token, { background: "explorer", goal: "everyday" });
      const session = await db.session(token);
      if (session.kind !== "active")
        throw Error("Native owner was not created.");
      if (kind === "derivative") {
        const source = await evidence.upload(token, input);
        if (source.kind !== "created")
          throw Error("Native derivative source was not created.");
        expect(await evidence.transitionQuarantine(source.id, "clean")).toBe(
          true,
        );
        loseAcknowledgement = true;
        await expect(
          evidence.addDerivative(source.id, "text-extract", bytes),
        ).rejects.toThrow("Controlled lost object acknowledgement.");
      } else {
        loseAcknowledgement = true;
        await expect(evidence.upload(token, input)).rejects.toThrow(
          "Controlled lost object acknowledgement.",
        );
      }
      expect(await actual.get(uncertainKey)).toEqual(bytes);
      await evidence.removeWorkspace(token);
      await db.remove(session.learner.id);
      await recoverPendingMemberDeletions(pool, objects);
      await expect(actual.get(uncertainKey)).rejects.toThrow(
        "could not be confirmed",
      );
    } finally {
      await pool.end();
    }
  },
  30_000,
);

it("HOSTED-06 skips an active writer and preserves a committed source after an object-key collision", async () => {
  const pool = testPool();
  await migrate(pool);
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const container = client().getContainerClient(
    `active-${randomBytes(8).toString("hex")}`,
  );
  await container.create();
  const actual = blobObjectStorage(container);
  const bytes = Buffer.from("Invented active private upload.");
  let key = "";
  let entered!: () => void;
  let resume!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueWrite = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const objects = {
    ...actual,
    async put(id: string, data: Buffer) {
      key = id;
      await actual.put(id, data);
      entered();
      await continueWrite;
    },
  };
  const pending = evidenceStore(pool, objects, "native-active-writer").upload(
    token,
    {
      name: "active.txt",
      mediaType: "text/plain",
      data: bytes,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    },
  );
  try {
    await Promise.race([
      writing,
      pending.then(() => {
        throw Error("Expected an in-progress provider write.");
      }),
    ]);
    expect(await recoverPendingObjectWrites(pool, actual)).toMatchObject({
      examined: 1,
      completed: 0,
      failed: 0,
    });
    expect(await actual.get(key)).toEqual(bytes);
    resume();
    expect(await pending).toMatchObject({ kind: "created" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM private_object_write_intents",
        )
      ).rows[0].n,
    ).toBe(0);
    const lease = await pool.connect();
    try {
      await objectWriteJournal.prepare(lease, key);
      await expect(actual.put(key, Buffer.from("collision"))).rejects.toThrow(
        "could not be confirmed",
      );
      await objectWriteJournal.release(lease, key);
    } finally {
      lease.release();
    }
    expect(await recoverPendingObjectWrites(pool, actual)).toMatchObject({
      completed: 1,
      failed: 0,
    });
    expect(await actual.get(key)).toEqual(bytes);
  } finally {
    resume();
    await pending.catch(() => {});
    await pool.end();
  }
}, 30_000);

it("HOSTED-06 retains disconnected-writer intent and advances past a failed cleanup without losing private keys", async () => {
  const pool = testPool();
  await migrate(pool);
  const container = client().getContainerClient(
    `disconnect-${randomBytes(8).toString("hex")}`,
  );
  await container.create();
  const actual = blobObjectStorage(container);
  const keys = [randomUUID(), randomUUID()].sort();
  const bytes = Buffer.from("Invented recoverable private bytes.");
  try {
    for (const key of keys) {
      const lease = await pool.connect();
      const pid = (await lease.query("SELECT pg_backend_pid() AS id")).rows[0]
        .id as number;
      await objectWriteJournal.prepare(lease, key);
      await lease.query("BEGIN");
      await actual.put(key, bytes);
      lease.release(Error("Controlled writer connection loss."));
      const deadline = Date.now() + 5_000;
      while (
        (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid]))
          .rowCount
      ) {
        if (Date.now() >= deadline)
          throw Error("Owned writer connection did not close.");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const failing = {
      ...actual,
      async remove(key: string) {
        if (key === keys[0])
          throw Error("Controlled provider deletion failure.");
        await actual.remove(key);
      },
    };
    const first = await recoverPendingObjectWrites(pool, failing, null, 1);
    expect(first).toEqual({
      examined: 1,
      completed: 0,
      failed: 1,
      nextCursor: keys[0],
    });
    const second = await recoverPendingObjectWrites(
      pool,
      failing,
      first.nextCursor,
      1,
    );
    expect(second).toEqual({
      examined: 1,
      completed: 1,
      failed: 0,
      nextCursor: keys[1],
    });
    expect(await actual.get(keys[0]!)).toEqual(bytes);
    await expect(actual.get(keys[1]!)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(await recoverPendingObjectWrites(pool, actual)).toMatchObject({
      examined: 1,
      completed: 1,
      failed: 0,
    });
    await expect(actual.get(keys[0]!)).rejects.toThrow(
      "could not be confirmed",
    );
  } finally {
    await pool.end();
  }
}, 30_000);

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
    await expect(
      objects.put(
        row.storage_key.toUpperCase(),
        Buffer.from("case-alias replacement"),
      ),
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
