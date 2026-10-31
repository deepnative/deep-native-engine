import { expect, it } from "vitest";
import {
  emptyLearningSnapshot,
  joinLearningSnapshot,
  learningDigest,
  learningInteger,
  learningObject,
  learningUuid,
  splitLearningSnapshot,
  validLearningDecision,
  validLearningIdentity,
  validLearningSnapshot,
  type LearningDecision,
} from "../../src/learning-workspace-values.ts";
import {
  bundleFixture as bundle,
  identityFixture as identity,
} from "./learning-workspace-fixtures.ts";

it("LWORK fixed snapshots retain all27 exact writing fields without metadata text", () => {
  const state = emptyLearningSnapshot(bundle, "everyday");
  state.lessons[0]!.selections = ["a", null];
  state.contribution = {
    problem: "p",
    first: "f",
    revision: "",
    reason: "r",
    rights: "owned",
    attribution: "author",
    audience: "members-later",
    checked: true,
  };
  const split = splitLearningSnapshot(state);
  expect(split.fields).toHaveLength(27);
  split.fields.forEach((field, index) => {
    field[1] = `${index}\u0000\ud800`;
  });
  const restored = joinLearningSnapshot(split.metadata, split.fields);
  expect(splitLearningSnapshot(restored).fields).toEqual(split.fields);
  expect(validLearningSnapshot(restored, bundle, "everyday")).toBe(true);
  expect(() =>
    joinLearningSnapshot(split.metadata, split.fields.slice(1)),
  ).toThrow();
  expect(() =>
    joinLearningSnapshot(
      split.metadata,
      split.fields.map(() => split.fields[0]!),
    ),
  ).toThrow();
  expect(() =>
    joinLearningSnapshot(split.metadata, [
      ...split.fields.slice(1),
      ["unknown", ""],
    ]),
  ).toThrow();
});

it("LWORK accepts valid routes, flags, boundaries and private contribution self-check", () => {
  for (const variant of ["everyday", "work", "technical"] as const) {
    const state = emptyLearningSnapshot(bundle, variant);
    expect(validLearningSnapshot(state, bundle, variant)).toBe(true);
    state.lesson = 6;
    state.step = 3;
    state.finalStep = 3;
    state.reviewCriterion = 5;
    state.lessons[0]!.work = "\ud800".repeat(30000);
    state.contribution = {
      problem: "p",
      first: "f",
      revision: "",
      reason: "r",
      rights: "owned",
      attribution: "",
      audience: "private",
      checked: true,
    };
    expect(validLearningSnapshot(state, bundle, variant)).toBe(true);
  }
});

it("LWORK rejects malformed shapes, choices, forged cases and incomplete checked proposals", () => {
  const invalid = [
    null,
    [],
    {},
    { ...emptyLearningSnapshot(bundle, "everyday"), extra: true },
    ...["lesson", "step", "finalStep"].flatMap((key) =>
      [-1, 1.1, "1", 7].map((value) => ({ [key]: value })),
    ),
    { finalChecked: 1 },
    { reviewCriterion: -1 },
    { reviewCriterion: 6 },
    { reviewCriterion: "0" },
    { final: [] },
    { final: Array(6).fill(1) },
    { final: Array(6).fill("x".repeat(30001)) },
    { lessons: [] },
    { lessons: Array(6).fill(null) },
    ...[
      { transfer: 1 },
      { work: 1 },
      { selfChecked: 1 },
      { selections: 1 },
      { selections: ["nope"] },
      { selections: ["a", "yes", null] },
    ].map((change) => ({
      lessons: Array.from({ length: 6 }, () => ({
        ...emptyLearningSnapshot(bundle, "everyday").lessons[0],
        ...change,
      })),
    })),
    { feedback: null },
    { feedback: { caseId: "wrong", draft: {} } },
    { feedback: { caseId: "case-everyday", draft: {} } },
    ...[{ decision: "grade" }, { text: 2 }].map((change) => ({
      feedback: {
        caseId: "case-everyday",
        draft: {
          ...emptyLearningSnapshot(bundle, "everyday").feedback.draft,
          ...change,
        },
      },
    })),
    ...[
      null,
      { problem: 2 },
      { audience: "public" },
      { checked: 1 },
      { checked: true },
      {
        problem: "p",
        first: "f",
        reason: "r",
        rights: "r",
        audience: "members-later",
        checked: true,
      },
    ].map((change) => ({
      contribution:
        change === null
          ? null
          : {
              ...emptyLearningSnapshot(bundle, "everyday").contribution,
              ...change,
            },
    })),
  ];
  for (const change of invalid) {
    const value =
      change && !Array.isArray(change) && Object.keys(change).length
        ? { ...emptyLearningSnapshot(bundle, "everyday"), ...change }
        : change;
    expect(
      validLearningSnapshot(value, bundle, "everyday"),
      JSON.stringify(change),
    ).toBe(false);
  }
});

it("LWORK decisions preserve the exact artifact chain and reject forged transitions", () => {
  const current = bundle.routes.everyday.feedback.initial;
  const decision: LearningDecision = {
    id: 1,
    commentVersion: 1,
    fromVersion: 1,
    toVersion: 2,
    decision: "revise",
    text: "Revised artifact",
    reason: "Source evidence",
    question: "",
    proposedText: "Revised artifact",
  };
  expect(validLearningDecision(decision, bundle, "everyday", 0, current)).toBe(
    true,
  );
  for (const change of [
    null,
    {},
    { id: 2 },
    { commentVersion: 2 },
    { fromVersion: 2 },
    { text: 2 },
    { reason: " " },
    { text: " " },
    { text: current.text, proposedText: current.text },
    { toVersion: 3 },
    { proposedText: "other" },
    { decision: "unknown" },
  ]) {
    expect(
      validLearningDecision(
        change === null || Object.keys(change).length === 0
          ? change
          : { ...decision, ...change },
        bundle,
        "everyday",
        0,
        current,
      ),
    ).toBe(false);
  }
  const keep = {
    ...decision,
    decision: "decline" as const,
    text: current.text,
    toVersion: 1,
  };
  expect(validLearningDecision(keep, bundle, "everyday", 0, current)).toBe(
    true,
  );
  expect(
    validLearningDecision(
      { ...keep, text: "changed" },
      bundle,
      "everyday",
      0,
      current,
    ),
  ).toBe(false);
  expect(
    validLearningDecision(
      { ...keep, decision: "addressed" },
      bundle,
      "everyday",
      0,
      current,
    ),
  ).toBe(false);
  expect(
    validLearningDecision(
      {
        ...keep,
        decision: "addressed",
        fromVersion: 2,
        toVersion: 2,
        text: "newer",
      },
      bundle,
      "everyday",
      0,
      { id: 2, text: "newer" },
    ),
  ).toBe(true);
});

it("LWORK identity validation and canonical digest preserve significant Unicode and ignore object order", () => {
  expect(validLearningIdentity(identity)).toBe(true);
  for (const value of [
    null,
    {},
    { ...identity, extra: 1 },
    { ...identity, contentId: "../x" },
    { ...identity, contentVersion: 0 },
    { ...identity, contentVersion: 1.2 },
    { ...identity, contentHash: "bad" },
    { ...identity, variant: "build" },
  ])
    expect(validLearningIdentity(value)).toBe(false);
  expect(learningUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
  expect(learningUuid(1)).toBe(false);
  expect(learningUuid("bad")).toBe(false);
  expect(learningInteger(0)).toBe(true);
  expect(learningInteger(-1)).toBe(false);
  expect(learningObject([], [])).toBe(false);
  expect(learningDigest({ b: [null, 1, "x"], a: 2 })).toBe(
    learningDigest({ a: 2, b: [null, 1, "x"] }),
  );
  expect(
    new Set(["\u0000", "\\u0000", "\ud800", "\udc00", "�"].map(learningDigest))
      .size,
  ).toBe(5);
});
