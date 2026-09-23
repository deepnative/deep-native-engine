import {
  BACKGROUNDS,
  GOALS,
  DOMAINS,
  IT_ROLES,
  EXPERIENCE,
  WEEKLY_TIME,
  type LearnerProfile,
} from "./content.ts";
export type Fields = Record<string, unknown>;
export type SubmissionField = "instruction" | "verification" | "checked";
export interface SubmissionError {
  field: SubmissionField | null;
  message: string;
}
function timeZone(value: unknown): string | null | undefined {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 64 || value.trim() !== value)
    return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return undefined;
  }
}
function selections(value: unknown, choices: object): string[] | null {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length > Object.keys(choices).length ||
    values.some(
      (item) => typeof item !== "string" || !Object.hasOwn(choices, item),
    ) ||
    new Set(values).size !== values.length
  )
    return null;
  return values as string[];
}
export function profile(body: Fields): LearnerProfile | null {
  const backgroundTags = selections(body.background_tags, BACKGROUNDS);
  const domainTags = selections(body.domain_tags, DOMAINS);
  const itRoles = selections(body.it_roles, IT_ROLES);
  const timezone = timeZone(body.timezone);
  const weeklyMinutes =
    body.weekly_minutes === undefined || body.weekly_minutes === ""
      ? null
      : typeof body.weekly_minutes === "string" &&
          Object.hasOwn(WEEKLY_TIME, body.weekly_minutes)
        ? Number(body.weekly_minutes)
        : undefined;
  if (
    typeof body.background !== "string" ||
    !Object.hasOwn(BACKGROUNDS, body.background) ||
    typeof body.goal !== "string" ||
    !Object.hasOwn(GOALS, body.goal) ||
    body.synthetic !== "yes" ||
    !backgroundTags ||
    !domainTags ||
    !itRoles ||
    timezone === undefined ||
    weeklyMinutes === undefined ||
    (body.experience !== undefined &&
      body.experience !== "" &&
      (typeof body.experience !== "string" ||
        !Object.hasOwn(EXPERIENCE, body.experience))) ||
    (body.exploratory !== undefined && body.exploratory !== "yes")
  )
    return null;
  return {
    background: body.background as LearnerProfile["background"],
    goal: body.goal as LearnerProfile["goal"],
    backgroundTags: backgroundTags as LearnerProfile["backgroundTags"],
    domainTags: domainTags as LearnerProfile["domainTags"],
    itRoles: itRoles as LearnerProfile["itRoles"],
    experience: (body.experience || null) as LearnerProfile["experience"],
    exploratory: body.exploratory === "yes",
    timezone,
    weeklyMinutes,
  };
}
export function submission(body: Fields) {
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";
  const verification =
    typeof body.verification === "string" ? body.verification.trim() : "";
  const complete = body.intent === "complete";
  const errors: SubmissionError[] = [];
  if (body.intent !== "draft" && !complete)
    errors.push({
      field: null,
      message: "Choose Save draft or Complete exercise.",
    });
  if (instruction.length > 2000)
    errors.push({
      field: "instruction",
      message: "Your instruction to AI: use no more than 2,000 characters.",
    });
  if (verification.length > 1000)
    errors.push({
      field: "verification",
      message:
        "How will you check the result? Use no more than 1,000 characters.",
    });
  if (complete && instruction.length < 20)
    errors.push({
      field: "instruction",
      message:
        "Your instruction to AI: write at least 20 characters to complete.",
    });
  if (complete && verification.length < 20)
    errors.push({
      field: "verification",
      message:
        "How will you check the result? Write at least 20 characters to complete.",
    });
  if (complete && body.checked !== "yes")
    errors.push({
      field: "checked",
      message:
        "Confirm that you checked your instruction and used only sample information.",
    });
  return { instruction, verification, complete, errors };
}
