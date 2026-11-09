import { createHash } from "node:crypto";
import { aiInputTokens } from "./ai-budget-policy.ts";
import { interviewNotice } from "./practice-session-purpose.ts";

// #200 PRACTICE-AI: one optional simulated AI suggestion per saved practice
// pair, from the local deterministic test provider only. Nothing here calls
// a live provider, spends, scores or reviews.
export const PRACTICE_SUGGESTION_OPERATION = "practice-suggestion-local-v1";
export const PRACTICE_SUGGESTION_PROMPT = "practice-suggestion-v1";
export const PRACTICE_SUGGESTION_MODEL = "deterministic-local-v1";
export const PRACTICE_SUGGESTION_LABEL =
  "Simulated AI suggestion, not reviewed by a person.";
const MAX_TEXT = 1200;
const MAX_QUOTE = 160;
const MIN_QUOTE = 12;

export interface PracticeSuggestionInput {
  response: string;
  contentId: string;
  contentVersion: number;
  sourceExcerpt: string;
  interview: boolean;
}
export interface PracticeSuggestion {
  text: string;
  reference: string;
}
/** Output is untrusted: only validatePracticeSuggestion may read it. */
export interface PracticeSuggestionProvider {
  suggest(input: PracticeSuggestionInput): Promise<unknown>;
}

function citation(input: PracticeSuggestionInput) {
  return `${input.contentId} v${input.contentVersion}`;
}

// The quote is the start of the member's own words, up to the first line
// break, so it is always an exact part of what they saved.
function quoteOf(response: string) {
  const firstLine = response.trim().split(/\r?\n/, 1)[0]!.trim();
  return Array.from(firstLine).slice(0, MAX_QUOTE).join("").trim();
}

export function deterministicPracticeSuggestionProvider(
  mode: "demo" | "test",
): PracticeSuggestionProvider {
  return {
    async suggest(input) {
      const text =
        `${PRACTICE_SUGGESTION_LABEL} You wrote: “${quoteOf(input.response)}”. ` +
        `Compare that with ${citation(input)}: find one detail in the source that supports your words, and one you still need to check. ` +
        "This suggestion is uncertain and may be wrong. It gives no score and is not an assessment." +
        (input.interview ? ` ${interviewNotice}` : "");
      const reference = createHash("sha256")
        .update(JSON.stringify([mode, PRACTICE_SUGGESTION_PROMPT, input, text]))
        .digest("hex")
        .slice(0, 24);
      // Simulated usage at the published test rates (#188): the member's
      // words and source excerpt in, the suggestion out.
      return {
        text,
        reference: `${mode}_${reference}`,
        usage: {
          inputTokens: aiInputTokens(
            Buffer.byteLength(input.response) +
              Buffer.byteLength(input.sourceExcerpt),
          ),
          outputTokens: aiInputTokens(Buffer.byteLength(text)),
        },
      };
    },
  };
}

const field = (value: object, name: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

// PRACTICE-AI-02: a suggestion is kept only when it is grounded in the
// member's exact words and the exact pinned source version, says it is a
// simulated unreviewed suggestion, marks its uncertainty and carries no score.
// Anything else is rejected whole; nothing is repaired or partly shown.
export function validatePracticeSuggestion(
  value: unknown,
  input: PracticeSuggestionInput,
): PracticeSuggestion | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const text = field(value, "text");
    const reference = field(value, "reference");
    if (
      typeof reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference) ||
      typeof text !== "string" ||
      text.length < 1 ||
      text.length > MAX_TEXT ||
      text.trim() !== text ||
      /\p{C}/u.test(text) ||
      !text.startsWith(PRACTICE_SUGGESTION_LABEL)
    )
      return null;
    const quotes = [...text.matchAll(/“([^“”]*)”/g)];
    if (quotes.length !== 1 || /[“”]/.test(text.replace(quotes[0]![0], "")))
      return null;
    const quote = quotes[0]![1]!;
    if (
      !quote ||
      quote.trim() !== quote ||
      Array.from(quote).length <
        Math.min(MIN_QUOTE, Array.from(quoteOf(input.response)).length) ||
      !input.response.includes(quote)
    )
      return null;
    // Everything outside the member's own words is checked as provider text.
    const own = text.replace(quotes[0]![0], "“”");
    const cited = citation(input);
    const citations = own.match(/\b[A-Z]{2,5}-[0-9]{3} v[0-9]+\b/g) ?? [];
    if (!citations.length || citations.some((item) => item !== cited))
      return null;
    const rest = own.split(cited).join("");
    if (
      /[0-9%<>]|https?:|www\./i.test(rest) ||
      !/\buncertain\b/i.test(rest) ||
      !rest.includes("It gives no score and is not an assessment.") ||
      /\b(excellent|competent|incompetent|hireable|hired|qualified|passed|failed|grade[ds]?|rating|rated)\b/i.test(
        rest,
      ) ||
      (input.interview && !rest.includes(interviewNotice))
    )
      return null;
    return { text, reference };
  } catch {
    return null;
  }
}
