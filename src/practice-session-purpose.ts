// Practice session purposes are identified by their immutable prompt version.
// Interview practice is optional: only a member's own start chooses it.
export const interviewPromptVersion = "interview-practice-v1";
export const interviewNotice =
  "This interview practice doesn't predict hiring, interview results or competence.";
export function isInterviewPractice(promptVersion: string): boolean {
  return promptVersion === interviewPromptVersion;
}
export function practicePurposeLabel(promptVersion: string): string {
  return isInterviewPractice(promptVersion)
    ? "Optional interview practice"
    : "Lesson practice";
}
