import { expect, it } from "vitest";
import {
  decodeLearningText,
  encodeLearningText,
} from "../../src/learning-workspace-text.ts";

it("LWORK-TEXT preserves reader-accepted code units and an exportable field size", () => {
  for (const text of [
    "",
    "\u0000",
    "\ud800",
    "\udc00",
    "😀",
    "\\u0000",
    "\u0000".repeat(30000),
    "\ud800".repeat(30000),
  ]) {
    const stored = encodeLearningText(text);
    expect(decodeLearningText(Buffer.from(stored).toString())).toBe(text);
    expect(
      Buffer.byteLength(JSON.stringify({ text: decodeLearningText(stored) })),
    ).toBeLessThan(256 * 1024);
  }
});

it("LWORK-TEXT rejects oversized writing and corrupt encoded rows without substitution", () => {
  expect(() => encodeLearningText("x".repeat(30001))).toThrow();
  expect(() => encodeLearningText(null as unknown as string)).toThrow();
  for (const raw of [
    "broken",
    "null",
    "3",
    '"\\u0061"',
    JSON.stringify("x".repeat(30001)),
  ])
    expect(() => decodeLearningText(raw)).toThrow();
});
