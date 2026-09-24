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
    new URL(`../assets/docs/content/workflows/${file}`, import.meta.url),
    "utf8",
  );
  const { meta, body } = parseDraftFile(download, file);
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
    lastVerification: meta.last_verification!,
    nextReview: meta.next_review!,
    readiness: meta.readiness!,
    limitations: meta.limitations!,
    body,
    download,
  };
}

export async function workflowRegistry(q = ""): Promise<WorkflowBundle[]> {
  const bundles = await Promise.all(
    Object.keys(files).map(async (id) => (await workflowBundle(id))!),
  );
  const needle = q.trim().toLocaleLowerCase().slice(0, 100);
  return bundles.filter((bundle) =>
    `${bundle.title} ${bundle.goal} ${bundle.backgrounds}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
