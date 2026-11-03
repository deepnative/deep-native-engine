import { expect } from "vitest";

/** The page body only: the shared site footer keeps its own inline links. */
export function mainHtml(html: string) {
  const start = html.indexOf("<main");
  return start < 0 ? html : html.slice(start, html.indexOf("</main>", start));
}

/** Every action row on the page: the children of each portal-actions group. */
export function portalActionRows(html: string) {
  return [
    ...mainHtml(html).matchAll(
      /<(div|nav) class="portal-actions"[^>]*>([\s\S]*?)<\/\1>/g,
    ),
  ].map((match) => match[2]!);
}

/**
 * ADMIN-LAYOUT: navigation actions are grouped buttons, never a dotted
 * inline link list, and each named action sits inside a grouped row.
 */
export function expectPortalActions(
  html: string,
  actions: readonly (readonly [href: string, label: string])[],
) {
  const main = mainHtml(html);
  expect(main).not.toMatch(/<\/a>\s*·\s*<a/);
  const rows = portalActionRows(html).join("\n");
  for (const [href, label] of actions)
    expect(rows).toMatch(
      new RegExp(
        `<a href="${href.replace(/[?.]/g, "\\$&")}" class="button(?: secondary)?">${label}</a>`,
      ),
    );
}
