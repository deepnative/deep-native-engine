import { expect, it } from "vitest";
import { accountPage, page } from "../../src/views.ts";

it("NAV-01 exposes account, logout, coaching and administration in shared navigation", () => {
  const html = page("Learning", "<h1>Learning</h1>");
  const navigation = html.match(
    /<nav[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  expect(navigation).toBeDefined();
  for (const path of [
    "/learn",
    "/account",
    "/account/coaching",
    "/admin",
    "/account/sign-out",
  ])
    expect(navigation).toContain(`href="${path}"`);
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
