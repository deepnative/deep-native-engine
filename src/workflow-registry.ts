import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDraftFile } from "./catalog.ts";

const files = {
  "WF-001": "WF-001-requirements.md",
  "WF-002": "WF-002-test-review.md",
  "WF-003": "WF-003-meeting-actions.md",
} as const;

// Templates come from an explicit Git source release. Tests may point the
// /workflows pages at a fixture release, only in test mode.
const RELEASE = new URL(
  "../assets/docs/content/reviewed-v3/workflows/",
  import.meta.url,
);
export function workflowTestRoot(
  mode: string,
  value: string | undefined,
): URL | undefined {
  if (!value) return undefined;
  if (mode !== "test" || !isAbsolute(value))
    throw Error(
      "DNE_WORKFLOW_ROOT is accepted only in test mode, as an absolute folder.",
    );
  return pathToFileURL(value.endsWith("/") ? value : `${value}/`);
}

export interface WorkflowBundle {
  id: string;
  title: string;
  version: number;
  goal: string;
  backgrounds: string;
  prerequisites: string;
  setup: string;
  supportedEnvironment: string;
  estimatedCost: string;
  permissions: string;
  license: string;
  owner: string;
  sources: string;
  rights: string;
  reviewer: string;
  reviewedOn: string;
  lastVerification: string;
  nextReview: string;
  readiness: string;
  limitations: string;
  body: string;
  download: string;
  // #769: an editor can mark a release unverified; the review date is read
  // from the start of next_review and is null when it is not a real date.
  verification: "maintained" | "unverified";
  nextReviewDate: string | null;
}
export type WorkflowSupport =
  | { state: "current"; nextReview: string }
  | { state: "overdue"; since: string }
  | { state: "unverified" }
  | { state: "undated" };

function reviewDate(value: string): string | null {
  const date = /^(\d{4}-\d{2}-\d{2})(?!\d)/.exec(value)?.[1];
  const time = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
  // Rolled-over dates such as 2026-02-30 do not read back unchanged.
  return date &&
    !Number.isNaN(time) &&
    new Date(time).toISOString().startsWith(date)
    ? date
    : null;
}
// today is a UTC calendar date (YYYY-MM-DD). Support lasts through the
// review date itself; anything unverified or undated is never current.
export function workflowSupport(
  item: WorkflowBundle,
  today: string,
): WorkflowSupport {
  if (item.verification === "unverified") return { state: "unverified" };
  if (!item.nextReviewDate) return { state: "undated" };
  return item.nextReviewDate < today
    ? { state: "overdue", since: item.nextReviewDate }
    : { state: "current", nextReview: item.nextReviewDate };
}

async function source(id: string, root: URL) {
  if (!Object.hasOwn(files, id)) return null;
  const file = files[id as keyof typeof files];
  const download = await readFile(new URL(file, root), "utf8");
  try {
    return { ...parseDraftFile(download, file), download };
  } catch {
    return null;
  }
}
const versionPattern = /^[1-9][0-9]*$/;

export async function workflowBundle(
  id: string,
  root: URL = RELEASE,
): Promise<WorkflowBundle | null> {
  const parsed = await source(id, root);
  if (!parsed) return null;
  const { meta, body, download } = parsed;
  const required = [
    "title",
    "goals",
    "backgrounds",
    "prerequisites",
    "setup",
    "supported_environment",
    "estimated_cost",
    "permissions",
    "license",
    "owner",
    "sources",
    "rights",
    "reviewer",
    "reviewed_on",
    "last_verification",
    "next_review",
    "readiness",
    "limitations",
  ];
  // Publishing/retiring these curated files is an explicit source release.
  // Invalid or retired content never falls back to an older draft.
  if (
    meta.id !== id ||
    !versionPattern.test(meta.version ?? "") ||
    !Number.isSafeInteger(Number(meta.version)) ||
    Number(meta.version) < 2 ||
    required.some((key) => !meta[key]?.trim()) ||
    !body.trim() ||
    (meta.publication_state !== undefined &&
      meta.publication_state !== "reviewed") ||
    (meta.support_state !== undefined &&
      meta.support_state !== "current" &&
      meta.support_state !== "unverified")
  )
    return null;
  return {
    id,
    title: meta.title!,
    version: Number(meta.version),
    goal: meta.goals!,
    backgrounds: meta.backgrounds!,
    prerequisites: meta.prerequisites!,
    setup: meta.setup!,
    supportedEnvironment: meta.supported_environment!,
    estimatedCost: meta.estimated_cost!,
    permissions: meta.permissions!,
    license: meta.license!,
    owner: meta.owner!,
    sources: meta.sources!,
    rights: meta.rights!,
    reviewer: meta.reviewer!,
    reviewedOn: meta.reviewed_on!,
    lastVerification: meta.last_verification!,
    nextReview: meta.next_review!,
    readiness:
      "Editorially reviewed ordinary education for manual use; not qualified assessment",
    limitations: meta.limitations!,
    body,
    download,
    verification:
      meta.support_state === "unverified" ? "unverified" : "maintained",
    nextReviewDate: reviewDate(meta.next_review!),
  };
}

// A retired release is not offered, but its last version stays identified.
export async function retiredWorkflows(
  root: URL = RELEASE,
): Promise<{ id: string; title: string; version: number }[]> {
  const retired = [];
  for (const id of Object.keys(files)) {
    const parsed = await source(id, root);
    const meta = parsed?.meta;
    if (
      meta?.id === id &&
      meta.publication_state === "retired" &&
      versionPattern.test(meta.version ?? "") &&
      Number.isSafeInteger(Number(meta.version)) &&
      meta.title?.trim()
    )
      retired.push({ id, title: meta.title, version: Number(meta.version) });
  }
  return retired;
}

export async function workflowRegistry(
  q = "",
  root: URL = RELEASE,
): Promise<WorkflowBundle[]> {
  const bundles = await Promise.all(
    Object.keys(files).map((id) => workflowBundle(id, root)),
  );
  const needle = q.trim().toLocaleLowerCase().slice(0, 100);
  return bundles
    .filter((bundle): bundle is WorkflowBundle => bundle !== null)
    .filter((bundle) =>
      `${bundle.title} ${bundle.goal} ${bundle.backgrounds}`
        .toLocaleLowerCase()
        .includes(needle),
    );
}
