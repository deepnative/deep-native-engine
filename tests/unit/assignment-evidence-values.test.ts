import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  assignmentEvidenceInstruction,
  assignmentPayloadDigest,
  assignmentEvidenceName,
  assignmentSequence,
} from "../../src/assignment-evidence-values.ts";
const valid = () => ({
  operationId: randomUUID(),
  attemptId: randomUUID(),
  sequence: 1,
  contentId: "SYN-545",
  contentVersion: 1,
  rubricVersion: 4,
  sourceSha256: "a".repeat(64),
  privateReview: true as const,
});
it("AHO-01/02 accepts only a deliberate exact submitted identity and private purpose, with no replacement response field", () => {
  const input = valid();
  expect(assignmentEvidenceInstruction(input)).toEqual(input);
  expect(
    assignmentEvidenceInstruction({
      ...input,
      operationId: input.operationId.toUpperCase(),
      attemptId: input.attemptId.toUpperCase(),
    }),
  ).toEqual(input);
  for (const value of [
    null,
    undefined,
    false,
    [],
    {},
    { ...input, response: "substitute" },
    { ...input, operationId: "bad" },
    { ...input, attemptId: "bad" },
    { ...input, sequence: "1" },
    { ...input, sequence: 0 },
    { ...input, sequence: 11 },
    { ...input, sequence: 1.5 },
    { ...input, contentId: 1 },
    { ...input, contentId: "../private" },
    { ...input, contentVersion: "1" },
    { ...input, contentVersion: 0 },
    { ...input, contentVersion: 2147483648 },
    { ...input, rubricVersion: "1" },
    { ...input, rubricVersion: 0 },
    { ...input, rubricVersion: 2147483648 },
    { ...input, sourceSha256: 1 },
    { ...input, sourceSha256: "bad" },
    { ...input, privateReview: false },
  ])
    expect(assignmentEvidenceInstruction(value)).toBeNull();
  const inherited = Object.create(input) as Record<string, unknown>;
  inherited.untrusted = true;
  expect(assignmentEvidenceInstruction(inherited)).toBeNull();
  const wrongNames = { ...input } as Record<string, unknown>;
  delete wrongNames.sequence;
  wrongNames.extra = 1;
  expect(assignmentEvidenceInstruction(wrongNames)).toBeNull();
});
it("AHO-03 operation fingerprint binds the complete selected provenance and purpose, not the retry key", () => {
  const input = valid(),
    digest = assignmentPayloadDigest(input);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(assignmentPayloadDigest({ ...input, operationId: randomUUID() })).toBe(
    digest,
  );
  for (const change of [
    { attemptId: randomUUID() },
    { sequence: 2 },
    { contentId: "SYN-546" },
    { contentVersion: 2 },
    { rubricVersion: 5 },
    { sourceSha256: "b".repeat(64) },
  ])
    expect(assignmentPayloadDigest({ ...input, ...change })).not.toBe(digest);
  expect(assignmentEvidenceName(1)).toBe("Assignment submission 1.txt");
  expect(assignmentSequence(10)).toBe(true);
});
