import {
  type LearningBundle,
  type LearningIdentity,
} from "../../src/learning-workspace-values.ts";
export const bundleFixture: LearningBundle = {
  publication: {
    id: "LRN-001",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented learning bundle",
    body: "Six invented lessons and practice cases.",
    owner: "Synthetic editor",
    sources: "Original invented cases",
    rights: "Original instructional work",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "",
    rubric: null,
    rubricVersion: null,
  },
  contentHash: "a".repeat(64),
  routes: Object.fromEntries(
    ["everyday", "work", "technical"].map((variant) => [
      variant,
      {
        questionChoices: Array.from({ length: 6 }, () => [
          ["a", "b"],
          ["yes", "no"],
        ]),
        reviewCriteria: 6,
        feedback: {
          caseId: `case-${variant}`,
          commentVersion: 1,
          initial: {
            id: variant === "work" ? 2 : 1,
            text: `Invented ${variant} artifact`,
          },
        },
      },
    ]),
  ) as LearningBundle["routes"],
};
export const identityFixture: LearningIdentity = {
  contentId: "LRN-001",
  contentVersion: 1,
  contentHash: bundleFixture.contentHash,
  variant: "everyday",
};
