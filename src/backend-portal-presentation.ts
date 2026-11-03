/** A destination in a backend portal action row: an escaped href and label. */
export type PortalLink = readonly [href: string, label: string];

/**
 * Backend portal pages group navigation as a wrapped row of buttons rather
 * than a dot-separated inline link list. Only the first link is primary when
 * asked; callers pass already escaped values.
 */
export function portalActions(links: readonly PortalLink[], primary = false) {
  return `<div class="portal-actions">${links
    .map(
      ([href, label], index) =>
        `<a href="${href}" class="button${primary && index === 0 ? "" : " secondary"}">${label}</a>`,
    )
    .join("")}</div>`;
}
