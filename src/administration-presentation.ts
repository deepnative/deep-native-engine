import { AsyncLocalStorage } from "node:async_hooks";

// Whether this request's member may use administrator entry. Only a request
// that confirmed a verified owner shows the link; routes still authorize.
const administration = new AsyncLocalStorage<boolean>();
export function withAdministration<T>(available: boolean, render: () => T): T {
  return administration.run(available, render);
}
export function administrationLink(html: string): string {
  return administration.getStore() === true ? html : "";
}

/** ADMINNAV-01: the one small menu every administrator page carries. */
export type AdminMenuItem =
  "students" | "invoices" | "roles" | "history" | "more";
/** HIDE-01: areas that are switched off on this site get no menu link. */
export interface AdminMenuAvailable {
  invoices?: boolean;
  roles?: boolean;
}
const ADMIN_MENU: ReadonlyArray<
  readonly [item: AdminMenuItem, href: string, label: string]
> = [
  ["students", "/operator", "Students"],
  ["invoices", "/operator/invoices", "Invoices"],
  ["roles", "/operator/roles", "Roles"],
  ["history", "/operator/changes", "History"],
  ["more", "/staff", "More"],
];
export function adminMenu(
  current?: AdminMenuItem,
  available: AdminMenuAvailable = {},
) {
  const off = (item: AdminMenuItem) =>
    (item === "invoices" && available.invoices === false) ||
    ((item === "roles" || item === "history") && available.roles === false);
  return `<nav class="admin-menu" aria-label="Administration">${ADMIN_MENU.filter(
    ([item]) => !off(item),
  )
    .map(
      ([item, href, label]) =>
        `<a href="${href}"${item === current ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}
/**
 * The menu for this site: administrator entry records which areas are on in
 * `app.locals.adminMenu`; a page mounted without it shows every item.
 */
export function adminMenuFor(
  res: { app: { locals: Record<string, unknown> } },
  current?: AdminMenuItem,
) {
  return adminMenu(
    current,
    res.app.locals.adminMenu as AdminMenuAvailable | undefined,
  );
}
