import { expect, it } from "vitest";
import {
  learningBand,
  learningCohorts,
  learningDisclosure,
  learningSegments,
  type RawLearningCell,
} from "../../src/learning-metrics.ts";

const raw = (over: Partial<RawLearningCell> = {}): RawLearningCell => ({
  members: 60,
  activated: 30,
  selfAssessed: 4,
  participated: 56,
  activeCircle: 5,
  submittedAssignment: 19,
  returnEligible: 40,
  crossContentReturned: 36,
  ...over,
});

it("MET-SUPP-01 bands values and suppresses below five or within five of the denominator", () => {
  expect(learningBand(4, 60)).toBeNull();
  expect(learningBand(5, 60)).toBe("5-19");
  expect(learningBand(19, 60)).toBe("5-19");
  expect(learningBand(20, 60)).toBe("20-49");
  expect(learningBand(50, 200)).toBe("50-99");
  expect(learningBand(100, 400)).toBe("100-199");
  expect(learningBand(200, 400)).toBe("200+");
  expect(learningBand(56, 60)).toBeNull();
  expect(learningBand(55, 60)).toBe("50-99");
  expect(learningBand(-1, 60)).toBeNull();
  expect(learningBand(1.5, 60)).toBeNull();
  expect(learningBand(70, 60)).toBeNull();
});

it("MET-SUPP-01 shows nothing below 20 members and only bands from 20", () => {
  const below = learningDisclosure(raw({ members: 19 }));
  expect(below.disclosure).toBe("suppressed");
  expect(below.members).toBeNull();
  expect(Object.values(below.values).every((v) => v === null)).toBe(true);
  const shown = learningDisclosure(raw());
  expect(shown).toEqual({
    disclosure: "coarse-band",
    members: "50-99",
    values: {
      activated: "20-49",
      selfAssessed: null,
      participated: null,
      activeCircle: "5-19",
      submittedAssignment: "5-19",
      returnEligible: "20-49",
      // The return measure's denominator is the eligible group, not all members.
      crossContentReturned: null,
    },
  });
  expect(learningDisclosure(raw({ members: 20 })).members).toBe("20-49");
  expect(JSON.stringify(shown)).not.toMatch(/:\s*\d/);
  for (const malformed of [
    null,
    "x",
    {},
    raw({ members: -1 }),
    raw({ activated: 1.5 }),
  ])
    expect(learningDisclosure(malformed).disclosure).toBe("suppressed");
});

it("MET-SEG-01/02 lists every known segment, suppresses small groups and small complements", () => {
  const total = 100;
  const segments = learningSegments(
    {
      background: {
        explorer: raw({ members: 96 }),
        professional: raw({ members: 19 }),
      },
      goal: { everyday: raw({ members: 20 }), bogus: raw({ members: 50 }) },
      interests: { technical: raw({ members: 45 }) },
    },
    total,
  );
  expect(segments.background.map((s) => s.key)).toEqual([
    "explorer",
    "professional",
    "technical",
  ]);
  expect(segments.goal.map((s) => s.key)).toEqual([
    "everyday",
    "work",
    "build",
  ]);
  expect(segments.interests.map((s) => s.key)).toEqual([
    "explorer",
    "professional",
    "technical",
  ]);
  const of = (group: keyof typeof segments, key: string) =>
    segments[group].find((s) => s.key === key)!;
  // Only four members lie outside this segment.
  expect(of("background", "explorer").disclosure).toBe("suppressed");
  expect(of("background", "professional").disclosure).toBe("suppressed");
  // An absent segment reads the same as a small one, not as zero.
  expect(of("background", "technical").disclosure).toBe("suppressed");
  expect(of("background", "technical").members).toBeNull();
  expect(of("goal", "everyday").members).toBe("20-49");
  expect(of("interests", "technical").members).toBe("20-49");
  expect(JSON.stringify(segments)).not.toContain("bogus");
  const empty = learningSegments(null, 0);
  expect(empty.goal.every((s) => s.disclosure === "suppressed")).toBe(true);
  expect(JSON.stringify(segments)).not.toMatch(/paid|tier|career|staff|price/i);
});

it("MET-COH-01/02 discloses only closed cohorts in bands and never partial open windows", () => {
  const cohorts = learningCohorts([
    {
      month: "2026-10",
      closed: false,
      members: 80,
      activated: 40,
      selfAssessed: 10,
      submittedAssignment: 10,
      continued: 10,
    },
    {
      month: "2026-08",
      closed: true,
      members: 80,
      activated: 40,
      selfAssessed: 4,
      submittedAssignment: 76,
      continued: 20,
    },
    {
      month: "2026-07",
      closed: true,
      members: 19,
      activated: 10,
      selfAssessed: 10,
      submittedAssignment: 10,
      continued: 10,
    },
    { month: "not-a-month", closed: true, members: 80 },
    { month: "2026-06", closed: true, members: 80, activated: "x" },
  ]);
  expect(cohorts).toEqual([
    {
      month: "2026-10",
      disclosure: "window-open",
      members: null,
      values: {
        activated: null,
        selfAssessed: null,
        submittedAssignment: null,
        continued: null,
      },
    },
    {
      month: "2026-08",
      disclosure: "coarse-band",
      members: "50-99",
      values: {
        activated: "20-49",
        selfAssessed: null,
        submittedAssignment: null,
        continued: "20-49",
      },
    },
    {
      month: "2026-07",
      disclosure: "suppressed",
      members: null,
      values: {
        activated: null,
        selfAssessed: null,
        submittedAssignment: null,
        continued: null,
      },
    },
    {
      month: "2026-06",
      disclosure: "suppressed",
      members: null,
      values: {
        activated: null,
        selfAssessed: null,
        submittedAssignment: null,
        continued: null,
      },
    },
  ]);
  expect(learningCohorts(null)).toEqual([]);
  expect(learningCohorts("x")).toEqual([]);
  expect(learningCohorts([null])).toEqual([]);
});
