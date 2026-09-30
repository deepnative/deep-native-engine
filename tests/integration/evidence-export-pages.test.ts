import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  evidenceStore,
  fileObjectStorage,
  MAX_EVIDENCE_BYTES,
  MAX_EXPORT_BYTES,
  EVIDENCE_EXPORT_CURSOR_TTL_MS,
  type EvidenceExport,
} from "../../src/evidence.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const db = store(pool);
let root = "";
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne-evidence-pages-"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const result = await db.session(token);
  if (result.kind !== "active") throw Error("Member fixture unavailable");
  return { token, id: result.learner.id };
}
async function fixture(
  count = 21,
  bytes = Buffer.from("Invented private source"),
) {
  const owner = await member();
  const objects = fileObjectStorage(root);
  const evidence = evidenceStore(pool, objects, "synthetic-page-secret");
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const result = await evidence.upload(owner.token, {
      name: `sample-${index}.txt`,
      mediaType: "text/plain",
      data: bytes,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (result.kind !== "created") throw Error("Evidence fixture unavailable");
    ids.push(result.id);
    expect(await evidence.transitionQuarantine(result.id, "clean")).toBe(true);
  }
  return { owner, objects, evidence, ids, bytes };
}
function ready(result: EvidenceExport) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Export unavailable");
  return result;
}
async function first(f: Awaited<ReturnType<typeof fixture>>) {
  const result = ready(await f.evidence.exportOwned(f.owner.token));
  expect(result.page.nextCursor).toEqual(expect.any(String));
  return result;
}
it("retrieves every unchanged item exactly once across timestamp ties and microseconds beyond the 20-item cap", async () => {
  const f = await fixture(43);
  await pool.query(
    `UPDATE evidence_objects SET created_at='2026-09-29T00:00:00.123456Z' WHERE owner_principal_id=$1`,
    [f.owner.id],
  );
  await pool.query(
    `UPDATE evidence_objects SET created_at='2026-09-29T00:00:00.123457Z' WHERE id=$1`,
    [f.ids[0]],
  );
  const expected = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_objects WHERE owner_principal_id=$1 ORDER BY created_at,id",
      [f.owner.id],
    )
  ).rows.map((row) => row.id);
  const collected: string[] = [];
  let cursor: string | undefined;
  for (let number = 1; number <= 3; number++) {
    const result = ready(await f.evidence.exportOwned(f.owner.token, cursor));
    expect(result.page).toMatchObject({
      number,
      consistency: "live-pages",
      itemCount: number < 3 ? 20 : 3,
      complete: number === 3,
    });
    expect(result.items.length).toBeLessThanOrEqual(20);
    expect(result.page.sourceBytes).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
    expect(result.page.nextHref).toBe(
      result.page.nextCursor
        ? `/api/evidence/export?cursor=${encodeURIComponent(result.page.nextCursor)}`
        : null,
    );
    collected.push(...result.items.map((item) => item.id));
    cursor = result.page.nextCursor ?? undefined;
  }
  expect(collected).toEqual(expected);
  expect(new Set(collected).size).toBe(43);
  expect(cursor).toBeUndefined();
});
it("retrieves more than 4 MiB over bounded pages without returning pending, infected, rejected or deleting bytes", async () => {
  const f = await fixture(9, Buffer.alloc(MAX_EVIDENCE_BYTES, 97));
  for (const [index, state] of [
    [5, "pending"],
    [6, "rejected"],
    [7, "infected"],
    [8, "deleting"],
  ] as const)
    await pool.query(
      "UPDATE evidence_objects SET quarantine_state=$2 WHERE id=$1",
      [f.ids[index], state],
    );
  const a = ready(await f.evidence.exportOwned(f.owner.token));
  expect(a.items.map((item) => item.id)).toEqual(f.ids.slice(0, 4));
  expect(a.page.sourceBytes).toBe(MAX_EXPORT_BYTES);
  const b = ready(
    await f.evidence.exportOwned(f.owner.token, a.page.nextCursor!),
  );
  expect(b.items.map((item) => item.id)).toEqual(f.ids.slice(4, 8));
  expect(b.items.map((item) => item.sourceBase64 === null)).toEqual([
    false,
    true,
    true,
    true,
  ]);
  expect(b.page).toMatchObject({
    number: 2,
    sourceBytes: MAX_EVIDENCE_BYTES,
    complete: true,
    nextCursor: null,
    nextHref: null,
  });
  expect(
    a.items
      .concat(b.items)
      .reduce(
        (sum, item) =>
          sum +
          (item.sourceBase64
            ? Buffer.from(item.sourceBase64, "base64").length
            : 0),
        0,
      ),
  ).toBe(5 * MAX_EVIDENCE_BYTES);
});
it("rejects cross-member and forged continuations, fixes traversal expiry, and permits a fresh export after expiry", async () => {
  const f = await fixture();
  const other = await member();
  let now = Date.now();
  const timed = evidenceStore(
    pool,
    f.objects,
    "synthetic-page-secret",
    () => now,
  );
  const a = ready(await timed.exportOwned(f.owner.token));
  const cursor = a.page.nextCursor!;
  expect(await timed.exportOwned(other.token, cursor)).toEqual({
    kind: "denied",
  });
  expect(
    await timed.exportOwned(f.owner.token, `${cursor.slice(0, -1)}!`),
  ).toEqual({ kind: "denied" });
  now += EVIDENCE_EXPORT_CURSOR_TTL_MS;
  expect(await timed.exportOwned(f.owner.token, cursor)).toEqual({
    kind: "denied",
  });
  expect(ready(await timed.exportOwned(f.owner.token)).page.number).toBe(1);
});
it.each(["revoked", "expired", "deleting workspace", "deleted owner"])(
  "reauthorizes every continuation after %s",
  async (change) => {
    const f = await fixture();
    const a = await first(f);
    if (change === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [f.owner.id],
      );
    if (change === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
        [f.owner.id],
      );
    if (change === "deleting workspace")
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [f.owner.id],
      );
    if (change === "deleted owner") await db.remove(f.owner.id);
    expect(
      await f.evidence.exportOwned(f.owner.token, a.page.nextCursor!),
    ).toEqual({ kind: "denied" });
  },
);
it("continues after deletion of the last emitted item and omits a future deleted item", async () => {
  const f = await fixture(23);
  const a = await first(f);
  expect(await f.evidence.remove(f.owner.token, a.items.at(-1)!.id)).toBe(true);
  expect(await f.evidence.remove(f.owner.token, f.ids[21]!)).toBe(true);
  const b = ready(
    await f.evidence.exportOwned(f.owner.token, a.page.nextCursor!),
  );
  expect(b.items.map((item) => item.id)).toEqual([f.ids[20], f.ids[22]]);
  expect(b.page.complete).toBe(true);
});
it("withholds a failed continuation in full and supports storage repair without losing its next item", async () => {
  const f = await fixture();
  const a = await first(f);
  const failing = evidenceStore(
    pool,
    {
      ...f.objects,
      get: async () => {
        throw Error("synthetic source unavailable");
      },
    },
    "synthetic-page-secret",
  );
  expect(await failing.exportOwned(f.owner.token, a.page.nextCursor!)).toEqual({
    kind: "unavailable",
  });
  const corrupt = evidenceStore(
    pool,
    { ...f.objects, get: async () => Buffer.alloc(f.bytes.length, 98) },
    "synthetic-page-secret",
  );
  expect(await corrupt.exportOwned(f.owner.token, a.page.nextCursor!)).toEqual({
    kind: "unavailable",
  });
  const recovered = ready(
    await f.evidence.exportOwned(f.owner.token, a.page.nextCursor!),
  );
  expect(recovered.items.map((item) => item.id)).toEqual([f.ids[20]]);
  expect(recovered.items[0]!.sourceBase64).toBe(f.bytes.toString("base64"));
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function blocked(blocker: number) {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    if (
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [blocker],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected database lock wait not observed");
}
it.each(["delete", "consent"])(
  "reads the current continuation after a winning %s mutation",
  async (change) => {
    const f = await fixture();
    const a = await first(f);
    const writer = await pool.connect();
    let exporting: Promise<EvidenceExport> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await writer.query(
        change === "delete"
          ? "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1"
          : "UPDATE evidence_objects SET private_review_allowed=false,private_review_revoked_at=clock_timestamp() WHERE id=$1",
        [f.ids[20]],
      );
      exporting = f.evidence.exportOwned(f.owner.token, a.page.nextCursor!);
      await blocked(pid);
      await writer.query("COMMIT");
      const result = ready(await exporting);
      if (change === "delete") expect(result.items).toEqual([]);
      else
        expect(result.items).toMatchObject([
          {
            id: f.ids[20],
            privateReviewAllowed: false,
            privateReviewRevokedAt: expect.any(Date),
            sourceBase64: f.bytes.toString("base64"),
          },
        ]);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await Promise.allSettled(exporting ? [exporting] : []);
    }
  },
);
it.each(["delete", "consent", "workspace"])(
  "finishes an authorized continuation before a waiting %s mutation and reflects it on a fresh read",
  async (change) => {
    const f = await fixture();
    const a = await first(f);
    const entered = gate(),
      resume = gate();
    let pid = 0;
    const wrapper = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        return client;
      },
    } as unknown as Pool;
    const delayed = evidenceStore(
      wrapper,
      {
        ...f.objects,
        get: async (key) => {
          const bytes = await f.objects.get(key);
          entered.release();
          await resume.wait;
          return bytes;
        },
      },
      "synthetic-page-secret",
    );
    const exporting = delayed.exportOwned(f.owner.token, a.page.nextCursor!);
    let mutation: Promise<unknown> | undefined;
    try {
      await entered.wait;
      mutation =
        change === "delete"
          ? f.evidence.remove(f.owner.token, f.ids[20]!)
          : change === "consent"
            ? f.evidence.revokePrivateReview(f.owner.token, f.ids[20]!)
            : f.evidence.removeWorkspace(f.owner.token);
      await blocked(pid);
      resume.release();
      expect(ready(await exporting).items).toMatchObject([
        {
          id: f.ids[20],
          privateReviewAllowed: true,
          sourceBase64: f.bytes.toString("base64"),
        },
      ]);
      await mutation;
      const later = await f.evidence.exportOwned(
        f.owner.token,
        a.page.nextCursor!,
      );
      if (change === "workspace") expect(later).toEqual({ kind: "denied" });
      else if (change === "delete") expect(ready(later).items).toEqual([]);
      else
        expect(ready(later).items).toMatchObject([
          { privateReviewAllowed: false },
        ]);
    } finally {
      resume.release();
      await Promise.allSettled([exporting, ...(mutation ? [mutation] : [])]);
    }
  },
);
