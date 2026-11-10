import {
  learningDisclosure,
  learningSegments,
} from "../../src/learning-metrics.ts";
import { expect, it } from "vitest";
import {
  VOLUME_KEYS,
  contributionGroup,
  contributionMetrics,
  type RawContributionGroup,
} from "../../src/contribution-metrics.ts";
import { metricsReportPage } from "../../src/metrics-report-views.ts";
import type { PreviewMetrics } from "../../src/metrics.ts";

const cell = (revisions: number, owners = revisions) => ({ revisions, owners });
function raw(
  contributors = 20,
  overrides: Partial<RawContributionGroup> = {},
): RawContributionGroup {
  return {
    contributors,
    volumes: Object.fromEntries(
      VOLUME_KEYS.map((key) => [key, cell(20, 20)]),
    ) as RawContributionGroup["volumes"],
    firstAccepted: cell(10, 5),
    firstNotAccepted: cell(10, 5),
    ...overrides,
  };
}

it("CM122-04 suppresses a whole group below 20 contributing owners without revealing zero", () => {
  expect(contributionGroup("member", raw(19))).toEqual({
    origin: "member",
    disclosure: "suppressed",
    volumes: Object.fromEntries(VOLUME_KEYS.map((key) => [key, null])),
    firstDecisionAcceptanceBand: null,
  });
  expect(contributionGroup("member", raw(0))).toEqual(
    contributionGroup("member", raw(19)),
  );
  expect(contributionGroup("member", raw(20)).disclosure).toBe("disclosed");
});

it("CM122-04 discloses a volume only with five owners and only as a coarse band, however prolific one owner is", () => {
  const volumes = raw().volumes;
  const at = (revisions: number, owners: number) =>
    contributionGroup(
      "member",
      raw(20, { volumes: { ...volumes, submitted: cell(revisions, owners) } }),
    ).volumes.submitted;
  expect(at(400, 4)).toBeNull();
  expect(at(5, 5)).toBe("5-19");
  expect(at(19, 5)).toBe("5-19");
  expect(at(20, 5)).toBe("20-49");
  expect(at(49, 5)).toBe("20-49");
  expect(at(50, 5)).toBe("50-99");
  expect(at(99, 5)).toBe("50-99");
  expect(at(100, 5)).toBe("100-199");
  expect(at(199, 5)).toBe("100-199");
  expect(at(200, 5)).toBe("200+");
});

it("CM122-04 discloses the first-decision acceptance share only with five owners on each side, in 25-point bands", () => {
  const share = (accepted: number, other: number, owners = [5, 5]) =>
    contributionGroup(
      "member",
      raw(20, {
        firstAccepted: cell(accepted, owners[0]),
        firstNotAccepted: cell(other, owners[1]),
      }),
    ).firstDecisionAcceptanceBand;
  expect(share(10, 10, [4, 5])).toBeNull();
  expect(share(10, 10, [5, 4])).toBeNull();
  expect(share(5, 16)).toBe("0-24%");
  expect(share(5, 15)).toBe("25-49%");
  expect(share(10, 10)).toBe("50-74%");
  expect(share(15, 5)).toBe("75-100%");
});

it("CM122-04 treats malformed or missing aggregates as suppressed instead of partial counts", () => {
  for (const bad of [
    null,
    undefined,
    "20",
    {},
    raw(20.5),
    raw(-1),
    raw(20, { firstAccepted: cell(4, 5) }),
    raw(20, { firstNotAccepted: { revisions: "5", owners: 5 } as never }),
    { ...raw(), volumes: { ...raw().volumes, published: undefined } },
    { ...raw(), volumes: undefined },
  ])
    expect(contributionGroup("sample", bad).disclosure).toBe("suppressed");
  const empty = contributionMetrics("2026-11-02", undefined);
  expect(empty.measuredSince).toBeNull();
  expect(empty.groups.map((g) => [g.origin, g.disclosure])).toEqual([
    ["member", "suppressed"],
    ["sample", "suppressed"],
  ]);
  expect(
    contributionMetrics(new Date(Number.NaN), {}).measuredSince,
  ).toBeNull();
});

const base: PreviewMetrics = {
  scope: "synthetic-local-preview",
  accounts: "not-demo",
  asOf: new Date("2026-11-02T12:00:00Z"),
  definitions: {
    accounts: "Not demo.",
    denominator: "Retained.",
    activated: "Opened.",
    selfAssessed: "Self.",
    participated: "Joined.",
    activeCircle: "Current.",
    submittedAssignment: "Submitted.",
    returnEligible: "Eligible.",
    crossContentReturned: "Returned.",
    reportedOutcome: "Reported.",
    enrolledInProgram: "Enrolled in the program term.",
    withdrewFromProgram: "Withdrew from the program term.",
    usefulness: "Useful.",
    segments: "Segments.",
    cohorts: "Cohorts.",
    cohortActivated: "Cohort opened.",
    cohortSelfAssessed: "Cohort self-reported.",
    cohortSubmittedAssignment: "Cohort submitted.",
    cohortContinued: "Cohort continued.",
  },
  learning: learningDisclosure(null),
  segments: learningSegments(null, 0),
  cohorts: [],
  usefulness: { disclosure: "suppressed", helpfulShareBand: null },
  contributions: contributionMetrics(new Date("2026-11-01T00:00:00Z"), {
    member: raw(20, {
      volumes: { ...raw().volumes, published: cell(30, 4) },
      firstNotAccepted: cell(3, 3),
    }),
  }),
};

it("CM122-04/05 renders separate provenance groups with bands, suppression and definitions but no exact counts", () => {
  const html = metricsReportPage(base);
  expect(html).toContain("Reviewed contributions");
  expect(html).toContain('datetime="2026-11-01T00:00:00.000Z"');
  expect(html).toContain('data-contribution="member-submitted">20-49</dd>');
  expect(html).toContain(
    'data-contribution="member-published">Suppressed</dd>',
  );
  expect(html).toContain('data-contribution="member-share">Suppressed</dd>');
  expect(html).toContain('data-contributions="sample-suppressed"');
  expect(html).toContain("Sample-attested contributions");
  expect(html).toContain("origin alone does not establish live activity");
  expect(html).toContain("not instructional quality");
  expect(html).toContain("Suppressed values may be zero or not");
  expect(html).not.toContain("reviewed contribution quality");
  const block = html.slice(html.indexOf("Reviewed contributions"));
  expect(block).not.toMatch(/data-contribution="[^"]+">\d+<\/dd>/);
});
