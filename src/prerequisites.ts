import type { ContentVersion } from "./catalog.ts";
import type { Exercise, LessonActivity } from "./store.ts";

export type PrerequisiteAtom =
  | {
      kind: "lesson";
      id: string;
      version: number;
      activity: "started" | "self-assessed";
    }
  | {
      kind: "exercise";
      id: "clear-instructions";
      version: 1;
      activity: "completed";
    };
export interface PrerequisiteSpec {
  schemaVersion: 1;
  all: PrerequisiteAtom[];
}

const lessonId = /^[A-Z]{2,5}-[0-9]{3}$/;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validPrerequisiteSpec(
  value: unknown,
): value is PrerequisiteSpec {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "all"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.all) ||
    value.all.length > 8
  )
    return false;
  const seen = new Set<string>();
  for (const atom of value.all) {
    if (
      !record(atom) ||
      !exactKeys(atom, ["kind", "id", "version", "activity"]) ||
      !Number.isSafeInteger(atom.version) ||
      (atom.version as number) < 1 ||
      (atom.version as number) > 2147483647
    )
      return false;
    if (atom.kind === "lesson") {
      if (
        typeof atom.id !== "string" ||
        !lessonId.test(atom.id) ||
        !["started", "self-assessed"].includes(atom.activity as string)
      )
        return false;
    } else if (atom.kind === "exercise") {
      if (
        atom.id !== "clear-instructions" ||
        atom.version !== 1 ||
        atom.activity !== "completed"
      )
        return false;
    } else return false;
    const identity = `${atom.kind}:${atom.id}:${atom.version}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
  }
  return true;
}

export function effectivePrerequisiteSpec(
  structured: unknown,
  legacy: string,
): PrerequisiteSpec | null {
  if (structured !== null && structured !== undefined)
    return validPrerequisiteSpec(structured) ? structured : null;
  const text = legacy.trim();
  if (!text || text.toLowerCase() === "none")
    return { schemaVersion: 1, all: [] };
  if (text === "LOCAL-FIRST-EXERCISE-COMPLETE")
    return {
      schemaVersion: 1,
      all: [
        {
          kind: "exercise",
          id: "clear-instructions",
          version: 1,
          activity: "completed",
        },
      ],
    };
  return null;
}

export function prerequisitesMet(
  item: ContentVersion,
  catalog: ContentVersion[],
  progress: Exercise | undefined,
  activity: LessonActivity[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  // Cache only this snapshot; subtree height preserves the limit on every path.
  const heights = new Map<string, number>();
  function visit(
    current: ContentVersion,
    ancestors: ReadonlySet<string>,
  ): number {
    const identity = `${current.id}:${current.version}`;
    if (ancestors.has(identity) || ancestors.size > 32) return 0;
    const cached = heights.get(identity);
    if (cached !== undefined) return ancestors.size + cached <= 33 ? cached : 0;
    if (
      current.origin !== "curated" ||
      current.state !== "published" ||
      current.requiresQualifiedSignoff ||
      catalog.some(
        (other) =>
          other.id === current.id &&
          other.version > current.version &&
          other.publishedAt !== null,
      )
    )
      return 0;
    const spec = effectivePrerequisiteSpec(
      current.structuredPrerequisites,
      current.prerequisites,
    );
    if (!spec) return 0;
    const path = new Set(ancestors).add(identity);
    let height = 1;
    for (const atom of spec.all) {
      if (atom.kind === "exercise") {
        if (!(progress?.has_completed_version ?? progress?.completed_at))
          return 0;
      } else {
        const source = catalog.find(
          (candidate) =>
            candidate.id === atom.id &&
            candidate.version === atom.version &&
            candidate.kind === "lesson",
        );
        if (!source) return 0;
        const childHeight = visit(source, path);
        if (!childHeight) return 0;
        const observed = activity.find(
          (entry) =>
            entry.contentId === atom.id &&
            entry.contentVersion === atom.version,
        );
        if (
          !(atom.activity === "started"
            ? observed?.startedAt
            : observed?.selfAssessedAt)
        )
          return 0;
        height = Math.max(height, childHeight + 1);
      }
    }
    heights.set(identity, height);
    return height;
  }
  return visit(item, seen) > 0;
}
