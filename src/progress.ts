import { LESSON, GOALS } from "./content.ts";
import type { AssignmentAttemptListItem } from "./attempts.ts";
import type { Exercise, ExerciseHistory, LessonActivity } from "./store.ts";

export interface ActivityItem {
  kind: "starter exercise" | "sample lesson" | "assignment attempt";
  title: string;
  version: number;
  state: string;
  availability: string;
  href: string | null;
  contentId?: string;
  reportable?: boolean;
  submittedAt?: string;
}

export function activityItems(
  exercise: Exercise | undefined,
  lessons: LessonActivity[],
  attempts: AssignmentAttemptListItem[],
  starterHistory: ExerciseHistory[] = [],
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const starters = starterHistory.length
    ? starterHistory
    : exercise
      ? [
          {
            lessonId: LESSON.id,
            version: LESSON.version,
            instruction: exercise.instruction,
            verification: exercise.verification,
            completedAt: exercise.completed_at,
            withdrawnAt: exercise.withdrawn_at ?? null,
            goalAtStart: exercise.goal_at_start ?? null,
          },
        ]
      : [];
  for (const row of starters) {
    if (row.lessonId !== LESSON.id) continue;
    const goal = row.goalAtStart ?? "unattributed";
    items.push({
      kind: "starter exercise",
      title: LESSON.title,
      version: row.version,
      state: row.completedAt
        ? row.withdrawnAt
          ? "Self-reported complete; text withdrawn"
          : "Self-reported complete"
        : "Draft saved",
      availability: `Recorded goal: ${row.goalAtStart ? GOALS[row.goalAtStart] : "Unattributed historical goal"}. Local foundation preview; no qualified review`,
      href: `/lesson?version=${row.version}&goal=${goal}#starter-version-${row.version}-${goal}`,
    });
  }
  for (const lesson of lessons) {
    items.push({
      kind: "sample lesson",
      title: lesson.title ?? lesson.contentId,
      version: lesson.contentVersion,
      state: lesson.selfAssessedAt
        ? "Self-reported complete"
        : lesson.startedAt
          ? "Started"
          : "Opened in reader",
      availability: lesson.available
        ? "Current published sample; no qualified review"
        : "Historical version unavailable; activity retained",
      href: lesson.available
        ? `/library/${encodeURIComponent(lesson.contentId)}`
        : null,
      contentId: lesson.contentId,
      reportable: lesson.reportable ?? false,
    });
  }
  for (const attempt of attempts) {
    const availability = !attempt.currentPublished
      ? "Historical assignment version unavailable for new work"
      : attempt.currentEligible
        ? "Current published sample"
        : "Not eligible for your current direction; history retained";
    for (const submission of attempt.submissionHistory ?? []) {
      items.push({
        kind: "assignment attempt",
        title: attempt.title,
        version: attempt.contentVersion,
        state: `Submission ${submission.sequence} · submitted locally; no qualified review`,
        availability,
        href: `/assignments/attempts/${encodeURIComponent(attempt.id)}?version=${attempt.contentVersion}&submission=${submission.sequence}#submission-${submission.sequence}`,
        submittedAt: submission.submittedAt,
      });
    }
    if (attempt.submittedAt && attempt.submissionHistory?.length) continue;
    items.push({
      kind: "assignment attempt",
      title: attempt.title,
      version: attempt.contentVersion,
      state: attempt.submittedAt
        ? "Submitted locally; no qualified review"
        : attempt.submissionHistory?.length
          ? attempt.savedAt
            ? "Current revision draft saved"
            : "Current revision started"
          : attempt.savedAt
            ? "Draft saved"
            : "Started",
      availability,
      href: `/assignments/attempts/${encodeURIComponent(attempt.id)}`,
    });
  }
  return items;
}
