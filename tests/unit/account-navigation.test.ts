import { expect, it } from "vitest";
import { starterGuidanceExample } from "../../src/starter-guidance-views.ts";
import { withAdministration } from "../../src/administration-presentation.ts";
import { withCurrentPath } from "../../src/navigation-presentation.ts";
import { accountPage, page } from "../../src/views.ts";

it("NAV-01 exposes account, logout, coaching and administration in shared navigation", () => {
  const html = page("Learning", "<h1>Learning</h1>");
  const navigation = html.match(
    /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  expect(navigation).toBeDefined();
  expect(navigation).toContain('href="/account/coaching">Monthly coaching hours</a>');
  for (const path of [
    "/learn",
    "/account",
    "/account/coaching",
    "/admin",
    "/account/sign-out",
  ])
    expect(navigation).toContain(`href="${path}"`);
  const guidance = starterGuidanceExample("everyday");
  for (const path of [
    "/account",
    "/account/sign-out",
    "/account/coaching",
    "/admin",
  ])
    expect(guidance).toContain(`href="${path}"`);
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
  "ACCT-LAYOUT-02 renders the %s account page in its own single-column layout",
  (status) => {
    const html = accountPage(
      { id: "invented", background: "explorer", goal: "everyday" },
      "a".repeat(64),
      status,
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
  const html = withCurrentPath(path, () => page("Page", "<h1>Page</h1>"));
  const current = [...html.matchAll(/aria-current="page">([^<]+)</g)].map(
    (m) => m[1],
  );
  expect(current).toEqual(label ? [label] : []);
});
it("NAV-07 marks nothing when rendered outside a request", () => {
  expect(page("Page", "<h1>Page</h1>")).not.toContain("aria-current");
});
