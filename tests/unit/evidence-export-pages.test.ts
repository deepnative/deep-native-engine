import { createHash, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  EVIDENCE_EXPORT_CURSOR_TTL_MS,
  MAX_EVIDENCE_BYTES,
  MAX_EXPORT_BYTES,
  evidenceStore,
  type EvidenceExport,
} from "../../src/evidence.ts";
import { hash } from "../../src/store.ts";
const token = "a".repeat(64),
  secret = "synthetic-page-secret";
const id = "11111111-1111-4111-8111-111111111111";
const time = "2026-09-29T12:00:00.123456Z";
function signed(value: unknown) {
  const body = Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret)
    .update(`evidence-export-v2.${hash(token)}.${body}`)
    .digest("base64url")}`;
}
function fixture(count = 1, size = 5) {
  let now = Date.now();
  const data = Buffer.alloc(size, 97);
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `sample-${i}.txt`,
    mediaType: "text/plain",
    quarantineState: "clean",
    privateReviewAllowed: true,
    privateReviewRevokedAt: null,
    createdAt: new Date(time),
    orderTime: time,
    revisionParentId: null,
    revisionParentStatus: "none",
    revisionNumber: 1,
    byteSize: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    storageKey: String(i),
  }));
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("FROM principals"))
      return { rows: [{ id, validUntil: new Date("2030-01-01") }] };
    if (statement.includes("FROM workspaces")) return { rows: [{ id }] };
    if (statement.includes("FROM evidence_objects e")) return { rows };
    if (statement.includes("AS valid")) return { rows: [{ valid: true }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const connect = vi.fn(async () => client);
  const objects = {
    put: vi.fn(),
    get: vi.fn(async () => data),
    remove: vi.fn(),
  };
  const evidence = evidenceStore(
    { connect } as unknown as Pool,
    objects,
    secret,
    () => now,
  );
  return {
    evidence,
    query,
    connect,
    client,
    objects,
    rows,
    data,
    advance: () => {
      now += EVIDENCE_EXPORT_CURSOR_TTL_MS;
    },
  };
}
function ready(result: EvidenceExport) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Export unavailable");
  return result;
}
it("bounds each page by item count and signs the last included exact key", async () => {
  const f = fixture(21);
  const first = ready(await f.evidence.exportOwned(token));
  expect(first.items.length).toBe(20);
  expect(first.page).toMatchObject({
    number: 1,
    itemCount: 20,
    sourceBytes: 100,
    complete: false,
    consistency: "live-pages",
  });
  expect(f.objects.get).toHaveBeenCalledTimes(20);
  const decoded = JSON.parse(
    Buffer.from(first.page.nextCursor!.split(".")[0]!, "base64url").toString(),
  );
  expect(decoded.slice(0, 4)).toEqual([1, time, f.rows[19]!.id, 2]);
  f.rows.splice(0, 20);
  const second = ready(
    await f.evidence.exportOwned(token, first.page.nextCursor!),
  );
  expect(second.page).toMatchObject({
    number: 2,
    complete: true,
    nextCursor: null,
    nextHref: null,
    itemCount: 1,
  });
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("(e.created_at,e.id)>"),
    [id, id, time, first.items[19]!.id, 21],
  );
});
it("splits before a clean source exceeds the raw-byte budget and resumes with that source", async () => {
  const f = fixture(5, MAX_EVIDENCE_BYTES);
  const first = ready(await f.evidence.exportOwned(token));
  expect(first.page).toMatchObject({
    sourceBytes: MAX_EXPORT_BYTES,
    itemCount: 4,
    complete: false,
  });
  expect(f.objects.get).toHaveBeenCalledTimes(4);
  f.rows.splice(0, 4);
  const second = ready(
    await f.evidence.exportOwned(token, first.page.nextCursor!),
  );
  expect(second.items[0]!.id).toBe(f.rows[0]!.id);
  expect(second.page).toMatchObject({
    sourceBytes: MAX_EVIDENCE_BYTES,
    itemCount: 1,
    complete: true,
  });
});
it("reports an empty live page with no continuation", async () => {
  const f = fixture(0);
  expect(ready(await f.evidence.exportOwned(token)).page).toEqual({
    number: 1,
    itemCount: 0,
    sourceBytes: 0,
    consistency: "live-pages",
    complete: true,
    nextCursor: null,
    nextHref: null,
  });
  expect(f.objects.get).not.toHaveBeenCalled();
});
it.each([1.5, -1, MAX_EVIDENCE_BYTES + 1])(
  "withholds corrupt source size %s before retrieval",
  async (bytes) => {
    const f = fixture();
    f.rows[0]!.byteSize = bytes;
    expect(await f.evidence.exportOwned(token)).toEqual({
      kind: "unavailable",
    });
    expect(f.objects.get).not.toHaveBeenCalled();
  },
);
it("denies a deleting or missing workspace without accessing its evidence", async () => {
  const f = fixture();
  f.query.mockImplementation(async (sql) =>
    sql.includes("FROM principals")
      ? { rows: [{ id, validUntil: new Date("2030-01-01") }] }
      : { rows: [] },
  );
  expect(await f.evidence.exportOwned(token)).toEqual({ kind: "denied" });
  expect(f.objects.get).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledWith("ROLLBACK");
});
it.each([
  "",
  "x".repeat(1025),
  "not-signed",
  `${Buffer.from("[]").toString("base64url")}.${"a".repeat(43)}`,
  ...[
    "{",
    null,
    {},
    [],
    [2, time, id, 2, Date.now() + 60000],
    [1, 7, id, 2, Date.now() + 60000],
    [1, "imprecise", id, 2, Date.now() + 60000],
    [1, time, 7, 2, Date.now() + 60000],
    [1, time, "bad", 2, Date.now() + 60000],
    [1, time, id, 1.5, Date.now() + 60000],
    [1, time, id, 1, Date.now() + 60000],
    [1, time, id, 2, 1.5],
    [1, time, id, 2, 0],
  ].map(signed),
])(
  "rejects malformed or expired continuation %# before opening the database",
  async (cursor) => {
    const f = fixture();
    expect(await f.evidence.exportOwned(token, cursor)).toEqual({
      kind: "denied",
    });
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("binds the cursor to its session and purpose, preserves expiry and rejects a slow page that outlives it", async () => {
  const f = fixture(21);
  const a = ready(await f.evidence.exportOwned(token));
  const cursor = a.page.nextCursor!;
  expect(await f.evidence.exportOwned("b".repeat(64), cursor)).toEqual({
    kind: "denied",
  });
  const body = cursor.split(".")[0]!;
  const wrongPurpose = `${body}.${createHmac("sha256", secret)
    .update(`${hash(token)}.${body}`)
    .digest("base64url")}`;
  expect(await f.evidence.exportOwned(token, wrongPurpose)).toEqual({
    kind: "denied",
  });
  f.rows.splice(0, 20);
  f.objects.get.mockImplementationOnce(async () => {
    f.advance();
    return f.data;
  });
  expect(await f.evidence.exportOwned(token, cursor)).toEqual({
    kind: "denied",
  });
  expect(f.query).toHaveBeenCalledWith("ROLLBACK");
  expect(await f.evidence.exportOwned(token, cursor)).toEqual({
    kind: "denied",
  });
  expect(ready(await f.evidence.exportOwned(token)).page.number).toBe(1);
});
it("does not disclose an assembled page if COMMIT fails", async () => {
  const f = fixture();
  const query = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql) => {
    if (sql === "COMMIT") throw Error("synthetic commit failure");
    return query(sql);
  });
  expect(await f.evidence.exportOwned(token)).toEqual({ kind: "unavailable" });
  expect(f.query).toHaveBeenCalledWith("ROLLBACK");
  expect(f.client.release).toHaveBeenCalled();
});
