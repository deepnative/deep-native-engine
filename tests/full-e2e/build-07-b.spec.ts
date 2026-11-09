import { expect, test } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { workflowRelease } from "../support/workflow-release.ts";

// #769: retiring or unverifying a template is an editor's source release;
// this test changes a fixture copy of that release between checks.
test("[F-BUILD-07-B] a retired or unverified workflow template is not presented as currently supported", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const release = await workflowRelease();
  const f = await reviewedContentFixture(browser, info, {
    workflowRoot: release.folder,
  });
  try {
    const page = await f.page();

    await requiredCheck(1, async () => {
      const title = await release.title("WF-003");
      await release.set("WF-003", "publication_state", "retired");
      await page.goto(`${f.origin}/workflows`);
      await expect(page.getByRole("link", { name: title })).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Retired versions" }),
      ).toContainText(`WF-003 · ${title} · version 2`);
      await page.goto(`${f.origin}/workflows/WF-003?version=2`);
      await expect(
        page.getByRole("heading", { name: "Workflow unavailable" }),
      ).toBeVisible();
      await expect(page.getByText("Currently supported")).toHaveCount(0);
    });

    await requiredCheck(2, async () => {
      const title = await release.title("WF-001");
      await page.goto(`${f.origin}/workflows/WF-001?version=2`);
      const status = page.locator('dt:text-is("Support status") + dd');
      await expect(status).toHaveText(
        "Currently supported; next review by 2999-01-01.",
      );
      await release.set("WF-001", "support_state", "unverified");
      await page.reload();
      await expect(status).toHaveText(
        "Not currently supported: unverified. The environment and verification details below describe the last check, not current support.",
      );
      await page.goto(`${f.origin}/workflows`);
      const entry = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: title }) });
      await expect(entry).toContainText("Not currently supported: unverified.");
      await expect(entry).not.toContainText("Currently supported;");
      // The template that was not changed is still current.
      const other = page.getByRole("listitem").filter({
        has: page.getByRole("link", { name: await release.title("WF-002") }),
      });
      await expect(other).toContainText(
        "Currently supported; next review by 2999-01-01.",
      );
    });
  } finally {
    await f.close();
    await release.close();
  }
});
