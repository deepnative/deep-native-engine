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

/**
 * INVOICELIST-01: an invoice number as people read it. A number that ends in
 * a full account-style reference keeps only its first eight characters.
 */
export function shortInvoiceNumber(number: string) {
  return number.replace(
    /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    "$1",
  );
}

/** True when this request's account holds the admin role (see above). */
export function administrationAvailable(): boolean {
  return administration.getStore() === true;
}

/**
 * MENUALL-01 (#850): which menu item owns an administrator address. A
 * student's pages belong to Students, an invoice to Invoices, and the reports
 * and tools listed under More to More.
 */
export function adminMenuItem(path: string): AdminMenuItem {
  if (path === "/operator" || /^\/operator\/coaching\/./.test(path))
    return "students";
  if (/^\/operator\/invoices(\/|$)/.test(path)) return "invoices";
  if (path === "/operator/roles") return "roles";
  if (path === "/operator/changes") return "history";
  return "more";
}

/**
 * MENUALL-01: a page that was built without the menu gets it as the first
 * thing in its main content. A page that already carries it is left alone.
 */
export function withAdminMenu(html: string, menu: string): string {
  return html.includes('class="admin-menu"')
    ? html
    : html.replace('<main id="main">', `<main id="main">${menu}`);
}

/**
 * MENUALL-01: every administrator page that renders for an admin account
 * carries the menu, including the reports and tools under More that are built
 * elsewhere. It only adds links to a page the route already chose to show:
 * refusals, redirects and non-page responses pass through untouched.
 */
export function adminMenuOnEveryPage(
  req: { path: string },
  res: {
    statusCode: number;
    send: (body?: unknown) => unknown;
    app: { locals: Record<string, unknown> };
  },
  next: () => void,
) {
  if (/^\/(operator|moderate)(\/|$)/.test(req.path)) {
    const send = res.send.bind(res);
    res.send = (body?: unknown) =>
      send(
        typeof body === "string" &&
          res.statusCode === 200 &&
          administrationAvailable()
          ? withAdminMenu(body, adminMenuFor(res, adminMenuItem(req.path)))
          : body,
      );
  }
  next();
}
