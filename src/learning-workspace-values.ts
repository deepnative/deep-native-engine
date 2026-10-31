import { createHash } from "node:crypto";
import type { DraftContent } from "./catalog.ts";

export const LEARNING_VARIANTS = ["everyday", "work", "technical"] as const;
export type LearningVariant = (typeof LEARNING_VARIANTS)[number];
export interface LearningIdentity {
  contentId: string;
  contentVersion: number;
  contentHash: string;
  variant: LearningVariant;
}
export interface LearningBundle {
  publication: DraftContent;
  contentHash: string;
  routes: Record<
    LearningVariant,
    {
      questionChoices: string[][][];
      reviewCriteria: number;
      feedback: {
        caseId: string;
        commentVersion: number;
        initial: { id: number; text: string };
      };
    }
  >;
}
export type LearningBundleLoader = (
  identity: LearningIdentity,
) => Promise<LearningBundle | null>;
export interface LearningLesson {
  transfer: string;
  work: string;
  selfChecked: boolean;
  selections: Array<string | null>;
  checked: boolean;
  reviewNeeded: boolean;
  hint: boolean;
}
export interface LearningFeedbackDraft {
  decision: "" | "revise" | "decline" | "addressed";
  text: string;
  reason: string;
  question: string;
}
export interface LearningSnapshot {
  lesson: number;
  step: number;
  lessons: LearningLesson[];
  final: string[];
  finalChecked: boolean;
  finalStep: number;
  reviewCriterion: number | null;
  feedback: { caseId: string; draft: LearningFeedbackDraft };
  contribution: {
    problem: string;
    first: string;
    revision: string;
    reason: string;
    rights: string;
    attribution: string;
    audience: "private" | "members-later";
    checked: boolean;
  };
}
export interface LearningDecision {
  id: number;
  commentVersion: number;
  fromVersion: number;
  toVersion: number;
  decision: "revise" | "decline" | "addressed";
  text: string;
  reason: string;
  question: string;
  proposedText: string;
}
export const learningUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const learningInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const writing = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 30000;
export function learningObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function validLearningIdentity(
  value: unknown,
): value is LearningIdentity {
  if (
    !learningObject(value, [
      "contentId",
      "contentVersion",
      "contentHash",
      "variant",
    ])
  )
    return false;
  return (
    typeof value.contentId === "string" &&
    /^[A-Z]{2,5}-[0-9]{3}$/.test(value.contentId) &&
    learningInteger(value.contentVersion) &&
    value.contentVersion > 0 &&
    typeof value.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.contentHash) &&
    LEARNING_VARIANTS.includes(value.variant as LearningVariant)
  );
}
const contributionKeys = [
  "problem",
  "first",
  "revision",
  "reason",
  "rights",
  "attribution",
] as const;
const decisionKeys = [
  "id",
  "commentVersion",
  "fromVersion",
  "toVersion",
  "decision",
  "text",
  "reason",
  "question",
  "proposedText",
];
export function emptyLearningSnapshot(
  bundle: LearningBundle,
  variant: LearningVariant,
): LearningSnapshot {
  return {
    lesson: 0,
    step: 0,
    lessons: Array.from({ length: 6 }, () => ({
      transfer: "",
      work: "",
      selfChecked: false,
      selections: [],
      checked: false,
      reviewNeeded: false,
      hint: false,
    })),
    final: Array<string>(6).fill(""),
    finalChecked: false,
    finalStep: 0,
    reviewCriterion: null,
    feedback: {
      caseId: bundle.routes[variant].feedback.caseId,
      draft: {
        decision: "",
        text: bundle.routes[variant].feedback.initial.text,
        reason: "",
        question: "",
      },
    },
    contribution: {
      problem: "",
      first: "",
      revision: "",
      reason: "",
      rights: "",
      attribution: "",
      audience: "private",
      checked: false,
    },
  };
}
export function validLearningSnapshot(
  value: unknown,
  bundle: LearningBundle,
  variant: LearningVariant,
): value is LearningSnapshot {
  if (
    !learningObject(value, [
      "lesson",
      "step",
      "lessons",
      "final",
      "finalChecked",
      "finalStep",
      "reviewCriterion",
      "feedback",
      "contribution",
    ])
  )
    return false;
  const route = bundle.routes[variant];
  if (
    !learningInteger(value.lesson) ||
    value.lesson > 6 ||
    !learningInteger(value.step) ||
    value.step > 3 ||
    !learningInteger(value.finalStep) ||
    value.finalStep > 3 ||
    typeof value.finalChecked !== "boolean" ||
    (value.reviewCriterion !== null &&
      (!learningInteger(value.reviewCriterion) ||
        value.reviewCriterion >= route.reviewCriteria))
  )
    return false;
  if (
    !Array.isArray(value.final) ||
    value.final.length !== 6 ||
    !value.final.every(writing) ||
    !Array.isArray(value.lessons) ||
    value.lessons.length !== 6
  )
    return false;
  if (
    !value.lessons.every((lesson, index) => {
      if (
        !learningObject(lesson, [
          "transfer",
          "work",
          "selfChecked",
          "selections",
          "checked",
          "reviewNeeded",
          "hint",
        ])
      )
        return false;
      const choices = route.questionChoices[index]!;
      return (
        writing(lesson.transfer) &&
        writing(lesson.work) &&
        [
          lesson.selfChecked,
          lesson.checked,
          lesson.reviewNeeded,
          lesson.hint,
        ].every((flag) => typeof flag === "boolean") &&
        Array.isArray(lesson.selections) &&
        lesson.selections.length <= choices.length &&
        lesson.selections.every(
          (choice, question) =>
            choice === null || choices[question]!.includes(choice),
        )
      );
    })
  )
    return false;
  if (
    !learningObject(value.feedback, ["caseId", "draft"]) ||
    value.feedback.caseId !== route.feedback.caseId ||
    !learningObject(value.feedback.draft, [
      "decision",
      "text",
      "reason",
      "question",
    ])
  )
    return false;
  const draft = value.feedback.draft;
  if (
    !["", "revise", "decline", "addressed"].includes(
      draft.decision as string,
    ) ||
    ![draft.text, draft.reason, draft.question].every(writing)
  )
    return false;
  const c = value.contribution;
  return (
    learningObject(c, [...contributionKeys, "audience", "checked"]) &&
    contributionKeys.every((key) => writing(c[key])) &&
    ["private", "members-later"].includes(c.audience as string) &&
    typeof c.checked === "boolean" &&
    (!c.checked ||
      (["problem", "first", "reason", "rights"].every((key) =>
        (c[key] as string).trim(),
      ) &&
        (c.audience === "private" || !!(c.attribution as string).trim())))
  );
}
export function validLearningDecision(
  value: unknown,
  bundle: LearningBundle,
  variant: LearningVariant,
  sequence: number,
  current: { id: number; text: string },
): value is LearningDecision {
  if (!learningObject(value, decisionKeys)) return false;
  const source = bundle.routes[variant].feedback;
  if (
    value.id !== sequence + 1 ||
    value.commentVersion !== source.commentVersion ||
    value.fromVersion !== current.id ||
    ![value.text, value.reason, value.question, value.proposedText].every(
      writing,
    ) ||
    !(value.reason as string).trim()
  )
    return false;
  if (value.decision === "revise")
    return (
      !!(value.text as string).trim() &&
      value.text !== current.text &&
      value.toVersion === current.id + 1 &&
      value.proposedText === value.text
    );
  return (
    ["decline", "addressed"].includes(value.decision as string) &&
    value.toVersion === current.id &&
    value.text === current.text &&
    (value.decision !== "addressed" || current.id > source.commentVersion)
  );
}
/** Stable object ordering prevents JSON property order from changing replay identity. */
export function learningDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Metadata contains no writing; JSONB never sees a learner's NUL/surrogates. */
export function splitLearningSnapshot(state: LearningSnapshot): {
  metadata: LearningSnapshot;
  fields: Array<[string, string]>;
} {
  const metadata = structuredClone(state),
    fields: Array<[string, string]> = [];
  state.lessons.forEach((lesson, index) => {
    for (const key of ["transfer", "work"] as const) {
      fields.push([`lesson.${index}.${key}`, lesson[key]]);
      metadata.lessons[index]![key] = "";
    }
  });
  state.final.forEach((text, index) => {
    fields.push([`final.${index}`, text]);
    metadata.final[index] = "";
  });
  for (const key of ["text", "reason", "question"] as const) {
    fields.push([`feedback.${key}`, state.feedback.draft[key]]);
    metadata.feedback.draft[key] = "";
  }
  for (const key of contributionKeys) {
    fields.push([`contribution.${key}`, state.contribution[key]]);
    metadata.contribution[key] = "";
  }
  return { metadata, fields };
}
export function joinLearningSnapshot(
  metadata: LearningSnapshot,
  fields: Array<[string, string]>,
): LearningSnapshot {
  const state = structuredClone(metadata),
    expected = splitLearningSnapshot(metadata).fields.map(([key]) => key);
  if (
    fields.length !== expected.length ||
    new Set(fields.map(([key]) => key)).size !== expected.length ||
    fields.some(([key]) => !expected.includes(key))
  )
    throw Error("Learning writing unavailable");
  for (const [path, value] of fields) {
    const [section, slot, key] = path.split(".");
    if (section === "lesson")
      state.lessons[Number(slot)]![key as "transfer" | "work"] = value;
    else if (section === "final") state.final[Number(slot)] = value;
    else if (section === "feedback")
      state.feedback.draft[slot as "text" | "reason" | "question"] = value;
    else state.contribution[slot as (typeof contributionKeys)[number]] = value;
  }
  return state;
}
