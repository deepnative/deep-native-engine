import { expect, it } from "vitest";
import {
  reviewGrantFields,
  reviewGrantReferences,
  reviewGrantInput,
  reviewGrantRevokeInput,
} from "../../src/review-time-grant-values.ts";
const id = "ABCDEFAB-1111-4111-8111-111111111111",
  refs = { allocationId: id, reviewerId: id },
  input = {
    ...refs,
    operationId: id,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-01T01:00:00.000Z",
  };
it("REVIEW-GRANT-02/05 validates exact reference/operation fields and canonical finite UTC", () => {
  expect(reviewGrantReferences(refs)).toEqual({
    allocationId: id.toLowerCase(),
    reviewerId: id.toLowerCase(),
  });
  expect(reviewGrantInput(input)).toEqual({
    ...input,
    allocationId: id.toLowerCase(),
    reviewerId: id.toLowerCase(),
    operationId: id.toLowerCase(),
  });
  expect(reviewGrantRevokeInput({ grantId: id, operationId: id })).toEqual({
    grantId: id.toLowerCase(),
    operationId: id.toLowerCase(),
  });
  for (const value of [
    null,
    undefined,
    [],
    1,
    {},
    { ...refs, extra: "x" },
    { ...refs, allocationId: 1 },
    { ...refs, reviewerId: "bad" },
    { ...refs, allocationId: "bad" },
    { other: id, reviewerId: id },
  ])
    expect(reviewGrantReferences(value)).toBeNull();
  for (const value of [
    null,
    { ...input, extra: "x" },
    { ...input, operationId: "bad" },
    { ...input, startsAt: "bad" },
    { ...input, expiresAt: "bad" },
    { ...input, expiresAt: input.startsAt },
    { ...input, allocationId: "bad" },
    { ...input, reviewerId: "bad" },
  ])
    expect(reviewGrantInput(value)).toBeNull();
  for (const value of [
    null,
    { grantId: "bad", operationId: id },
    { grantId: id, operationId: "bad" },
  ])
    expect(reviewGrantRevokeInput(value)).toBeNull();
  expect(reviewGrantFields({ a: "x" }, ["b"])).toBe(false);
});
