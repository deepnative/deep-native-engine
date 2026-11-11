import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  capacityGroup,
  decodeAiUsage,
  decodeReviewTime,
  decodeRosterFact,
  decodeSupportTime,
  disabledStaffCapacityStore,
  readStaffCapacity,
  recordRoom,
  rosterStanding,
  staffCapacityStore,
  type RosterFact,
} from "../../src/staff-capacity.ts";
import {
  deliveryCostPage,
  staffCapacityPage,
  staffCapacityUnavailablePage,
} from "../../src/staff-capacity-views.ts";

// #123 CAP-01..10 with invented roster records only.
const record = (over: Partial<RosterFact> = {}): RosterFact => ({
  service: "formal-review",
  current: true,
  verified: true,
  staffActive: true,
  backupVerified: true,
  capacityMinutes: 300,
  committedMinutes: 60,
  slotMinutes: 120,
  heldSlots: 1,
  ...over,
});
const reviewRow = {
  open: 0,
  openMinutes: "0",
  granted: 0,
  grantedMinutes: "0",
  reviewers: 0,
  unrostered: 0,
  unrosteredMinutes: "0",
  unrosteredReviewers: 0,
  waiting: 0,
  waitingMinutes: "0",
  completed: 0,
  reviewMinutes: "0",
  preparationMinutes: "0",
};
const supportRow = {
  open: 0,
  openMinutes: "0",
  granted: 0,
  grantedMinutes: "0",
  operators: 0,
  waiting: 0,
  waitingMinutes: "0",
  completed: 0,
  supportMinutes: "0",
  preparationMinutes: "0",
};
const aiRow = {
  estimated: 0,
  estimatedPoints: "0",
  settled: 0,
  settledPoints: "0",
  settledEstimatePoints: "0",
};
const rosterRow = {
  service: "coaching",
  current: true,
  verified: true,
  staffActive: true,
  backupVerified: true,
  capacityMinutes: 120,
  committedMinutes: 0,
  slotMinutes: "60",
  heldSlots: 0,
};

it("CAP-01 an empty roster reads not recorded, not zero available", () => {
  const group = capacityGroup("coaching", []);
  expect(group).toMatchObject({
    status: "empty",
    records: 0,
    covered: 0,
    availableMinutes: null,
    capacityMinutes: 0,
  });
  expect(decodeReviewTime(reviewRow).status).toBe("empty");
});

it("CAP-02 unverified records keep their declared minutes apart and add nothing to available", () => {
  const group = capacityGroup("formal-review", [
    record({ verified: false, capacityMinutes: 500, committedMinutes: 30 }),
  ]);
  expect(group).toMatchObject({
    status: "consistent",
    records: 1,
    covered: 0,
    unverified: 1,
    unverifiedCapacityMinutes: 500,
    unverifiedCommittedMinutes: 30,
    capacityMinutes: 0,
    availableMinutes: null,
  });
  expect(rosterStanding(record({ verified: false, current: false }))).toBe(
    "not_current",
  );
});

it("CAP-03 available is capacity minus committed minus open slots, per verified record", () => {
  const group = capacityGroup("formal-review", [
    record(),
    record({
      capacityMinutes: 100,
      committedMinutes: 40,
      slotMinutes: 0,
      heldSlots: 0,
    }),
  ]);
  expect(recordRoom(record())).toBe(120);
  expect(group).toMatchObject({
    status: "consistent",
    covered: 2,
    capacityMinutes: 400,
    committedMinutes: 100,
    slotMinutes: 120,
    heldSlots: 1,
    availableMinutes: 180,
  });
});

it("CAP-04 an overrun is flagged with its size and never cancels another record's room", () => {
  const group = capacityGroup("formal-review", [
    record({ capacityMinutes: 60, committedMinutes: 60, slotMinutes: 60 }),
    record({ capacityMinutes: 120, committedMinutes: 0, slotMinutes: 60 }),
  ]);
  expect(group).toMatchObject({
    status: "discrepancies",
    overcommitted: 1,
    overcommitMinutes: 60,
    availableMinutes: 60,
  });
});

it("CAP-05 no verified backup and ended staff access are counted apart", () => {
  const group = capacityGroup("coaching", [
    record({ service: "coaching", backupVerified: false }),
    record({ service: "coaching", staffActive: false, capacityMinutes: 90 }),
  ]);
  expect(group).toMatchObject({
    covered: 0,
    noBackup: 1,
    noBackupCapacityMinutes: 300,
    inactive: 1,
    inactiveCapacityMinutes: 90,
    availableMinutes: null,
  });
});

it("CAP-06 records that aren't current are counted and left out of every current figure", () => {
  const group = capacityGroup("formal-review", [
    record({ current: false }),
    record({ service: "coaching" }),
  ]);
  expect(group).toMatchObject({
    status: "empty",
    records: 0,
    notCurrent: 1,
    capacityMinutes: 0,
  });
});

it("CAP-07 review time granted to an unrostered reviewer is a mismatch; waiting is not", () => {
  expect(
    decodeReviewTime({
      ...reviewRow,
      open: 2,
      openMinutes: "50",
      waiting: 2,
      waitingMinutes: "50",
    }).status,
  ).toBe("consistent");
  expect(decodeReviewTime({ ...reviewRow, completed: 1 }).status).toBe(
    "consistent",
  );
  expect(
    decodeReviewTime({
      ...reviewRow,
      open: 1,
      granted: 1,
      unrostered: 1,
      unrosteredMinutes: "20",
    }),
  ).toMatchObject({ status: "discrepancies", unrosteredMinutes: 20 });
});

it("CAP-10 a missing row or a value that isn't a whole number is refused", () => {
  expect(() => decodeReviewTime(undefined)).toThrow("row missing");
  expect(() => decodeReviewTime({ ...reviewRow, open: "1.5" })).toThrow(
    "whole number",
  );
  expect(() => decodeReviewTime({ ...reviewRow, open: -1 })).toThrow(
    "whole number",
  );
  expect(() => decodeReviewTime({ ...reviewRow, open: null })).toThrow(
    "whole number",
  );
  expect(() => decodeRosterFact({ ...rosterRow, service: "other" })).toThrow(
    "unknown",
  );
  expect(() => decodeRosterFact({ ...rosterRow, verified: "t" })).toThrow(
    "yes or no",
  );
  expect(decodeRosterFact(rosterRow)).toMatchObject({ slotMinutes: 60 });
});

const asOf = new Date("2026-11-08T12:00:00Z");
function respond(rows: {
  roster?: unknown[];
  review?: unknown[];
  support?: unknown[];
  ai?: unknown[];
  asOf?: unknown[];
  allowed?: unknown[];
}) {
  return (sql: string) => {
    if (sql.includes("authorized_staff_profiles"))
      return { rows: rows.allowed ?? [{}] };
    if (sql.includes("WITH grants"))
      return { rows: rows.review ?? [reviewRow] };
    if (sql.includes("FROM ai_usage_estimates"))
      return { rows: rows.ai ?? [aiRow] };
    if (sql.includes("FROM support_time_allocations"))
      return { rows: rows.support ?? [supportRow] };
    if (sql.includes("FROM expert_registry e"))
      return { rows: rows.roster ?? [] };
    if (sql.includes('now() AS "asOf"'))
      return { rows: rows.asOf ?? [{ asOf }] };
    return { rows: [] };
  };
}
function pool(
  answer: (sql: string) => unknown,
  release = vi.fn(),
): { fake: Pool; queries: string[]; release: typeof release } {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    return answer(sql);
  });
  return {
    fake: { connect: async () => ({ query, release }) } as unknown as Pool,
    queries,
    release,
  };
}

it("CAP-01/09 reads one snapshot, rolls back and releases cleanly", async () => {
  const f = pool(respond({ roster: [rosterRow] }));
  const result = await staffCapacityStore(f.fake).snapshot("a".repeat(64));
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      asOf,
      groups: [
        { service: "coaching", covered: 1, availableMinutes: 60 },
        { service: "formal-review", status: "empty" },
      ],
      reviewTime: { status: "empty" },
      supportTime: { status: "empty", open: 0 },
    },
  });
  expect(f.queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(f.queries.at(-1)).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("CAP-08 a malformed token is refused before connecting; other staff are denied", async () => {
  const connect = vi.fn();
  expect(
    await staffCapacityStore({ connect } as unknown as Pool).snapshot("nope"),
  ).toEqual({ kind: "denied" });
  expect(connect).not.toHaveBeenCalled();
  const f = pool(respond({ allowed: [] }));
  expect(await staffCapacityStore(f.fake).snapshot("b".repeat(64))).toEqual({
    kind: "denied",
  });
  expect(f.queries.some((sql) => sql.includes("expert_registry"))).toBe(false);
  expect(f.queries.at(-1)).toBe("ROLLBACK");
});

it("CAP-10 a failed connection, read or rollback shows no figures", async () => {
  expect(
    await staffCapacityStore({
      connect: async () => {
        throw new Error("down");
      },
    } as unknown as Pool).snapshot("c".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  const missing = pool(respond({ asOf: [] }));
  expect(
    await staffCapacityStore(missing.fake).snapshot("c".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  const release = vi.fn();
  const f = pool((sql) => {
    if (sql === "ROLLBACK") return Promise.reject(new Error("gone"));
    return respond({})(sql);
  }, release);
  expect(await staffCapacityStore(f.fake).snapshot("d".repeat(64))).toEqual({
    kind: "unavailable",
  });
  expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(await disabledStaffCapacityStore().snapshot("e".repeat(64))).toEqual({
    kind: "unavailable",
  });
});

it("CAP-02/09 the page labels unverified minutes and names no one", async () => {
  const value = await readStaffCapacity({
    query: (async (sql: string) =>
      respond({
        roster: [
          rosterRow,
          { ...rosterRow, verified: false, capacityMinutes: 480 },
          {
            ...rosterRow,
            service: "formal-review",
            capacityMinutes: 60,
            committedMinutes: 60,
          },
        ],
        review: [
          {
            ...reviewRow,
            open: 1,
            openMinutes: "20",
            granted: 1,
            grantedMinutes: "20",
            reviewers: 1,
            unrostered: 1,
            unrosteredMinutes: "20",
            unrosteredReviewers: 1,
          },
        ],
      })(sql)) as never,
  });
  const html = staffCapacityPage(value);
  expect(html).toContain("Staff capacity");
  expect(html).toMatch(/data-field="coaching.available">60 min/);
  expect(html).toMatch(
    /Unverified records, not qualified coverage \(1\)<\/dt><dd data-field="coaching.unverified">480 min declared/,
  );
  expect(html).toMatch(/data-field="formal-review.overcommitted">60 min/);
  expect(html).toMatch(/data-field="review.unrostered">20 min/);
  expect(html).toContain('data-capacity-status="discrepancies"');
  const empty = staffCapacityPage({
    asOf,
    groups: [capacityGroup("coaching", []), capacityGroup("formal-review", [])],
    reviewTime: decodeReviewTime(reviewRow),
    supportTime: decodeSupportTime(supportRow),
    aiUsage: decodeAiUsage(aiRow),
  });
  expect(empty).toMatch(/data-field="coaching.available">Not recorded/);
  expect(empty).toContain("No review time to compare.");
  expect(empty).toContain("No support time to show.");
  for (const kind of ["denied", "unavailable", "live", "query"] as const)
    expect(staffCapacityUnavailablePage(kind)).not.toMatch(/\d+ min/);
});

// #94 SUPCAP-01..03: support time members allocated, beside the roster.
it("SUPCAP-01/02 decodes support time as whole numbers and marks it empty or recorded", () => {
  expect(decodeSupportTime(supportRow)).toEqual({
    status: "empty",
    open: 0,
    openMinutes: 0,
    granted: 0,
    grantedMinutes: 0,
    operators: 0,
    waiting: 0,
    waitingMinutes: 0,
    completed: 0,
    supportMinutes: 0,
    preparationMinutes: 0,
  });
  expect(
    decodeSupportTime({ ...supportRow, open: 2, openMinutes: "40" }),
  ).toMatchObject({ status: "recorded", open: 2, openMinutes: 40 });
  expect(
    decodeSupportTime({ ...supportRow, completed: 1, supportMinutes: "15" }),
  ).toMatchObject({ status: "recorded", supportMinutes: 15 });
  expect(() => decodeSupportTime(undefined)).toThrow("row missing");
  expect(() =>
    decodeSupportTime({ ...supportRow, openMinutes: "1.5" }),
  ).toThrow("whole number");
  expect(() => decodeSupportTime({ ...supportRow, operators: -1 })).toThrow(
    "whole number",
  );
});

it("SUPCAP-01/02 one statement reads open allocations once each, with current grants only, and completed entries", async () => {
  const statements: string[] = [];
  const value = await readStaffCapacity({
    query: (async (sql: string) => {
      statements.push(sql);
      return respond({
        support: [
          {
            ...supportRow,
            open: 2,
            openMinutes: "40",
            granted: 1,
            grantedMinutes: "20",
            operators: 1,
            waiting: 1,
            waitingMinutes: "20",
            completed: 1,
            supportMinutes: "15",
            preparationMinutes: "5",
          },
        ],
      })(sql);
    }) as never,
  });
  expect(value.supportTime).toEqual({
    status: "recorded",
    open: 2,
    openMinutes: 40,
    granted: 1,
    grantedMinutes: 20,
    operators: 1,
    waiting: 1,
    waitingMinutes: 20,
    completed: 1,
    supportMinutes: 15,
    preparationMinutes: 5,
  });
  const sql = statements.find((text) =>
    text.includes("FROM support_time_allocations"),
  )!;
  expect(sql).toContain(
    "a.state IN ('allocated','begun','needs_reconciliation')",
  );
  expect(sql).toContain(
    "g.revoked_at IS NULL AND g.starts_at<=now() AND g.expires_at>now()",
  );
  expect(sql).toContain("count(DISTINCT g.staff_id)");
  expect(sql).not.toMatch(/member_id|request_id|staff_role/);
});

it("SUPCAP-03 the page shows support time apart, says it has no roster and names no one", async () => {
  const value = await readStaffCapacity({
    query: (async (sql: string) =>
      respond({
        support: [
          {
            ...supportRow,
            open: 1,
            openMinutes: "20",
            waiting: 1,
            waitingMinutes: "20",
            completed: 2,
            supportMinutes: "30",
            preparationMinutes: "10",
          },
        ],
      })(sql)) as never,
  });
  const html = staffCapacityPage(value);
  expect(html).toContain("<h2>Support time · Test data</h2>");
  expect(html).toMatch(
    /Open support time \(1\)<\/dt><dd data-field="support.open">20 min/,
  );
  expect(html).toMatch(
    /Granted to an operator \(0\)<\/dt><dd data-field="support.granted">0 min/,
  );
  expect(html).toMatch(/data-field="support.operators">0</);
  expect(html).toMatch(
    /Waiting for an operator \(1\)<\/dt><dd data-field="support.waiting">20 min/,
  );
  expect(html).toMatch(/data-field="support.completed">2</);
  expect(html).toMatch(/data-field="support.used">30 min/);
  expect(html).toMatch(/data-field="support.preparation">10 min/);
  expect(html).toContain(
    "Open support time stays held from the member's support test minutes until an operator settles it or the member cancels.",
  );
  expect(html).toContain(
    "Support has no roster: nobody declares support capacity, so open support time is shown on its own and is compared with nothing.",
  );
  expect(html).toMatch(/data-support-time>.*data-capacity-status="recorded"/s);
});

// #94 COST-01..03 (F-ROADMAP-09-C): delivery cost from existing records only.
it("COST-01 decodes AI usage as whole numbers and refuses anything else", () => {
  expect(decodeAiUsage(aiRow)).toEqual({
    estimated: 0,
    estimatedPoints: 0,
    settled: 0,
    settledPoints: 0,
    settledEstimatePoints: 0,
  });
  expect(() => decodeAiUsage(undefined)).toThrow("row missing");
  expect(() => decodeAiUsage({ ...aiRow, settledPoints: "0.5" })).toThrow(
    "whole number",
  );
});

it("COST-01/02/03 the page counts preparation once, labels every AI figure as an estimate and shows no money", async () => {
  const statements: string[] = [];
  const value = await readStaffCapacity({
    query: (async (sql: string) => {
      statements.push(sql);
      return respond({
        review: [
          {
            ...reviewRow,
            completed: 2,
            reviewMinutes: "50",
            preparationMinutes: "10",
          },
        ],
        support: [
          {
            ...supportRow,
            open: 1,
            openMinutes: "20",
            completed: 1,
            supportMinutes: "10",
            preparationMinutes: "5",
          },
        ],
        ai: [
          {
            estimated: 3,
            estimatedPoints: "12",
            settled: 1,
            settledPoints: "1",
            settledEstimatePoints: "4",
          },
        ],
      })(sql);
    }) as never,
  });
  expect(value.aiUsage).toEqual({
    estimated: 3,
    estimatedPoints: 12,
    settled: 1,
    settledPoints: 1,
    settledEstimatePoints: 4,
  });
  const ai = statements.find((sql) => sql.includes("FROM ai_usage_estimates"))!;
  expect(ai).toContain("JOIN ai_usage_settlements s ON s.job_id=e.job_id");
  expect(ai).not.toMatch(/member_id|tokens/);
  const html = deliveryCostPage(value);
  expect(html).toContain("<h1>Delivery cost</h1>");
  expect(html).toMatch(/data-field="cost.reviews">2</);
  expect(html).toMatch(/data-field="cost.review">50 min/);
  expect(html).toMatch(
    /Review preparation minutes, counted once<\/dt><dd data-field="cost.reviewPreparation">10 min/,
  );
  expect(html).toMatch(/data-field="cost.supports">1</);
  expect(html).toMatch(/data-field="cost.support">10 min/);
  expect(html).toMatch(
    /Support preparation minutes, counted once<\/dt><dd data-field="cost.supportPreparation">5 min/,
  );
  // 50 + 10 + 10 + 5; the open 20-minute booking is not a cost yet.
  expect(html).toMatch(/data-field="cost.staffMinutes">75 min/);
  expect(html).toContain("ESTIMATE · SIMULATED · NO MONEY CHARGED.");
  expect(html).toMatch(/data-field="cost.aiRequests">3</);
  expect(html).toMatch(
    /data-field="cost.aiEstimated">12 simulated cost points · estimate/,
  );
  expect(html).toMatch(/data-field="cost.aiSettled">1</);
  expect(html).toMatch(
    /data-field="cost.aiSettledPoints">1 simulated cost point · estimate/,
  );
  expect(html).toMatch(
    /data-field="cost.aiSettledEstimate">4 simulated cost points · estimate/,
  );
  expect(html).toContain("No cost in money.");
  expect(html).not.toMatch(/CAD|\$\d/);
  expect(staffCapacityPage(value)).toContain('href="/operator/delivery-cost"');
});
