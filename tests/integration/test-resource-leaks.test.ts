import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// These read other test folders, which the gate's isolated unit probes do not
// have, so they run with the integration suite.
const specs = readdirSync("tests/e2e").filter((file) =>
  file.endsWith(".spec.ts"),
);

// A fixture that keeps its database when a test fails leaks one per failure.
it.each(specs)(
  "LEFTOVER-06 %s does not tie its database drop to the test outcome",
  (file) => {
    expect(readFileSync(`tests/e2e/${file}`, "utf8")).not.toMatch(
      /if \(completed\)\s*await drop|if \(\s*test\.info\(\)\.status/,
    );
  },
);

it("LEFTOVER-11 removes the Azurite fixture's anonymous volume with its container", () => {
  expect(
    readFileSync("tests/integration/azure-object-storage.test.ts", "utf8"),
  ).toContain('docker("rm", "--force", "--volumes", name)');
});
