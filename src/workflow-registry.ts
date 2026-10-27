import { readFile } from "node:fs/promises";
import { parseDraftFile } from "./catalog.ts";

const files = {
  "WF-001": "WF-001-requirements.md",
  "WF-002": "WF-002-test-review.md",
  "WF-003": "WF-003-meeting-actions.md",
} as const;

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
}

export async function workflowBundle(
  id: string,
): Promise<WorkflowBundle | null> {
  if (!Object.hasOwn(files, id)) return null;
  const file = files[id as keyof typeof files];
  const download = await readFile(
    new URL(
      `../assets/docs/content/reviewed-v2/workflows/${file}`,
      import.meta.url,
    ),
    "utf8",
  );
  let parsed: ReturnType<typeof parseDraftFile>;
  try {
    parsed = parseDraftFile(download, file);
  } catch {
    return null;
  }
  const { meta, body } = parsed;
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
    !/^[1-9][0-9]*$/.test(meta.version ?? "") ||
    !Number.isSafeInteger(Number(meta.version)) ||
    Number(meta.version) < 2 ||
    required.some((key) => !meta[key]?.trim()) ||
    !body.trim() ||
    (meta.publication_state !== undefined &&
      meta.publication_state !== "reviewed")
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
  };
}

export async function workflowRegistry(q = ""): Promise<WorkflowBundle[]> {
  const bundles = await Promise.all(
    Object.keys(files).map((id) => workflowBundle(id)),
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
