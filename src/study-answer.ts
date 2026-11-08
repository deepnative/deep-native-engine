// #202 (CTP-015): a study answer may only quote the exact lesson version the
// member opened. The deterministic matcher below needs no provider; a future
// provider's output must pass the same validator before a member sees it.
export const STUDY_ANSWER_CONTRACT = "study-answer-v1";
export const STUDY_QUESTION_MAX = 300;
export const STUDY_EXCERPT_COUNT = 3;
export const STUDY_EXCERPT_LENGTH = 400;

export interface StudySource {
  id: string;
  version: number;
  body: string;
}
export interface StudyAnswer {
  contract: typeof STUDY_ANSWER_CONTRACT;
  sourceId: string;
  version: number;
  status: "cited" | "insufficient";
  excerpts: string[];
}

// Common words say nothing about what a question is after.
const COMMON = new Set(
  "about after also and any are before but can could did does doing for from had has have how into its just like may might more most not now off one only other our out over should some such than that the their them then there these they this those too use used using very was way were what when where which while who why will with would you your".split(
    " ",
  ),
);
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !COMMON.has(word)),
  );
}
function passages(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((text) => text.trim())
    .filter((text) => text && text.length <= STUDY_EXCERPT_LENGTH);
}

// Quotes up to three whole sentences that share words with the question, in
// lesson order. With no shared words it says so instead of guessing. The
// question is only compared as words; nothing in it is followed.
export function answerStudyQuestion(
  source: StudySource,
  question: string,
): StudyAnswer {
  const wanted = terms(question);
  const excerpts = passages(source.body)
    .map((text, index) => ({
      text,
      index,
      score: [...terms(text)].filter((word) => wanted.has(word)).length,
    }))
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, STUDY_EXCERPT_COUNT)
    .sort((a, b) => a.index - b.index)
    .map((passage) => passage.text);
  return {
    contract: STUDY_ANSWER_CONTRACT,
    sourceId: source.id,
    version: source.version,
    status: excerpts.length ? "cited" : "insufficient",
    excerpts,
  };
}

const FIELDS = "contract,excerpts,sourceId,status,version";
function own(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// Answer output is untrusted. It is accepted only in the exact bounded shape,
// for the exact source and version, quoting text that is really in that
// version. Anything else is refused rather than repaired.
export function validateStudyAnswer(
  value: unknown,
  source: StudySource,
): StudyAnswer | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join() !== FIELDS
    )
      return null;
    const status = own(value, "status"),
      excerpts = own(value, "excerpts");
    if (
      own(value, "contract") !== STUDY_ANSWER_CONTRACT ||
      own(value, "sourceId") !== source.id ||
      own(value, "version") !== source.version ||
      !Array.isArray(excerpts) ||
      excerpts.length > STUDY_EXCERPT_COUNT ||
      (status === "cited"
        ? excerpts.length === 0
        : status !== "insufficient") ||
      (status === "insufficient" && excerpts.length > 0)
    )
      return null;
    const quoted: string[] = [];
    for (let index = 0; index < excerpts.length; index++) {
      const text: unknown = own(excerpts, String(index));
      if (
        typeof text !== "string" ||
        text.trim() !== text ||
        !text ||
        text.length > STUDY_EXCERPT_LENGTH ||
        !source.body.includes(text)
      )
        return null;
      quoted.push(text);
    }
    return {
      contract: STUDY_ANSWER_CONTRACT,
      sourceId: source.id,
      version: source.version,
      status: status as StudyAnswer["status"],
      excerpts: quoted,
    };
  } catch {
    return null;
  }
}
