import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  circleGrantCursor,
  readCircleGrantCursor,
} from "../../src/circle-grant-cursor.ts";
import { CIRCLE_DISCUSSION_POLICY } from "../../src/circle-discussion.ts";
import { CircleGrantFailure } from "../../src/circle-grant-lifetime.ts";
const id = "00000000-0000-4000-8000-000000000001",
  actor = "admin",
  scope = { staffId: "moderator", circleId: "everyday-ai" },
  secret = "invented-unit-secret";
afterEach(() => vi.restoreAllMocks());
it("CIRADM-06 continues from the exact last grant only within its current actor, target, circle and secret", () => {
  vi.spyOn(Date, "now").mockReturnValue(1791288000000);
  const cursor = circleGrantCursor(id, actor, scope, secret);
  expect(readCircleGrantCursor(undefined, actor, scope, secret)).toBeNull();
  expect(readCircleGrantCursor(cursor, actor, scope, secret)).toBe(id);
  for (const [a, s, key] of [
    ["other-admin", scope, secret],
    [actor, { ...scope, staffId: "other-target" }, secret],
    [actor, { ...scope, circleId: "technical-practice" }, secret],
    [actor, scope, "other-secret"],
  ] as const)
    expect(() => readCircleGrantCursor(cursor, a, s, key)).toThrow(
      CircleGrantFailure,
    );
});
it("CIRADM-06 rejects malformed, tampered, expired or wrong-policy continuation rather than starting over", () => {
  const now = 1791288000000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const cursor = circleGrantCursor(id, actor, scope, secret),
    [last, expiry, sig] = cursor.split("|");
  const oldBody = `${id}|${now + 1200000}`;
  const wrongPolicy = createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "circle-grant-history",
        `${CIRCLE_DISCUSSION_POLICY}-different`,
        actor,
        scope.staffId,
        scope.circleId,
        oldBody,
      ]),
    )
    .digest("hex");
  for (const value of [
    "",
    "x".repeat(201),
    `${last}|${expiry}`,
    `bad|${expiry}|${sig}`,
    `${last}|x|${sig}`,
    `${last}|${now}|${sig}`,
    `${last}|${expiry}|BAD`,
    `${last}|${expiry}|${"0".repeat(64)}`,
    `${oldBody}|${wrongPolicy}`,
    `${last}|${expiry}|${sig}|extra`,
  ])
    expect(() => readCircleGrantCursor(value, actor, scope, secret)).toThrow(
      CircleGrantFailure,
    );
  vi.spyOn(Date, "now").mockReturnValue(now + 1200000);
  expect(() => readCircleGrantCursor(cursor, actor, scope, secret)).toThrow(
    CircleGrantFailure,
  );
});
