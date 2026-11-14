import { expect, it } from "vitest";
import { withAccountView, type AccountRole } from "../../src/account-view.ts";
import { withAdministration } from "../../src/administration-presentation.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import { withMembership } from "../../src/membership-presentation.ts";
import { withCurrentPath } from "../../src/navigation-presentation.ts";
import {
  accountPage,
  availabilityPage,
  billingOutcome,
  dashboard,
  milestonesPage,
  page,
} from "../../src/views.ts";

// #846: fewer student pages, one profile form, one header for every role.
const member = {
  id: "invented-reference",
  displayName: "Mei Tanaka",
  background: "explorer",
  goal: "everyday",
} as never;
const token = "a".repeat(64);
const main = (html: string) =>
  html.match(/<main id="main">([\s\S]*)<\/main>/)![1]!;
const navigation = (html: string) =>
  html.match(
    /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )![1]!;
const labels = (nav: string) =>
  [...nav.matchAll(/<(?:a|summary)[^>]*>([^<]+)</g)].map((m) => m[1]);
const as = (view: AccountRole, roles: AccountRole[], render: () => string) =>
  withAccountView({ roles, view, csrf: "c".repeat(64) }, render);
const profile = { name: "Mei Tanaka", email: "", company: null, revision: 0 };

it("PROFILE-01 the learning page links to the one profile form on My account", () => {
  const learn = main(dashboard(member, undefined, token));
  expect(learn).toContain(
    '<a href="/account#profile">Change your learning profile</a>',
  );
  expect(learn).not.toContain('action="/profile"');
  expect(learn).not.toContain('name="background_tags"');
  expect(learn).not.toContain('action="/delete"');
  const account = main(accountPage(member, token, "linked"));
  expect(account).toMatch(
    /<section class="profile-form" id="profile"><h2>Your learning profile<\/h2><form method="post" action="\/profile">/,
  );
  expect(
    account.match(
      /type="checkbox" name="(?:background_tags|domain_tags|it_roles)"/g,
    ),
  ).toHaveLength(19);
  expect(account.match(/action="\/delete"/g)).toHaveLength(1);
});

it("PROFILE-01 pages that send a member to change their time zone point at My account", () => {
  expect(main(availabilityPage([], undefined))).toContain(
    'Choose a valid time zone in your <a href="/account#timezone">profile form</a>',
  );
  expect(main(milestonesPage(member, [], token))).toContain(
    '<a href="/account#timezone">Change your time zone in your learning profile</a>',
  );
  expect(main(accountPage(member, token, "linked"))).toContain(
    '<input type="text" id="timezone" name="timezone"',
  );
});

it("PROFILE-01 a refused profile save is shown on My account with its fields", () => {
  const html = accountPage(member, token, "linked", false, false, {
    profileState: {
      attempted: {
        displayName: "<Mei>",
        background: "explorer",
        goal: "everyday",
        backgroundTags: [],
        domainTags: [],
        itRoles: [],
        experience: "",
        timezone: "Nowhere/City",
        weeklyMinutes: "",
        exploratory: false,
      },
      errors: [{ field: "timezone", message: "Enter a valid time zone." }],
    } as never,
  });
  expect(html).toContain("<title>Error in your profile · Deep Native Engine");
  const form = main(html).match(
    /<section class="profile-form"[\s\S]*?<\/section>/,
  )![0];
  expect(form).toContain('<a href="#timezone">Enter a valid time zone.</a>');
  expect(form).toContain('value="Nowhere/City"');
  expect(form).toContain('value="&lt;Mei&gt;"');
});

it("ACCOUNT-01 My account runs who you are, profile, billing, sharing, then your data", () => {
  const html = main(
    withAdministration(false, () =>
      accountPage(member, token, "linked", false, true, {
        billing: { profile },
      }),
    ),
  );
  const order = [
    "<h1>My account</h1>",
    "Mei Tanaka",
    "Student reference:",
    "<h2>Verified email linked</h2>",
    'href="/account/password"',
    'id="profile"',
    'id="billing"',
    '<a href="/account/sharing">Who can see my work</a>',
    "<h2>Your data</h2>",
    'href="/member/export"',
    "<h3>Delete your account</h3>",
    'action="/delete"',
  ].map((part) => html.indexOf(part));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The header already offers these, so the page does not repeat them.
  expect(html).not.toContain("Sign out");
  expect(html).not.toContain('action="/account/sign-out"');
  expect(html).not.toContain('href="/learn"');
  expect(html).not.toContain('href="/account/coaching"');
  expect(html).not.toContain('href="/account/billing"');
  expect(html).not.toContain('class="button secondary" href="/account/');
  expect(html).not.toContain("eyebrow");
});

it.each([
  [
    "linked",
    false,
    "Verified email linked",
    ["/account/password", "/email/sign-in"],
  ],
  [
    "unlinked",
    true,
    "Email not yet verified",
    ["/email/attach", "/account/password"],
  ],
  ["unlinked", false, "This browser only", ["/email/attach"]],
  ["unavailable", false, "Email recovery is unavailable", []],
] as const)(
  "ACCOUNT-01/COPY-01 the %s sign-in summary (password %s) is one short paragraph and plain links",
  (status, passwordSet, heading, links) => {
    const section = main(accountPage(member, token, status, passwordSet)).match(
      /<section class="account-recovery">([\s\S]*?)<\/section>/,
    )![1]!;
    expect(section).toContain(`<h2>${heading}</h2>`);
    expect(section.match(/<p>/g)).toHaveLength(1);
    expect(section.match(/<p>([^<]*)<\/p>/)![1]!.length).toBeLessThan(140);
    expect(
      [...section.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]),
    ).toEqual(links);
  },
);

it("ACCOUNT-01 a member without a display name is asked for one; an owner keeps the administration link", () => {
  const unnamed = {
    id: "invented",
    background: "explorer",
    goal: "everyday",
  } as never;
  const plain = main(
    withAdministration(false, () => accountPage(unnamed, token, "linked")),
  );
  expect(plain).toContain('<a href="#display_name">Add your display name</a>');
  expect(plain).not.toContain('href="/admin"');
  expect(plain).not.toContain("account-sharing");
  expect(plain).not.toContain('id="billing"');
  expect(
    main(withAdministration(true, () => accountPage(unnamed, token, "linked"))),
  ).toContain('<a href="/admin">Administration</a>');
});

it.each([true, false])(
  "ACCOUNT-01 retention is two periods at the delete control with the full list one click away (hosted %s)",
  (hosted) => {
    const html = withHosting(hosted, () =>
      main(accountPage(member, token, "linked")),
    );
    const data = html.slice(html.indexOf('<section class="account-data"'));
    expect(data).toContain(
      "<p>This cannot be undone. Issued invoices stay for 6 years for tax records, and backup copies for up to 30 days.</p>",
    );
    const details = data.match(
      /<details class="deletion-details"><summary>What stays after deletion<\/summary>([\s\S]*?)<\/details>/,
    )![1]!;
    expect(details).toContain('<div id="deletion-kept">');
    expect(details).toContain("Canada Revenue Agency record-keeping rules");
    expect(details).toContain("until December 31, 6 years after the tax year");
    expect(data.indexOf("</details>")).toBeLessThan(
      data.indexOf('action="/delete"'),
    );
    expect(data).toContain(
      hosted ? "Delete my account" : "Delete this preview",
    );
  },
);

it("FOLD-02 billing details are a short form on My account posting to the billing route", () => {
  const html = main(
    accountPage(member, token, "linked", false, false, {
      billing: {
        profile: {
          name: 'Mei "T" <Tanaka>',
          email: "mei@example.test",
          company: "Tanaka & Co",
          revision: 3,
        },
      },
    }),
  );
  const section = html.match(
    /<section class="account-billing" id="billing">([\s\S]*?)<\/section>/,
  )![1]!;
  expect(section).toContain("<h2>Billing details</h2>");
  expect(section).toContain(
    `<form method="post" action="/account/billing"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="revision" value="3">`,
  );
  expect(section).toContain(
    'name="name" autocomplete="name" maxlength="200" value="Mei &quot;T&quot; &lt;Tanaka&gt;" required>',
  );
  expect(section).toContain(
    'name="company" autocomplete="organization" maxlength="200" value="Tanaka &amp; Co">',
  );
  // The invoice email is never forced.
  const email = section.match(/<input type="email"[^>]*>/)![0];
  expect(email).toContain('value="mei@example.test"');
  expect(email).not.toContain("required");
  expect(
    [...section.matchAll(/<label for="[^"]+">([^<]+)<\/label>/g)].map(
      (m) => m[1],
    ),
  ).toEqual([
    "Invoice recipient name",
    "Company name (optional)",
    "Invoice email (optional)",
  ]);
  expect(section).toContain(
    '<button type="submit">Save billing details</button>',
  );
  expect(section).toContain('<a href="/account/purchases">Invoices</a>');
  expect(section).not.toContain('role="status"');
  expect(section).not.toContain('role="alert"');
  // COPY-01: one short line above the fields; the warning sits under its field.
  expect(section.slice(0, section.indexOf("<form"))).toBe(
    "<h2>Billing details</h2><p>Shown on your invoices.</p>",
  );
  expect(section).toMatch(
    /<input type="email"[^>]*aria-describedby="billing-email-help"><p id="billing-email-help" class="small">[^<]*Never enter card or bank details\.<\/p>/,
  );
});

it.each([
  ["saved", "status", "Billing details saved."],
  [
    "invalid",
    "alert",
    "Billing details not saved. Enter a name and a valid email address.",
  ],
  [
    "conflict",
    "alert",
    "Billing details not saved because they changed in another window.",
  ],
  ["email", "alert", "Add an email to save billing details."],
] as const)(
  "FOLD-02 the %s outcome is announced in the billing section",
  (outcome, role, text) => {
    expect(billingOutcome(outcome)).toBe(outcome);
    const html = main(
      accountPage(member, token, "linked", false, false, {
        billing: { profile, outcome },
      }),
    );
    expect(html).toContain(
      `<h2>Billing details</h2><p class="notice" role="${role}">${text}`,
    );
  },
);

it("FOLD-02 only known outcomes are announced", () => {
  for (const value of [undefined, "", "toString", "<script>", ["saved"], 1])
    expect(billingOutcome(value)).toBeUndefined();
});

const everyRole: AccountRole[] = ["student", "coach", "admin"];
it.each([
  [
    "student",
    ["student"],
    ["Learning", "Coaching", "Account", "Sign out"],
    "/account/coaching",
  ],
  [
    "student",
    everyRole,
    ["Learning", "Coaching", "Account", "View: Student", "Sign out"],
    "/account/coaching",
  ],
  [
    "coach",
    everyRole,
    ["Learning", "Coaching", "Account", "View: Coach", "Sign out"],
    "/coach",
  ],
  [
    "admin",
    everyRole,
    ["Learning", "Coaching", "Account", "Admin", "View: Admin", "Sign out"],
    "/coach",
  ],
  [
    "admin",
    ["student", "admin"],
    ["Learning", "Coaching", "Account", "Admin", "View: Admin", "Sign out"],
    "/account/coaching",
  ],
] as const)(
  "HEADER-01 the %s view of %j reads the same labels in the same order",
  (view, roles, expected, coaching) => {
    const nav = navigation(as(view, [...roles], () => page("Page", "")));
    expect(labels(nav)).toEqual(expected);
    expect(nav).toContain(`<a href="${coaching}">Coaching</a>`);
    expect(nav).toContain('<a href="/learn">Learning</a>');
    expect(nav).not.toContain("Coaching hours");
    expect(nav).not.toContain("Administration");
    expect(nav.includes('<a href="/admin">Admin</a>')).toBe(view === "admin");
  },
);

it("HEADER-01 the view switch is one closed control around the unchanged form", () => {
  const nav = navigation(as("admin", everyRole, () => page("Page", "")));
  expect(nav.match(/<details/g)).toHaveLength(1);
  expect(nav).toContain(
    `<details class="view-menu"><summary>View: Admin</summary><form class="view-switch" method="post" action="/account/view"><input type="hidden" name="csrf" value="${"c".repeat(64)}"><button type="submit" name="view" value="student">Switch to student view</button><button type="submit" name="view" value="coach">Switch to coach view</button></form></details>`,
  );
  expect(nav).not.toContain("<details open");
  expect(
    navigation(as("student", ["student"], () => page("Page", ""))),
  ).not.toContain("view-menu");
});

it("HEADER-01 the admin link is the current page inside administration", () => {
  const nav = navigation(
    as("admin", everyRole, () =>
      withCurrentPath("/operator/coaching", () => page("Page", "")),
    ),
  );
  expect(nav).toContain('<a href="/admin" aria-current="page">Admin</a>');
  expect(nav.match(/aria-current/g)).toHaveLength(1);
});

it("HEADER-01 a signed-out visitor is not offered Learning, and the footer drops My courses", () => {
  const signedOut = withMembership(
    { signedIn: false, signInAvailable: true },
    () => page("Page", ""),
  );
  expect(labels(navigation(signedOut))).toEqual(["Sign in", "Create account"]);
  expect(signedOut).not.toContain('href="/learn"');
  expect(signedOut).not.toContain('href="/my-courses"');
  expect(signedOut).toContain('<a href="/programs">Explore programs</a>');
  expect(
    navigation(
      withMembership({ signedIn: false, signInAvailable: false }, () =>
        page("Page", ""),
      ),
    ),
  ).toBe("");
  const signedIn = withMembership(
    { signedIn: true, signInAvailable: true },
    () => page("Page", ""),
  );
  expect(signedIn).toContain('<a href="/my-courses">My courses</a>');
});
