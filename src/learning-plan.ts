import { LESSON, exercise, type Experience, type Goal } from "./content.ts";

export interface PlanStep {
  minutes: number;
  action: string;
}

export function learningPlan(profile: {
  goal: Goal;
  experience?: Experience | null;
  exploratory?: boolean;
  weeklyMinutes?: number | null;
}) {
  const focus = exercise(profile.goal).title;
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
    steps,
    nextSession:
      profile.weeklyMinutes == null
        ? "Choose weekly time below to see a practice rhythm that fits your availability."
        : profile.weeklyMinutes < 30
          ? `Next session: try the sample exercise: ${focus}.`
          : null,
    exploratory: profile.exploratory
      ? "You can explore another direction later without losing this practice."
      : null,
  };
}
