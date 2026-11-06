// Test-only budget policy for metered AI requests (#188). The rates are invented
// and priced in simulated points, not money. A real provider needs its own
// reviewed rate version and spending ceiling before anything can use it.
export const AI_TEST_MODEL_VERSION = "simulated-model-v1";
export const AI_TEST_RATE_VERSION = "simulated-rates-v1";
export const AI_USAGE_BYTES_PER_TOKEN = 4;
export const AI_ESTIMATED_OUTPUT_TOKENS = 256;
export const AI_SIMULATED_OUTPUT_TOKENS = 64;
export const AI_MAX_USAGE_TOKENS = 10_000_000;
const INPUT_POINTS_PER_1000_TOKENS = 300;
const OUTPUT_POINTS_PER_1000_TOKENS = 600;

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface AiUsageAmount extends AiUsage {
  costPoints: number;
}
export interface AiUsageEstimate extends AiUsageAmount {
  modelVersion: string;
  rateVersion: string;
}

export function aiCostPoints(usage: AiUsage): number {
  return Math.ceil(
    (usage.inputTokens * INPUT_POINTS_PER_1000_TOKENS +
      usage.outputTokens * OUTPUT_POINTS_PER_1000_TOKENS) /
      1000,
  );
}

export function aiInputTokens(byteLength: number): number {
  return Math.ceil(byteLength / AI_USAGE_BYTES_PER_TOKEN);
}

export function estimateAiRequest(byteLength: number): AiUsageEstimate {
  const usage = {
    inputTokens: aiInputTokens(byteLength),
    outputTokens: AI_ESTIMATED_OUTPUT_TOKENS,
  };
  return {
    ...usage,
    costPoints: aiCostPoints(usage),
    modelVersion: AI_TEST_MODEL_VERSION,
    rateVersion: AI_TEST_RATE_VERSION,
  };
}

function ownValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const tokenCount = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= minimum &&
  (value as number) <= AI_MAX_USAGE_TOKENS;

// Provider output is untrusted. Keep only two bounded integers, so no prompt,
// text or credential in the response can reach a stored usage record. Anything
// else returns null, which leaves the request held rather than settled.
export function readAiUsage(result: unknown): AiUsage | null {
  try {
    if (typeof result !== "object" || result === null) return null;
    const usage = ownValue(result, "usage");
    if (typeof usage !== "object" || usage === null) return null;
    const inputTokens = ownValue(usage, "inputTokens");
    const outputTokens = ownValue(usage, "outputTokens");
    return tokenCount(inputTokens, 1) && tokenCount(outputTokens, 0)
      ? { inputTokens, outputTokens }
      : null;
  } catch {
    return null;
  }
}
