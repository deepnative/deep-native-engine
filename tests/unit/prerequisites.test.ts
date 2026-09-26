import { expect, it } from "vitest";
import type { ContentVersion } from "../../src/catalog.ts";
import type { Exercise, LessonActivity } from "../../src/store.ts";
import {
  effectivePrerequisiteSpec,
  prerequisitesMet,
  validPrerequisiteSpec,
  type PrerequisiteSpec,
} from "../../src/prerequisites.ts";

const published = (
  id: string,
  kind: ContentVersion["kind"] = "lesson",
): ContentVersion => ({
  id,
  version: 1,
  kind,
  origin: "curated",
  title: "Invented study item",
  body: "Use only invented examples.",
  owner: "Synthetic editor",
  sources: "Original sample",
  rights: "Owned synthetic text",
  goals: [],
  backgrounds: [],
  domains: [],
  prerequisites: "None",
  structuredPrerequisites: null,
  minimumExperience: "new",
  rubric: null,
  rubricVersion: null,
  state: "published",
  requiresQualifiedSignoff: false,
  reviewedAt: new Date(),
  publishedAt: new Date(),
});
const lessonAtom = {
  kind: "lesson",
  id: "SYN-801",
  version: 1,
  activity: "started",
} as const;
const exerciseAtom = {
  kind: "exercise",
  id: "clear-instructions",
  version: 1,
  activity: "completed",
} as const;
const spec: PrerequisiteSpec = {
  schemaVersion: 1,
  all: [lessonAtom, exerciseAtom],
};
const completed: Exercise = {
  instruction: "Invented task",
  verification: "Check",
  completed_at: new Date(),
};
const activity = (
  started: Date | null,
  assessed: Date | null = null,
): LessonActivity => ({
  contentId: "SYN-801",
  contentVersion: 1,
  openedAt: new Date(),
  startedAt: started,
  selfAssessedAt: assessed,
  available: true,
});

it("accepts a bounded exact-version all-of and rejects malformed or unsupported authoring", () => {
  expect(validPrerequisiteSpec({ schemaVersion: 1, all: [] })).toBe(true);
  expect(validPrerequisiteSpec(spec)).toBe(true);
  const invalid: unknown[] = [
    null,
    [],
    { schemaVersion: 1 },
    { schemaVersion: 2, all: [] },
    { ...spec, unexpected: true },
    { schemaVersion: 1, all: "none" },
    { schemaVersion: 1, all: Array(9).fill(exerciseAtom) },
    { schemaVersion: 1, all: [null] },
    { schemaVersion: 1, all: [{ ...lessonAtom, extra: true }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, id: "bad" }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, version: 0 }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, version: 1.5 }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, version: 2147483648 }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, activity: "opened" }] },
    { schemaVersion: 1, all: [{ ...exerciseAtom, id: "other" }] },
    { schemaVersion: 1, all: [{ ...exerciseAtom, version: 2 }] },
    { schemaVersion: 1, all: [{ ...exerciseAtom, activity: "started" }] },
    { schemaVersion: 1, all: [{ ...lessonAtom, kind: "assignment" }] },
    {
      schemaVersion: 1,
      all: [lessonAtom, { ...lessonAtom, activity: "self-assessed" }],
    },
  ];
  for (const value of invalid) expect(validPrerequisiteSpec(value)).toBe(false);
});

it("normalizes only the accepted legacy tokens and never guesses unknown requirements", () => {
  expect(effectivePrerequisiteSpec(undefined, " None ")).toEqual({
    schemaVersion: 1,
    all: [],
  });
  expect(effectivePrerequisiteSpec(null, "   ")).toEqual({
    schemaVersion: 1,
    all: [],
  });
  expect(
    effectivePrerequisiteSpec(undefined, "LOCAL-FIRST-EXERCISE-COMPLETE"),
  ).toEqual({ schemaVersion: 1, all: [exerciseAtom] });
  expect(
    effectivePrerequisiteSpec(undefined, "Human approval required"),
  ).toBeNull();
  expect(
    effectivePrerequisiteSpec({ schemaVersion: 2, all: [] }, "None"),
  ).toBeNull();
  expect(effectivePrerequisiteSpec(spec, "")).toEqual(spec);
});

it("requires matching observed lesson and local exercise versions without treating an open as completion", () => {
  const lesson = published("SYN-801");
  const assignment = {
    ...published("SYN-802", "assignment"),
    prerequisites: "",
    structuredPrerequisites: spec,
  };
  const catalog = [lesson, assignment];
  expect(
    prerequisitesMet(assignment, catalog, undefined, [activity(null)]),
  ).toBe(false);
  expect(
    prerequisitesMet(assignment, catalog, completed, [activity(null)]),
  ).toBe(false);
  expect(
    prerequisitesMet(assignment, catalog, undefined, [activity(new Date())]),
  ).toBe(false);
  expect(
    prerequisitesMet(assignment, catalog, completed, [activity(new Date())]),
  ).toBe(true);
  expect(
    prerequisitesMet(assignment, catalog, completed, [
      { ...activity(new Date()), contentVersion: 2 },
    ]),
  ).toBe(false);
  const assessed = {
    ...assignment,
    structuredPrerequisites: {
      schemaVersion: 1 as const,
      all: [{ ...lessonAtom, activity: "self-assessed" as const }],
    },
  };
  expect(
    prerequisitesMet(assessed, [lesson, assessed], undefined, [
      activity(new Date()),
    ]),
  ).toBe(false);
  expect(
    prerequisitesMet(assessed, [lesson, assessed], undefined, [
      activity(new Date(), new Date()),
    ]),
  ).toBe(true);
});

it("fails closed for unavailable, retired, superseded and cyclic lesson references", () => {
  const lesson = published("SYN-801");
  const assignment = {
    ...published("SYN-802", "assignment"),
    prerequisites: "",
    structuredPrerequisites: spec,
  };
  expect(
    prerequisitesMet(assignment, [assignment], completed, [
      activity(new Date()),
    ]),
  ).toBe(false);
  expect(
    prerequisitesMet(
      assignment,
      [{ ...lesson, state: "retired" }, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
  expect(
    prerequisitesMet(
      assignment,
      [lesson, { ...lesson, version: 2, state: "retired" }, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
  expect(
    prerequisitesMet(
      { ...assignment, state: "draft" },
      [lesson, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
  expect(
    prerequisitesMet(
      { ...assignment, requiresQualifiedSignoff: true },
      [lesson, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
  expect(
    prerequisitesMet(
      assignment,
      [{ ...lesson, origin: "member-proposal" }, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
  const cyclic = {
    ...lesson,
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1 as const,
      all: [{ ...lessonAtom, activity: "started" as const }],
    },
  };
  expect(
    prerequisitesMet(assignment, [cyclic, assignment], completed, [
      activity(new Date()),
    ]),
  ).toBe(false);
  const otherLesson = {
    ...published("SYN-803"),
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1 as const,
      all: [{ ...lessonAtom, activity: "started" as const }],
    },
  };
  const firstLesson = {
    ...lesson,
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1 as const,
      all: [
        {
          ...lessonAtom,
          id: otherLesson.id,
          activity: "started" as const,
        },
      ],
    },
  };
  expect(
    prerequisitesMet(
      assignment,
      [firstLesson, otherLesson, assignment],
      completed,
      [activity(new Date())],
    ),
  ).toBe(false);
});
