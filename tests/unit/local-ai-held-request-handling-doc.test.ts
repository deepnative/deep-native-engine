import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const doc = readFileSync(
  new URL(
    "../../assets/docs/LOCAL-AI-HELD-REQUEST-HANDLING.md",
    import.meta.url,
  ),
  "utf8",
);
it("STAFFHOLD-10 names who can act, what is kept and that erasure cannot be confirmed", () => {
  for (const section of [
    "## We cannot confirm erasure",
    "## Who can do what",
    "## Process for a held request",
    "## What is kept and what is removed",
    "### Why deleting a source keeps a hold",
    "## Known limits",
    "## Rollback",
  ])
    expect(doc).toContain(section);
  expect(doc).toContain(
    "Nothing in this system can confirm that a provider erased",
  );
  expect(doc).toContain("**No AI provider is connected.**");
  expect(doc).not.toMatch(/\b(?:has|have|was|were|is|are) (?:been )?erased\b/i);
});
