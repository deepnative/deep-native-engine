import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import {
  evidenceStore,
  fileObjectStorage,
  type ObjectStorage,
} from "../../src/evidence.ts";
import { assignmentObjectStorage } from "../../src/assignment-evidence-storage.ts";
import { preparedObjectStorage } from "../../src/prepared-sample-storage.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { sampleFeedbackStore } from "../../src/sample-feedback.ts";
import { recoverPendingMemberDeletions } from "../../src/deletion-recovery.ts";

const pool = testPool();
let root: string;
const input = {
  name: "Invented source.txt",
  mediaType: "text/plain",
  data: Buffer.from("Invented member source"),
  consent: {
    rightsConfirmed: true,
    privateReview: true,
    communityPublication: false,
  },
};
beforeAll(() => migrate(pool), 30000);
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-storage-regression-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(() => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const session = await store(pool).session(token);
  if (session.kind !== "active") throw Error("Synthetic member missing");
  return { token, id: session.learner.id };
}
async function source(
  token: string,
  objects: ObjectStorage = fileObjectStorage(root),
) {
  const evidence = evidenceStore(pool, objects, "synthetic-storage-secret");
  const result = await evidence.upload(token, input);
  if (result.kind !== "created") throw Error("Synthetic source missing");
  await evidence.transitionQuarantine(result.id, "clean");
  return { evidence, id: result.id };
}
function wrapped(db: Pool, files = fileObjectStorage(root)) {
  return assignmentObjectStorage(db, preparedObjectStorage(db, files));
}

it("AUDIT-DELETE-01 recovers a partially removed individual source without deleting its owner or unrelated bytes", async () => {
  const owner = await member(),
    other = await member(),
    files = fileObjectStorage(root);
  const target = await source(owner.token),
    kept = await source(owner.token),
    unrelated = await source(other.token);
  await target.evidence.addDerivative(
    target.id,
    "text-extract",
    Buffer.from("Invented derivative"),
  );
  const keys = (
    await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM evidence_objects WHERE id=$1 UNION ALL SELECT storage_key FROM evidence_derivatives WHERE evidence_id=$1",
      [target.id],
    )
  ).rows.map((row) => row.storage_key);
  let calls = 0;
  const broken: ObjectStorage = {
    ...files,
    async remove(key) {
      if (++calls === 2) throw Error("Synthetic interrupted removal");
      await files.remove(key);
    },
  };
  await expect(
    evidenceStore(pool, broken, "synthetic-storage-secret").remove(
      owner.token,
      target.id,
    ),
  ).rejects.toThrow("interrupted removal");
  expect(await target.evidence.owned(owner.token)).toHaveLength(1);
  await expect(files.get(keys[0]!)).rejects.toThrow();
  expect(await files.get(keys[1]!)).toEqual(Buffer.from("Invented derivative"));
  await recoverPendingMemberDeletions(pool, wrapped(pool));
  expect(
    (
      await pool.query("SELECT id FROM evidence_objects WHERE id=$1", [
        target.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query("SELECT id FROM principals WHERE id=ANY($1::uuid[])", [
        [owner.id, other.id],
      ])
    ).rowCount,
  ).toBe(2);
  expect(
    (await target.evidence.owned(owner.token)).map((row) => row.id),
  ).toEqual([kept.id]);
  expect(
    (await target.evidence.owned(other.token)).map((row) => row.id),
  ).toEqual([unrelated.id]);
  for (const key of keys) await expect(files.get(key)).rejects.toThrow();
  await recoverPendingMemberDeletions(pool, wrapped(pool));
  expect((await pool.query("SELECT id FROM evidence_objects")).rowCount).toBe(
    2,
  );
});

it.each([
  "download",
  "export",
  "upload",
  "derivative",
  "local-ai",
  "feedback",
  "recovery",
])(
  "AUDIT-POOL-01 %s completes through both runtime wrappers with one PostgreSQL connection",
  async (operation) => {
    const owner = await member(),
      target = await source(owner.token);
    const small = new Pool({
      connectionString: process.env.DNE_TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 500,
    });
    const evidence = evidenceStore(
      small,
      wrapped(small),
      "synthetic-storage-secret",
    );
    try {
      if (operation === "download") {
        const capability = await evidence.issueDownload(owner.token, target.id);
        if (capability.kind !== "issued")
          throw Error("Synthetic capability missing");
        expect(
          await evidence.download(
            owner.token,
            target.id,
            capability.capability,
          ),
        ).toMatchObject({ kind: "allowed", data: input.data });
      } else if (operation === "export") {
        expect(await evidence.exportOwned(owner.token)).toMatchObject({
          kind: "ready",
          items: [{ sourceBase64: input.data.toString("base64") }],
        });
      } else if (operation === "upload") {
        expect(await evidence.upload(owner.token, input)).toMatchObject({
          kind: "created",
        });
      } else if (operation === "local-ai") {
        expect(
          await localAiConsentStore(
            small,
            wrapped(small),
            deterministicRegistry({}, "test"),
          ).list(owner.token),
        ).toHaveLength(1);
      } else if (operation === "feedback") {
        expect(await evidence.submitForReview(owner.token, target.id)).toBe(
          true,
        );
        expect(
          await sampleFeedbackStore(small, wrapped(small)).owner(
            owner.token,
            target.id,
          ),
        ).toMatchObject({ kind: "ready" });
      } else if (operation === "recovery") {
        await pool.query(
          "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
          [target.id],
        );
        expect(
          (await recoverPendingMemberDeletions(small, wrapped(small)))
            .evidenceDeletions,
        ).toMatchObject({ completed: 1, failed: 0 });
      } else {
        expect(
          await evidence.addDerivative(
            target.id,
            "text-extract",
            Buffer.from("Synthetic derivative"),
          ),
        ).toMatch(/^[a-f0-9-]{36}$/);
      }
      expect(small.waitingCount).toBe(0);
    } finally {
      await small.end();
    }
  },
);

it.each(["principal", "workspace", "evidence"])(
  "AUDIT-DELETE-01 skips a busy %s fence without losing the durable marker",
  async (fence) => {
    const owner = await member(),
      target = await source(owner.token);
    await pool.query(
      "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
      [target.id],
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      if (fence === "principal")
        await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
          owner.id,
        ]);
      else if (fence === "workspace")
        await holder.query(
          "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
          [owner.id],
        );
      else
        await holder.query(
          "SELECT id FROM evidence_objects WHERE id=$1 FOR UPDATE",
          [target.id],
        );
      expect(
        (await recoverPendingMemberDeletions(pool, wrapped(pool)))
          .evidenceDeletions,
      ).toMatchObject({ examined: 1, completed: 0, failed: 0 });
      expect(
        (
          await pool.query(
            "SELECT quarantine_state FROM evidence_objects WHERE id=$1",
            [target.id],
          )
        ).rows,
      ).toEqual([{ quarantine_state: "deleting" }]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(
      (await recoverPendingMemberDeletions(pool, wrapped(pool)))
        .evidenceDeletions.completed,
    ).toBe(1);
  },
);

it("AUDIT-DELETE-01 competing recovery workers remove an individual source once", async () => {
  const owner = await member(),
    target = await source(owner.token),
    files = fileObjectStorage(root);
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
    [target.id],
  );
  let entered!: () => void,
    resume!: () => void,
    removals = 0;
  const removing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const slow: ObjectStorage = {
    ...files,
    async remove(key) {
      removals++;
      entered();
      await proceed;
      await files.remove(key);
    },
  };
  const winning = recoverPendingMemberDeletions(pool, wrapped(pool, slow));
  await removing;
  try {
    expect(
      (await recoverPendingMemberDeletions(pool, wrapped(pool)))
        .evidenceDeletions,
    ).toMatchObject({ examined: 1, completed: 0, failed: 0 });
  } finally {
    resume();
  }
  expect((await winning).evidenceDeletions.completed).toBe(1);
  expect(removals).toBe(1);
});

it("AUDIT-DELETE-01 failed objects do not starve later pages and retries finish after provider recovery", async () => {
  const owner = await member(),
    files = fileObjectStorage(root);
  const first = await source(owner.token),
    second = await source(owner.token);
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=ANY($1::uuid[])",
    [[first.id, second.id]],
  );
  const rows = (
    await pool.query<{ id: string; storage_key: string }>(
      "SELECT id,storage_key FROM evidence_objects ORDER BY id",
    )
  ).rows;
  const broken: ObjectStorage = {
    ...files,
    async remove(key) {
      if (key === rows[0]!.storage_key)
        throw Error("Synthetic provider failure");
      await files.remove(key);
    },
  };
  const page = await recoverPendingMemberDeletions(
    pool,
    wrapped(pool, broken),
    null,
    1,
  );
  expect(page.evidenceDeletions).toEqual({
    examined: 1,
    completed: 0,
    failed: 1,
    nextCursor: rows[0]!.id,
  });
  const next = await recoverPendingMemberDeletions(
    pool,
    wrapped(pool, broken),
    null,
    1,
    null,
    page.evidenceDeletions.nextCursor,
  );
  expect(next.evidenceDeletions).toMatchObject({
    examined: 1,
    completed: 1,
    failed: 0,
  });
  expect(
    (await recoverPendingMemberDeletions(pool, wrapped(pool))).evidenceDeletions
      .completed,
  ).toBe(1);
  expect((await pool.query("SELECT id FROM evidence_objects")).rowCount).toBe(
    0,
  );
});

it("AUDIT-POOL-01 ten concurrent authorized downloads finish when all ten pool connections are held", async () => {
  const owner = await member(),
    outsider = await member(),
    target = await source(owner.token);
  const issued = await target.evidence.issueDownload(owner.token, target.id);
  if (issued.kind !== "issued") throw Error("Synthetic capability missing");
  const small = new Pool({
    connectionString: process.env.DNE_TEST_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 500,
  });
  const base = wrapped(small);
  let entered = 0,
    resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const allHeld: ObjectStorage = {
    ...base,
    async get(key, query) {
      if (++entered === 10) resume();
      await ready;
      return base.get(key, query);
    },
  };
  const evidence = evidenceStore(small, allHeld, "synthetic-storage-secret");
  try {
    expect(
      await evidence.download(outsider.token, target.id, issued.capability),
    ).toEqual({ kind: "denied" });
    const downloads = await Promise.all(
      Array.from({ length: 10 }, () =>
        evidence.download(owner.token, target.id, issued.capability),
      ),
    );
    expect(downloads).toHaveLength(10);
    for (const download of downloads)
      expect(download).toMatchObject({ kind: "allowed", data: input.data });
    expect(entered).toBe(10);
    expect(small.waitingCount).toBe(0);
  } finally {
    resume();
    await small.end();
  }
});
