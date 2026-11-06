import { describe, expect, it } from "vitest";
import {
  AI_MAX_USAGE_TOKENS,
  aiCostPoints,
  estimateAiRequest,
  readAiUsage,
} from "../../src/ai-budget-policy.ts";

describe("AI test budget policy", () => {
  it("labels an estimate with its model and rate version", () => {
    expect(estimateAiRequest(42)).toEqual({
      inputTokens: 11,
      outputTokens: 256,
      costPoints: 157,
      modelVersion: "simulated-model-v1",
      rateVersion: "simulated-rates-v1",
    });
  });

  it("rounds cost points up", () => {
    expect(aiCostPoints({ inputTokens: 1, outputTokens: 0 })).toBe(1);
    expect(aiCostPoints({ inputTokens: 1000, outputTokens: 1000 })).toBe(900);
  });

  it("keeps the largest evidence estimate within the stored limits", () => {
    expect(estimateAiRequest(1024 * 1024).inputTokens).toBeLessThan(
      AI_MAX_USAGE_TOKENS,
    );
  });

  it("keeps only two bounded integers from provider usage", () => {
    expect(
      readAiUsage({
        usage: { inputTokens: 1, outputTokens: 0, prompt: "invented secret" },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 0 });
    expect(
      readAiUsage({
        usage: {
          inputTokens: AI_MAX_USAGE_TOKENS,
          outputTokens: AI_MAX_USAGE_TOKENS,
        },
      }),
    ).toEqual({
      inputTokens: AI_MAX_USAGE_TOKENS,
      outputTokens: AI_MAX_USAGE_TOKENS,
    });
  });

  const accessor = {
    usage: {
      get inputTokens() {
        return 1;
      },
      outputTokens: 1,
    },
  };
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("Invented provider fault");
      },
    },
  );
  it.each([
    ["no result", null],
    ["a text result", "usage"],
    ["no usage", {}],
    ["null usage", { usage: null }],
    ["text usage", { usage: "11" }],
    ["list usage", { usage: [1, 1] }],
    ["text counts", { usage: { inputTokens: "1", outputTokens: "1" } }],
    ["a fraction", { usage: { inputTokens: 1.5, outputTokens: 1 } }],
    ["zero input", { usage: { inputTokens: 0, outputTokens: 1 } }],
    ["negative output", { usage: { inputTokens: 1, outputTokens: -1 } }],
    ["too much input", { usage: { inputTokens: 1e7 + 1, outputTokens: 1 } }],
    ["too much output", { usage: { inputTokens: 1, outputTokens: 1e7 + 1 } }],
    ["an accessor", accessor],
    ["a hostile object", hostile],
  ])("rejects %s", (_name, value) => {
    expect(readAiUsage(value)).toBeNull();
  });
});
