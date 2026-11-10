import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import {
  adminTermsSection,
  coachingTermsStore,
  memberTermsSection,
  type CoachingTerms,
} from "../../src/coaching-terms.ts";
import { coachingAllowanceLedgerOnConnection } from "../../src/ledger.ts";
import {
  practiceTransaction,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";

// #27 ALLOW27-01..07 without a database; PostgreSQL behaviour is in
// tests/integration/coaching-allowances.test.ts.
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
vi.mock("../../src/ledger.ts", async () => ({
  ...(await vi.importActual<typeof import("../../src/ledger.ts")>(
    "../../src/ledger.ts",
  )),
  coachingAllowanceLedgerOnConnection: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  token = "a".repeat(64);
const values = {
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
};
const saved: CoachingTerms = {
  ...values,
  version: 1,
  savedAt: new Date("2026-11-09T12:00:00Z"),
};
interface Row {
  id: string;
  same: boolean;
  available: number;
  reserved: number;
  consumed: number;
  live: boolean;
}
const row = (o: Partial<Row>): Row => ({
  id: "g",
  same: true,
  available: 0,
  reserved: 0,
  consumed: 0,
  live: true,
  ...o,
});
const starts = new Date("2026-12-01T05:00:00.000Z"),
  expires = new Date("2027-06-01T04:00:00.000Z");
const ledger = { grant: vi.fn(), adjust: vi.fn() };
function fixture(o: {
  open?: boolean;
  member?: boolean;
  review?: Row[];
  ai?: Row[];
  current?: CoachingTerms | null;
}) {
  let granted = 0;
  ledger.grant.mockImplementation(async () => `grant-${++granted}`);
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    let rows: unknown[] = [];
    if (sql.includes("FROM principals WHERE token_hash"))
      rows = [
        {
          id: key,
          kind: o.member ? "member" : "staff",
          expires: new Date("2099-01-01"),
        },
      ];
    else if (sql.includes("FROM authorized_staff_profiles"))
      rows = [{ role: "platform_admin" }];
    else if (sql.includes("FROM principals p JOIN learners")) rows = [{}];
    else if (sql.includes("FROM coaching_terms WHERE owner_id"))
      rows = o.current ? [o.current] : [];
    else if (sql.includes("AT TIME ZONE 'America/Toronto'"))
      rows = [{ starts, expires, open: o.open ?? true }];
    else if (sql.includes("FROM coaching_allowance_grants"))
      rows = (args[1] === "review_minutes" ? o.review : o.ai) ?? [];
    return { rows, rowCount: rows.length };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe: async () => {} } as unknown as PracticeTransaction),
  );
  vi.mocked(coachingAllowanceLedgerOnConnection).mockReturnValue(
    ledger as never,
  );
  return { terms: coachingTermsStore({} as Pool), query };
}
const save = (f: ReturnType<typeof fixture>, over = {}) =>
  f.terms.save(token, {
    ...values,
    ...over,
    ownerId: id,
    expectedVersion: 0,
    operationId: key,
  });
const links = (f: ReturnType<typeof fixture>) =>
  f.query.mock.calls
    .filter(([sql]) => sql.startsWith("INSERT INTO coaching_allowance_grants"))
    .map(([, args]) => (args as unknown[])[3]);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
beforeEach(() => vi.clearAllMocks());

it("ALLOW27-01 grants both allowances for the period in Toronto days, and nothing for a closed period", async () => {
  const f = fixture({});
  expect(await save(f)).toEqual({ kind: "ready", value: { version: 1 } });
  const window = {
    startsAt: starts.toISOString(),
    expiresAt: expires.toISOString(),
  };
  expect(ledger.grant.mock.calls).toEqual([
    [
      id,
      "review_minutes",
      120,
      expect.stringMatching(/^coaching-allowance:.+:review_minutes:0$/),
      window,
    ],
    [
      id,
      "study_requests",
      200,
      expect.stringMatching(/^coaching-allowance:.+:study_requests:0$/),
      window,
    ],
  ]);
  expect(links(f)).toEqual(["review_minutes", "study_requests"]);
  expect(ledger.adjust).not.toHaveBeenCalled();
  const closed = fixture({ open: false });
  expect(await save(closed)).toEqual({ kind: "ready", value: { version: 1 } });
  expect(ledger.grant).toHaveBeenCalledTimes(2);
  expect(
    closed.query.mock.calls.some(([sql]) =>
      sql.includes("FROM coaching_allowance_grants"),
    ),
  ).toBe(false);
});

it("ALLOW27-03/05 writes off unused units of other overlapping periods first, then of this period, never used ones", async () => {
  const f = fixture({
    review: [
      row({ id: "other", same: false, available: 30, reserved: 10 }),
      row({ id: "ended", same: false, available: 5, consumed: 7, live: false }),
      row({ id: "spent", same: true, available: 0, consumed: 20 }),
      row({ id: "old", same: true, available: 50, live: false }),
      row({ id: "this", same: true, available: 100 }),
      row({ id: "spare", same: true, available: 40 }),
    ],
    ai: [row({ id: "ai", available: 200 })],
  });
  await save(f, { reviewMinutes: 60, aiRequests: 200 });
  // In use: 10 held + 7 used (ended) + 20 used + 100 + 40 unused = 177; 60 wanted.
  expect(
    ledger.adjust.mock.calls.map(([, grant, quantity]) => [grant, quantity]),
  ).toEqual([
    ["other", 30],
    ["this", 100],
    ["spare", 17],
  ]);
  expect(ledger.adjust.mock.calls[0]![3]).toMatch(
    /^coaching-allowance-writeoff:.+:other$/,
  );
  expect(ledger.grant).not.toHaveBeenCalled();
});

it("ALLOW27-03/08 tops up only the remainder, in grants of at most 100,000", async () => {
  const f = fixture({
    review: [row({ available: 20, consumed: 100 })],
    ai: [row({ id: "ai", available: 1000 })],
  });
  await save(f, { aiRequests: 251000 });
  expect(
    ledger.grant.mock.calls.map(([, category, quantity, k]) => [
      category,
      quantity,
      String(k).split(":").pop(),
    ]),
  ).toEqual([
    ["study_requests", 100000, "0"],
    ["study_requests", 100000, "1"],
    ["study_requests", 50000, "2"],
  ]);
  expect(ledger.adjust).not.toHaveBeenCalled();
});

it("ALLOW27-07 balances sum this period's units, counting only live unused ones as left", async () => {
  const f = fixture({
    member: true,
    current: saved,
    review: [
      row({ available: 80, reserved: 10, consumed: 30 }),
      row({ available: 9, live: false, consumed: 1 }),
    ],
  });
  expect(await f.terms.own(token)).toEqual({
    kind: "ready",
    value: {
      ...saved,
      balances: {
        reviewMinutes: { left: 80, held: 10, used: 31 },
        aiRequests: { left: 0, held: 0, used: 0 },
      },
    },
  });
  expect(
    await fixture({ member: true, current: saved }).terms.own(token),
  ).toEqual({
    kind: "ready",
    value: { ...saved, balances: null },
  });
  expect(
    await fixture({ member: true, current: null }).terms.own(token),
  ).toEqual({
    kind: "ready",
    value: null,
  });
});

it("ALLOW27-07 shows what's left to the student and the administrator, and nothing without units", () => {
  const t = {
    ...saved,
    balances: {
      reviewMinutes: { left: 90, held: 10, used: 20 },
      aiRequests: { left: 193, held: 2, used: 5 },
    },
  };
  const member = text(memberTermsSection(t));
  expect(member).toContain("Allowances left this period");
  expect(member).toContain(
    "Expert review time 90 of 120 minutes left, 10 held, 20 used",
  );
  expect(member).toContain("AI requests 193 of 200 left, 2 held, 5 used");
  expect(member).toContain(
    "Coaching sessions are arranged with your coach and aren't counted here.",
  );
  const admin = text(adminTermsSection(t, "/a", ""));
  expect(admin).toContain("AI requests 193 of 200 left, 2 held, 5 used");
  expect(admin).toContain(
    "Coaching sessions aren't counted as units; the student arranges them with their coach.",
  );
  for (const none of [saved, { ...saved, balances: null }])
    expect(memberTermsSection(none)).not.toContain("Allowances left");
});
