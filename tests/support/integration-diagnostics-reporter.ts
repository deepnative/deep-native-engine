import { mkdirSync, writeFileSync } from "node:fs";

// Vitest's JSON reporter counts test assertions, while an unhandled error can
// still make its process fail. This reporter records only fixed, code-owned
// categories: never serialize a message, stack, path or rejected value.
const testFiles = [
  "availability.test.ts",
  "ledger-migration.test.ts",
  "ledger.test.ts",
  "member-deletion.test.ts",
  "member-export.test.ts",
  "restore.test.ts",
  "slot-holds.test.ts",
  "store.test.ts",
] as const;
const codes = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "53300",
] as const;

function field(error: unknown, key: string): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function firstFrame(error: unknown) {
  const stack = field(error, "stack");
  if (typeof stack !== "string") return "other";
  const frame = stack
    .split("\n")
    .find((line) => /^\s*(?:at\s|❯\s)/u.test(line));
  if (!frame) return "other";
  if (/[\\/]tests[\\/]integration[\\/]/u.test(frame)) return "integration-test";
  if (/[\\/]tests[\\/]support[\\/]/u.test(frame)) return "test-support";
  if (/[\\/]src[\\/]/u.test(frame)) return "application";
  if (/[\\/]node_modules[\\/]/u.test(frame)) return "dependency";
  if (/\bnode:(?:internal|events|net|timers|process)\b/u.test(frame))
    return "node-runtime";
  return "other";
}

function testFile(error: unknown) {
  const path = field(error, "VITEST_TEST_PATH");
  if (typeof path !== "string") return "other";
  const normalized = path.replaceAll("\\", "/");
  return (
    testFiles.find((name) =>
      normalized.endsWith(`/tests/integration/${name}`),
    ) ?? "other"
  );
}

function signature(error: unknown) {
  const type = field(error, "type");
  const name = field(error, "name");
  const code = field(error, "code");
  return {
    kind:
      type === "Unhandled Rejection"
        ? "unhandled-rejection"
        : type === "Uncaught Exception"
          ? "uncaught-exception"
          : type === "Unhandled Error"
            ? "unhandled-error"
            : "other",
    name:
      name === "TypeError"
        ? "type-error"
        : name === "Error"
          ? "error"
          : name === "AggregateError"
            ? "aggregate-error"
            : name === "DatabaseError"
              ? "database-error"
              : name === "TimeoutError"
                ? "timeout-error"
                : name === "EnvironmentTeardownError"
                  ? "environment-teardown-error"
                  : "other",
    code: codes.find((known) => known === code) ?? "other",
    testFile: testFile(error),
    firstFrame: firstFrame(error),
  };
}

const reporter = {
  onTestRunEnd(_modules: unknown, unhandledErrors: ReadonlyArray<unknown>) {
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      "artifacts/integration-unhandled.json",
      JSON.stringify({
        schema: "integration-unhandled-v1",
        count: Math.min(unhandledErrors.length, 99),
        truncated: unhandledErrors.length > 3,
        signatures: unhandledErrors.slice(0, 3).map(signature),
      }) + "\n",
    );
  },
};

export default reporter;
