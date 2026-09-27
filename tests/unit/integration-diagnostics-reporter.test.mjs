import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  mkdir: vi.fn(),
  write: vi.fn(),
}));
vi.mock("node:fs", () => ({
  mkdirSync: files.mkdir,
  writeFileSync: files.write,
}));

beforeEach(() => vi.clearAllMocks());

it("records bounded code-owned unhandled-error signatures without private error text or stack", async () => {
  const { default: reporter } =
    await import("../support/integration-diagnostics-reporter.ts");
  const secret = "synthetic-private-member-note";
  await reporter.onTestRunEnd(
    [],
    [
      {
        type: "Unhandled Rejection",
        name: "TypeError",
        code: "ECONNRESET",
        message: secret,
        stack: `TypeError: ${secret}\n    at missing (/private/${secret}/node_modules/pg/lib/client.js:5:3)`,
        VITEST_TEST_PATH: `/private/${secret}/tests/integration/store.test.ts`,
      },
    ],
  );
  const [path, body] = files.write.mock.calls.at(-1);
  expect(path).toBe("artifacts/integration-unhandled.json");
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual({
    schema: "integration-unhandled-v1",
    count: 1,
    truncated: false,
    signatures: [
      {
        kind: "unhandled-rejection",
        name: "type-error",
        code: "ECONNRESET",
        testFile: "store.test.ts",
        firstFrame: "dependency",
      },
    ],
  });
});

it("caps signatures and maps arbitrary private fields to fixed unknown values", async () => {
  const { default: reporter } =
    await import("../support/integration-diagnostics-reporter.ts");
  const secret = "synthetic-credential-candidate";
  await reporter.onTestRunEnd(
    [],
    Array.from({ length: 5 }, () => ({
      type: secret,
      name: secret,
      code: secret,
      message: secret,
      stack: `Error: ${secret}\n    at ${secret}`,
      VITEST_TEST_PATH: `/tmp/${secret}.test.ts`,
    })),
  );
  const body = files.write.mock.calls.at(-1)[1];
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual({
    schema: "integration-unhandled-v1",
    count: 5,
    truncated: true,
    signatures: Array.from({ length: 3 }, () => ({
      kind: "other",
      name: "other",
      code: "other",
      testFile: "other",
      firstFrame: "other",
    })),
  });
});
