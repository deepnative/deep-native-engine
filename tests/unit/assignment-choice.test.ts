import { expect, it } from "vitest";
import {
  eligibleAssignments,
  recommendLesson,
} from "../../src/assignment-choice.ts";
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

it("recommends one unfinished current synthetic lesson and prefers observed starts", () => {
  const first = { ...published, id: "SYN-936", kind: "lesson" as const };
  const started = { ...first, id: "SYN-937", title: "Started reading" };
  const activity = [
    {
      contentId: started.id,
      contentVersion: 1,
      openedAt: new Date("2026-09-23"),
      startedAt: new Date("2026-09-23"),
      selfAssessedAt: null,
      available: true,
    },
  ];
  expect(
    recommendLesson([first, started], learner, undefined, activity),
  ).toEqual(started);
  expect(recommendLesson([first, started], learner, undefined)).toEqual(first);
  expect(
    recommendLesson(
      [
        {
          ...first,
          goals: ["everyday", "work", "build"],
          backgrounds: ["explorer", "professional", "technical"],
        },
        started,
      ],
      learner,
      undefined,
    ),
  ).toEqual(started);
  expect(
    recommendLesson(
      [first, { ...started, domains: ["education"] }],
      learner,
      undefined,
    ),
  ).toEqual({ ...started, domains: ["education"] });
  expect(
    recommendLesson([first, started], learner, undefined, [
      { ...activity[0]!, selfAssessedAt: new Date("2026-09-24") },
      {
        ...activity[0]!,
        contentId: first.id,
        selfAssessedAt: new Date("2026-09-24"),
      },
    ]),
  ).toBeNull();
});

it("does not recommend a mismatched, unsigned, retired or prerequisite-locked lesson", () => {
  const lesson = { ...published, id: "SYN-938", kind: "lesson" as const };
  const cases: ContentVersion[] = [
    { ...lesson, goals: ["build"] },
    { ...lesson, backgrounds: ["technical"] },
    { ...lesson, domains: ["finance"] },
    { ...lesson, minimumExperience: "experienced" },
    { ...lesson, prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE" },
    { ...lesson, prerequisites: "unsupported" },
    { ...lesson, origin: "member-proposal" },
    { ...lesson, requiresQualifiedSignoff: true },
    { ...lesson, state: "retired" },
  ];
  for (const candidate of cases)
    expect(recommendLesson([candidate], learner, undefined)).toBeNull();
  expect(
    recommendLesson(
      [lesson, { ...lesson, version: 2, publishedAt: new Date("2026-09-24") }],
      learner,
      undefined,
    ),
  ).toEqual({ ...lesson, version: 2, publishedAt: new Date("2026-09-24") });
  expect(
    recommendLesson(
      [{ ...lesson, prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE" }],
      learner,
      completed,
    ),
  ).toEqual({ ...lesson, prerequisites: "LOCAL-FIRST-EXERCISE-COMPLETE" });
});
