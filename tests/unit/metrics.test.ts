import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledMetricsStore,
  metricsStore,
  usefulnessDisclosure,
} from "../../src/metrics.ts";
import { hash } from "../../src/store.ts";

it("disables preview metrics unless a real store is configured", async () => {
  expect(await disabledMetricsStore().snapshot("a".repeat(64))).toBeNull();
});

it("returns only defined synthetic aggregates to an authorized operator", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        asOf: new Date("2026-09-24T00:00:00Z"),
        members: 4,
        activated: 3,
        selfAssessed: 1,
        participated: 2,
        activeCircle: 1,
        submittedAssignment: 2,
        returnEligible: 3,
        crossContentReturned: 1,
        usefulnessRespondents: 20,
        usefulnessHelpful: 10,
        usefulnessNotYet: 10,
      },
    ],
  });
  const metrics = metricsStore({ query } as unknown as Pool);
  const snapshot = await metrics.snapshot("a".repeat(64));
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("p.revoked_at IS NULL"),
    [hash("a".repeat(64))],
  );
  expect(snapshot).toMatchObject({
    scope: "synthetic-local-preview",
    counts: {
      members: 4,
      activated: 3,
      selfAssessed: 1,
      participated: 2,
      activeCircle: 1,
      submittedAssignment: 2,
      returnEligible: 3,
      crossContentReturned: 1,
    },
  });
  expect(snapshot?.definitions.selfAssessed).toContain("not observed skill");
  expect(snapshot?.definitions.submittedAssignment).toContain("not reviewed");
  expect(snapshot?.definitions.crossContentReturned).toContain("7 full days");
  expect(snapshot?.definitions.returnEligible).toContain("14 full days");
  expect(snapshot?.usefulness).toEqual({
    disclosure: "coarse-band",
    helpfulShareBand: "50-74%",
  });
  expect(snapshot?.definitions.usefulness).toContain("self-reported");
  expect(JSON.stringify(snapshot)).not.toContain("usefulnessRespondents");
  query.mockResolvedValue({ rows: [] });
  expect(await metrics.snapshot("b".repeat(64))).toBeNull();
});

it.each([
  [19, 10, 9, "suppressed", null],
  [20, 16, 4, "suppressed", null],
  [20, 5, 15, "coarse-band", "25-49%"],
  [20, 10, 10, "coarse-band", "50-74%"],
  [20, 15, 5, "coarse-band", "75-100%"],
  [26, 5, 21, "coarse-band", "0-24%"],
  [20, 15, 4, "suppressed", null],
  [Number.NaN, 10, 10, "suppressed", null],
  [20, Number.NaN, 10, "suppressed", null],
  [20, 10, Number.NaN, "suppressed", null],
])(
  "coarsens retained usefulness %s/%s/%s without disclosing small cells",
  (respondents, helpful, notYet, disclosure, helpfulShareBand) => {
    expect(usefulnessDisclosure(respondents, helpful, notYet)).toEqual({
      disclosure,
      helpfulShareBand,
    });
  },
);
