import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const diagnostic =
  "Installed dependencies differ from package.json/package-lock.json. Run npm ci, then make verify.";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function equalRecords(left, right) {
  return (
    JSON.stringify(Object.entries(left ?? {}).sort()) ===
    JSON.stringify(Object.entries(right ?? {}).sort())
  );
}

function installedPaths(modules, root, found) {
  function addPackage(directory) {
    const relative = path.relative(root, directory).split(path.sep).join("/");
    found.add(relative);
    const nested = path.join(directory, "node_modules");
    if (existsSync(nested)) installedPaths(nested, root, found);
  }
  const stat = lstatSync(modules);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) throw new Error();
    const directory = path.join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(directory, { withFileTypes: true })) {
        if (!scoped.isDirectory()) throw new Error();
        addPackage(path.join(directory, scoped.name));
      }
    } else {
      addPackage(directory);
    }
  }
}

export function checkInstalledDependencies(root = process.cwd()) {
  try {
    const manifest = readJson(path.join(root, "package.json"));
    const lock = readJson(path.join(root, "package-lock.json"));
    const lockedRoot = lock.packages?.[""];
    if (
      lock.lockfileVersion !== 3 ||
      !lockedRoot ||
      manifest.name !== lockedRoot.name ||
      manifest.version !== lockedRoot.version ||
      lock.name !== manifest.name ||
      lock.version !== manifest.version
    )
      throw new Error();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "engines",
    ]) {
      if (!equalRecords(manifest[field], lockedRoot[field])) throw new Error();
    }

    const found = new Set();
    installedPaths(path.join(root, "node_modules"), root, found);
    if ([...found].some((relative) => !lock.packages[relative]))
      throw new Error();

    let checked = 0;
    for (const [relative, expected] of Object.entries(lock.packages)) {
      if (!relative) continue;
      const parts = relative.split("/");
      if (
        !relative.startsWith("node_modules/") ||
        parts.includes("..") ||
        parts.includes(".") ||
        !expected.version ||
        expected.link
      )
        throw new Error();
      const directory = path.join(root, relative);
      let stat;
      try {
        stat = lstatSync(directory);
      } catch (error) {
        if (error.code === "ENOENT" && expected.optional) continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      const installed = readJson(path.join(directory, "package.json"));
      const expectedName = relative.split("node_modules/").at(-1);
      if (
        installed.name !== expectedName ||
        installed.version !== expected.version
      )
        throw new Error();
      checked += 1;
    }

    // npm detects extraneous, missing and invalid dependency edges. Its output
    // is never inherited or printed because npm diagnostics can contain secrets.
    const npm = spawnSync(
      "npm",
      ["ls", "--all", "--json", "--offline", "--silent"],
      { cwd: root, stdio: "ignore" },
    );
    if (npm.status !== 0) throw new Error();
    return { checked };
  } catch {
    throw new Error(diagnostic);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = checkInstalledDependencies();
    console.log(
      `Installed dependency prerequisite PASS (${result.checked} packages checked).`,
    );
  } catch {
    console.error(diagnostic);
    process.exitCode = 1;
  }
}
