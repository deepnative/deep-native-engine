import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DraftContent } from "./catalog.ts";
import {
  LEARNING_VARIANTS,
  type LearningBundle,
  type LearningIdentity,
  type LearningVariant,
} from "./learning-workspace-values.ts";

export const LEARNING_WORKSPACE_CONTENT = {
  id: "LRN-001",
  version: 1,
  contentHash:
    "5f8099258b1c5399d7ffc8cf29ebbfa63421fa04d04043a0f6b3d064cbe7925f",
  fileHash: "6f3326c2532166ba14fead1193617ccbd22c1c6270a41657948a1ac87974d131",
} as const;

interface Course {
  version: number;
  contentHash: string;
  sources: Array<{ path: string; sha256: string }>;
  lessons: Array<{
    title: string;
    routes: Record<
      LearningVariant,
      { practice: { questions: Array<{ choices: Array<{ key: string }> }> } }
    >;
  }>;
  feedbackCases: Record<
    LearningVariant,
    {
      id: string;
      commentVersion: number;
      versions: Array<{ id: number; text: string }>;
    }
  >;
  reviewGuidance: { routes: Record<LearningVariant, { rows: unknown[] }> };
}

export interface LearningWorkspacePack extends LearningBundle {
  course: Course;
  module: string;
}

/** Immutable authored bytes, not an editorial approval or runtime publication. */
export async function learningWorkspacePack(): Promise<LearningWorkspacePack> {
  let bytes: Buffer;
  try {
    bytes = await readFile(
      new URL(
        "../assets/docs/content/learning-workspace/v1/course.json",
        import.meta.url,
      ),
    );
  } catch {
    throw new Error("Learning workspace content unavailable");
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    LEARNING_WORKSPACE_CONTENT.fileHash
  )
    throw new Error("Learning workspace content unavailable");
  // The exact reviewed source shape is pinned above before parsing. A changed
  // source/shape needs a new registry entry, never a permissive runtime fallback.
  const course = JSON.parse(bytes.toString("utf8")) as Course;
  const publication: DraftContent = {
    id: LEARNING_WORKSPACE_CONTENT.id,
    version: LEARNING_WORKSPACE_CONTENT.version,
    kind: "lesson",
    origin: "curated",
    title: "AI foundations: learn, practise and apply",
    body: [
      "Six source-grounded lessons, with Everyday, Work and Technical examples.",
      ...course.lessons.map((lesson, index) => `${index + 1}. ${lesson.title}`),
      "Apply the skills to the book-swap, work-handover or upload-investigation case. Keep private drafts, practise responding to supplied feedback and shape a contribution.",
      "The full instructional bundle includes each source, choice, explanation, fresh case and capstone. Review the complete bundle before approving publication; this overview alone is insufficient.",
      "Checked practice and learner self-checks are not formal assessment, grades or credentials. Feedback is authored practice guidance, not a live AI response or independent review. Saving neither submits an assignment nor shares a contribution.",
      "This is a separate instructional version. It does not replace FND v2 lessons, satisfy ASN assignment prerequisites or reinterpret earlier saved responses.",
    ].join("\n\n"),
    owner: "Deep Native learning content",
    sources: `Repository-authored learning drafts; 12 source files and digests in the complete bundle. Instructional manifest ${course.contentHash}; bundle SHA-256 ${LEARNING_WORKSPACE_CONTENT.fileHash}.`,
    rights:
      "Repository-authored teaching examples and invented cases. The complete bundle is subject to the ordinary editorial rights confirmation before publication.",
    goals: ["everyday", "work", "build"],
    backgrounds: ["explorer", "professional", "technical"],
    domains: [],
    prerequisites: "",
    structuredPrerequisites: { schemaVersion: 1, all: [] },
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  const routes = Object.fromEntries(
    LEARNING_VARIANTS.map((variant) => {
      const feedback = course.feedbackCases[variant];
      return [
        variant,
        {
          questionChoices: course.lessons.map((lesson) =>
            lesson.routes[variant].practice.questions.map((question) =>
              question.choices.map((choice) => choice.key),
            ),
          ),
          reviewCriteria: course.reviewGuidance.routes[variant].rows.length,
          feedback: {
            caseId: feedback.id,
            commentVersion: feedback.commentVersion,
            initial: feedback.versions.at(-1)!,
          },
        },
      ];
    }),
  ) as LearningBundle["routes"];
  return {
    publication,
    contentHash: course.contentHash,
    routes,
    course,
    module: `export const course = ${JSON.stringify(course)};\n`,
  };
}

export async function resolveLearningWorkspaceBundle(
  identity: LearningIdentity,
): Promise<LearningWorkspacePack | null> {
  if (
    identity.contentId !== LEARNING_WORKSPACE_CONTENT.id ||
    identity.contentVersion !== LEARNING_WORKSPACE_CONTENT.version ||
    identity.contentHash !== LEARNING_WORKSPACE_CONTENT.contentHash ||
    !LEARNING_VARIANTS.includes(identity.variant)
  )
    return null;
  return learningWorkspacePack();
}
