import { BACKGROUNDS, GOALS, type Background, type Goal } from "./content.ts";
export type Fields = Record<string, unknown>;
export function profile(
  body: Fields,
): { background: Background; goal: Goal } | null {
  if (
    typeof body.background !== "string" ||
    !Object.hasOwn(BACKGROUNDS, body.background) ||
    typeof body.goal !== "string" ||
    !Object.hasOwn(GOALS, body.goal) ||
    body.synthetic !== "yes"
  )
    return null;
  return { background: body.background as Background, goal: body.goal as Goal };
}
export function submission(body: Fields) {
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";
  const verification =
    typeof body.verification === "string" ? body.verification.trim() : "";
  const complete = body.intent === "complete";
  const errors: string[] = [];
  if (body.intent !== "draft" && !complete)
    errors.push("Choose Save draft or Complete exercise.");
  if (instruction.length > 2000 || verification.length > 1000)
    errors.push(
      "Keep your instruction within 2,000 characters and your check within 1,000.",
    );
  if (complete && (instruction.length < 20 || verification.length < 20))
    errors.push(
      "Write at least 20 characters in each answer before completing the exercise.",
    );
  if (complete && body.checked !== "yes")
    errors.push(
      "Confirm that you checked your instruction and used only sample information.",
    );
  return { instruction, verification, complete, errors };
}
