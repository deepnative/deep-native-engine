import type { Fields } from "./validation.ts";

export interface MilestoneInput {
  goalTitle: string;
  milestoneTitle: string;
  evidenceNote: string;
  nextAction: string;
  reminderDate: string | null;
  reminderTime: string | null;
  reminderTimezone: string | null;
  selfReportedComplete: boolean;
}

const field = (fields: Fields, name: string) =>
  typeof fields[name] === "string" ? fields[name].trim() : "";

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    year! >= 2020 &&
    year! <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function parseMilestone(
  fields: Fields,
  timezone: string | null | undefined,
): { input: MilestoneInput; errors: string[] } {
  const goalTitle = field(fields, "goal_title");
  const milestoneTitle = field(fields, "milestone_title");
  const evidenceNote = field(fields, "evidence_note");
  const nextAction = field(fields, "next_action");
  const date = field(fields, "reminder_date");
  const time = field(fields, "reminder_time");
  const errors: string[] = [];
  if (goalTitle.length < 3 || goalTitle.length > 160)
    errors.push("Write a goal between 3 and 160 characters.");
  if (milestoneTitle.length < 3 || milestoneTitle.length > 160)
    errors.push("Write a milestone between 3 and 160 characters.");
  if (evidenceNote.length > 1000)
    errors.push("Keep the evidence note within 1,000 characters.");
  if (nextAction.length < 3 || nextAction.length > 500)
    errors.push("Write a next action between 3 and 500 characters.");
  if (fields.sample_only !== "yes")
    errors.push("Confirm that you used only invented or sample information.");
  if (fields.complete !== undefined && fields.complete !== "yes")
    errors.push("Choose a valid completion state.");
  if (fields.complete === "yes" && evidenceNote.length < 20)
    errors.push(
      "Add an evidence note of at least 20 characters before marking a milestone complete.",
    );
  if (date || time) {
    if (!calendarDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      errors.push("Choose a valid local reminder date and time together.");
    if (!timezone)
      errors.push(
        "Set your time zone in your learning direction before adding a local reminder.",
      );
  }
  return {
    input: {
      goalTitle,
      milestoneTitle,
      evidenceNote,
      nextAction,
      reminderDate: date || null,
      reminderTime: time || null,
      reminderTimezone: date && time ? (timezone ?? null) : null,
      selfReportedComplete: fields.complete === "yes",
    },
    errors,
  };
}

export function validMilestoneId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}
