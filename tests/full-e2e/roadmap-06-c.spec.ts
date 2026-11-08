import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { workflowRelease } from "../support/workflow-release.ts";

// #769: support status comes from the template's own source release. This
// test changes a fixture copy of that release between checks.
const supportStatus = (page: Page) =>
  page.locator('dt:text-is("Support status") + dd');

test("[F-ROADMAP-06-C] a stale or retired workflow template is not shown as current support", async ({
  browser,
}, info) => {
  test.setTimeout(60_000);
  const release = await workflowRelease();
  const f = await reviewedContentFixture(browser, info, {
    workflowRoot: release.folder,
  });
  try {
    const page = await f.page();
    const list = () => page.goto(`${f.origin}/workflows`);

    await requiredCheck(1, async () => {
      // Before: within its review date, it is current support.
      await page.goto(`${f.origin}/workflows/WF-001?version=2`);
      await expect(supportStatus(page)).toHaveText(
        "Currently supported; next review by 2999-01-01.",
      );
      // The editor's release lets the review date pass: the template is stale.
      await release.set("WF-001", "next_review", "2026-01-01 manual recheck");
      await page.reload();
      await expect(supportStatus(page)).toHaveText(
        "Not currently supported: review overdue since 2026-01-01. The environment and verification details below describe the last check, not current support.",
      );
      // Its compatibility details stay, but only as the last check.
      await expect(
        page.locator('dt:text-is("Supported environment") + dd'),
      ).toContainText("Plain text manual exercise");
      await list();
      const title = await release.title("WF-001");
      const entry = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: title }) });
      await expect(entry).toContainText(
        "Not currently supported: review overdue since 2026-01-01.",
      );
      await expect(entry).not.toContainText("Currently supported;");
    });

    await requiredCheck(2, async () => {
      const title = await release.title("WF-002");
      await list();
      await expect(page.getByRole("link", { name: title })).toBeVisible();
      // The editor's release retires WF-002.
      await release.set("WF-002", "publication_state", "retired");
      await list();
      await expect(page.getByRole("link", { name: title })).toHaveCount(0);
      const retired = page.getByRole("region", { name: "Retired versions" });
      await expect(retired).toContainText(`WF-002 · ${title} · version 2`);
      await expect(retired.getByRole("link")).toHaveCount(0);
      // Neither the page nor the download is offered any more.
      await page.goto(`${f.origin}/workflows/WF-002?version=2`);
      await expect(
        page.getByRole("heading", { name: "Workflow unavailable" }),
      ).toBeVisible();
      const download = await page.request.get(
        `${f.origin}/workflows/WF-002/download?version=2`,
      );
      expect(download.status()).toBe(404);
      expect(download.headers()["content-disposition"]).toBeUndefined();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  } finally {
    await f.close();
    await release.close();
  }
});
