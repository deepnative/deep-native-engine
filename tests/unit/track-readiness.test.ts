import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledTrackStore,
  expertEligible,
  specialtyState,
  trackStore,
  type ExpertRecord,
} from "../../src/track-readiness.ts";

const now = new Date("2026-09-23T12:00:00Z");
const evidence: ExpertRecord = {
  id: "e1",
  staffId: "primary",
  staffRole: "reviewer",
  domain: "education",
  serviceType: "formal-review",
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: new Date("2026-10-01T00:00:00Z"),
  loadedCostCents: 12500,
  capacityMinutes: 90,
  committedMinutes: 0,
  backupStaffId: "backup",
  qualificationRef: "qualification file",
  agreementRef: "agreement file",
  conflictReviewRef: "conflict check",
  verifiedBy: "admin",
  verifiedAt: new Date("2026-09-20T00:00:00Z"),
  retiredAt: null,
};
const backup: ExpertRecord = {
  ...evidence,
  id: "e2",
  staffId: "backup",
  backupStaffId: "primary",
};
it("requires every current qualified and operational expert fact before claiming coverage", () => {
  expect(expertEligible(evidence, now)).toBe(true);
  const invalid: Partial<ExpertRecord>[] = [
    { verifiedBy: null },
    { verifiedAt: null },
    { qualificationRef: " " },
    { agreementRef: " " },
    { conflictReviewRef: " " },
    { backupStaffId: null },
    { backupStaffId: "primary" },
    { retiredAt: now },
    { startsAt: new Date("2026-09-24T00:00:00Z") },
    { endsAt: now },
  ];
  for (const change of invalid)
    expect(expertEligible({ ...evidence, ...change }, now)).toBe(false);
});
it("separates retired, unprepared, limited and available specialist coverage", () => {
  expect(specialtyState(true, [{ ...evidence, retiredAt: now }], now)).toBe(
    "retired",
  );
  expect(specialtyState(false, [evidence], now)).toBe("in preparation");
  expect(specialtyState(true, [], now)).toBe("in preparation");
  expect(specialtyState(true, [{ ...evidence, verifiedBy: null }], now)).toBe(
    "in preparation",
  );
  expect(specialtyState(true, [evidence], now)).toBe("in preparation");
  expect(
    specialtyState(true, [evidence, { ...backup, committedMinutes: 90 }], now),
  ).toBe("in preparation");
  expect(
    specialtyState(true, [{ ...evidence, committedMinutes: 60 }, backup], now),
  ).toBe("limited coverage");
  expect(specialtyState(true, [evidence, backup], now)).toBe("available");
});
it("defaults every track to preparation and denies private roster access", async () => {
  const disabled = disabledTrackStore();
  expect((await disabled.snapshot()).foundation).toHaveLength(3);
  expect((await disabled.snapshot()).specialties).toHaveLength(12);
  expect(await disabled.registry("unknown")).toBeNull();
});
it("derives foundation and specialist states from published qualified content and registry data", async () => {
  const query = vi.fn().mockResolvedValueOnce({
    rows: [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        id: `FND-00${n}`,
        goals: ["everyday", "work", "build"],
        domains: [],
      })),
      { id: "SYN-010", goals: [], domains: ["education"] },
    ],
  });
  query.mockResolvedValueOnce({ rows: [evidence, backup] });
  const store = trackStore({ query } as unknown as Pool);
  const result = await store.snapshot();
  expect(result.foundation.map((track) => track.state)).toEqual([
    "available",
    "available",
    "available",
  ]);
  expect(result.specialties[0]).toEqual({
    domain: "education",
    serviceType: "coaching",
    state: "in preparation",
  });
  expect(result.specialties[1]).toEqual({
    domain: "education",
    serviceType: "formal-review",
    state: "available",
  });
  expect(result.specialties[2]?.state).toBe("in preparation");
  expect(query.mock.calls[0]?.[0]).toContain("requires_qualified_signoff=true");
});
it("never implies released foundation content from an incomplete six-lesson set", async () => {
  const query = vi.fn().mockResolvedValueOnce({
    rows: [{ id: "FND-001", goals: ["everyday"], domains: [] }],
  });
  query.mockResolvedValueOnce({ rows: [] });
  expect(
    (await trackStore({ query } as unknown as Pool).snapshot()).foundation,
  ).toEqual([
    { goal: "everyday", state: "in preparation" },
    { goal: "work", state: "in preparation" },
    { goal: "build", state: "in preparation" },
  ]);
});
it("allows only current operators to see the full expert registry", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ allowed: false, id: null }] })
    .mockResolvedValueOnce({ rows: [{ allowed: true, ...evidence }] })
    .mockResolvedValueOnce({ rows: [{ allowed: true, id: null }] });
  const registry = trackStore({ query } as unknown as Pool);
  expect(await registry.registry("member")).toBeNull();
  expect(await registry.registry("operator")).toEqual([evidence]);
  expect(await registry.registry("operator")).toEqual([]);
  expect(query.mock.calls[0]?.[0]).toContain("p.expires_at>CURRENT_TIMESTAMP");
  expect(query.mock.calls[0]?.[0]).toContain("LEFT JOIN LATERAL");
});
