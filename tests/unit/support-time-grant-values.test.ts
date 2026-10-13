import { expect, it } from "vitest";
import {
  supportMinuteFields,
  supportMinuteReferences,
  supportMinuteInput,
  supportMinuteRevokeInput,
} from "../../src/support-time-grant-values.ts";
const id = "ABCDEFAB-1111-4111-8111-111111111111",
  refs = { requestId: id, allocationId: id, operatorId: id },
  input = {
    ...refs,
    operationId: id,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-01T01:00:00.000Z",
  };
it("SUPPORT-GRANT-02/05 validates exact reference/operation fields and canonical finite UTC", () => {
  expect(supportMinuteReferences(refs)).toEqual({
    requestId: id.toLowerCase(),
    allocationId: id.toLowerCase(),
    operatorId: id.toLowerCase(),
  });
  expect(supportMinuteInput(input)).toEqual({
    ...input,
    requestId: id.toLowerCase(),
    allocationId: id.toLowerCase(),
    operatorId: id.toLowerCase(),
    operationId: id.toLowerCase(),
  });
  expect(supportMinuteRevokeInput({ grantId: id, operationId: id })).toEqual({
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
    { ...refs, operatorId: "bad" },
    { ...refs, allocationId: "bad" },
    { other: id, operatorId: id },
  ])
    expect(supportMinuteReferences(value)).toBeNull();
  for (const value of [
    null,
    { ...input, extra: "x" },
    { ...input, operationId: "bad" },
    { ...input, startsAt: "bad" },
    { ...input, expiresAt: "bad" },
    { ...input, expiresAt: input.startsAt },
    { ...input, allocationId: "bad" },
    { ...input, operatorId: "bad" },
  ])
    expect(supportMinuteInput(value)).toBeNull();
  for (const value of [
    null,
    { grantId: "bad", operationId: id },
    { grantId: id, operationId: "bad" },
  ])
    expect(supportMinuteRevokeInput(value)).toBeNull();
  expect(supportMinuteFields({ a: "x" }, ["b"])).toBe(false);
});
