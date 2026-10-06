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
        if (sql.startsWith("WITH instant")) {
          const observedAt = new Date();
          return {
            rows: owner
              ? [
                  {
                    id: owner.id,
                    observedAt,
                    snapshotStartedAt: observedAt,
                    remainingMs: "60000",
                  },
                ]
              : [],
          };
        }
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
      version: "local-member-records-v22",
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
  const valid = [2, 0, ["key"], 2, Date.now() + 60000];
  const candidates: unknown[] = [
    null,
    [],
    [1, ...valid.slice(1)],
    [2, -1, ...valid.slice(2)],
    [2, 37, ...valid.slice(2)],
    [2, 0.1, ...valid.slice(2)],
    [2, 0, null, 2, valid[4]],
    [2, 0, [], 2, valid[4]],
    [2, 0, ["a", "b", "c", "d"], 2, valid[4]],
    [2, 0, ["x".repeat(161)], 2, valid[4]],
    [2, 0, [{}], 2, valid[4]],
    [2, 0, [-1], 2, valid[4]],
    [2, 0, [1.2], 2, valid[4]],
    [2, 0, ["key"], 1, valid[4]],
    [2, 0, ["key"], 2.5, valid[4]],
    [2, 0, ["key"], 2, 0],
    [2, 0, ["key"], 2, "future"],
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
      signed([2, 0, ["lesson", 1], 2, Date.now() + 60000]),
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
    "SELECT s.id FROM private_practice_sessions",
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
    kind: "unavailable",
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

it("exports owned practice pairs after parent locks even when continuation starts inside exchanges", async () => {
  for (const continuation of [
    undefined,
    signed([2, 18, ["prior", 1], 2, Date.now() + 60000]),
  ]) {
    const calls: { sql: string; values: unknown[] | undefined }[] = [];
    const fake = fakePool({ id: "member-1" }, (sql) =>
      sql.startsWith("SELECT s.id")
        ? [{ id: "owned-session" }]
        : sql.includes("FROM private_practice_exchanges e") &&
            sql.includes('AS "_key"')
          ? [
              {
                _key: ["z-session", 2],
                sessionId: "owned-session",
                sequence: 2,
                response: "Invented response",
                comparison: "Simulated comparison",
                sourceExcerpt: "Exact sample",
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
    expect(
      await memberExportStore(pool, secret).exportOwned("owner", continuation),
    ).toMatchObject({
      kind: "ready",
      payload: {
        records: {
          practiceExchanges: [
            {
              sessionId: "owned-session",
              sequence: 2,
              response: "Invented response",
            },
          ],
        },
      },
    });
    const parent = calls.findIndex((call) =>
      call.sql.startsWith("SELECT s.id"),
    );
    const child = calls.findIndex(
      (call) =>
        call.sql.includes('AS "_key"') &&
        call.sql.includes("FROM private_practice_exchanges e"),
    );
    expect(parent).toBeGreaterThan(-1);
    expect(parent).toBeLessThan(child);
    expect(calls[child]!.values![3]).toEqual(["owned-session"]);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  }
});

it("exports member support receipts and visible replies without querying internal notes", async () => {
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM support_requests WHERE")
      ? [
          {
            id: "request",
            subject: "Invented subject",
            body: "Invented request",
          },
        ]
      : sql.startsWith("SELECT r.id FROM support_requests r")
        ? [{ id: "request" }]
        : sql.includes("FROM support_request_replies e")
          ? [
              {
                id: "reply",
                requestId: "request",
                body: "Visible sample reply",
              },
            ]
          : [],
  );
  expect(await memberExportStore(fake.pool).exportOwned("owner")).toMatchObject(
    {
      kind: "ready",
      payload: {
        version: "local-member-records-v22",
        records: {
          supportRequests: [
            { subject: "Invented subject", body: "Invented request" },
          ],
          supportReplies: [{ body: "Visible sample reply" }],
        },
      },
    },
  );
  expect(fake.statements.join("\n")).not.toMatch(
    /support_request_(notes|grants|events|mutations)/,
  );
});

it("locks owned support parents before direct reply continuation and withholds text on lock failure", async () => {
  const continuation = signed([
    2,
    20,
    ["prior", "prior-reply"],
    2,
    Date.now() + 60000,
  ]);
  for (const failAt of [undefined, "SELECT r.id FROM support_requests r"]) {
    const fake = fakePool(
      { id: "member-1" },
      (sql) =>
        sql.startsWith("SELECT r.id FROM support_requests r")
          ? [{ id: "owned-request" }]
          : sql.includes("FROM support_request_replies e")
            ? [{ _key: ["z-request", "z-reply"], body: "Visible sample" }]
            : [],
      failAt,
    );
    const result = await memberExportStore(fake.pool, secret).exportOwned(
      "owner",
      continuation,
    );
    if (failAt) {
      expect(result).toEqual({ kind: "unavailable" });
      expect(fake.statements).not.toContain("COMMIT");
    } else {
      expect(result).toMatchObject({
        kind: "ready",
        payload: { records: { supportReplies: [{ body: "Visible sample" }] } },
      });
      const parent = fake.statements.findIndex((sql) =>
        sql.startsWith("SELECT r.id FROM support_requests r"),
      );
      const child = fake.statements.findIndex(
        (sql) =>
          sql.includes('AS "_key"') &&
          sql.includes("FROM support_request_replies e"),
      );
      expect(parent).toBeGreaterThan(-1);
      expect(parent).toBeLessThan(child);
    }
  }
});

it("keeps legacy section indices stable and accepts the two appended owned support-time sections", async () => {
  const fake = fakePool({ id: "member-1" });
  const exporter = memberExportStore(fake.pool, secret);
  for (const section of [19, 20, 21, 22]) {
    const result = await exporter.exportOwned(
      "owner",
      signed([2, section, ["key"], 2, Date.now() + 60000]),
    );
    expect(result.kind).toBe("ready");
  }
  expect(
    fake.statements.some((sql) =>
      sql.includes("support_time_allocations a WHERE a.member_id=$1"),
    ),
  ).toBe(true);
  expect(
    fake.statements.some(
      (sql) =>
        sql.includes(
          "support_time_entries e JOIN support_time_allocations a",
        ) && sql.includes("a.member_id=$1"),
    ),
  ).toBe(true);
});

it("continues from appended circle sections at indices 23-26 without moving legacy indices", async () => {
  for (const [index, name, table] of [
    [23, "circleChoices", "preview_circle_choices"],
    [24, "circlePosts", "preview_circle_posts"],
    [25, "circleReports", "preview_circle_reports"],
    [26, "circleMembershipHistory", "preview_circle_membership_history"],
  ] as const) {
    const fake = fakePool({ id: "member-1" }, (sql) =>
      sql.includes(`FROM ${table} WHERE member_id=$1`)
        ? [{ _key: ["z-record"], id: "retained-own-record" }]
        : [],
    );
    const value = await memberExportStore(fake.pool, secret).exportOwned(
      "owner",
      signed([2, index, ["key"], 2, Date.now() + 60000]),
    );
    expect(value).toMatchObject({
      kind: "ready",
      payload: { records: { [name]: [{ id: "retained-own-record" }] } },
    });
  }
});

it("accepts every legacy section index and appends retained unit history at indices 27-30", async () => {
  const empty = memberExportStore(fakePool({ id: "member-1" }).pool, secret);
  for (let index = 0; index <= 30; index++)
    expect(
      await empty.exportOwned(
        "owner",
        signed([2, index, ["key"], 2, Date.now() + 60000]),
      ),
    ).toMatchObject({ kind: "ready" });
  for (const [index, name, table] of [
    [27, "testUnitGrants", "synthetic_entitlement_grants g"],
    [28, "testUnitReservations", "synthetic_entitlement_reservations r"],
    [29, "testUnitEvents", "synthetic_entitlement_events e"],
    [30, "testUnitSettlements", "synthetic_entitlement_settlements s"],
  ] as const) {
    const fake = fakePool({ id: "member-1" }, (sql) =>
      sql.includes(`FROM ${table}`)
        ? [{ _key: ["z-owned"], id: "retained-owned" }]
        : [],
    );
    const value = await memberExportStore(fake.pool, secret).exportOwned(
      "owner",
      signed([2, index, ["key"], 2, Date.now() + 60000]),
    );
    expect(value).toMatchObject({
      kind: "ready",
      payload: { records: { [name]: [{ id: "retained-owned" }] } },
    });
  }
});
it("exports published sample feedback after fencing its source and omits internal pagination keys", async () => {
  const fake = fakePool({ id: "member-1" }, (sql) => {
    if (sql.startsWith("SELECT e.id FROM evidence_objects e"))
      return [{ id: "source-1" }];
    if (sql.includes("FROM private_sample_feedback f JOIN"))
      return [
        {
          id: "feedback-1",
          evidenceId: "source-1",
          criteria: [{ label: "Clarity", comment: "Invented feedback" }],
          consentActive: false,
        },
      ];
    return [];
  });
  const result = await memberExportStore(fake.pool).exportOwned("x");
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      records: {
        sampleFeedback: [
          {
            id: "feedback-1",
            evidenceId: "source-1",
            criteria: [{ label: "Clarity", comment: "Invented feedback" }],
            consentActive: false,
          },
        ],
      },
      page: { complete: true, recordCount: 1 },
    },
  });
  expect(JSON.stringify(result)).not.toContain('"_key"');
  const fence = fake.statements.findIndex((sql) =>
    sql.startsWith("SELECT e.id FROM evidence_objects e"),
  );
  const feedback = fake.statements.findIndex((sql) =>
    sql.includes("FROM private_sample_feedback f JOIN"),
  );
  expect(fence).toBeGreaterThan(-1);
  expect(feedback).toBeGreaterThan(fence);
  expect(fake.statements.at(-1)).toBe("COMMIT");
});

it("appends owned review accounting at indices 33-35 without moving existing sections", async () => {
  for (const [index, name, table] of [
    [33, "reviewTimeAllocations", "review_time_allocations a JOIN workspaces"],
    [
      34,
      "reviewTimeEntries",
      "review_time_entries e JOIN review_time_allocations",
    ],
    [
      35,
      "reviewTimeEvents",
      "review_time_events e JOIN review_time_allocations",
    ],
  ] as const) {
    const fake = fakePool({ id: "member-1" }, (sql) =>
      sql.includes(`FROM ${table}`)
        ? [{ _key: ["retained"], id: "owned-accounting" }]
        : [],
    );
    const value = await memberExportStore(fake.pool, secret).exportOwned(
      "owner",
      signed([2, index, ["key"], 2, Date.now() + 60000]),
    );
    expect(value).toMatchObject({
      kind: "ready",
      payload: {
        version: "local-member-records-v22",
        records: { [name]: [{ id: "owned-accounting" }] },
      },
    });
    expect(
      fake.statements.filter((sql) => sql.includes(`FROM ${table}`))[0],
    ).toContain("w.owner_principal_id=a.member_id");
  }
});

it("appends safe source-deleted assignment receipts at index36 without moving any v2 cursor section", async () => {
  const record = {
    receiptId: "retained",
    evidenceId: "deleted-source",
    sourceRevision: 2,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-02T00:00:00.000Z",
    createdAt: "2090-01-01T00:00:00.000Z",
    state: "retained-structural-receipt",
  };
  const fake = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM private_sample_assignment_operations o JOIN workspaces")
      ? [{ _key: ["retained"], ...record }]
      : [],
  );
  const exporter = memberExportStore(fake.pool, secret);
  const value = await exporter.exportOwned(
    "owner",
    signed([2, 36, ["key"], 2, Date.now() + 60000]),
  );
  expect(value).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v22",
      records: { sampleAssignmentOperations: [record] },
    },
  });
  const query = fake.statements.find((sql) =>
    sql.includes("FROM private_sample_assignment_operations"),
  )!;
  expect(query).toContain("w.owner_principal_id=$1 AND w.deleting_at IS NULL");
  expect(query).not.toMatch(
    /administrator_id|reviewer_id|operation_id|assignment_id|exact_grant_id|JOIN evidence/,
  );
  for (let index = 0; index <= 36; index++)
    expect(
      (
        await memberExportStore(
          fakePool({ id: "member-1" }).pool,
          secret,
        ).exportOwned(
          "owner",
          signed([2, index, ["key"], 2, Date.now() + 60000]),
        )
      ).kind,
    ).toBe("ready");
});
