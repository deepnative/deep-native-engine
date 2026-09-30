import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { hash } from "../../src/store.ts";
import {
  disabledMemberExportStore,
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
  MAX_MEMBER_EXPORT_BYTES,
  MEMBER_EXPORT_CURSOR_TTL_MS,
} from "../../src/member-export.ts";
const secret = Buffer.alloc(32, 7);
afterEach(() => vi.useRealTimers());
function fakePool(
  owner: Record<string, unknown> | null,
  rows: (sql: string) => Record<string, unknown>[] = () => [],
  failAt?: string,
) {
  const statements: string[] = [];
  let released = false,
    destroyed = false;
  const pool = {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        statements.push(sql);
        if (failAt && sql.includes(failAt))
          throw Error("private database details");
        if (
          sql.includes("FROM principals p JOIN learners l") ||
          sql.startsWith("SELECT id FROM principals")
        )
          return { rows: owner ? [owner] : [] };
        const all = rows(sql).map((row, index) => ({
          _key: [String(index).padStart(5, "0")],
          ...row,
        }));
        if (!sql.includes('AS "_key"')) return { rows: all };
        const key = JSON.parse(values![2] as string) as string[];
        return {
          rows: all
            .filter(
              (row) =>
                key.length === 0 ||
                JSON.stringify(row._key) > JSON.stringify(key),
            )
            .slice(0, Number(values![1])),
        };
      },
      release: (error?: Error) => {
        released = true;
        destroyed = error instanceof Error;
      },
    }),
  } as unknown as Pool;
  return {
    pool,
    statements,
    wasReleased: () => released,
    wasDestroyed: () => destroyed,
  };
}
const manyRows = (sql: string) =>
  sql.includes("FROM exercises")
    ? Array.from({ length: 205 }, (_, id) => ({ id }))
    : [];
function signed(data: unknown, body?: string) {
  const encoded =
    body ?? Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(hash("owner")).update(".").update(encoded).digest("base64url")}`;
}
it("fails closed without configured storage or an active owner", async () => {
  expect(await disabledMemberExportStore().exportOwned("x")).toEqual({
    kind: "denied",
  });
  const fake = fakePool(null);
  expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(fake.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(fake.wasReleased()).toBe(true);
});
it("returns a versioned complete page only after commit, without internal cursor keys", async () => {
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM learning_milestones")
      ? [{ milestoneTitle: "Invented milestone" }]
      : [],
  );
  expect(await memberExportStore(fake.pool).exportOwned("x")).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v10",
      profile: { id: "member-1" },
      records: { milestones: [{ milestoneTitle: "Invented milestone" }] },
      page: {
        complete: true,
        nextCursor: null,
        recordCount: 1,
        number: 1,
        consistency: "live-pages",
      },
    },
  });
  expect(fake.statements).toContain("COMMIT");
  expect(fake.wasReleased()).toBe(true);
  expect(fake.wasDestroyed()).toBe(false);
});
it("continues after the last emitted record, including the exact cap and section boundary", async () => {
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM exercises")
      ? Array.from({ length: 100 }, (_, id) => ({ id }))
      : sql.includes("FROM local_ai_receipts")
        ? [{ id: "receipt" }]
        : [],
  );
  const exporter = memberExportStore(fake.pool);
  const first = await exporter.exportOwned("x");
  expect(first).toMatchObject({
    kind: "ready",
    payload: {
      page: { complete: false, recordCount: MAX_MEMBER_EXPORT_RECORDS },
    },
  });
  if (first.kind !== "ready") throw Error("Missing page");
  expect(JSON.stringify(first.payload)).not.toContain('"_key"');
  const next = await exporter.exportOwned("x", first.payload.page.nextCursor!);
  expect(next).toMatchObject({
    kind: "ready",
    payload: {
      records: { exercises: [], localAiReceipts: [{ id: "receipt" }] },
      page: { complete: true, recordCount: 1, number: 2 },
    },
  });
  const exact = memberExportStore(
    fakePool({ id: "member-1" }, (sql) =>
      sql.includes("FROM exercises")
        ? Array.from({ length: 100 }, () => ({}))
        : [],
    ).pool,
  );
  expect(await exact.exportOwned("x")).toMatchObject({
    kind: "ready",
    payload: { page: { complete: true, recordCount: 100 } },
  });
});
it("bounds the entire escaped UTF-8 envelope and does not consume a byte-rejected row", async () => {
  const records = Array.from({ length: 80 }, (_, id) => ({
    id,
    instruction: 'é\\"'.repeat(1000),
  }));
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM exercises") ? records : [],
  );
  const exporter = memberExportStore(fake.pool);
  const found: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.exportOwned("owner", cursor);
    if (page.kind !== "ready") throw Error("Missing page");
    expect(Buffer.byteLength(JSON.stringify(page.payload))).toBeLessThanOrEqual(
      MAX_MEMBER_EXPORT_BYTES,
    );
    expect(page.payload.page.recordCount).toBeGreaterThan(0);
    found.push(...page.payload.records.exercises!.map((row) => Number(row.id)));
    cursor = page.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(found).toEqual(records.map((row) => row.id));
});
it("explicitly refuses an oversized first record or profile and releases locks", async () => {
  for (const fake of [
    fakePool({ id: "member-1" }, (sql) =>
      sql.includes("FROM exercises")
        ? [{ instruction: "x".repeat(MAX_MEMBER_EXPORT_BYTES) }]
        : [],
    ),
    fakePool({ id: "x".repeat(MAX_MEMBER_EXPORT_BYTES) }),
  ]) {
    expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
      kind: "limit",
    });
    expect(fake.statements).not.toContain("COMMIT");
    expect(fake.wasReleased()).toBe(true);
  }
});
it("binds continuation to the session and process key, rejecting tampering and expiry", async () => {
  const fake = fakePool({ id: "member-1" }, manyRows);
  const exporter = memberExportStore(fake.pool, secret);
  const first = await exporter.exportOwned("owner");
  if (first.kind !== "ready") throw Error("Missing page");
  const cursor = first.payload.page.nextCursor!;
  expect(await exporter.exportOwned("other", cursor)).toEqual({
    kind: "denied",
  });
  const [body, signature] = cursor.split(".");
  const tampered = `${body}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  expect(await exporter.exportOwned("owner", tampered)).toEqual({
    kind: "denied",
  });
  expect(
    await memberExportStore(fake.pool).exportOwned("owner", cursor),
  ).toEqual({ kind: "denied" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + MEMBER_EXPORT_CURSOR_TTL_MS + 1);
  expect(await exporter.exportOwned("owner", cursor)).toEqual({
    kind: "denied",
  });
});
it("rejects malformed or obsolete authenticated cursor fields before connecting", async () => {
  const valid = [1, 0, ["key"], 2, Date.now() + 60000];
  const candidates: unknown[] = [
    null,
    [],
    [2, ...valid.slice(1)],
    [1, -1, ...valid.slice(2)],
    [1, 16, ...valid.slice(2)],
    [1, 0.1, ...valid.slice(2)],
    [1, 0, null, 2, valid[4]],
    [1, 0, [], 2, valid[4]],
    [1, 0, ["a", "b", "c"], 2, valid[4]],
    [1, 0, ["x".repeat(161)], 2, valid[4]],
    [1, 0, [{}], 2, valid[4]],
    [1, 0, [-1], 2, valid[4]],
    [1, 0, [1.2], 2, valid[4]],
    [1, 0, ["key"], 1, valid[4]],
    [1, 0, ["key"], 2.5, valid[4]],
    [1, 0, ["key"], 2, 0],
    [1, 0, ["key"], 2, "future"],
  ];
  const fake = fakePool({ id: "member-1" });
  const exporter = memberExportStore(fake.pool, secret);
  for (const cursor of [
    "",
    "x".repeat(1025),
    "broken",
    signed(null, Buffer.from("{").toString("base64url")),
    ...candidates.map((value) => signed(value)),
  ])
    expect(await exporter.exportOwned("owner", cursor)).toEqual({
      kind: "denied",
    });
  expect(fake.statements).toEqual([]);
  expect(
    await exporter.exportOwned(
      "owner",
      signed([1, 0, ["lesson", 1], 2, Date.now() + 60000]),
    ),
  ).toMatchObject({ kind: "ready" });
});
it("withholds a page if continuation expires during assembly", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fake = fakePool({ id: "member-1" }, (sql) => {
    if (sql.includes("FROM exercises"))
      vi.setSystemTime(Date.now() + MEMBER_EXPORT_CURSOR_TTL_MS + 1);
    return [];
  });
  expect(await memberExportStore(fake.pool).exportOwned("owner")).toEqual({
    kind: "denied",
  });
  expect(fake.statements).not.toContain("COMMIT");
});
it("withholds records on receipt, parent-lock, connection or commit failure", async () => {
  for (const failAt of [
    "FROM local_ai_receipts",
    "FROM assignment_attempts a",
    "COMMIT",
  ]) {
    const fake = fakePool({ id: "member-1" }, () => [], failAt);
    expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
      kind: "unavailable",
    });
    expect(fake.wasReleased()).toBe(true);
  }
  expect(
    await memberExportStore({
      connect: async () => {
        throw Error("private connection");
      },
    } as unknown as Pool).exportOwned("x"),
  ).toEqual({ kind: "unavailable" });
  const fake = fakePool(null, () => [], "ROLLBACK");
  expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(fake.wasDestroyed()).toBe(true);
});
it("withholds a page when the session expires before commit", async () => {
  const statements: string[] = [];
  const fake = {
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: sql.includes("FROM principals p JOIN learners l")
            ? [{ id: "member-1" }]
            : [],
        };
      },
      release() {},
    }),
  } as unknown as Pool;
  expect(await memberExportStore(fake).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(statements).not.toContain("COMMIT");
  expect(statements.at(-1)).toBe("ROLLBACK");
});

it("returns submission text only after its bounded parent batch is locked", async () => {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.startsWith("SELECT a.id")
      ? [{ id: "owned-attempt" }]
      : sql.includes("FROM assignment_submission_snapshots s")
        ? [
            {
              attemptId: "owned-attempt",
              sequence: 1,
              response: "Invented private submission",
            },
          ]
        : [],
  );
  const original = fake.pool.connect.bind(fake.pool);
  const pool = {
    connect: async () => {
      const client = await original();
      return {
        query: (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(await memberExportStore(pool).exportOwned("owner")).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        assignmentSubmissions: [
          {
            attemptId: "owned-attempt",
            sequence: 1,
            response: "Invented private submission",
          },
        ],
      },
    },
  });
  const locked = calls.findIndex((call) => call.sql.startsWith("SELECT a.id"));
  const children = calls.findIndex(
    (call) =>
      call.sql.includes('AS "_key"') &&
      call.sql.includes("FROM assignment_submission_snapshots s"),
  );
  expect(locked).toBeLessThan(children);
  expect(calls[children]!.values![3]).toEqual(["owned-attempt"]);
});

it("accepts the exact serialized UTF-8 page byte cap and rejects one additional byte", async () => {
  let instruction = "";
  const rows = (sql: string) =>
    sql.includes("FROM exercises")
      ? [{ instruction }, { instruction: "x".repeat(MAX_MEMBER_EXPORT_BYTES) }]
      : [];
  const exporter = memberExportStore(fakePool({ id: "member-1" }, rows).pool);
  const baseline = await exporter.exportOwned("owner");
  if (baseline.kind !== "ready") throw Error("Missing baseline page");
  const padding =
    MAX_MEMBER_EXPORT_BYTES -
    Buffer.byteLength(JSON.stringify(baseline.payload));
  instruction = "é" + "x".repeat(padding - 2);
  const exact = await exporter.exportOwned("owner");
  if (exact.kind !== "ready") throw Error("Missing exact-boundary page");
  expect(Buffer.byteLength(JSON.stringify(exact.payload))).toBe(
    MAX_MEMBER_EXPORT_BYTES,
  );
  expect(exact.payload.page.complete).toBe(false);
  instruction += "x";
  expect(await exporter.exportOwned("owner")).toEqual({ kind: "limit" });
});
