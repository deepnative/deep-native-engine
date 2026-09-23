import {
  mkdtempSync,
  realpathSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requireGate } from "./quality-gates.mjs";
const root = process.cwd(),
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "dne-gate-probes-")));
const evidence = { unimportedSourceRejected: false, brokenCsrfRejected: false };
mkdirSync("artifacts/probes", { recursive: true });
try {
  for (const name of [
    "src",
    "public",
    "migrations",
    "assets/docs/content",
    "tests/unit",
    "vitest.config.ts",
    "package.json",
  ]) {
    mkdirSync(path.dirname(path.join(sandbox, name)), { recursive: true });
    cpSync(name, path.join(sandbox, name), { recursive: true });
  }
  // Tooling-unit fixtures import the shared gate; keep it present in the isolated probe checkout.
  cpSync("scripts", path.join(sandbox, "scripts"), { recursive: true });
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(sandbox, "node_modules"),
    "dir",
  );
  const probe = path.join(sandbox, "src/unimported-probe.ts");
  writeFileSync(
    probe,
    'export function untestedGuard(value: boolean) { return value ? "allowed" : "denied"; }\n',
  );
  // The full unit suite runs before this probe. A stable target keeps unrelated
  // unit failures from suppressing the coverage report we inspect here.
  let result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/unit/domain.test.ts",
      "--coverage",
    ],
    { cwd: sandbox, encoding: "utf8" },
  );
  writeFileSync(
    "artifacts/probes/unimported.log",
    result.stdout + result.stderr,
  );
  requireGate(
    result.status !== 0 && result.status !== null,
    "Unimported-source probe did not fail",
  );
  requireGate(
    existsSync(path.join(sandbox, "artifacts/coverage/coverage-summary.json")),
    "Unimported-source probe produced no coverage report; inspect artifacts/probes/unimported.log",
  );
  const coverage = JSON.parse(
    readFileSync(
      path.join(sandbox, "artifacts/coverage/coverage-summary.json"),
      "utf8",
    ),
  );
  requireGate(
    coverage[probe]?.functions.covered === 0 &&
      coverage[probe]?.functions.total > 0,
    "Probe source absent from coverage",
  );
  evidence.unimportedSourceRejected = true;
  rmSync(probe);
  const target = path.join(sandbox, "src/session.ts"),
    original = readFileSync(target, "utf8");
  const mutant = original.replace(
    /Buffer\.from\(provided,\s*(['"])hex\1\)/,
    'Buffer.from(csrf(value, secret), "hex")',
  );
  requireGate(mutant !== original, "CSRF mutation target missing");
  writeFileSync(target, mutant);
  result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/unit/domain.test.ts",
    ],
    { cwd: sandbox, encoding: "utf8" },
  );
  writeFileSync(
    "artifacts/probes/csrf-mutation.log",
    result.stdout + result.stderr,
  );
  requireGate(
    result.status !== 0 &&
      result.status !== null &&
      (result.stdout + result.stderr).includes("binds CSRF"),
    "Broken CSRF behavior did not fail its regression",
  );
  evidence.brokenCsrfRejected = true;
  writeFileSync(
    "artifacts/probes/summary.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.info(
    "Negative probes passed: unimported source and broken CSRF both fail the gate.",
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
