import { createHash } from "node:crypto";

export const SAMPLE_FEEDBACK_PURPOSE = "private_sample_feedback_v1";
export const SAMPLE_FEEDBACK_PAGE_SIZE = 20;
export interface SampleCriterion {
  label: string;
  comment: string;
  start: number;
  end: number;
  quote: string;
}
export interface SampleDraftInput {
  revision: number;
  operationId: string;
  criteria: SampleCriterion[];
  preparationMinutes: number | null;
  reviewMinutes: number | null;
}
export const sampleUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const sampleToken = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function sampleText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    }) &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const minutes = (value: unknown) =>
  value === null ||
  (typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 480);
function boundary(source: string, offset: number) {
  // A reference may not split a UTF-16 surrogate pair. Offsets are explicitly
  // UTF-16 code units, matching browser selectionStart/selectionEnd semantics.
  return (
    offset === 0 ||
    offset === source.length ||
    !(
      source.charCodeAt(offset - 1) >= 0xd800 &&
      source.charCodeAt(offset - 1) <= 0xdbff &&
      source.charCodeAt(offset) >= 0xdc00 &&
      source.charCodeAt(offset) <= 0xdfff
    )
  );
}
export function sampleDraftValid(
  value: unknown,
  source: string,
): value is SampleDraftInput {
  if (
    !exact(value, [
      "revision",
      "operationId",
      "criteria",
      "preparationMinutes",
      "reviewMinutes",
    ]) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) >= 2147483647 ||
    !sampleUuid(value.operationId) ||
    !minutes(value.preparationMinutes) ||
    !minutes(value.reviewMinutes) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length < 1 ||
    value.criteria.length > 5
  )
    return false;
  return value.criteria.every(
    (item) =>
      exact(item, ["label", "comment", "start", "end", "quote"]) &&
      sampleText(item.label, 100) &&
      sampleText(item.comment, 1000) &&
      sampleText(item.quote, 1000) &&
      Number.isSafeInteger(item.start) &&
      Number.isSafeInteger(item.end) &&
      (item.start as number) >= 0 &&
      (item.end as number) > (item.start as number) &&
      (item.end as number) <= source.length &&
      boundary(source, item.start as number) &&
      boundary(source, item.end as number) &&
      source.slice(item.start as number, item.end as number) === item.quote,
  );
}
export function sampleDraftDigest(value: SampleDraftInput) {
  // Canonical field order means JSON key order cannot turn a replay into a
  // different request; revision is part of the submitted optimistic contract.
  return createHash("sha256")
    .update(
      JSON.stringify({
        revision: value.revision,
        criteria: value.criteria.map(
          ({ label, comment, start, end, quote }) => ({
            label,
            comment,
            start,
            end,
            quote,
          }),
        ),
        preparationMinutes: value.preparationMinutes,
        reviewMinutes: value.reviewMinutes,
      }),
    )
    .digest("hex");
}
