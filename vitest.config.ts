import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,mjs}"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    // Unit files mock shared runtime modules. Serial file execution avoids the
    // observed order-sensitive full-suite failure in the isolated gate probe.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "src/**/*.ts",
        "public/**/*.js",
        "assets/docs/learning-design/reader/*.mjs",
      ],
      // The course is generated data; the other two files are browser tests.
      // Every reader controller, adapter and entry point remains measured.
      exclude: [
        "assets/docs/learning-design/reader/course.mjs",
        "assets/docs/learning-design/reader/checks.mjs",
        "assets/docs/learning-design/reader/gui-checks.mjs",
      ],
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "artifacts/coverage",
      thresholds: {
        statements: 99,
        branches: 99,
        functions: 99,
        lines: 99,
        perFile: true,
      },
    },
    reporters: ["default", "json"],
    outputFile: { json: "artifacts/unit-results.json" },
  },
});
