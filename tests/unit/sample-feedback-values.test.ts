import { describe, expect, it } from "vitest";
import {
  sampleDraftValid,
  sampleDraftDigest,
  sampleText,
  sampleUuid,
  sampleToken,
} from "../../src/sample-feedback-values.ts";
const source = "Check 🤖 claims. Check 🤖 claims.";
const draft = () => ({
  revision: 0,
  operationId: "40000000-0000-4000-8000-000000000001",
  criteria: [
    {
      label: "Verification",
      comment: "Cite the primary source.",
      start: 6,
      end: 8,
      quote: "🤖",
    },
  ],
  preparationMinutes: null,
  reviewMinutes: 0,
});
describe("private feedback source reference contract", () => {
  it("accepts an exact Unicode reference without splitting a surrogate pair", () => {
    expect(sampleDraftValid(draft(), source)).toBe(true);
    const value = draft();
    value.criteria[0] = {
      ...value.criteria[0]!,
      start: source.lastIndexOf("🤖"),
      end: source.lastIndexOf("🤖") + 2,
    };
    expect(sampleDraftValid(value, source)).toBe(true);
  });
  it.each([
    ["wrong quote", { quote: "other" }],
    ["wrong offset", { start: 5 }],
    ["negative offset", { start: -1 }],
    ["oversized offset", { end: 1000 }],
    ["reversed range", { start: 8, end: 6 }],
    ["fractional start", { start: 6.5 }],
    ["fractional end", { end: 7.5 }],
    ["split pair", { end: 7, quote: "\ud83e" }],
    ["empty label", { label: "" }],
    ["blank comment", { comment: "  " }],
    ["long label", { label: "x".repeat(101) }],
    ["long comment", { comment: "x".repeat(1001) }],
    ["extra field", { unexpected: true }],
  ])("rejects %s without changing caller input", (_label, change) => {
    const value = draft();
    Object.assign(value.criteria[0]!, change);
    const before = structuredClone(value);
    expect(sampleDraftValid(value, source)).toBe(false);
    expect(value).toEqual(before);
  });
  it.each([null, undefined, [], {}, "text", 1])(
    "rejects malformed draft %s",
    (value) => {
      expect(sampleDraftValid(value, source)).toBe(false);
    },
  );
  it.each([
    { revision: -1 },
    { revision: 1.5 },
    { revision: 2147483647 },
    { operationId: "bad" },
    { preparationMinutes: -1 },
    { preparationMinutes: 481 },
    { reviewMinutes: 0.5 },
    { criteria: [] },
    { criteria: Array.from({ length: 6 }, () => draft().criteria[0]) },
  ])("rejects invalid draft bounds %j", (change) => {
    expect(sampleDraftValid({ ...draft(), ...change }, source)).toBe(false);
  });
  it("accepts the complete source and bounded maximum time values", () => {
    const value = {
      ...draft(),
      criteria: [
        {
          label: "Whole sample",
          comment: "Review the complete claim.",
          quote: source,
          start: 0,
          end: source.length,
        },
      ],
      preparationMinutes: 480,
      reviewMinutes: 480,
    };
    expect(sampleDraftValid(value, source)).toBe(true);
  });
  it("canonicalizes field order but binds replay identity to submitted revision and content", () => {
    const value = draft();
    const reordered = {
      ...value,
      criteria: [
        {
          quote: "🤖",
          end: 8,
          start: 6,
          comment: "Cite the primary source.",
          label: "Verification",
        },
      ],
    };
    expect(sampleDraftDigest(value)).toBe(sampleDraftDigest(reordered));
    expect(sampleDraftDigest(value)).not.toBe(
      sampleDraftDigest({ ...value, revision: 1 }),
    );
    expect(sampleDraftDigest(value)).not.toBe(
      sampleDraftDigest({ ...value, reviewMinutes: 1 }),
    );
  });
});
it.each(["plain", "line\nbreak", "tab\ttext", "carriage\rreturn", "🤖"])(
  "allows bounded readable text %s",
  (text) => {
    expect(sampleText(text, 100)).toBe(true);
  },
);
it.each([
  "",
  "   ",
  "a\u0000b",
  "a\u0008b",
  "a\u000bb",
  "a\u000cb",
  "a\u001fb",
  "a\u007fb",
  "\ud800",
  "\udfff",
])("rejects empty, control or malformed Unicode text %j", (text) => {
  expect(sampleText(text, 100)).toBe(false);
});
it("enforces text lengths and typed identity shapes", () => {
  expect(sampleText("four", 3)).toBe(false);
  expect(sampleText(1, 100)).toBe(false);
  expect(sampleUuid(draft().operationId)).toBe(true);
  expect(sampleUuid("bad")).toBe(false);
  expect(sampleUuid(null)).toBe(false);
  expect(sampleToken("a".repeat(64))).toBe(true);
  expect(sampleToken("A".repeat(64))).toBe(false);
  expect(sampleToken(null)).toBe(false);
});
it("rejects a valid-looking replacement quote whose offsets cut through the source emoji", () => {
  const value = draft();
  value.criteria[0] = { ...value.criteria[0]!, start: 7, end: 8, quote: "x" };
  expect(sampleDraftValid(value, source)).toBe(false);
});
