import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  MAX_EVIDENCE_BYTES,
  disabledEvidenceStore,
  evidenceStore,
  fileObjectStorage,
  validUpload,
  type EvidenceUpload,
  type ObjectStorage,
  type QuarantineResult,
} from "../../src/evidence.ts";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const storageKey = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);
const base: EvidenceUpload = {
  name: "sample.txt",
  mediaType: "text/plain",
  consent: {
    rightsConfirmed: true,
    privateReview: true,
    communityPublication: false,
  },
  data: Buffer.from("Synthetic evidence"),
};
const metadata = {
  id: evidenceId,
  workspace_id: evidenceId,
  original_name: base.name,
  media_type: base.mediaType,
  storage_key: storageKey,
};

function objectStorage() {
  return {
    put: vi.fn<ObjectStorage["put"]>().mockResolvedValue(undefined),
    get: vi
      .fn<ObjectStorage["get"]>()
      .mockResolvedValue(Buffer.from("Synthetic evidence")),
    remove: vi.fn<ObjectStorage["remove"]>().mockResolvedValue(undefined),
  };
}

function database(...results: unknown[]) {
  const queued = [...results];
  const failures: Array<{ pattern: RegExp; error: Error; once: boolean }> = [];
  const query = vi.fn(async (statement: string) => {
    const index = failures.findIndex(({ pattern }) => pattern.test(statement));
    if (index >= 0) {
      const failure = failures[index]!;
      if (failure.once) failures.splice(index, 1);
      throw failure.error;
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(statement)) return { rows: [] };
    const result = queued.shift();
    return { rows: result ? (Array.isArray(result) ? result : [result]) : [] };
  });
  const client = { query, release: vi.fn() };
  const connect = vi.fn().mockResolvedValue(client);
  return {
    query,
    client,
    connect,
    failOn(pattern: RegExp, error: Error, once = false) {
      failures.push({ pattern, error, once });
    },
    pool: { query, connect } as unknown as Pool,
  };
}

it("accepts allowlisted text, PDF and PNG evidence with explicit rights and scope", () => {
  expect(validUpload(base)).toBe(true);
  expect(
    validUpload({
      ...base,
      name: "sample.pdf",
      mediaType: "application/pdf",
      data: Buffer.from("%PDF-synthetic"),
    }),
  ).toBe(true);
  expect(
    validUpload({
      ...base,
      name: "sample.png",
      mediaType: "image/png",
      data: Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from("synthetic"),
      ]),
    }),
  ).toBe(true);
  expect(
    validUpload({
      ...base,
      consent: {
        rightsConfirmed: true,
        privateReview: false,
        communityPublication: false,
        learningCircleId: "group-a",
      },
    }),
  ).toBe(true);
});

it.each([
  [{ ...base, data: "not bytes" as unknown as Buffer }, "non-buffer"],
  [{ ...base, data: Buffer.alloc(0) }, "empty"],
  [{ ...base, data: Buffer.alloc(MAX_EVIDENCE_BYTES + 1) }, "oversize"],
  [{ ...base, mediaType: "text/html" }, "type"],
  [
    { ...base, mediaType: "application/pdf", data: Buffer.from("not pdf") },
    "PDF signature",
  ],
  [
    { ...base, mediaType: "image/png", data: Buffer.from("not png") },
    "PNG signature",
  ],
  [{ ...base, data: Buffer.from([0]) }, "binary text"],
  [{ ...base, name: "../sample.txt" }, "path"],
  [{ ...base, name: "bad<script>.txt" }, "name"],
  [{ ...base, consent: { ...base.consent, rightsConfirmed: false } }, "rights"],
  [
    {
      ...base,
      consent: {
        rightsConfirmed: true,
        privateReview: false,
        communityPublication: false,
      },
    },
    "scope",
  ],
  [
    {
      ...base,
      consent: { ...base.consent, learningCircleId: "BAD/CIRCLE" },
    },
    "circle",
  ],
])("rejects invalid evidence at the %s boundary", (input) => {
  expect(validUpload(input as EvidenceUpload)).toBe(false);
});

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

it("stores opaque objects privately and removes them idempotently", async () => {
  temporary = await mkdtemp(join(tmpdir(), "dne-object-unit-"));
  const objects = fileObjectStorage(temporary),
    bytes = Buffer.from("private synthetic bytes");
  await objects.put(storageKey, bytes);
  expect(await objects.get(storageKey)).toEqual(bytes);
  expect((await stat(join(temporary, storageKey))).mode & 0o077).toBe(0);
  await expect(objects.put(storageKey, bytes)).rejects.toThrow();
  await objects.remove(storageKey);
  await objects.remove(storageKey);
  await expect(readFile(join(temporary, storageKey))).rejects.toThrow();
  expect(() => objects.get("unsafe/key")).toThrow("Invalid private object key");
});

it("fails closed when evidence storage is not configured", async () => {
  const disabled = disabledEvidenceStore();
  await expect(disabled.upload(token, base)).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    disabled.transitionQuarantine(evidenceId, "clean"),
  ).resolves.toBe(false);
  await expect(disabled.submitForReview(token, evidenceId)).resolves.toBe(
    false,
  );
  await expect(
    disabled.destinationAllowed(evidenceId, "private-review"),
  ).resolves.toBe(false);
  await expect(disabled.issueDownload(token, evidenceId)).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    disabled.download(token, evidenceId, "capability"),
  ).resolves.toEqual({ kind: "denied" });
  await expect(
    disabled.addDerivative(evidenceId, "thumbnail", Buffer.from("x")),
  ).rejects.toThrow("not configured");
  await expect(disabled.remove(token, evidenceId)).resolves.toBe(false);
  await expect(disabled.removeWorkspace(token)).resolves.toBeUndefined();
});

it("writes valid uploads without persisting raw content", async () => {
  const db = database({ principal_id: evidenceId, workspace_id: evidenceId }),
    objects = objectStorage(),
    evidence = evidenceStore(db.pool, objects, "secret");
  await expect(evidence.upload(token, base)).resolves.toEqual({
    kind: "created",
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    state: "pending",
  });
  expect(objects.put).toHaveBeenCalledWith(
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    base.data,
  );
  const insert = db.query.mock.calls.find(([statement]) =>
    String(statement).includes("INSERT INTO evidence_objects"),
  );
  expect(JSON.stringify(insert)).not.toContain(base.data.toString());
  expect((insert as unknown[] | undefined)?.[1]).toEqual([
    expect.any(String),
    evidenceId,
    evidenceId,
    base.name,
    base.mediaType,
    base.data.length,
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.any(String),
    true,
    false,
    null,
  ]);
});

it("rejects invalid or unauthorized uploads before writing and cleans failed transactions", async () => {
  const objects = objectStorage(),
    noRow = database(),
    noAccess = evidenceStore(noRow.pool, objects, "secret");
  await expect(noAccess.upload("bad", base)).resolves.toEqual({
    kind: "denied",
  });
  await expect(
    noAccess.upload(token, { ...base, name: "bad/name" }),
  ).resolves.toEqual({ kind: "invalid" });
  await expect(noAccess.upload(token, base)).resolves.toEqual({
    kind: "denied",
  });
  expect(objects.put).not.toHaveBeenCalled();
  expect(objects.remove).not.toHaveBeenCalled();
  const failed = database({
    principal_id: evidenceId,
    workspace_id: evidenceId,
  });
  failed.failOn(/INSERT INTO evidence_objects/, new Error("database offline"));
  const failedObjects = objectStorage();
  await expect(
    evidenceStore(failed.pool, failedObjects, "secret").upload(token, base),
  ).rejects.toThrow("database offline");
  expect(failedObjects.remove).toHaveBeenCalledOnce();
});

it("reconciles ambiguous upload commits without deleting committed bytes", async () => {
  const owner = { principal_id: evidenceId, workspace_id: evidenceId };
  const committed = database(owner, undefined, { id: evidenceId });
  committed.failOn(/^COMMIT$/, new Error("acknowledgement lost"), true);
  const kept = objectStorage();
  await expect(
    evidenceStore(committed.pool, kept, "secret").upload(token, base),
  ).resolves.toMatchObject({ kind: "created", state: "pending" });
  expect(kept.remove).not.toHaveBeenCalled();
  expect(committed.client.release).toHaveBeenCalledWith(expect.any(Error));

  const absent = database(owner, undefined, undefined);
  absent.failOn(/^COMMIT$/, new Error("commit rejected"), true);
  const removed = objectStorage();
  await expect(
    evidenceStore(absent.pool, removed, "secret").upload(token, base),
  ).rejects.toThrow("commit rejected");
  expect(removed.remove).not.toHaveBeenCalled();

  const uncertain = database(owner, undefined);
  uncertain.failOn(/^COMMIT$/, new Error("commit uncertain"), true);
  uncertain.failOn(
    /SELECT id FROM evidence_objects WHERE/,
    new Error("offline"),
  );
  const preserved = objectStorage();
  await expect(
    evidenceStore(uncertain.pool, preserved, "secret").upload(token, base),
  ).rejects.toThrow("commit uncertain");
  expect(preserved.remove).not.toHaveBeenCalled();
});

it("preserves the original upload error when storage or rollback fails", async () => {
  const owner = { principal_id: evidenceId, workspace_id: evidenceId };
  const failed = database(owner);
  failed.failOn(/^ROLLBACK$/, new Error("rollback failed"));
  const objects = objectStorage();
  objects.put.mockRejectedValueOnce(new Error("storage failed"));
  await expect(
    evidenceStore(failed.pool, objects, "secret").upload(token, base),
  ).rejects.toThrow("storage failed");
  expect(objects.remove).not.toHaveBeenCalled();
  expect(failed.client.release).toHaveBeenCalledWith(expect.any(Error));
});

it("moves only pending evidence through a trusted quarantine result", async () => {
  const db = database({ id: evidenceId }, undefined),
    evidence = evidenceStore(db.pool, objectStorage(), "secret");
  await expect(evidence.transitionQuarantine("bad", "clean")).resolves.toBe(
    false,
  );
  await expect(
    evidence.transitionQuarantine(evidenceId, "pending" as QuarantineResult),
  ).resolves.toBe(false);
  await expect(
    evidence.transitionQuarantine(evidenceId, "clean"),
  ).resolves.toBe(true);
  await expect(
    evidence.transitionQuarantine(evidenceId, "infected"),
  ).resolves.toBe(false);
});

it("queues only clean, consented evidence owned by an active member", async () => {
  const db = database({ id: evidenceId }, undefined),
    evidence = evidenceStore(db.pool, objectStorage(), "secret");
  await expect(evidence.submitForReview("bad", evidenceId)).resolves.toBe(
    false,
  );
  await expect(evidence.submitForReview(token, "bad")).resolves.toBe(false);
  await expect(evidence.submitForReview(token, evidenceId)).resolves.toBe(true);
  await expect(evidence.submitForReview(token, evidenceId)).resolves.toBe(
    false,
  );
});

it("keeps review, publication and exact-circle consent independent", async () => {
  const db = database(
      { id: evidenceId },
      { id: evidenceId },
      { id: evidenceId },
      undefined,
    ),
    evidence = evidenceStore(db.pool, objectStorage(), "secret");
  await expect(
    evidence.destinationAllowed("bad", "private-review"),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(evidenceId, "unknown" as "private-review"),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(
      evidenceId,
      "learning-circle:group:extra" as `learning-circle:${string}`,
    ),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(evidenceId, "private-review"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(evidenceId, "community-publication"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(evidenceId, "learning-circle:group-a"),
  ).resolves.toBe(true);
  await expect(
    evidence.destinationAllowed(evidenceId, "learning-circle:BAD"),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(
      evidenceId,
      "learning-circle" as `learning-circle:${string}`,
    ),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(evidenceId, "private-review"),
  ).resolves.toBe(false);
});

it("issues short-lived capabilities and rechecks authorization at download", async () => {
  let now = 1_800_000_000_000;
  const db = database(metadata, metadata, undefined),
    objects = objectStorage(),
    evidence = evidenceStore(db.pool, objects, "secret", () => now);
  await expect(evidence.issueDownload("bad", evidenceId)).resolves.toEqual({
    kind: "denied",
  });
  const issued = await evidence.issueDownload(token, evidenceId);
  expect(issued).toMatchObject({
    kind: "issued",
    expiresAt: new Date(now + 300_000),
  });
  if (issued.kind !== "issued") throw new Error("capability not issued");
  await expect(
    evidence.download(token, evidenceId, issued.capability),
  ).resolves.toEqual({
    kind: "allowed",
    name: base.name,
    mediaType: base.mediaType,
    data: base.data,
  });
  await expect(
    evidence.download(token, evidenceId, issued.capability),
  ).resolves.toEqual({ kind: "denied" });
  now += 300_001;
  await expect(
    evidence.download(token, evidenceId, issued.capability),
  ).resolves.toEqual({ kind: "denied" });
});

it.each([
  "",
  "bad.bad.bad.bad",
  "1.bad.bad",
  "1800000300000",
  `1800000300000.${"a".repeat(48)}`,
  `${Number.MAX_SAFE_INTEGER + 1}.${"a".repeat(48)}.${"b".repeat(64)}`,
  `1800000300000.short.${"b".repeat(64)}`,
  `1800000300000.${"a".repeat(48)}.short`,
])("rejects malformed download capability %j", async (capability) => {
  const evidence = evidenceStore(
    database().pool,
    objectStorage(),
    "secret",
    () => 1_800_000_000_000,
  );
  await expect(
    evidence.download(token, evidenceId, capability),
  ).resolves.toEqual({ kind: "denied" });
});

it("rejects a well-formed capability with a changed signature", async () => {
  const db = database(metadata),
    evidence = evidenceStore(
      db.pool,
      objectStorage(),
      "secret",
      () => 1_800_000_000_000,
    ),
    issued = await evidence.issueDownload(token, evidenceId);
  if (issued.kind !== "issued") throw new Error("capability not issued");
  const changed = `${issued.capability.slice(0, -1)}${issued.capability.endsWith("0") ? "1" : "0"}`;
  await expect(evidence.download(token, evidenceId, changed)).resolves.toEqual({
    kind: "denied",
  });
});

it("stores derived private objects and cleans them after a failed insert", async () => {
  const db = database({ id: evidenceId }),
    objects = objectStorage(),
    evidence = evidenceStore(db.pool, objects, "secret");
  await expect(
    evidence.addDerivative(evidenceId, "thumbnail", Buffer.from("thumb")),
  ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  for (const [id, kind, data] of [
    ["bad", "thumbnail", Buffer.from("x")],
    [evidenceId, "other", Buffer.from("x")],
    [evidenceId, "thumbnail", Buffer.alloc(0)],
    [evidenceId, "thumbnail", Buffer.alloc(MAX_EVIDENCE_BYTES + 1)],
    [evidenceId, "thumbnail", "not bytes"],
  ] as const)
    await expect(
      evidence.addDerivative(
        id,
        kind as "thumbnail",
        data as unknown as Buffer,
      ),
    ).rejects.toThrow("Invalid evidence derivative");
  const failedDb = database({ id: evidenceId }),
    failedObjects = objectStorage();
  failedDb.failOn(
    /INSERT INTO evidence_derivatives/,
    new Error("insert failed"),
  );
  await expect(
    evidenceStore(failedDb.pool, failedObjects, "secret").addDerivative(
      evidenceId,
      "text-extract",
      Buffer.from("extract"),
    ),
  ).rejects.toThrow("insert failed");
  expect(failedObjects.remove).toHaveBeenCalledOnce();
  await expect(
    evidenceStore(database().pool, objectStorage(), "secret").addDerivative(
      evidenceId,
      "thumbnail",
      Buffer.from("thumb"),
    ),
  ).rejects.toThrow("could not be stored");

  const rollbackFailed = database({ id: evidenceId });
  rollbackFailed.failOn(
    /INSERT INTO evidence_derivatives/,
    new Error("derivative insert failed"),
  );
  rollbackFailed.failOn(/^ROLLBACK$/, new Error("rollback failed"));
  await expect(
    evidenceStore(rollbackFailed.pool, objectStorage(), "secret").addDerivative(
      evidenceId,
      "thumbnail",
      Buffer.from("thumb"),
    ),
  ).rejects.toThrow("derivative insert failed");
  expect(rollbackFailed.client.release).toHaveBeenCalledWith(expect.any(Error));
});

it("reconciles ambiguous derivative commits without deleting committed bytes", async () => {
  const committed = database({ id: evidenceId }, undefined, { id: evidenceId });
  committed.failOn(/^COMMIT$/, new Error("acknowledgement lost"), true);
  const kept = objectStorage();
  await expect(
    evidenceStore(committed.pool, kept, "secret").addDerivative(
      evidenceId,
      "thumbnail",
      Buffer.from("thumb"),
    ),
  ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  expect(kept.remove).not.toHaveBeenCalled();

  const absent = database({ id: evidenceId }, undefined, undefined);
  absent.failOn(/^COMMIT$/, new Error("commit rejected"), true);
  const removed = objectStorage();
  await expect(
    evidenceStore(absent.pool, removed, "secret").addDerivative(
      evidenceId,
      "thumbnail",
      Buffer.from("thumb"),
    ),
  ).rejects.toThrow("commit rejected");
  expect(removed.remove).not.toHaveBeenCalled();

  const uncertain = database({ id: evidenceId }, undefined);
  uncertain.failOn(/^COMMIT$/, new Error("commit uncertain"), true);
  uncertain.failOn(
    /SELECT id FROM evidence_derivatives WHERE/,
    new Error("offline"),
  );
  const preserved = objectStorage();
  await expect(
    evidenceStore(uncertain.pool, preserved, "secret").addDerivative(
      evidenceId,
      "thumbnail",
      Buffer.from("thumb"),
    ),
  ).rejects.toThrow("commit uncertain");
  expect(preserved.remove).not.toHaveBeenCalled();
});

it("deletes owned evidence and all derived object keys before metadata", async () => {
  const db = database(
      { id: evidenceId },
      [{ storage_key: storageKey }, { storage_key: evidenceId }],
      undefined,
    ),
    objects = objectStorage(),
    evidence = evidenceStore(db.pool, objects, "secret");
  await expect(evidence.remove("bad", evidenceId)).resolves.toBe(false);
  await expect(evidence.remove(token, "bad")).resolves.toBe(false);
  await expect(evidence.remove(token, evidenceId)).resolves.toBe(true);
  expect(objects.remove.mock.calls).toEqual([[storageKey], [evidenceId]]);
  expect(db.query).toHaveBeenCalledTimes(3);
  await expect(
    evidenceStore(database().pool, objectStorage(), "secret").remove(
      token,
      evidenceId,
    ),
  ).resolves.toBe(false);
});

it("deletes every owned workspace object once and tolerates an empty cleanup", async () => {
  const db = database(
      { id: evidenceId },
      undefined,
      undefined,
      [
        { id: evidenceId, storage_key: storageKey },
        { id: evidenceId, storage_key: "33333333-3333-4333-8333-333333333333" },
      ],
      undefined,
    ),
    objects = objectStorage(),
    evidence = evidenceStore(db.pool, objects, "secret");
  await evidence.removeWorkspace("bad");
  await evidence.removeWorkspace(token);
  expect(objects.remove).toHaveBeenCalledTimes(2);
  expect((db.query.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toEqual([
    [evidenceId],
  ]);
  await expect(
    evidenceStore(database().pool, objectStorage(), "secret").removeWorkspace(
      token,
    ),
  ).resolves.toBeUndefined();
  const failed = database();
  failed.failOn(/SELECT w.id/, new Error("workspace lookup failed"));
  failed.failOn(/^ROLLBACK$/, new Error("rollback failed"));
  await expect(
    evidenceStore(failed.pool, objectStorage(), "secret").removeWorkspace(
      token,
    ),
  ).rejects.toThrow("workspace lookup failed");
  expect(failed.client.release).toHaveBeenCalledWith(expect.any(Error));

  await expect(
    evidenceStore(
      database({ id: evidenceId }, undefined, undefined, undefined).pool,
      objectStorage(),
      "secret",
    ).removeWorkspace(token),
  ).resolves.toBeUndefined();
});
