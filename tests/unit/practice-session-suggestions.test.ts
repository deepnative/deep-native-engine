import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  deterministicPracticeSuggestionProvider,
  type PracticeSuggestionProvider,
} from "../../src/practice-ai-suggestions.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";

// #200 PRACTICE-AI store behaviour against a scripted connection. The real
// PostgreSQL behaviour is in tests/integration/practice-ai-suggestions.test.ts.
const id = "00000000-0000-4000-8000-000000000001";
const RESPONSE = "Invented response long enough to quote back.";
interface Options {
  principal?: boolean;
  sessionRow?: Record<string, unknown> | null;
  source?: boolean;
  sourceGoal?: string;
  pair?: boolean;
  existing?: boolean;
  paused?: boolean | null;
  open?: number;
  job?: { status: string; attempt_token: string | null } | "match" | null;
  kept?: boolean;
  principalAfter?: boolean;
  failAt?: string;
  suggestionState?: "requested" | "ready" | "rejected" | null;
}
function fixture(
  options: Options = {},
  provider?: PracticeSuggestionProvider,
  extra: { providerLimitMs?: number; noSuggestions?: boolean } = {},
) {
  let principalCalls = 0;
  let token: string | null = null;
  const statements: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (options.failAt && sql.includes(options.failAt))
      throw Error("Sensitive database diagnostic");
    if (sql.startsWith("SELECT id,expires_at")) {
      principalCalls++;
      const allowed =
        principalCalls === 1
          ? options.principal !== false
          : options.principalAfter !== false;
      return {
        rows: allowed
          ? [{ id: "member-id", expires_at: new Date("2100-01-01") }]
          : [],
      };
    }
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: [{ id: "member-id" }] };
    if (sql.startsWith("SELECT cv.id AS"))
      return {
        rows:
          options.source === false
            ? []
            : [
                {
                  contentId: "SYN-130",
                  contentVersion: 2,
                  title: "Invented lesson",
                  body: "Exact invented source",
                  goal: options.sourceGoal ?? "everyday",
                },
              ],
      };
    if (sql.includes("FROM private_practice_sessions s"))
      return {
        rows:
          options.sessionRow === null
            ? []
            : [
                {
                  id,
                  contentId: "SYN-130",
                  contentVersion: 2,
                  goal: "everyday",
                  promptVersion: "practice-v1",
                  createdAt: new Date("2026-01-01"),
                  withdrawnAt: null,
                  title: "Invented lesson",
                  ...options.sessionRow,
                },
              ],
      };
    if (sql.startsWith("SELECT response,source_excerpt"))
      return {
        rows:
          options.pair === false
            ? []
            : [{ response: RESPONSE, sourceExcerpt: "Exact invented source" }],
      };
    if (sql.startsWith("SELECT 1 FROM practice_ai_suggestions"))
      return { rows: options.existing ? [{ "?column?": 1 }] : [] };
    if (sql.startsWith("SELECT paused FROM local_ai_control"))
      return {
        rows:
          options.paused === null ? [] : [{ paused: options.paused ?? false }],
      };
    if (sql.includes("AS open")) return { rows: [{ open: options.open ?? 0 }] };
    if (sql.startsWith("INSERT INTO adapter_jobs"))
      token = params![5] as string;
    if (sql.startsWith("SELECT status,attempt_token"))
      return {
        rows:
          options.job === null
            ? []
            : [
                options.job === undefined || options.job === "match"
                  ? { status: "running", attempt_token: token }
                  : options.job,
              ],
      };
    if (sql.includes("RETURNING 1"))
      return { rows: options.kept === false ? [] : [{ "?column?": 1 }] };
    if (sql.includes("FROM private_practice_exchanges e"))
      return {
        rows: [
          {
            sequence: 1,
            response: RESPONSE,
            comparison: "Stored comparison",
            sourceExcerpt: "Exact invented source",
            acceptedAt: new Date("2026-01-01"),
            suggestionState: options.suggestionState ?? null,
            suggestionText:
              options.suggestionState === "ready" ? "Stored suggestion" : null,
            suggestionRequestedAt: options.suggestionState
              ? new Date("2026-01-02")
              : null,
          },
        ],
      };
    if (sql.includes("AS valid"))
      return {
        rows: [{ valid: true, remaining: "60000", observed: new Date() }],
      };
    return { rows: [], rowCount: 1 };
  });
  const connect = vi
    .fn()
    .mockImplementation(async () => ({ query, release: vi.fn() }));
  const store = practiceSessionStore(
    { connect } as unknown as Pool,
    extra.noSuggestions
      ? {}
      : {
          suggestions: {
            mode: "test",
            ...(provider ? { provider } : {}),
            ...(extra.providerLimitMs
              ? { providerLimitMs: extra.providerLimitMs }
              : {}),
          },
        },
  );
  const ran = (pattern: string) =>
    statements.filter(({ sql }) => sql.includes(pattern));
  return { store, connect, statements, ran };
}

it("PRACTICE-AI-07 refuses malformed requests, or a store without suggestions, before any connection", async () => {
  const off = fixture({}, undefined, { noSuggestions: true });
  expect(await off.store.suggest!("token", id, 1)).toBe("unavailable");
  const f = fixture();
  for (const [session, sequence] of [
    ["not-a-uuid", 1],
    [id, 0],
    [id, 16],
    [id, 1.5],
  ] as const)
    expect(await f.store.suggest!("token", session, sequence)).toBe(
      "unavailable",
    );
  expect(await f.store.suggest!("", id, 1)).toBe("unavailable");
  expect(off.connect).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

it("PRACTICE-AI-01 records a grounded suggestion once and finishes its single-attempt job", async () => {
  const f = fixture();
  expect(await f.store.suggest!("token", id, 1)).toBe("ready");
  const [job] = f.ran("INSERT INTO adapter_jobs");
  expect(job!.sql).toContain("'running',1,1");
  expect(job!.params).toEqual([
    expect.any(String),
    "test",
    "practice-suggestion-local-v1",
    `practice-suggestion:${id}:1`,
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.any(String),
    "practice-suggestion-v1",
    "deterministic-local-v1",
    "member-id",
  ]);
  expect(f.ran("pg_advisory_xact_lock")[0]!.params).toEqual(["member-id"]);
  const [done] = f.ran("SET status='succeeded'");
  expect(done!.params![1]).toMatch(/^test_[a-f0-9]{24}$/);
  const [kept] = f.ran("SET state='ready'");
  expect(kept!.params![1]).toContain(`“${RESPONSE}”`);
  expect(kept!.params![1]).toContain("SYN-130 v2");
  expect(kept!.params![1]).not.toContain("interview");
});

it("PRACTICE-AI-01 interview sessions ask the provider for the no-prediction notice", async () => {
  const suggest = vi.fn(
    deterministicPracticeSuggestionProvider("test").suggest,
  );
  const f = fixture(
    { sessionRow: { promptVersion: "interview-practice-v1" } },
    { suggest },
  );
  expect(await f.store.suggest!("token", id, 1)).toBe("ready");
  expect(suggest.mock.calls[0]![0]).toMatchObject({ interview: true });
});

it("PRACTICE-AI-05/06 refuses unowned, withdrawn, missing, ineligible, paused and limited requests without a job", async () => {
  for (const [options, outcome] of [
    [{ principal: false }, "unavailable"],
    [{ sessionRow: null }, "unavailable"],
    [{ sessionRow: { withdrawnAt: new Date() } }, "withdrawn"],
    [{ pair: false }, "unavailable"],
    [{ existing: true }, "replayed"],
    [{ source: false }, "unavailable"],
    [{ sourceGoal: "work" }, "unavailable"],
    [{ sessionRow: { promptVersion: "retired-v0" } }, "unavailable"],
    [{ paused: true }, "paused"],
    [{ paused: null }, "paused"],
    [{ open: 3 }, "limit"],
  ] as [Options, string][]) {
    const suggest = vi.fn();
    const f = fixture(options, { suggest });
    expect(await f.store.suggest!("token", id, 1)).toBe(outcome);
    expect(f.ran("INSERT INTO adapter_jobs")).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  }
});

it("PRACTICE-AI-02/03 holds an error or a timeout as unknown and rejects invalid output", async () => {
  const thrown = fixture(
    {},
    {
      suggest: async () => {
        throw Error("invented fault");
      },
    },
  );
  expect(await thrown.store.suggest!("token", id, 1)).toBe("unknown");
  expect(thrown.ran("SET status='needs_reconciliation'")).toHaveLength(1);
  expect(thrown.ran("SET state=")).toEqual([]);

  const slow = fixture(
    {},
    { suggest: () => new Promise(() => undefined) },
    { providerLimitMs: 5 },
  );
  expect(await slow.store.suggest!("token", id, 1)).toBe("unknown");
  expect(slow.ran("SET status='needs_reconciliation'")).toHaveLength(1);

  const invalid = fixture({}, { suggest: async () => ({ text: "Score 10" }) });
  expect(await invalid.store.suggest!("token", id, 1)).toBe("rejected");
  expect(invalid.ran("'invalid_provider_response'")).toHaveLength(1);
  expect(invalid.ran("SET state='rejected'")).toHaveLength(1);
});

it("PRACTICE-AI-03/06 keeps nothing when the job changed, the pair went, authority ended or the write failed", async () => {
  for (const [options, outcome] of [
    [{ job: null }, "unknown"],
    [{ job: { status: "succeeded", attempt_token: null } }, "unknown"],
    [{ job: { status: "running", attempt_token: "another" } }, "unknown"],
    [{ kept: false }, "withdrawn"],
    [{ principalAfter: false }, "unknown"],
    [{ failAt: "SET status='succeeded'" }, "unknown"],
  ] as [Options, string][]) {
    const f = fixture(options);
    expect(await f.store.suggest!("token", id, 1)).toBe(outcome);
  }
});

it("PRACTICE-AI-01/05 detail reports whether suggestions can be asked for and each pair's state", async () => {
  const available = fixture({ suggestionState: "ready" });
  const detail = (await available.store.detail("token", id))!;
  expect(detail.suggestions).toBe("available");
  expect(detail.exchanges[0]!.suggestion).toEqual({
    state: "ready",
    text: "Stored suggestion",
    requestedAt: new Date("2026-01-02"),
  });
  const held = fixture({ suggestionState: "requested", paused: true });
  const heldDetail = (await held.store.detail("token", id))!;
  expect(heldDetail.suggestions).toBe("paused");
  expect(heldDetail.exchanges[0]!.suggestion!.state).toBe("unknown");
  expect(
    (await fixture({ paused: null }).store.detail("token", id))!.suggestions,
  ).toBe("paused");
  const none = (await fixture().store.detail("token", id))!;
  expect(none.exchanges[0]!.suggestion).toBeNull();
  const withdrawn = fixture({ sessionRow: { withdrawnAt: new Date() } });
  expect(
    (await withdrawn.store.detail("token", id))!.suggestions,
  ).toBeUndefined();
  expect(withdrawn.ran("FROM local_ai_control")).toEqual([]);
  const off = fixture({}, undefined, { noSuggestions: true });
  expect((await off.store.detail("token", id))!.suggestions).toBeUndefined();
});
