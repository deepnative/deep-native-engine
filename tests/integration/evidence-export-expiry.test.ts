import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
let root = "";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-evidence-export-expiry-"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
afterAll(async () => pool.end());

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw new Error("Member setup failed");
  return { token, id: session.learner.id };
}

async function fixture(
  state: "pending" | "clean" | "infected" | "rejected" = "clean",
) {
  const owner = await member();
  const objects = fileObjectStorage(root);
  const evidence = evidenceStore(pool, objects, "synthetic-export-secret");
  const bytes = Buffer.from("Private synthetic export source");
  const name = "private-synthetic-export.txt";
  const uploaded = await evidence.upload(owner.token, {
    name,
    mediaType: "text/plain",
    data: bytes,
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw new Error("Evidence setup failed");
  if (state !== "pending")
    expect(await evidence.transitionQuarantine(uploaded.id, state)).toBe(true);
  return { owner, objects, evidence, bytes, name, id: uploaded.id };
}

async function waitForEntry(
  entered: ReturnType<typeof gate>,
  operation: Promise<unknown>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered.wait,
      operation.then(() => {
        throw new Error("Export finished before the storage barrier");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Storage barrier was not reached")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setNearExpiry(ownerId: string) {
  await pool.query(
    `UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '5 seconds'
       WHERE id=$1`,
    [ownerId],
  );
}

async function waitForBlocked(blocker: number) {
  const stopAt = performance.now() + 3000;
  while (performance.now() < stopAt) {
    const observed = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,
      [blocker],
    );
    if (observed.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected blocked database operation was not observed");
}

function pausedExport(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = gate(),
    resume = gate();
  const state = { pid: 0 };
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      state.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      return {
        query: client.query.bind(client),
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const evidence = evidenceStore(
    wrapper,
    {
      ...f.objects,
      async get(key) {
        const data = await f.objects.get(key);
        entered.release();
        await resume.wait;
        return data;
      },
    },
    "synthetic-export-secret",
  );
  return { evidence, entered, resume, state };
}

function expectNoPayload(
  result: Awaited<ReturnType<ReturnType<typeof evidenceStore>["exportOwned"]>>,
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "denied" | "unavailable",
) {
  // Summarize leakage so a regression prints no source payload.
  expect({
    kind: result.kind,
    hasMetadata: "items" in result,
    hasPrivateName: JSON.stringify(result).includes(f.name),
    hasSourceBytes: JSON.stringify(result).includes(f.bytes.toString("base64")),
  }).toEqual({
    kind,
    hasMetadata: false,
    hasPrivateName: false,
    hasSourceBytes: false,
  });
  expect(result).toEqual({ kind });
}

async function expectLocksReleased(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='1s'");
    expect(
      (
        await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
          f.owner.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT id FROM evidence_objects WHERE id=$1 FOR UPDATE",
          [f.id],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function observeExpiry(ownerId: string) {
  const stopAt = performance.now() + 10_000;
  while (performance.now() < stopAt) {
    const observed = await pool.query<{ expired: boolean }>(
      "SELECT clock_timestamp()>=expires_at AS expired FROM principals WHERE id=$1",
      [ownerId],
    );
    if (observed.rows[0]!.expired) return;
    // This only limits polling; the database observation proves expiry.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Database expiry was not observed within the test deadline");
}

it("withholds source export when its owner session expires during assembly", async () => {
  const f = await fixture();
  await setNearExpiry(f.owner.id);
  const delayed = pausedExport(f);
  const exporting = delayed.evidence.exportOwned(f.owner.token);
  try {
    await waitForEntry(delayed.entered, exporting);
    await observeExpiry(f.owner.id);
    delayed.resume.release();
    const result = await exporting;
    expectNoPayload(result, f, "denied");
    await expectLocksReleased(f);
  } finally {
    delayed.resume.release();
    await Promise.allSettled([exporting]);
  }
}, 15_000);

it("returns the unchanged source schema for a valid owner and excludes it from another member's export", async () => {
  const f = await fixture();
  const other = await member();
  expect(await f.evidence.exportOwned(f.owner.token)).toMatchObject({
    kind: "ready",
    version: "local-evidence-v2",
    items: [
      {
        id: f.id,
        name: f.name,
        mediaType: "text/plain",
        quarantineState: "clean",
        privateReviewAllowed: true,
        privateReviewRevokedAt: null,
        createdAt: expect.any(Date),
        revisionParentId: null,
        revisionParentStatus: "none",
        revisionNumber: 1,
        sourceBase64: f.bytes.toString("base64"),
      },
    ],
  });
  expect(await f.evidence.exportOwned(other.token)).toMatchObject({
    kind: "ready",
    version: "local-evidence-v2",
    items: [],
  });
});

it("denies an owner whose session already expired without reading storage", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
    [f.owner.id],
  );
  const evidence = evidenceStore(
    pool,
    {
      ...f.objects,
      async get() {
        throw new Error("Expired sessions must not read storage");
      },
    },
    "synthetic-export-secret",
  );
  expectNoPayload(await evidence.exportOwned(f.owner.token), f, "denied");
  await expectLocksReleased(f);
});

it.each(["pending", "infected", "rejected"] as const)(
  "withholds %s source bytes without reading unsafe storage",
  async (state) => {
    const f = await fixture(state);
    const evidence = evidenceStore(
      pool,
      {
        ...f.objects,
        async get() {
          throw new Error("Unsafe sources must not be loaded");
        },
      },
      "synthetic-export-secret",
    );
    const result = await evidence.exportOwned(f.owner.token);
    expect(result).toMatchObject({
      kind: "ready",
      items: [{ id: f.id, quarantineState: state, sourceBase64: null }],
    });
    expect(JSON.stringify(result).includes(f.bytes.toString("base64"))).toBe(
      false,
    );
  },
);

it.each(["principal", "evidence"] as const)(
  "withholds export when its owner expires while waiting for the %s lock",
  async (boundary) => {
    const f = await fixture();
    await setNearExpiry(f.owner.id);
    const blocker = await pool.connect();
    let exporting: ReturnType<typeof f.evidence.exportOwned> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      if (boundary === "principal")
        await blocker.query(
          "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
          [f.owner.id],
        );
      else
        await blocker.query(
          "SELECT id FROM evidence_objects WHERE id=$1 FOR UPDATE",
          [f.id],
        );
      exporting = f.evidence.exportOwned(f.owner.token);
      await waitForBlocked(pid);
      await observeExpiry(f.owner.id);
      await blocker.query("COMMIT");
      expectNoPayload(await exporting, f, "denied");
      await expectLocksReleased(f);
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled(exporting ? [exporting] : []);
      blocker.release();
    }
  },
  15_000,
);

it("withholds export when session revocation wins its principal lock", async () => {
  const f = await fixture();
  const revoker = await pool.connect();
  let exporting: ReturnType<typeof f.evidence.exportOwned> | undefined;
  try {
    await revoker.query("BEGIN");
    const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await revoker.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.owner.id],
    );
    exporting = f.evidence.exportOwned(f.owner.token);
    await waitForBlocked(pid);
    await revoker.query("COMMIT");
    expectNoPayload(await exporting, f, "denied");
    await expectLocksReleased(f);
  } finally {
    await revoker.query("ROLLBACK");
    await Promise.allSettled(exporting ? [exporting] : []);
    revoker.release();
  }
});

it("completes an authorized export before a waiting session revocation, then denies subsequent exports", async () => {
  const f = await fixture();
  const delayed = pausedExport(f);
  const revoker = await pool.connect();
  const exporting = delayed.evidence.exportOwned(f.owner.token);
  let revoking: Promise<unknown> | undefined;
  try {
    await waitForEntry(delayed.entered, exporting);
    revoking = revoker.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.owner.id],
    );
    await waitForBlocked(delayed.state.pid);
    delayed.resume.release();
    expect(await exporting).toMatchObject({
      kind: "ready",
      items: [{ id: f.id, sourceBase64: f.bytes.toString("base64") }],
    });
    await revoking;
    expectNoPayload(await f.evidence.exportOwned(f.owner.token), f, "denied");
    await expectLocksReleased(f);
  } finally {
    delayed.resume.release();
    await Promise.allSettled([exporting, ...(revoking ? [revoking] : [])]);
    revoker.release();
  }
});

it.each(["storage failure", "size mismatch", "hash mismatch"] as const)(
  "withholds payload on %s and releases locks for export, revocation and deletion recovery",
  async (failure) => {
    const f = await fixture();
    const broken = evidenceStore(
      pool,
      {
        ...f.objects,
        async get(key) {
          const data = await f.objects.get(key);
          if (failure === "storage failure")
            throw new Error("Synthetic storage failure");
          if (failure === "size mismatch") return data.subarray(1);
          return Buffer.alloc(data.length, 65);
        },
      },
      "synthetic-export-secret",
    );
    expectNoPayload(await broken.exportOwned(f.owner.token), f, "unavailable");
    await expectLocksReleased(f);
    expect(await f.evidence.exportOwned(f.owner.token)).toMatchObject({
      kind: "ready",
      items: [{ id: f.id, sourceBase64: f.bytes.toString("base64") }],
    });
    expect(await f.evidence.revokePrivateReview(f.owner.token, f.id)).toBe(
      true,
    );
    expect(await f.evidence.remove(f.owner.token, f.id)).toBe(true);
    expect(await f.evidence.exportOwned(f.owner.token)).toMatchObject({
      kind: "ready",
      version: "local-evidence-v2",
      items: [],
    });
  },
);

it("withholds an assembled payload on a real database error and recovers for export, revocation and deletion", async () => {
  const f = await fixture();
  const wrapper = {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          return sql === "COMMIT"
            ? client.query("SELECT 1 / 0")
            : client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const broken = evidenceStore(wrapper, f.objects, "synthetic-export-secret");
  expectNoPayload(await broken.exportOwned(f.owner.token), f, "unavailable");
  await expectLocksReleased(f);
  expect(await f.evidence.exportOwned(f.owner.token)).toMatchObject({
    kind: "ready",
    items: [{ id: f.id, sourceBase64: f.bytes.toString("base64") }],
  });
  expect(await f.evidence.revokePrivateReview(f.owner.token, f.id)).toBe(true);
  expect(await f.evidence.remove(f.owner.token, f.id)).toBe(true);
});

it("discards a failed rollback connection so later export, revocation and deletion can finish", async () => {
  const f = await fixture();
  const exportPool = testPool();
  const wrapper = {
    async connect() {
      const client = await exportPool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          if (sql === "ROLLBACK")
            return Promise.reject(new Error("Synthetic rollback failure"));
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const broken = evidenceStore(
    wrapper,
    {
      ...f.objects,
      async get(key) {
        await f.objects.get(key);
        throw new Error("Synthetic storage failure before rollback failure");
      },
    },
    "synthetic-export-secret",
  );
  try {
    expectNoPayload(await broken.exportOwned(f.owner.token), f, "unavailable");
    // The database transaction remains live unless the failed client is discarded.
    await expectLocksReleased(f);
    expect(await f.evidence.exportOwned(f.owner.token)).toMatchObject({
      kind: "ready",
      items: [{ id: f.id, sourceBase64: f.bytes.toString("base64") }],
    });
    expect(await f.evidence.revokePrivateReview(f.owner.token, f.id)).toBe(
      true,
    );
    expect(await f.evidence.remove(f.owner.token, f.id)).toBe(true);
  } finally {
    await exportPool.end();
  }
});
