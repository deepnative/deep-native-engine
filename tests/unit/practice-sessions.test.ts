import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledPracticeSessionStore,
  practiceSessionStore,
  type PracticeSessionExchange,
  type PracticeSessionStore,
  type PracticeSessionSummary,
} from "../../src/practice-sessions.ts";

const id = "00000000-0000-4000-8000-000000000001";
const summary: PracticeSessionSummary & { title: string } = {
  id,
  contentId: "SYN-130",
  contentVersion: 1,
  goal: "everyday",
  promptVersion: "practice-v1",
  createdAt: new Date("2026-01-01"),
  withdrawnAt: null,
  title: "Invented lesson",
};
const start = {
  contentId: "SYN-130",
  contentVersion: 1,
  goal: "everyday" as const,
  promptVersion: "practice-v1",
};
const pair = (
  sequence = 1,
  response = "Invented response",
): PracticeSessionExchange => ({
  sequence,
  response,
  comparison: "Stored unreviewed comparison",
  sourceExcerpt: "Exact invented source",
  acceptedAt: new Date("2026-01-01"),
});
function fixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    valid?: boolean;
    source?: boolean;
    row?: Partial<typeof summary> | null;
    sourceGoal?: "everyday" | "work" | "build";
    body?: string;
    existing?: { id: string; withdrawnAt: Date | null };
    pairs?: PracticeSessionExchange[];
    history?: (PracticeSessionSummary & { cursorAt: string })[];
    failAt?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const pairs = [...(options.pairs ?? [])];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      (options.failAt && sql.includes(options.failAt)) ||
      (options.rollbackFails && sql === "ROLLBACK")
    )
      throw Error("Sensitive database diagnostic");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "member-id", expires_at: new Date("2100-01-01") }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "member-id" }] };
    if (sql.startsWith("SELECT cv.id AS"))
      return {
        rows:
          options.source === false
            ? []
            : [
                {
                  contentId: "SYN-130",
                  contentVersion: 1,
                  title: "Invented lesson",
                  body: options.body ?? "Exact invented source",
                  goal: options.sourceGoal ?? "everyday",
                },
              ],
      };
    if (sql.startsWith("SELECT id,withdrawn_at"))
      return { rows: options.existing ? [options.existing] : [] };
    if (sql.includes('AS "cursorAt"')) return { rows: options.history ?? [] };
    if (sql.includes("FROM private_practice_sessions s"))
      return {
        rows: options.row === null ? [] : [{ ...summary, ...options.row }],
      };
    if (
      sql.includes("FROM private_practice_exchanges") &&
      sql.startsWith("SELECT")
    )
      return { rows: pairs };
    if (sql.startsWith("INSERT INTO private_practice_exchanges"))
      pairs.push({
        ...pair(params![1] as number, params![2] as string),
        comparison: params![3] as string,
        sourceExcerpt: params![4] as string,
      });
    if (sql.includes("AS valid"))
      return { rows: [{ valid: options.valid !== false }] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    store: practiceSessionStore({ connect } as unknown as Pool),
    query,
    release,
    connect,
    pairs,
  };
}
const operations = {
  source: (store: PracticeSessionStore, token = "token") =>
    store.source(token, "SYN-130"),
  start: (store: PracticeSessionStore, token = "token") =>
    store.start(token, start),
  history: (store: PracticeSessionStore, token = "token") =>
    store.history(token),
  detail: (store: PracticeSessionStore, token = "token") =>
    store.detail(token, id),
  append: (store: PracticeSessionStore, token = "token") =>
    store.append(token, id, {
      expectedSequence: 1,
      response: "Invented response",
    }),
  withdraw: (store: PracticeSessionStore, token = "token") =>
    store.withdraw(token, id),
};
function denied(operation: keyof typeof operations) {
  return operation === "start"
    ? { kind: "unavailable" }
    : operation === "append" || operation === "withdraw"
      ? "unavailable"
      : null;
}
it("keeps every disabled entry point unavailable", async () => {
  const store = disabledPracticeSessionStore();
  for (const [name, run] of Object.entries(operations))
    expect(await run(store)).toEqual(denied(name as keyof typeof operations));
});
it.each(Object.keys(operations) as (keyof typeof operations)[])(
  "protects %s through active identity, workspace and a final expiry barrier",
  async (operation) => {
    for (const options of [
      { principal: false },
      { workspace: false },
      { valid: false },
    ]) {
      const f = fixture(options);
      expect(await operations[operation](f.store)).toEqual(denied(operation));
      expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
      expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
      expect(f.release).toHaveBeenCalledWith(undefined);
    }
    const empty = fixture();
    expect(await operations[operation](empty.store, " ")).toEqual(
      denied(operation),
    );
    expect(empty.connect).not.toHaveBeenCalled();
  },
);
it.each(["everyday", "work", "build"] as const)(
  "pins the %s instructions and bounds a Unicode excerpt without changing source bytes",
  async (goal) => {
    const f = fixture({ sourceGoal: goal, body: "😀".repeat(601) });
    const source = await f.store.source("token", "SYN-130");
    expect(source).toMatchObject({
      goal,
      promptVersion: "practice-v1",
      sourceExcerpt: "😀".repeat(600),
    });
    expect(source!.prompt).toContain("invented");
    expect(await f.store.start("token", { ...start, goal })).toMatchObject({
      kind: "started",
      sessionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  },
);
it("rejects malformed keys and response boundaries before acquiring a connection", async () => {
  const f = fixture();
  expect(await f.store.source("token", "bad")).toBeNull();
  for (const input of [
    { ...start, contentId: "bad" },
    { ...start, contentVersion: 0 },
    { ...start, contentVersion: 1.5 },
    { ...start, contentVersion: 2147483648 },
    { ...start, goal: "forged" },
    { ...start, promptVersion: "unknown" },
  ]) {
    expect(await f.store.start("token", input as typeof start)).toEqual({
      kind: "unavailable",
    });
  }
  expect(await f.store.detail("token", "bad")).toBeNull();
  expect(await f.store.withdraw("token", "bad")).toBe("unavailable");
  for (const [sessionId, expectedSequence, response] of [
    ["bad", 1, "sample"],
    [id, 0, "sample"],
    [id, 1.5, "sample"],
    [id, 17, "sample"],
    [id, 1, ""],
    [id, 1, " \n\t"],
    [id, 1, "x".repeat(1001)],
    [id, 1, 1],
  ] as const) {
    expect(
      await f.store.append("token", sessionId, {
        expectedSequence,
        response: response as string,
      }),
    ).toBe("unavailable");
  }
  expect(f.connect).not.toHaveBeenCalled();
});
it("fails closed for missing, changed-goal and unknown sources without creating a slot", async () => {
  expect(
    await fixture({ source: false }).store.source("token", "SYN-130"),
  ).toBeNull();
  for (const options of [{ source: false }, { sourceGoal: "work" as const }]) {
    const f = fixture(options);
    expect(await f.store.start("token", start)).toEqual({
      kind: "unavailable",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  }
});
it("replays the same start slot and preserves an irreversible withdrawal marker", async () => {
  expect(
    await fixture({ existing: { id, withdrawnAt: null } }).store.start(
      "token",
      start,
    ),
  ).toEqual({ kind: "replayed", sessionId: id });
  expect(
    await fixture({
      source: false,
      existing: { id, withdrawnAt: new Date() },
    }).store.start("token", start),
  ).toEqual({ kind: "withdrawn" });
});
it("returns retained detail with the correct availability and never regenerates stored comparisons", async () => {
  for (const [options, availability] of [
    [{}, "available"],
    [{ row: { withdrawnAt: new Date() } }, "withdrawn"],
    [{ row: { promptVersion: "retained-unknown" } }, "unknown-template"],
    [{ source: false }, "source-unavailable"],
    [{ sourceGoal: "work" }, "source-unavailable"],
    [{ pairs: Array.from({ length: 15 }, (_, i) => pair(i + 1)) }, "full"],
  ] as const) {
    const f = fixture({ pairs: [pair()], ...options });
    const result = await f.store.detail("token", id);
    expect(result).toMatchObject({
      availability,
      nextSequence: availability === "available" ? 2 : null,
    });
    expect(result!.exchanges).toHaveLength(
      availability === "withdrawn" ? 0 : availability === "full" ? 15 : 1,
    );
    if (availability !== "withdrawn")
      expect(result!.exchanges[0]!.comparison).toBe(
        "Stored unreviewed comparison",
      );
    if (availability === "withdrawn" || availability === "unknown-template")
      expect(result!.prompt).toBeNull();
  }
  expect(await fixture({ row: null }).store.detail("token", id)).toBeNull();
});
it("stores the exact paired words and source, then replays only byte-identical responses", async () => {
  const f = fixture();
  const response = "  Invented response\n🧪 ";
  expect(
    await f.store.append("token", id, { expectedSequence: 1, response }),
  ).toBe("saved");
  const detail = (await f.store.detail("token", id))!;
  expect(detail.exchanges[0]).toMatchObject({
    response,
    sourceExcerpt: "Exact invented source",
  });
  const comparison = detail.exchanges[0]!.comparison;
  for (const text of [
    response,
    "Exact invented source",
    "Simulation",
    "unreviewed",
    "Uncertainty",
    "cannot judge competence",
  ])
    expect(comparison).toContain(text);
  expect(
    await f.store.append("token", id, { expectedSequence: 1, response }),
  ).toBe("replayed");
  expect(
    await f.store.append("token", id, {
      expectedSequence: 1,
      response: response.trim(),
    }),
  ).toBe("conflict");
  expect(
    await f.store.append("token", id, { expectedSequence: 3, response }),
  ).toBe("conflict");
  expect(
    await f.store.append("token", id, {
      expectedSequence: 2,
      response: "x".repeat(1000),
    }),
  ).toBe("saved");
  expect(f.pairs).toHaveLength(2);
});
it("checks withdrawal and live eligibility before replay, and replay before the cap", async () => {
  for (const [options, outcome] of [
    [{ row: null }, "unavailable"],
    [{ row: { withdrawnAt: new Date() } }, "withdrawn"],
    [{ source: false }, "unavailable"],
    [{ sourceGoal: "work" }, "unavailable"],
    [{ row: { promptVersion: "unknown" } }, "unavailable"],
  ] as const) {
    expect(
      await fixture({ ...options, pairs: [pair()] }).store.append("token", id, {
        expectedSequence: 1,
        response: "Invented response",
      }),
    ).toBe(outcome);
  }
  const f = fixture({
    pairs: Array.from({ length: 15 }, (_, i) => pair(i + 1)),
  });
  expect(
    await f.store.append("token", id, {
      expectedSequence: 15,
      response: "Invented response",
    }),
  ).toBe("replayed");
  expect(
    await f.store.append("token", id, {
      expectedSequence: 15,
      response: "Different",
    }),
  ).toBe("conflict");
  expect(
    await f.store.append("token", id, {
      expectedSequence: 16,
      response: "New",
    }),
  ).toBe("full");
});
it("withdraws exact owned history regardless of source/template eligibility", async () => {
  const f = fixture({ row: { promptVersion: "unknown" }, source: false });
  expect(await f.store.withdraw("token", id)).toBe("withdrawn");
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(
    expect.arrayContaining([
      "DELETE FROM private_practice_exchanges WHERE session_id=$1",
      "UPDATE private_practice_sessions SET withdrawn_at=clock_timestamp() WHERE id=$1",
    ]),
  );
  expect(
    await fixture({ row: { withdrawnAt: new Date() } }).store.withdraw(
      "token",
      id,
    ),
  ).toBe("already-withdrawn");
  expect(await fixture({ row: null }).store.withdraw("token", id)).toBe(
    "unavailable",
  );
});
it("uses bounded history pages with a microsecond-precise keyset and no response fields", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    ...summary,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    cursorAt: "2026-01-01T00:00:00.123456Z",
  }));
  const f = fixture({ history: rows });
  const first = (await f.store.history("token"))!;
  expect(first.items).toHaveLength(20);
  expect(first.items[0]).not.toHaveProperty("cursorAt");
  expect(
    JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()),
  ).toEqual([rows[19]!.cursorAt, rows[19]!.id]);
  const second = fixture({ history: rows.slice(20) });
  expect(await second.store.history("token", first.nextCursor!)).toMatchObject({
    items: [expect.objectContaining({ id: rows[20]!.id })],
    nextCursor: null,
  });
  expect(
    second.query.mock.calls.find(([sql]) => sql.includes('AS "cursorAt"'))![1],
  ).toEqual(["member-id", rows[19]!.cursorAt, rows[19]!.id]);
  expect(await fixture().store.history("token")).toEqual({
    items: [],
    nextCursor: null,
  });
});
it("rejects malformed pagination before database access", async () => {
  const f = fixture();
  const encoded = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const cursor of [
    "",
    "%",
    "a".repeat(201),
    "broken",
    encoded({}),
    encoded([]),
    encoded([1, id]),
    encoded(["2026-01-01T00:00:00.000000Z", 1]),
    encoded(["bad", id]),
    encoded(["2026-01-01T00:00:00.000000Z", "bad"]),
    encoded(["2026-02-30T00:00:00.000000Z", id]),
    encoded(["2026-99-01T00:00:00.000000Z", id]),
  ])
    expect(await f.store.history("token", cursor)).toBeNull();
  expect(f.connect).not.toHaveBeenCalled();
});
it.each([
  "BEGIN",
  "SELECT id,expires_at",
  "SELECT id FROM workspaces",
  "SELECT cv.id",
  "INSERT INTO private_practice_exchanges",
  "AS valid",
  "COMMIT",
])(
  "returns generic uncertainty without retry after %s fails",
  async (failAt) => {
    const f = fixture({ failAt });
    await expect(operations.append(f.store)).rejects.toThrow(
      /^Practice session unavailable$/,
    );
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(undefined);
  },
);
it("discards a connection after failed rollback and sanitizes connect failures", async () => {
  const f = fixture({ failAt: "COMMIT", rollbackFails: true });
  await expect(operations.withdraw(f.store)).rejects.toThrow(
    /^Practice session unavailable$/,
  );
  expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  const connecting = fixture();
  connecting.connect.mockRejectedValueOnce(Error("private connection string"));
  await expect(operations.history(connecting.store)).rejects.toThrow(
    /^Practice session unavailable$/,
  );
  expect(connecting.release).not.toHaveBeenCalled();
});
