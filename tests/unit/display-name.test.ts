import { describe, expect, it } from "vitest";
import { profileStart, profileEdit } from "../../src/validation.ts";
import { accountPage, welcome } from "../../src/views.ts";

const choices = { background: "explorer", goal: "everyday" };
describe("NAME01/02/05 required display names", () => {
  for (const parse of [profileStart, profileEdit]) {
    it.each([
      undefined,
      "",
      "   ",
      "a".repeat(81),
      "Sam\nSmith",
      "Sam\u0000Smith",
      ["Sam"],
      42,
    ])(
      "rejects missing or invalid name %j without losing safe choices",
      (display_name) => {
        const result = parse({ ...choices, display_name });
        expect(result.input).toBeNull();
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: "display_name" }),
        );
        expect(result.attempted).toMatchObject(choices);
      },
    );
    it("accepts and trims an ordinary Unicode name without claiming verified identity", () => {
      expect(
        parse({ ...choices, display_name: "  李明 · Sam O’Neil  " }).input,
      ).toMatchObject({ displayName: "李明 · Sam O’Neil", ...choices });
    });
  }
  it("uses a labelled required native registration field", () => {
    const html = welcome("csrf");
    expect(html).toContain('for="display_name">Display name');
    expect(html).toMatch(/<input[^>]*name="display_name"[^>]*required/);
  });
  it("NAME04 prompts a legacy member without removing account access", () => {
    const html = accountPage(
      { id: "legacy", ...choices } as Parameters<typeof accountPage>[0],
      "csrf",
      "unavailable",
    );
    expect(html).toContain("Add your display name");
    expect(html).toContain('action="/profile"');
    expect(html).toContain('href="/learn"');
  });
});
