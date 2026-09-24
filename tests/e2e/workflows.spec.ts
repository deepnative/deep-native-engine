import { expect, test } from "@playwright/test";

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
  await page
    .getByRole("link", { name: "Extract actions from synthetic meeting notes" })
    .click();
  await expect(page.getByText("REVIEW PENDING")).toBeVisible();
  await expect(
    page.getByText("No account or external system access"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Select and copy the synthetic workflow text"),
  ).toContainText("## Synthetic input");
  const download = await page.request.get("/workflows/WF-003/download");
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain("attachment");
  expect(await download.text()).toContain(
    "Do not convert ‘next Tuesday’ to a date",
  );
  await page.goto("/workflows/no-such-workflow/download");
  await expect(
    page.getByRole("heading", { name: "Workflow unavailable" }),
  ).toBeVisible();
});
