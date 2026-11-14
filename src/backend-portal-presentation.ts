/** A destination in a backend portal action row: an escaped href and label. */
export type PortalLink = readonly [href: string, label: string];

/**
 * Backend portal pages group navigation as a wrapped row of buttons rather
 * than a dot-separated inline link list. Callers pass already escaped values.
 */
export function portalActions(links: readonly PortalLink[]) {
  return `<div class="portal-actions">${links
    .map(
      ([href, label]) =>
        `<a href="${href}" class="button secondary">${label}</a>`,
    )
    .join("")}</div>`;
}
