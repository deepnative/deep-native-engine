import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  workflowFiles,
  workflowRelease,
  type WorkflowId,
} from "../support/workflow-release.ts";

// A template's "sample test" is what the owner defined on 10 November 2026:
// the manual check done at each review, where the template's example input is
// compared by hand with its example output and the date is recorded. No
// software test or AI call runs. This test reads the same two parts a
// reviewer compares, on a fixture copy of the reviewed release.
test.use({ trace: "off" });

const CHECK = /^(\d{4}-\d{2}-\d{2}) manual input\/output comparison/;
const metadata = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, "m").exec(text)![1]!;
// One "## " section of a template, exactly as released.
function section(text: string, heading: RegExp) {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && heading.test(line),
  );
  if (start < 0) throw Error("Template section missing");
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

test("[F-BUILD-07-D] each template shows the example input and output its dated manual check compared, and its support status matches that check", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const release = await workflowRelease();
  const f = await reviewedContentFixture(browser, info, {
    workflowRoot: release.folder,
  });
  try {
    const page = await f.page();
    const source = (id: WorkflowId) =>
      readFile(join(release.folder, workflowFiles[id]), "utf8");
    const status = page.locator('dt:text-is("Support status") + dd');
    const lastCheck = page.locator('dt:text-is("Last verification") + dd');

    await requiredCheck(1, async () => {
      for (const id of Object.keys(workflowFiles) as WorkflowId[]) {
        const text = await source(id);
        const recorded = metadata(text, "last_verification");
        // The record names a dated manual comparison, not a software test.
        expect(recorded).toMatch(CHECK);
        expect(recorded).toContain("no AI call or software test execution");
        await page.goto(`${f.origin}/workflows/${id}?version=3`);
        await expect(lastCheck).toHaveText(recorded);

        // The two parts that check compares are on the page as released,
        // in the text the member reads and copies.
        const shown = (
          await page
            .getByLabel("Select and copy the synthetic workflow text")
            .inputValue()
        ).replace(/\r\n/g, "\n");
        for (const heading of [/Synthetic input/, /Hand-authored example/]) {
          const part = section(text, heading);
          expect(part.split("\n").length).toBeGreaterThan(2);
          expect(shown, `${id} · ${part.split("\n")[0]}`).toContain(part);
        }
        // The download carries the same input, output and check record.
        const downloading = page.waitForEvent("download");
        await page
          .getByRole("link", { name: "Download Markdown text" })
          .click();
        const bytes = await readFile(
          (await (await downloading).path())!,
          "utf8",
        );
        expect(bytes).toBe(text);

        // A template whose dated check stands is shown as supported.
        await expect(status).toHaveText(
          "Currently supported; next review by 2999-01-01.",
        );
      }

      // A review finds that WF-002's example output no longer follows from
      // its input. The release records that, and the status follows it.
      const failed =
        "2026-11-11 manual input/output comparison failed: the example review no longer follows from the input; no AI call or software test execution";
      await release.set("WF-002", "last_verification", failed);
      await release.set("WF-002", "support_state", "unverified");
      await page.goto(`${f.origin}/workflows/WF-002?version=3`);
      await expect(lastCheck).toHaveText(failed);
      await expect(status).toHaveText(
        "Not currently supported: unverified. The environment and verification details below describe the last check, not current support.",
      );
      await expect(page.getByText("Currently supported;")).toHaveCount(0);
      await page.goto(`${f.origin}/workflows`);
      const entry = (id: WorkflowId, title: string) =>
        page
          .getByRole("listitem")
          .filter({ has: page.getByRole("link", { name: title }) });
      await expect(
        entry("WF-002", await release.title("WF-002")),
      ).toContainText("Not currently supported: unverified.");
      // The templates whose checks stand are unchanged.
      for (const id of ["WF-001", "WF-003"] as const)
        await expect(entry(id, await release.title(id))).toContainText(
          "Currently supported; next review by 2999-01-01.",
        );
    });
  } finally {
    await f.close();
    await release.close();
  }
});
