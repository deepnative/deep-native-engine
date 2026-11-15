import type { Page } from "@playwright/test";

/**
 * #854 PAGE854-02: an administrator opens an invoice action the way they see
 * it, by its button in the action bar. Refund and void sit under More. A panel
 * that What's next already opened is left open.
 */
export async function openInvoicePanel(
  page: Page,
  panel: "send" | "payment" | "refund" | "void",
) {
  const details = page.locator(
    panel === "refund" || panel === "void"
      ? ".invoice-actions > details.more"
      : `.invoice-actions > details#${panel}`,
  );
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open)))
    await details.locator(":scope > summary").click();
}
