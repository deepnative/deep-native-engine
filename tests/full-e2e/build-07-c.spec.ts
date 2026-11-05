import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { requiredCheck } from "../support/required-check.ts";

const declared = [
  ["WF-001", "WF-001-requirements.md"],
  ["WF-002", "WF-002-test-review.md"],
  ["WF-003", "WF-003-meeting-actions.md"],
] as const;

function metadata(source: string, key: string) {
  const line = source.split("\n").find((row) => row.startsWith(`${key}:`));
  expect(line, key).toBeDefined();
  return line!.slice(key.length + 1).trim();
}

test("[F-BUILD-07-C] a declared workflow version downloads its exact bytes and an accurate compatibility label", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const files = new Map<string, Buffer>();
  for (const [id, file] of declared)
    files.set(
      id,
      await readFile(
        new URL(
          `../../assets/docs/content/reviewed-v2/workflows/${file}`,
          import.meta.url,
        ),
      ),
    );

  await requiredCheck(1, async () => {
    for (const [id] of declared) {
      await page.goto(`/workflows/${id}?version=2`);
      await expect(
        page.getByText("ORDINARY REVIEWED WORKFLOW · VERSION 2"),
      ).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download Markdown text" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`${id}-v2.md`);
      const bytes = await readFile((await download.path())!);
      expect(bytes.equals(files.get(id)!)).toBe(true);
      expect(metadata(bytes.toString("utf8"), "version")).toBe("2");
    }
    // Another version is refused rather than answered with the current bytes.
    for (const path of [
      "/workflows/WF-001/download?version=1",
      "/workflows/WF-001/download?version=3",
    ]) {
      const refused = await page.request.get(path);
      expect(refused.status()).toBe(409);
      expect(refused.headers()["content-disposition"]).toBeUndefined();
      expect((await refused.body()).equals(files.get("WF-001")!)).toBe(false);
    }
  });

  await requiredCheck(2, async () => {
    for (const [id] of declared) {
      const source = files.get(id)!.toString("utf8");
      await page.goto(`/workflows/${id}?version=2`);
      for (const [term, key] of [
        ["Supported environment", "supported_environment"],
        ["Last verification", "last_verification"],
        ["Readiness", "readiness"],
        ["Limitations", "limitations"],
      ] as const) {
        const value = page.locator(`dt:text-is("${term}") + dd`);
        await expect(value).toHaveText(metadata(source, key));
      }
      // The label must not claim tested compatibility that never happened.
      await expect(
        page.locator('dt:text-is("Last verification") + dd'),
      ).toContainText("no AI call or software test execution");
      await expect(
        page.getByText("Downloading it does not run a workflow", {
          exact: false,
        }),
      ).toBeVisible();
    }
  });
});
