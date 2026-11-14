import type { Page } from "@playwright/test";

/**
 * The member's form token: from a form on the open page, else from My
 * account. Since #846 the learning page holds a form only when it offers one.
 */
export async function formToken(page: Page): Promise<string> {
  const field = page.locator('input[name="csrf"]').first();
  if (await field.count()) return field.inputValue();
  const account = await page.request.get(new URL("/account", page.url()).href);
  const found = /name="csrf" value="([a-f0-9]+)"/.exec(await account.text());
  if (!found) throw Error("No form token on this page or on My account");
  return found[1]!;
}
