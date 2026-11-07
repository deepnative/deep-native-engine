import { expect, it } from "vitest";
import { starterGuidanceExample } from "../../src/starter-guidance-views.ts";
import { withAdministration } from "../../src/administration-presentation.ts";
import { withCurrentPath } from "../../src/navigation-presentation.ts";
import { withAccountView, type AccountRole } from "../../src/account-view.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import { accountPage, dashboard, page } from "../../src/views.ts";

const views = (view: AccountRole) => ({
  roles: ["student", "coach", "admin"] as AccountRole[],
  view,
  csrf: "c".repeat(64),
});
it("NAV-01 exposes account, logout, coaching and administration in shared navigation", () => {
  const nav = (view: AccountRole) =>
    withAdministration(true, () =>
      withAccountView(views(view), () => page("Learning", "<h1>Learning</h1>")),
    ).match(
      /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
    )?.[1];
  const navigation = nav("student");
  expect(navigation).toBeDefined();
  expect(navigation).toContain(
    'href="/account/coaching">Monthly coaching hours</a>',
  );
  for (const path of [
    "/learn",
    "/account",
    "/account/coaching",
    "/account/sign-out",
  ])
    expect(navigation).toContain(`href="${path}"`);
  // ROLES-02: Administration belongs to the admin view's header.
  expect(nav("admin")).toContain('href="/admin">Administration</a>');
  const guidance = (view: AccountRole) =>
    withAdministration(true, () =>
      withAccountView(views(view), () => starterGuidanceExample("everyday")),
    );
  for (const path of ["/account", "/account/sign-out", "/account/coaching"])
    expect(guidance("student")).toContain(`href="${path}"`);
  expect(guidance("admin")).toContain('href="/admin"');
  expect(guidance("coach")).toContain('href="/coach"');
});
it.each(["unlinked", "unavailable"] as const)(
  "NAV-03 makes logout available to %s accounts",
  (status) => {
    const html = accountPage(
      { id: "invented", background: "explorer", goal: "everyday" },
      "a".repeat(64),
      status,
    );
    expect(html).toContain('href="/account/sign-out"');
    expect(html).not.toContain("Sign-out requires a verified email");
  },
);
it.each(["linked", "unlinked", "unavailable"] as const)(
  "ACCT-LAYOUT-02 renders the %s account page in its own account layout",
  (status) => {
    const html = withAdministration(true, () =>
      accountPage(
        { id: "invented", background: "explorer", goal: "everyday" },
        "a".repeat(64),
        status,
      ),
    );
    const main = html.match(/<main id="main">([\s\S]*)<\/main>/)?.[1] ?? "";
    expect(main).toMatch(/^<div class="account-page">/);
    expect(main).not.toContain('class="reading"');
    expect(main).toMatch(
      /<section class="account-recovery"[^>]*><h2>(Verified email linked|This browser only|Email recovery is unavailable)<\/h2>/,
    );
    const links = html.match(/<p class="account-links">([\s\S]*?)<\/p>/)?.[1];
    expect(links?.match(/<a class="button secondary" href=/g)).toHaveLength(5);
  },
);
it.each(["linked", "unlinked", "unavailable"] as const)(
  "NAV-05 hides Administration from the %s account page when entry is off",
  (status) => {
    const render = () =>
      accountPage(
        { id: "invented", background: "explorer", goal: "everyday" },
        "a".repeat(64),
        status,
      );
    expect(withAdministration(false, render)).not.toContain('href="/admin"');
    expect(withAdministration(false, render)).toContain(
      'href="/account/coaching">Monthly coaching hours</a>',
    );
    expect(withAdministration(true, render)).toContain('href="/admin"');
  },
);
it.each([
  ["/learn", "Learning"],
  ["/learn/notebooks", "Learning"],
  ["/account", "Account"],
  ["/account/purchases", "Account"],
  ["/account/coaching", "Monthly coaching hours"],
  ["/account/coaching/save", "Monthly coaching hours"],
  ["/admin", "Administration"],
  ["/operator/coaching", "Administration"],
  ["/account/sign-out", "Sign out"],
  ["/readiness", null],
])("NAV-07 marks only the header destination that owns %s", (path, label) => {
  const html = withAdministration(true, () =>
    withAccountView(
      views(label === "Administration" ? "admin" : "student"),
      () => withCurrentPath(path, () => page("Page", "<h1>Page</h1>")),
    ),
  );
  const current = [...html.matchAll(/aria-current="page">([^<]+)</g)].map(
    (m) => m[1],
  );
  expect(current).toEqual(label ? [label] : []);
});
it("NAV-07 marks nothing when rendered outside a request", () => {
  expect(page("Page", "<h1>Page</h1>")).not.toContain("aria-current");
});

const member = { id: "invented", background: "explorer", goal: "everyday" };
const accountText = (
  status: "linked" | "unlinked" | "unavailable",
  passwordSet = false,
) =>
  accountPage(member as never, "a".repeat(64), status, passwordSet)
    .match(/<main id="main">([\s\S]*)<\/main>/)![1]!
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
const statuses = [
  ["linked", false],
  ["unlinked", true],
  ["unlinked", false],
  ["unavailable", false],
] as const;

it.each(statuses)(
  "ACCT-PLAIN-02 hosted %s account page (password %s) has no local-preview wording",
  (status, passwordSet) => {
    const hosted = withHosting(true, () => accountText(status, passwordSet));
    expect(hosted).toContain("Delete my account and all its saved work.");
    expect(hosted).toContain("Appointments are not scheduled here.");
    expect(hosted).not.toMatch(/preview/i);
    const local = withHosting(false, () => accountText(status, passwordSet));
    expect(local).toContain("Delete my local preview and all its saved work.");
    expect(local).toContain("Delete this preview");
    expect(local).toContain("This preview does not schedule appointments.");
  },
);
it.each([
  ["linked", false, "To come back, sign in with your verified email."],
  ["unlinked", true, "To come back, sign in with your email and password."],
] as const)(
  "ACCT-PLAIN-03 %s sign-out text keeps its promises in plain language",
  (status, passwordSet, returning) => {
    const text = accountText(status, passwordSet);
    expect(text).toContain(
      "This signs you out of this browser. Any copy of this sign-in saved elsewhere stops working too.",
    );
    expect(text).toContain("Your saved work stays in this account.");
    expect(text).toContain(returning);
    expect(text).toContain("We won’t email you unless you ask us to.");
  },
);
it.each(statuses)(
  "ACCT-PLAIN-04 %s account page (password %s) avoids technical terms",
  (status, passwordSet) => {
    const text = accountText(status, passwordSet);
    for (const term of [
      /\btoken\b/i,
      /\bcookies?\b/i,
      /\bsession\b/i,
      /self-reported/i,
      /location-style/i,
      /verified identity/i,
      /ending access/i,
      /grant staff/i,
    ])
      expect(text).not.toMatch(term);
  },
);
it("ACCT-PLAIN-05 the export paragraph lists the same records in plain language", () => {
  const paragraph = withHosting(true, () =>
    dashboard(member as never, undefined, "a".repeat(64)),
  )
    .match(/<a href="\/member\/export">[\s\S]*?<\/p>/)![0]
    .replace(/<[^>]+>/g, "");
  expect(paragraph).toBe(
    "Download my structured records. You get JSON files with your current profile, learning, plans and saved proposal records. Evidence samples download separately. Each file holds up to 100 records and 256 KiB, and shows your records as they are when you download it. It includes when staff opened your work. It leaves out other audit records, billing records, files made from your evidence, copies held by service providers and backups.",
  );
});
