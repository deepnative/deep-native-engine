import { expect, it } from "vitest";
import {
  adminMenu,
  adminMenuFor,
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
