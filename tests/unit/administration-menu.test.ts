import { expect, it } from "vitest";
import {
  adminMenu,
  adminMenuFor,
  adminMenuItem,
  adminMenuOnEveryPage,
  withAdminMenu,
  withAdministration,
} from "../../src/administration-presentation.ts";

const all =
  '<a href="/operator">Students</a><a href="/operator/invoices">Invoices</a><a href="/operator/roles">Roles</a><a href="/operator/changes">History</a><a href="/staff">More</a>';

it("ADMINNAV-01 renders the one administrator menu and marks the current page", () => {
  expect(adminMenu()).toBe(
    `<nav class="admin-menu" aria-label="Administration">${all}</nav>`,
  );
  for (const [item, link] of [
    ["students", '<a href="/operator" aria-current="page">Students</a>'],
    [
      "invoices",
      '<a href="/operator/invoices" aria-current="page">Invoices</a>',
    ],
    ["roles", '<a href="/operator/roles" aria-current="page">Roles</a>'],
    ["history", '<a href="/operator/changes" aria-current="page">History</a>'],
    ["more", '<a href="/staff" aria-current="page">More</a>'],
  ] as const) {
    const menu = adminMenu(item);
    expect(menu).toContain(link);
    expect(menu.match(/aria-current/g)).toHaveLength(1);
  }
});

it("HIDE-01 leaves out menu links to areas that are switched off on this site", () => {
  expect(adminMenu("students", { invoices: false })).not.toContain("Invoices");
  const noRoles = adminMenu(undefined, { roles: false });
  expect(noRoles).not.toContain("Roles");
  expect(noRoles).not.toContain("History");
  expect(noRoles).toContain("Invoices");
  expect(adminMenu(undefined, { invoices: true, roles: true })).toContain(all);
});

it("ADMINNAV-01 a page reads which areas are on from the app, and shows every item without it", () => {
  expect(adminMenuFor({ app: { locals: {} } }, "more")).toBe(adminMenu("more"));
  expect(
    adminMenuFor({ app: { locals: { adminMenu: { roles: false } } } }, "more"),
  ).toBe(adminMenu("more", { roles: false }));
});

it("MENUALL-01 names the menu item that owns each administrator address", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [path, item] of [
    ["/operator", "students"],
    [`/operator/coaching/${id}`, "students"],
    [`/operator/coaching/${id}/package`, "students"],
    ["/operator/coaching", "more"],
    ["/operator/invoices", "invoices"],
    [`/operator/invoices/${id}`, "invoices"],
    ["/operator/invoice-reconciliation", "more"],
    ["/operator/roles", "roles"],
    ["/operator/changes", "history"],
    ["/operator/staff-capacity", "more"],
    ["/moderate/proposals", "more"],
  ] as const)
    expect(adminMenuItem(path)).toBe(item);
});

it("MENUALL-01 adds the menu to a page built without it, once, as the first thing in the main content", () => {
  const page = '<body><main id="main"><h1>Report</h1></main></body>';
  const menu = adminMenu("more");
  const added = withAdminMenu(page, menu);
  expect(added).toBe(
    `<body><main id="main">${menu}<h1>Report</h1></main></body>`,
  );
  expect(withAdminMenu(added, menu)).toBe(added);
  expect(withAdminMenu("{}", menu)).toBe("{}");
});

it("MENUALL-01 every report and tool page an admin account opens carries the menu; refusals and other responses pass through", () => {
  const page = '<main id="main"><h1>Staff capacity</h1></main>';
  const run = (
    path: string,
    body: unknown,
    { status = 200, admin = true, locals = {} } = {},
  ) => {
    const sent: unknown[] = [];
    const res = {
      statusCode: status,
      app: { locals },
      send(this: unknown, value?: unknown) {
        expect(this).toBe(res);
        sent.push(value);
        return res;
      },
    };
    let continued = false;
    withAdministration(admin, () =>
      adminMenuOnEveryPage({ path }, res, () => {
        continued = true;
        expect(res.send(body)).toBe(res);
      }),
    );
    expect(continued).toBe(true);
    return sent[0];
  };
  expect(run("/operator/staff-capacity", page)).toBe(
    `<main id="main">${adminMenu("more")}<h1>Staff capacity</h1></main>`,
  );
  expect(run("/moderate/proposals", page)).toContain('class="admin-menu"');
  expect(run("/operator", page)).toContain(
    '<a href="/operator" aria-current="page">Students</a>',
  );
  // HIDE-01: the injected menu follows the areas this site has on.
  expect(
    run("/operator/delivery-cost", page, {
      locals: { adminMenu: { invoices: false } },
    }),
  ).not.toContain("Invoices");
  // Not an administrator address, not an admin account, or not a shown page.
  expect(run("/account", page)).toBe(page);
  expect(run("/operators", page)).toBe(page);
  expect(run("/operator/staff-capacity", page, { admin: false })).toBe(page);
  expect(run("/operator/staff-capacity", page, { status: 403 })).toBe(page);
  const data = { rows: 1 };
  expect(run("/operator/metrics", data)).toBe(data);
  expect(run("/operator/metrics", undefined)).toBeUndefined();
});
