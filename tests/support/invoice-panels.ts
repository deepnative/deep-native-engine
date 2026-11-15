import { expect, type Page } from "@playwright/test";

/**
 * #854 PAGE854-02: an administrator opens an invoice action the way they see
 * it, by its link in the action bar; refund and void are under More. The
 * panel then shows below the bar.
 */
export async function openInvoicePanel(
  page: Page,
  panel: "send" | "payment" | "refund" | "void",
) {
  const bar = page.locator(".invoice-actions");
  if (panel === "refund" || panel === "void") {
    const menu = bar.locator("details.action-menu");
    if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open)))
      await menu.locator(":scope > summary").click();
    await menu.locator(`a[href="#${panel}"]`).click();
  } else await bar.locator(`a[href="#${panel}"]`).click();
  await expect(page.locator(`section#${panel}`)).toBeVisible();
}
