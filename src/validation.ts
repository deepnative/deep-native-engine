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
export type ProfileField =
  | "background"
  | "goal"
  | "background_tags"
  | "domain_tags"
  | "it_roles"
  | "experience"
  | "timezone"
  | "weekly_minutes"
  | "exploratory";
export interface ProfileError {
  field: ProfileField;
  message: string;
}
export interface ProfileFormState {
  background: string;
  goal: string;
  backgroundTags: string[];
  domainTags: string[];
  itRoles: string[];
  experience: string;
  timezone: string;
  weeklyMinutes: string;
  exploratory: boolean;
}
export interface ProfileEditResult {
  input: LearnerProfile | null;
  attempted: ProfileFormState;
  errors: ProfileError[];
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
function safeChoice(value: unknown, choices: object): string {
  return typeof value === "string" && Object.hasOwn(choices, value)
    ? value
    : "";
}
function safeSelections(value: unknown, choices: object): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((item) => safeChoice(item, choices)))];
}
function parseProfile(body: Fields): ProfileEditResult {
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
  const errors: ProfileError[] = [];
  if (!safeChoice(body.background, BACKGROUNDS))
    errors.push({
      field: "background",
      message: "Your starting point: choose one of the listed options.",
    });
  if (!safeChoice(body.goal, GOALS))
    errors.push({
      field: "goal",
      message: "What would you like to do? Choose one of the listed options.",
    });
  if (!backgroundTags)
    errors.push({
      field: "background_tags",
      message: "Other starting points: choose each listed option only once.",
    });
  if (!domainTags)
    errors.push({
      field: "domain_tags",
      message: "Domains of interest: choose each listed option only once.",
    });
  if (!itRoles)
    errors.push({
      field: "it_roles",
      message: "IT specialties: choose each listed option only once.",
    });
  if (
    body.experience !== undefined &&
    body.experience !== "" &&
    !safeChoice(body.experience, EXPERIENCE)
  )
    errors.push({
      field: "experience",
      message: "Experience with AI: choose one of the listed options.",
    });
  if (timezone === undefined)
    errors.push({
      field: "timezone",
      message:
        "Time zone: enter a valid location-style time zone, or leave it blank.",
    });
  if (weeklyMinutes === undefined)
    errors.push({
      field: "weekly_minutes",
      message: "Weekly time available: choose one of the listed options.",
    });
  if (body.exploratory !== undefined && body.exploratory !== "yes")
    errors.push({
      field: "exploratory",
      message: "Exploratory path: use the listed checkbox only.",
    });
  const attempted: ProfileFormState = {
    background: safeChoice(body.background, BACKGROUNDS),
    goal: safeChoice(body.goal, GOALS),
    backgroundTags: safeSelections(body.background_tags, BACKGROUNDS),
    domainTags: safeSelections(body.domain_tags, DOMAINS),
    itRoles: safeSelections(body.it_roles, IT_ROLES),
    experience: safeChoice(body.experience, EXPERIENCE),
    timezone:
      typeof body.timezone === "string" && body.timezone.length <= 64
        ? body.timezone
        : "",
    weeklyMinutes: safeChoice(body.weekly_minutes, WEEKLY_TIME),
    exploratory: body.exploratory === "yes",
  };
  const input: LearnerProfile | null = errors.length
    ? null
    : {
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
  return { input, attempted, errors };
}
export function profile(body: Fields): LearnerProfile | null {
  return body.synthetic === "yes" ? parseProfile(body).input : null;
}
export function profileEdit(body: Fields): ProfileEditResult {
  return parseProfile(body);
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
