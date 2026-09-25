import { LESSON } from "./content.ts";
import type { AssignmentAttempt } from "./attempts.ts";
import type { Exercise, LessonActivity } from "./store.ts";

export interface ActivityItem {
  kind: "starter exercise" | "sample lesson" | "assignment attempt";
  title: string;
  version: number;
  state: string;
  availability: string;
  href: string | null;
}

export function activityItems(
  exercise: Exercise | undefined,
  lessons: LessonActivity[],
  attempts: AssignmentAttempt[],
): ActivityItem[] {
  const items: ActivityItem[] = [];
  if (exercise) {
    items.push({
      kind: "starter exercise",
      title: LESSON.title,
      version: LESSON.version,
      state: exercise.completed_at ? "Self-reported complete" : "Draft saved",
      availability: "Local foundation preview; no qualified review",
      href: "/lesson",
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
    });
  }
  for (const attempt of attempts) {
    items.push({
      kind: "assignment attempt",
      title: attempt.title,
      version: attempt.contentVersion,
      state: attempt.submittedAt
        ? "Submitted locally; no qualified review"
        : attempt.savedAt
          ? "Draft saved"
          : "Started",
      availability: !attempt.currentPublished
        ? "Historical assignment version unavailable for new work"
        : attempt.currentEligible
          ? "Current published sample"
          : "Not eligible for your current direction; history retained",
      href: `/assignments/attempts/${encodeURIComponent(attempt.id)}`,
    });
  }
  return items;
}
