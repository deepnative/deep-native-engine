import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { practiceSessionStore } from "../../src/practice-sessions.ts";

const grantId = "00000000-0000-4000-8000-0000000000aa",
  claimId = "00000000-0000-4000-8000-0000000000bb",
  memberId = "00000000-0000-4000-8000-0000000000cc",
  sessionId = "00000000-0000-4000-8000-000000000001";
const start = {
  contentId: "SYN-130",
  contentVersion: 1,
  goal: "everyday" as const,
  promptVersion: "practice-v1",
};
function fixture(
  allowance: boolean | undefined,
  options: {
    available?: number | null;
    existing?: { id: string; withdrawnAt: Date | null };
    source?: boolean;
    failAt?: string;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (options.failAt && sql.includes(options.failAt))
      throw Error("Sensitive database diagnostic");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows: [{ id: memberId, expires_at: new Date("2100-01-01") }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: [{ id: memberId }] };
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
                  body: "Exact invented source",
                  goal: "everyday",
                },
              ],
      };
    if (sql.startsWith("SELECT id,withdrawn_at"))
      return { rows: options.existing ? [options.existing] : [] };
    if (sql.includes("FROM study_allowance_claims"))
      return {
        // The query itself only returns a claim with a unit left.
        rows: options.available ? [{ claimId, grantId }] : [],
      };
    if (sql.startsWith("SELECT g.available,g.starts_at"))
      return {
        rows: [
          {
            available: options.available,
            starts_at: new Date("2000-01-01"),
            expires_at: new Date("2100-01-01"),
            expired_at: null,
          },
        ],
      };
    if (sql.startsWith("SELECT r.grant_id,r.quantity,r.state"))
      return {
        rows: [
          {
            grant_id: grantId,
            quantity: 1,
            state: "reserved",
            expires_at: new Date("2100-01-01"),
            expired_at: null,
          },
        ],
      };
    if (sql.includes('clock_timestamp() AS "instant"'))
      return { rows: [{ instant: new Date("2030-01-15") }] };
    if (sql.includes("AS valid"))
      return {
        rows: [{ valid: true, remaining: "60000", observed: new Date() }],
      };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const sql = () => query.mock.calls.map(([text]) => text);
  return {
    store: practiceSessionStore(
      pool as unknown as Pool,
      allowance === undefined ? undefined : { allowance },
    ),
    query,
    sql,
    wrote: (text: string) => sql().some((value) => value.includes(text)),
  };
}
const SESSION = "INSERT INTO private_practice_sessions",
  USE = "INSERT INTO practice_session_allowance_uses",
  LOOKUP = "FROM study_allowance_claims",
  RESERVE = "INSERT INTO synthetic_entitlement_reservations";

it.each([[undefined], [false]])(
  "MOCK-07 starts stay free and untouched when the setting is %s",
  async (allowance) => {
    const f = fixture(allowance);
    expect((await f.store.start("token", start)).kind).toBe("started");
    expect(f.wrote(SESSION)).toBe(true);
    expect(f.wrote(LOOKUP)).toBe(false);
    expect(f.wrote(RESERVE)).toBe(false);
    expect(f.wrote(USE)).toBe(false);
  },
);
it.each([
  ["no claim", null],
  ["no units left", 0],
])("MOCK-05 %s refuses a new session and creates nothing", async (_n, left) => {
  const f = fixture(true, { available: left });
  await expect(f.store.start("token", start)).resolves.toEqual({
    kind: "allowance-needed",
  });
  expect(f.wrote(SESSION)).toBe(false);
  expect(f.wrote(RESERVE)).toBe(false);
  expect(f.sql()).toContain("COMMIT");
});
it("MOCK-02 a new session and one consumed unit are written in one transaction", async () => {
  const f = fixture(true, { available: 2 });
  const result = await f.store.start("token", start);
  expect(result.kind).toBe("started");
  const order = [
    LOOKUP,
    SESSION,
    RESERVE,
    "UPDATE synthetic_entitlement_reservations SET state",
    USE,
  ].map((text) => f.sql().findIndex((value) => value.includes(text)));
  expect(order.every((value) => value > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(f.sql().filter((value) => value === "COMMIT")).toHaveLength(1);
  const useCall = f.query.mock.calls.find(([text]) => text.includes(USE)) as
    unknown[] | undefined;
  expect(useCall?.[1]).toEqual([
    (result as { sessionId: string }).sessionId,
    memberId,
    claimId,
    expect.any(String),
  ]);
});
it("MOCK-03 returning to a started session uses no unit", async () => {
  const f = fixture(true, {
    available: 2,
    existing: { id: sessionId, withdrawnAt: null },
  });
  await expect(f.store.start("token", start)).resolves.toEqual({
    kind: "replayed",
    sessionId,
  });
  expect(f.wrote(LOOKUP)).toBe(false);
  expect(f.wrote(RESERVE)).toBe(false);
});
it("MOCK-06 ineligible sources and withdrawn sessions use no unit", async () => {
  const gone = fixture(true, { available: 2, source: false });
  expect((await gone.store.start("token", start)).kind).toBe("unavailable");
  expect(gone.wrote(LOOKUP)).toBe(false);
  const withdrawn = fixture(true, {
    available: 2,
    existing: { id: sessionId, withdrawnAt: new Date("2030-01-01") },
  });
  expect((await withdrawn.store.start("token", start)).kind).toBe("withdrawn");
  expect(withdrawn.wrote(LOOKUP)).toBe(false);
});
it("MOCK-02 a failed unit write rolls the whole start back without a diagnostic", async () => {
  const f = fixture(true, { available: 2, failAt: USE });
  await expect(f.store.start("token", start)).rejects.toThrow(
    "Practice session unavailable",
  );
  expect(f.sql()).not.toContain("COMMIT");
});
