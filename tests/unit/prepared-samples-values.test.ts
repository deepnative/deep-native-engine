import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  PREPARED_SAMPLES,
  preparedInstruction,
  preparedPayloadDigest,
  preparedSample,
} from "../../src/prepared-sample-values.ts";
import { preparedSamplesEnabled } from "../../src/prepared-samples.ts";
import { config } from "../../src/config.ts";
const sample = PREPARED_SAMPLES[0]!;
const valid = () => ({
  operationId: randomUUID(),
  templateId: sample.id,
  templateVersion: 1,
  templateDigest: sample.digest,
  providedExample: true as const,
  privateReview: true as const,
});
it("PREPARED-01 fixes three inspectable small invented texts independently of member goals", () => {
  expect(PREPARED_SAMPLES.map((s) => s.goal)).toEqual([
    "everyday",
    "work",
    "build",
  ]);
  expect(Object.isFrozen(PREPARED_SAMPLES)).toBe(true);
  for (const s of PREPARED_SAMPLES) {
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.digest).toBe(createHash("sha256").update(s.text).digest("hex"));
    expect(s.name).toMatch(/^Provided .*\.txt$/);
    expect(s.text).toContain("provided practice example");
    expect(preparedSample(s.id, s.version, s.digest)).toBe(s);
  }
});
it("PREPARED-02 accepts only one exact supplied template with two independent acknowledgements", () => {
  const input = valid();
  expect(preparedInstruction(input)).toEqual(input);
  for (const bad of [
    null,
    undefined,
    false,
    [],
    "text",
    {},
    { ...input, text: "private" },
    { ...input, operationId: "bad" },
    { ...input, templateId: 7 },
    { ...input, templateVersion: 2 },
    { ...input, templateDigest: null },
    { ...input, providedExample: false },
    { ...input, privateReview: false },
    { ...input, templateId: "unknown" },
    { ...input, templateDigest: "a".repeat(64) },
  ])
    expect(preparedInstruction(bad)).toBeNull();
  const missing = Object.assign(Object.create({ privateReview: true }), input);
  delete missing.privateReview;
  expect(preparedInstruction(missing)).toBeNull();
});
it("PREPARED-04 binds replay to the original template and permissions, not a new random action key", () => {
  const input = valid();
  expect(
    preparedPayloadDigest({
      ...input,
      providedExample: true,
      privateReview: true,
    }),
  ).toBe(preparedPayloadDigest(input));
  expect(preparedPayloadDigest({ ...input, operationId: randomUUID() })).toBe(
    preparedPayloadDigest(input),
  );
  expect(
    preparedPayloadDigest({ ...input, templateId: PREPARED_SAMPLES[1]!.id }),
  ).not.toBe(preparedPayloadDigest(input));
});
it("PREPARED-02 enables creation only by deliberate flag in an explicit private preview", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    for (const mode of ["demo", "test"] as const)
      expect(
        preparedSamplesEnabled({
          enabled: true,
          mode,
          origin: `http://${host}:3000`,
        }),
      ).toBe(true);
  for (const options of [
    { enabled: false, mode: "test" },
    { enabled: true, mode: "live" },
    { enabled: true },
    {},
  ])
    expect(
      preparedSamplesEnabled({
        ...options,
        origin: "http://127.0.0.1",
      } as Parameters<typeof preparedSamplesEnabled>[0]),
    ).toBe(false);
  for (const origin of [
    "bad",
    "https://127.0.0.1",
    "http://example.invalid",
    "http://name:private@127.0.0.1",
    "http://name@127.0.0.1",
    "http://127.0.0.1/?x=1",
    "http://127.0.0.1/#x",
    "http://127.0.0.1/not-root",
  ])
    expect(
      preparedSamplesEnabled({ enabled: true, mode: "test", origin }),
    ).toBe(false);
});
it("PREPARED-02 configuration requires an explicit unambiguous opt-in", () => {
  const env = {
    DNE_DATABASE_URL:
      "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
  };
  expect(config(env).preparedReviewSamples).toBe(false);
  expect(
    config({ ...env, DNE_PREPARED_REVIEW_SAMPLES: "disabled" })
      .preparedReviewSamples,
  ).toBe(false);
  expect(
    config({ ...env, DNE_PREPARED_REVIEW_SAMPLES: "enabled" })
      .preparedReviewSamples,
  ).toBe(true);
  for (const value of ["true", "1", "", "Enabled"])
    expect(() =>
      config({ ...env, DNE_PREPARED_REVIEW_SAMPLES: value }),
    ).toThrow("DNE_PREPARED_REVIEW_SAMPLES must be enabled or disabled.");
});
