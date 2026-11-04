import { expect, it } from "vitest";
import { myCoursesPage } from "../../src/program-views.ts";

it("FRICTION-08 sends My courses to the real export, not an account page without one", () => {
  const html = myCoursesPage(null, null);
  expect(html).toContain('href="/member/export"');
  expect(html).not.toContain("Account and existing exports");
});
