import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("[L41] general learner explores three synthetic workflows without execution", async ({
  page,
}) => {
  await page.goto("/workflows");
  await expect(
    page.getByRole("heading", { name: "Workflow demonstrations" }),
  ).toBeVisible();
  await expect(
    page.locator('section[aria-label="Synthetic workflows"] li'),
  ).toHaveCount(3);
  await page.getByLabel("Search by title, goal or background").fill("meeting");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.locator('section[aria-label="Synthetic workflows"] li'),
  ).toHaveCount(1);
  // WFDL-01 and WFDL-04 retain the approved L41 actor and browser variants.
  const detailLink = page.getByRole("link", {
    name: "Extract actions from synthetic meeting notes",
  });
  await expect(detailLink).toHaveAttribute(
    "href",
    "/workflows/WF-003?version=1",
  );
  await detailLink.click();
  await expect(page.getByText("REVIEW PENDING")).toBeVisible();
  await expect(
    page.getByText("No account or external system access"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Select and copy the synthetic workflow text"),
  ).toContainText("## Synthetic input");
  await expect(
    page.getByLabel("Select and copy the synthetic workflow text"),
  ).toHaveAttribute("readonly", "");
  const downloadLink = page.getByRole("link", {
    name: "Download Markdown text",
  });
  await expect(downloadLink).toHaveAttribute(
    "href",
    "/workflows/WF-003/download?version=1",
  );
  const href = (await downloadLink.getAttribute("href"))!;
  const expectedBytes = await readFile(
    new URL(
      "../../assets/docs/content/workflows/WF-003-meeting-actions.md",
      import.meta.url,
    ),
  );
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("WF-003-v1.md");
  expect(await readFile((await download.path())!)).toEqual(expectedBytes);
  const attachment = await page.request.get(href);
  expect(attachment.status()).toBe(200);
  expect(attachment.headers()["content-disposition"]).toBe(
    'attachment; filename="WF-003-v1.md"',
  );
  expect(attachment.headers()["content-type"]).toBe(
    "text/markdown; charset=utf-8",
  );
  expect(attachment.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await attachment.body()).toEqual(expectedBytes);

  // WFDL-02 and WFDL-03: denial is visible and recovery is a deliberate action.
  for (const [path, status, title] of [
    ["/workflows/WF-003?version=2", 409, "Workflow version unavailable"],
    [
      "/workflows/WF-003/download?version=2",
      409,
      "Workflow version unavailable",
    ],
    ["/workflows/WF-003/download", 400, "Workflow version required"],
  ] as const) {
    const denied = await page.goto(path);
    expect(denied!.status()).toBe(status);
    expect(denied!.headers()["content-disposition"]).toBeUndefined();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page.getByLabel("Select and copy the synthetic workflow text"),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Browse current workflow drafts" })
      .click();
    await detailLink.click();
    await expect(downloadLink).toHaveAttribute("href", href);
  }
  const unknown = await page.goto("/workflows/no-such-workflow/download");
  expect(unknown!.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Workflow unavailable" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Browse current workflow drafts" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workflow demonstrations" }),
  ).toBeVisible();
});
