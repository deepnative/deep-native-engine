import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertFullReleaseJourneys, requireGate } from "./quality-gates.mjs";

const input = process.argv[2] ?? "artifacts/e2e-full-results.json";
const output = "artifacts/full-release-verification.json";
mkdirSync("artifacts", { recursive: true });
let result;
try {
  const register = JSON.parse(readFileSync("tests/e2e/scenarios.json", "utf8"));
  requireGate(
    register.fullMvpVersion === "full-mvp-v1",
    "Full-MVP proposal version changed without gate review",
  );
  const browser = JSON.parse(readFileSync(input, "utf8"));
  result = { exitStatus: 0, ...assertFullReleaseJourneys(register, browser) };
  console.log(
    `Full-release journey gate PASS: ${result.passed}/${result.total}`,
  );
} catch (error) {
  result = { exitStatus: 1, error: error.message };
  console.error(`Full-release journey gate FAIL: ${error.message}`);
  process.exitCode = 1;
}
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
