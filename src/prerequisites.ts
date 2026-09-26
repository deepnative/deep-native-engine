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
  const identity = `${item.id}:${item.version}`;
  if (
    seen.has(identity) ||
    seen.size > 32 ||
    item.origin !== "curated" ||
    item.state !== "published" ||
    item.requiresQualifiedSignoff ||
    catalog.some(
      (other) =>
        other.id === item.id &&
        other.version > item.version &&
        other.publishedAt !== null,
    )
  )
    return false;
  const spec = effectivePrerequisiteSpec(
    item.structuredPrerequisites,
    item.prerequisites,
  );
  if (!spec) return false;
  const path = new Set(seen).add(identity);
  return spec.all.every((atom) => {
    if (atom.kind === "exercise") return Boolean(progress?.completed_at);
    const source = catalog.find(
      (candidate) =>
        candidate.id === atom.id &&
        candidate.version === atom.version &&
        candidate.kind === "lesson",
    );
    if (!source || !prerequisitesMet(source, catalog, progress, activity, path))
      return false;
    const observed = activity.find(
      (entry) =>
        entry.contentId === atom.id && entry.contentVersion === atom.version,
    );
    return atom.activity === "started"
      ? Boolean(observed?.startedAt)
      : Boolean(observed?.selfAssessedAt);
  });
}
