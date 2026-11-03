import { expect, it } from "vitest";
import { starterGuidanceExample } from "../../src/starter-guidance-views.ts";
import { accountPage, page } from "../../src/views.ts";

it("NAV-01 exposes account, logout, coaching and administration in shared navigation", () => {
  const html = page("Learning", "<h1>Learning</h1>");
  const navigation = html.match(
    /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  expect(navigation).toBeDefined();
  expect(navigation).toContain('href="/account/coaching">Top up hours</a>');
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
