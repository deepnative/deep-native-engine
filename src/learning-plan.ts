import { LESSON, exercise, type Experience, type Goal } from "./content.ts";
import type { Exercise } from "./store.ts";

export interface PlanStep {
  minutes: number;
  action: string;
}

export function learningPlan(
  profile: {
    goal: Goal;
    experience?: Experience | null;
    exploratory?: boolean;
    weeklyMinutes?: number | null;
  },
  progress?: Pick<Exercise, "completed_at" | "goal_at_start" | "withdrawn_at">,
) {
  const focus = exercise(profile.goal).title;
  const completed = Boolean(progress?.completed_at);
  const withdrawn = completed && Boolean(progress?.withdrawn_at);
  const currentGoalCompleted =
    completed && progress?.goal_at_start === profile.goal;
  const guidance =
    profile.experience === "experienced"
      ? "Experienced with AI? Use this sample to test assumptions and improve your checks. No coding is required."
      : profile.experience === "some"
        ? "Use a familiar task, then compare each AI suggestion with the sample details."
        : "New or just starting? Follow the plain-language example and use only sample details.";
  const steps: PlanStep[] = [
    { minutes: LESSON.minutes, action: `Read ${LESSON.title}.` },
  ];
  if ((profile.weeklyMinutes ?? 0) >= 30)
    steps.push({ minutes: 15, action: `Try the sample exercise: ${focus}.` });
  if ((profile.weeklyMinutes ?? 0) >= 60)
    steps.push({
      minutes: 10,
      action: "Check your answer against the sample and note one improvement.",
    });
  return {
    focus,
    guidance,
    steps: completed ? [] : steps,
    status: completed
      ? currentGoalCompleted
        ? withdrawn
          ? "Starter exercise completed for your current goal · self-assessed; saved answers withdrawn."
          : "Starter exercise completed for your current goal · self-assessed."
        : progress?.goal_at_start
          ? `Starter exercise completed for an earlier goal · self-assessed${withdrawn ? "; saved answers withdrawn" : ""}. It does not count as practice for your current goal.`
          : `Starter exercise completed with no recorded goal · self-assessed${withdrawn ? "; saved answers withdrawn" : ""}. It does not count as practice for your current goal.`
      : null,
    nextSession: completed
      ? currentGoalCompleted
        ? withdrawn
          ? "Next session: browse published sample lessons. Your withdrawn answers are no longer available."
          : "Next session: review your saved starter exercise and its checks."
        : "Next session: browse published sample lessons for your current direction."
      : profile.weeklyMinutes == null
        ? "Choose weekly time below to see a practice rhythm that fits your availability."
        : profile.weeklyMinutes < 30
          ? `Next session: try the sample exercise: ${focus}.`
          : null,
    nextHref: completed
      ? currentGoalCompleted && !withdrawn
        ? "/lesson"
        : "/library"
      : null,
    nextLinkLabel: completed
      ? currentGoalCompleted && !withdrawn
        ? "Review saved starter exercise"
        : "Browse published sample library"
      : null,
    exploratory: profile.exploratory
      ? "You can explore another direction later without losing this practice."
      : null,
  };
}
