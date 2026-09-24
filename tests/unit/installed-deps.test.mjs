import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-installed-deps.mjs", import.meta.url),
);
const roots = [];

function fixture({ installedVersion = "1.0.0", present = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dne-installed-deps-"));
  roots.push(root);
  const manifest = {
    name: "synthetic-dependency-check",
    version: "1.0.0",
    dependencies: { "synthetic-package": "1.0.0" },
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/synthetic-package": { version: "1.0.0" },
    },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  mkdirSync(path.join(root, "node_modules"));
  if (present) {
    const installed = path.join(root, "node_modules/synthetic-package");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      path.join(installed, "package.json"),
      JSON.stringify({ name: "synthetic-package", version: installedVersion }),
    );
  }
  return root;
}

function check(root, env = process.env) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("rejects an extra installed package outside the lock", () => {
  const root = fixture();
  const extra = path.join(root, "node_modules/unlocked-package");
  mkdirSync(extra);
  writeFileSync(
    path.join(extra, "package.json"),
    JSON.stringify({ name: "unlocked-package", version: "1.0.0" }),
  );
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Run npm ci");
});

it("accepts a locally installed tree matching the manifest and lock", () => {
  const result = check(fixture());
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Installed dependency prerequisite PASS");
});

it.each([
  ["stale version", { installedVersion: "1.1.0" }],
  ["missing package", { present: false }],
])("rejects a %s before application verification", (_name, options) => {
  const result = check(fixture(options));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Run npm ci");
  expect(result.stdout).toBe("");
});

it("rejects manifest and lock drift without echoing npm output", () => {
  const root = fixture();
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "synthetic-dependency-check",
      version: "1.0.0",
      dependencies: { "synthetic-package": "2.0.0" },
    }),
  );
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Run npm ci");
  expect(result.stderr).not.toContain("synthetic-package");
});

it("withholds npm diagnostics when its graph check fails", () => {
  const root = fixture();
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const npm = path.join(bin, "npm");
  const marker = "synthetic-private-npm-error";
  writeFileSync(npm, `#!/bin/sh\nprintf '${marker}\\n' >&2\nexit 1\n`);
  chmodSync(npm, 0o755);
  const result = check(root, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Run npm ci");
  expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
});
