import { sampleUuid } from "./sample-feedback-values.ts";
import { sampleAssignmentUtc } from "./sample-assignment-values.ts";
import type {
  SampleAssignmentInput,
  SampleAssignmentReferences,
  SampleAssignmentSource,
} from "./sample-assignment-values.ts";

function fields(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function revision(value: unknown): number | null {
  const number =
    typeof value === "string" && /^(?:[1-9]|1[0-9]|20)$/.test(value)
      ? Number(value)
      : value;
  return typeof number === "number" &&
    Number.isInteger(number) &&
    number >= 1 &&
    number <= 20
    ? number
    : null;
}
export function sampleAssignmentSource(
  value: unknown,
): SampleAssignmentSource | null {
  if (
    !fields(value, ["evidenceId", "sourceRevision"]) ||
    !sampleUuid(value.evidenceId)
  )
    return null;
  const sourceRevision = revision(value.sourceRevision);
  return sourceRevision === null
    ? null
    : { evidenceId: value.evidenceId.toLowerCase(), sourceRevision };
}
export function sampleAssignmentReferences(
  value: unknown,
): SampleAssignmentReferences | null {
  if (
    !fields(value, ["evidenceId", "sourceRevision", "reviewerId"]) ||
    !sampleUuid(value.reviewerId)
  )
    return null;
  const source = sampleAssignmentSource({
    evidenceId: value.evidenceId,
    sourceRevision: value.sourceRevision,
  });
  return source
    ? { ...source, reviewerId: value.reviewerId.toLowerCase() }
    : null;
}
export function sampleAssignmentInput(
  value: unknown,
): SampleAssignmentInput | null {
  if (
    !fields(value, [
      "evidenceId",
      "sourceRevision",
      "reviewerId",
      "operationId",
      "startsAt",
      "expiresAt",
    ]) ||
    !sampleUuid(value.operationId) ||
    !sampleAssignmentUtc(value.startsAt) ||
    !sampleAssignmentUtc(value.expiresAt) ||
    value.startsAt >= value.expiresAt
  )
    return null;
  const references = sampleAssignmentReferences({
    evidenceId: value.evidenceId,
    sourceRevision: value.sourceRevision,
    reviewerId: value.reviewerId,
  });
  return references
    ? {
        ...references,
        operationId: value.operationId.toLowerCase(),
        startsAt: value.startsAt,
        expiresAt: value.expiresAt,
      }
    : null;
}
