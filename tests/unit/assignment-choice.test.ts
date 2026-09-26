import { expect, it } from "vitest";
import { eligibleAssignments } from "../../src/assignment-choice.ts";
import type { ContentVersion } from "../../src/catalog.ts";
import type { Learner, Exercise } from "../../src/store.ts";

const learner: Learner = {
  id: "member-1",
  background: "explorer",
  backgroundTags: ["professional"],
  goal: "everyday",
  domainTags: ["education"],
  experience: "new",
  exploratory: true,
};
const published: ContentVersion = {
  id: "SYN-920",
  version: 1,
  kind: "assignment",
  origin: "curated",
  title: "Invented community event",
  body: "Use invented details only.",
  owner: "Test editor",
  sources: "Original synthetic example",
  rights: "Owned synthetic example",
  goals: ["everyday"],
  backgrounds: ["explorer"],
  domains: [],
  prerequisites: "None",
  minimumExperience: "new",
  rubric: null,
  rubricVersion: null,
  state: "published",
  requiresQualifiedSignoff: false,
  reviewedAt: new Date("2026-09-23"),
  publishedAt: new Date("2026-09-23"),
};
const completed: Exercise = {
  instruction: "Use only these invented event details.",
  verification: "Compare the result with the brief.",
  completed_at: new Date("2026-09-23"),
};

it("recommends only published assignments matching goals, interests, self-reported experience and observed prerequisites", () => {
  const matchingInterest = {
    ...published,
    id: "SYN-921",
    backgrounds: ["professional"],
    domains: ["education"],
  };
  const needPractice = {
    ...published,
    id: "SYN-922",
    prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE",
  };
  const items: ContentVersion[] = [
    published,
    matchingInterest,
    needPractice,
    { ...published, id: "SYN-923", state: "draft" },
    { ...published, id: "SYN-924", kind: "lesson" },
    { ...published, id: "SYN-925", goals: ["build"] },
    { ...published, id: "SYN-926", backgrounds: ["technical"] },
    { ...published, id: "SYN-927", domains: ["finance"] },
    { ...published, id: "SYN-928", minimumExperience: "some" },
    { ...published, id: "SYN-929", prerequisites: "Human approval required" },
  ];
  expect(
    eligibleAssignments(items, learner, undefined).map((item) => item.id),
  ).toEqual(["SYN-920", "SYN-921"]);
  expect(
    eligibleAssignments(items, learner, completed).map((item) => item.id),
  ).toEqual(["SYN-920", "SYN-921", "SYN-922"]);
  expect(
    eligibleAssignments(
      items,
      { ...learner, experience: "some" },
      completed,
    ).map((item) => item.id),
  ).toEqual(["SYN-920", "SYN-921", "SYN-922", "SYN-928"]);
});

it("keeps an unspecified experience conservative and never counts an unfinished draft as completion", () => {
  const unreported = { ...learner, experience: null };
  const items = [
    { ...published, minimumExperience: "experienced" as const },
    {
      ...published,
      id: "SYN-930",
      minimumExperience: undefined,
      goals: [],
      backgrounds: [],
      prerequisites: "  ",
    },
    {
      ...published,
      id: "SYN-931",
      prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE",
    },
  ];
  expect(
    eligibleAssignments(items, unreported, {
      ...completed,
      completed_at: null,
    }).map((item) => item.id),
  ).toEqual(["SYN-930"]);
  expect(
    eligibleAssignments(
      items,
      { ...learner, experience: "experienced" },
      completed,
    ).map((item) => item.id),
  ).toEqual(["SYN-920", "SYN-930", "SYN-931"]);
});

it("treats missing optional interests as empty rather than inferring a match", () => {
  const withoutTags: Learner = {
    id: "member-2",
    background: "explorer",
    goal: "everyday",
  };
  expect(
    eligibleAssignments(
      [{ ...published, backgrounds: ["professional"] }],
      withoutTags,
      undefined,
    ),
  ).toEqual([]);
  expect(
    eligibleAssignments(
      [{ ...published, domains: ["education"] }],
      withoutTags,
      undefined,
    ),
  ).toEqual([]);
});

it("does not treat a structured lesson-activity prerequisite as free-text None", () => {
  const lesson = { ...published, id: "SYN-934", kind: "lesson" as const };
  const assignment = {
    ...published,
    id: "SYN-935",
    structuredPrerequisites: {
      schemaVersion: 1 as const,
      all: [
        {
          kind: "lesson" as const,
          id: lesson.id,
          version: 1,
          activity: "started" as const,
        },
      ],
    },
  };
  expect(eligibleAssignments([lesson, assignment], learner, undefined)).toEqual(
    [],
  );
});
