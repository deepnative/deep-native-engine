import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUNDS, GOALS } from "./content.ts";
import { parseDraftFile, validDraft, type DraftContent } from "./catalog.ts";

// Bytes reviewed in #93. Changes require a new editorial record/version.
export const FOUNDATION_PACK = [
  [
    "FND-001",
    "ai-literacy",
    "586f4b189fbed4d44208a1ccf6ea2e111b616686112dff8a11eaba65469d4d06",
  ],
  [
    "FND-002",
    "clear-requests",
    "ed24db3df9c205f5e3288b5f6c7c908b279750679da3a0a2551294157bf5b2ee",
  ],
  [
    "FND-003",
    "check-outputs",
    "040191ed7b6ee9b1c01784e4819d5e1ea2c21b30112d91caeb4a5c638d664833",
  ],
  [
    "FND-004",
    "privacy-rights",
    "a81642cf418549c73f5f87041a377230d971e91042db57afceb2bf279f14bf0a",
  ],
  [
    "FND-005",
    "practical-workflows",
    "de47809375ad26c60fbe3a41ae585643d5a30995bf2ab61917da102f72f2f272",
  ],
  [
    "FND-006",
    "participation",
    "de978a9af2c2cb91f70ba31536d95244d122d3c4f0e160e764b15b7d1e419e53",
  ],
] as const;

export async function reviewedFoundation(): Promise<DraftContent[]> {
  return Promise.all(
    FOUNDATION_PACK.map(async ([id, name, digest]) => {
      const file = `${id}-${name}.md`;
      const text = await readFile(
        new URL(
          `../assets/docs/content/reviewed-v2/foundation/${file}`,
          import.meta.url,
        ),
        "utf8",
      );
      if (createHash("sha256").update(text).digest("hex") !== digest)
        throw new Error("Reviewed foundation bytes unavailable");
      const { meta, body, prerequisites } = parseDraftFile(text, file);
      const item: DraftContent = {
        id,
        version: 2,
        kind: "lesson",
        origin: "curated",
        title: meta.title!,
        body: `Suggested preparation (guidance, not an access requirement): ${prerequisites}\n\n${body}`,
        owner: meta.owner!,
        sources: `${meta.sources}; reviewed foundation 2026-10-27; SHA-256 ${digest}`,
        rights: meta.rights!,
        goals: Object.keys(GOALS),
        backgrounds: Object.keys(BACKGROUNDS),
        domains: [],
        prerequisites: "",
        structuredPrerequisites: { schemaVersion: 1, all: [] },
        minimumExperience: "new",
        rubric: null,
        rubricVersion: null,
      };
      if (meta.id !== id || meta.version !== "2" || !validDraft(item))
        throw new Error("Reviewed foundation metadata unavailable");
      return item;
    }),
  );
}

export function isReviewedFoundation(
  item: Pick<DraftContent, "id" | "version" | "origin" | "sources">,
): boolean {
  return (
    item.version === 2 &&
    item.origin === "curated" &&
    FOUNDATION_PACK.some(
      ([id, , digest]) =>
        item.id === id &&
        item.sources.endsWith(
          `reviewed foundation 2026-10-27; SHA-256 ${digest}`,
        ),
    )
  );
}
