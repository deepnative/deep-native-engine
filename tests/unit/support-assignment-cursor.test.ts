import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  assignmentCursor,
  assignmentId,
  readAssignmentCursor,
} from "../../src/support-assignment-cursor.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const actor = "11111111-1111-4111-8111-111111111111";
const request = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const secret = "invented-cursor-test-secret";
const now = Date.parse("2026-10-06T12:00:00.000Z");
const position = { at: "2026-10-06T11:59:59.123456Z", id };
afterEach(() => vi.restoreAllMocks());
function clock() {
  return vi.spyOn(Date, "now").mockReturnValue(now);
}
function signed(at: string, grantId = id, expiry = String(now + 1200000)) {
  const body = `${at}|${grantId}|${expiry}`;
  return `${body}|${createHmac("sha256", secret).update(`${actor}|${request}|${body}`).digest("hex")}`;
}
function denied(token: string, who = actor, exact = request, signing = secret) {
  expect(() => readAssignmentCursor(token, who, exact, signing)).toThrow(
    SampleFeedbackFailure,
  );
  try {
    readAssignmentCursor(token, who, exact, signing);
  } catch (error) {
    expect(error).toMatchObject({ kind: "denied" });
    expect((error as Error).message).toBe(
      "Private sample feedback unavailable.",
    );
  }
}
it("SUPADM-08 accepts canonical UUID references and rejects aliases or nonreferences", () => {
  expect(assignmentId(id)).toBe(true);
  for (const value of [
    undefined,
    null,
    7,
    {},
    "",
    ` ${id}`,
    `${id}\n`,
    id.replace("4333", "0333"),
    id.replace("8333", "7333"),
    "not-a-reference",
  ]) {
    expect(assignmentId(value)).toBe(false);
  }
  expect(assignmentId("abcdefab-1234-4abc-8abc-abcdefabcdef")).toBe(true);
  expect(assignmentId("ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF")).toBe(false);
});
it("SUPADM-08 preserves microsecond pagination position only for the exact actor/request/secret", () => {
  clock();
  expect(readAssignmentCursor(undefined, actor, request, secret)).toBeNull();
  const token = assignmentCursor(position, actor, request, secret);
  expect(token.length).toBeLessThanOrEqual(200);
  expect(readAssignmentCursor(token, actor, request, secret)).toEqual(position);
  denied(token, request);
  denied(token, actor, actor);
  denied(token, actor, request, "another-secret");
  denied(token.replace("123456", "123457"));
  denied(`${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`);
});
it("SUPADM-08 denies a cursor exactly at expiry without renewing it on reads", () => {
  const time = clock();
  const token = assignmentCursor(position, actor, request, secret);
  time.mockReturnValue(now + 1199999);
  expect(readAssignmentCursor(token, actor, request, secret)).toEqual(position);
  time.mockReturnValue(now + 1200000);
  denied(token);
  time.mockReturnValue(now + 1200001);
  denied(token);
});
it("SUPADM-08 denies bounded malformed signed pagination positions with sanitized errors", () => {
  clock();
  for (const token of [
    "",
    "x".repeat(201),
    "a|b|c",
    `${signed(position.at)}|extra`,
    signed("bad-date"),
    signed("2026-13-06T11:59:59.123456Z"),
    signed(position.at, "not-a-uuid"),
    signed(position.at, id, "0000000000000"),
    signed(position.at, id, "123"),
    signed(position.at).replace(/[a-f0-9]{64}$/, "A".repeat(64)),
    signed(position.at).replace(/[a-f0-9]{64}$/, "z".repeat(64)),
  ])
    denied(token);
});
it("SUPADM-08 rejects impossible calendar dates even with a valid signature", () => {
  clock();
  denied(signed("2026-02-30T11:59:59.123456Z"));
  expect(
    readAssignmentCursor(
      signed("2024-02-29T11:59:59.123456Z"),
      actor,
      request,
      secret,
    ),
  ).toEqual({ at: "2024-02-29T11:59:59.123456Z", id });
});
