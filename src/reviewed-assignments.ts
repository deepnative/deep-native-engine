import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { BACKGROUNDS, GOALS } from "./content.ts";
import { parseDraftFile, validDraft, type DraftContent } from "./catalog.ts";
import { reviewedContentImportStore } from "./reviewed-content-import.ts";

export const ASSIGNMENT_PACK = [
  [
    "ASN-001",
    "signup-qa",
    "f5bde7b392087cb898d7ecca575d4f333ac4e3f59eb5af8c5c1bc513716c9fba",
  ],
  [
    "ASN-002",
    "meeting-actions",
    "8d4a483783bfe251d437f6db3c4c111e52c79e10a8d4e99767bbf17c507a2256",
  ],
] as const;

export async function reviewedAssignments(): Promise<DraftContent[]> {
  return Promise.all(
    ASSIGNMENT_PACK.map(async ([id, name, digest]) => {
      const file = `${id}-${name}.md`;
      const text = await readFile(
        new URL(
          `../assets/docs/content/reviewed-v2/assignments/${file}`,
          import.meta.url,
        ),
        "utf8",
      );
      if (createHash("sha256").update(text).digest("hex") !== digest)
        throw new Error("Reviewed assignment bytes unavailable");
      const { meta, body } = parseDraftFile(text, file);
      const item: DraftContent = {
        id,
        version: 2,
        kind: "assignment",
        origin: "curated",
        title: meta.title!,
        body: `Preparation in this service: self-report completion of FND-002 version 2 and FND-003 version 2 through their lesson pages. The checklist shows these observed steps; an equivalent habit is guidance, not an automatically verified completion. This is preparation, not a competence assessment. No code, paid plan, job or staff role is required.\n\n${body}`,
        owner: meta.owner!,
        sources: `${meta.sources}; reviewed assignment 2026-10-27; SHA-256 ${digest}`,
        rights: meta.rights!,
        goals: id === "ASN-001" ? ["build"] : Object.keys(GOALS),
        backgrounds: Object.keys(BACKGROUNDS),
        domains: [],
        prerequisites: "",
        structuredPrerequisites: {
          schemaVersion: 1,
          all: [
            {
              kind: "lesson",
              id: "FND-002",
              version: 2,
              activity: "self-assessed",
            },
            {
              kind: "lesson",
              id: "FND-003",
              version: 2,
              activity: "self-assessed",
            },
          ],
        },
        minimumExperience: "new",
        rubric: body,
        rubricVersion: 1,
      };
      if (
        meta.id !== id ||
        meta.version !== "2" ||
        meta.rubric_version !== "1" ||
        !validDraft(item)
      )
        throw new Error("Reviewed assignment metadata unavailable");
      return item;
    }),
  );
}
export function reviewedAssignmentImportStore(pool: Pool) {
  return reviewedContentImportStore(pool, reviewedAssignments, 103);
}
export function isReviewedAssignment(
  item: Pick<DraftContent, "id" | "version" | "origin" | "sources">,
): boolean {
  return (
    item.version === 2 &&
    item.origin === "curated" &&
    ASSIGNMENT_PACK.some(
      ([id, , digest]) =>
        item.id === id &&
        item.sources.endsWith(
          `reviewed assignment 2026-10-27; SHA-256 ${digest}`,
        ),
    )
  );
}
