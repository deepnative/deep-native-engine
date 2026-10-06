import { expect, it } from "vitest";
import {
  sampleAssignmentInput,
  sampleAssignmentReferences,
  sampleAssignmentSource,
} from "../../src/sample-assignment-input.ts";
import { sampleAssignmentUtc } from "../../src/sample-assignment-values.ts";
const evidenceId = "a12f4499-6652-4a39-8d68-0e390a19beef",
  reviewerId = "b12f4499-6652-4a39-8d68-0e390a19beef";
const refs = { evidenceId, sourceRevision: 1, reviewerId };
const input = {
  ...refs,
  operationId: "c12f4499-6652-4a39-8d68-0e390a19beef",
  startsAt: "2026-10-06T09:00:00.000Z",
  expiresAt: "2026-10-06T10:00:00.000Z",
};
it("REVADM-01/06 accepts only exact UUID/version references and rejects authority overrides and duplicate fields", () => {
  expect(
    sampleAssignmentReferences({
      ...refs,
      evidenceId: evidenceId.toUpperCase(),
      reviewerId: reviewerId.toUpperCase(),
      sourceRevision: "1",
    }),
  ).toEqual(refs);
  expect(sampleAssignmentSource({ evidenceId, sourceRevision: 20 })).toEqual({
    evidenceId,
    sourceRevision: 20,
  });
  for (const sourceRevision of [
    "01",
    "1.0",
    "1e0",
    " 1",
    "21",
    0,
    21,
    1.1,
    NaN,
    Infinity,
    null,
    [],
    true,
  ])
    expect(sampleAssignmentSource({ evidenceId, sourceRevision })).toBeNull();
  for (const bad of [
    null,
    undefined,
    [],
    "refs",
    {},
    { evidenceId, sourceRevision: 1, owner: evidenceId },
    { evidenceId: "bad", sourceRevision: 1 },
  ])
    expect(sampleAssignmentSource(bad)).toBeNull();
  for (const bad of [
    null,
    [],
    { ...refs, reviewerId: [reviewerId, reviewerId] },
    { ...refs, reviewerId: "bad" },
    { ...refs, sourceRevision: "bad" },
    { ...refs, role: "reviewer" },
  ])
    expect(sampleAssignmentReferences(bad)).toBeNull();
});
it("REVADM-02/05/06 preserves one exact canonical UTC payload and key without shortening or coercing it", () => {
  expect(
    sampleAssignmentInput({
      ...input,
      operationId: input.operationId.toUpperCase(),
    }),
  ).toEqual(input);
  for (const date of [
    null,
    "",
    "2026-02-29T00:00:00.000Z",
    "2026-99-06T09:00:00.000Z",
    "2026-10-06T09:00:00Z",
    "2026-10-06T09:00:00.000+00:00",
    "2026-10-06T09:00",
    "Infinity",
  ])
    expect(sampleAssignmentUtc(date)).toBe(false);
  for (const bad of [
    null,
    [],
    { ...input, operationId: "bad" },
    { ...input, startsAt: "bad" },
    { ...input, expiresAt: "bad" },
    { ...input, expiresAt: input.startsAt },
    { ...input, startsAt: input.expiresAt, expiresAt: input.startsAt },
    { ...input, reviewerId: "bad" },
    { ...input, actor: reviewerId },
  ])
    expect(sampleAssignmentInput(bad)).toBeNull();
});
