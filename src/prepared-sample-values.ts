import { createHash } from "node:crypto";
import { sampleUuid } from "./sample-feedback-values.ts";

export const PROVIDED_SAMPLE_LABEL =
  "Provided invented example · local synthetic · unreviewed";
const examples = [
  {
    id: "everyday-options",
    goal: "everyday",
    name: "Provided everyday options.txt",
    text: "An invented neighbourhood reading group wants to choose its next activity. Explain three simple options, state what information is missing, and suggest how the group could check the answer. This is a provided practice example; no real people or dates are included.\n",
  },
  {
    id: "work-next-steps",
    goal: "work",
    name: "Provided work next steps.txt",
    text: "An invented team discussed improving its weekly handover. Summarise the agreed next steps, separate proposals from decisions, and flag missing owners or dates instead of inventing them. This is a provided practice example; no client or employer information is included.\n",
  },
  {
    id: "technical-checks",
    goal: "build",
    name: "Provided technical checks.txt",
    text: "An invented application lets people save reading notes. Propose checks for a successful save, an unavailable database, and access by a different member. State assumptions and explain how each outcome could be observed. This is a provided practice example; no real code or credentials are included.\n",
  },
] as const;
export const PREPARED_SAMPLES = Object.freeze(
  examples.map((example) =>
    Object.freeze({
      ...example,
      version: 1,
      digest: createHash("sha256").update(example.text).digest("hex"),
    }),
  ),
);
export type PreparedSample = (typeof PREPARED_SAMPLES)[number];
export const preparedSample = (id: string, version: number, digest: string) =>
  PREPARED_SAMPLES.find(
    (sample) =>
      sample.id === id &&
      sample.version === version &&
      sample.digest === digest,
  );

export interface PreparedInstruction {
  operationId: string;
  templateId: string;
  templateVersion: number;
  templateDigest: string;
  providedExample: true;
  privateReview: true;
}
export function preparedInstruction(
  value: unknown,
): PreparedInstruction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const names = [
    "operationId",
    "templateId",
    "templateVersion",
    "templateDigest",
    "providedExample",
    "privateReview",
  ];
  if (
    Object.keys(row).length !== names.length ||
    !names.every((name) => Object.hasOwn(row, name)) ||
    !sampleUuid(row.operationId) ||
    typeof row.templateId !== "string" ||
    row.templateVersion !== 1 ||
    typeof row.templateDigest !== "string" ||
    row.providedExample !== true ||
    row.privateReview !== true ||
    !preparedSample(row.templateId, row.templateVersion, row.templateDigest)
  )
    return null;
  return row as unknown as PreparedInstruction;
}
export function preparedPayloadDigest(input: PreparedInstruction) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.templateId,
        input.templateVersion,
        input.templateDigest,
        true,
        true,
      ]),
    )
    .digest("hex");
}
export interface ProvidedSampleOrigin {
  kind: "platform-provided-invented";
  templateId: string;
  templateVersion: number;
  templateDigest: string;
  acknowledgedAt: Date | string;
  label: typeof PROVIDED_SAMPLE_LABEL;
}

// Evidence source alias e, immutable provenance alias o. The left join keeps
// legacy origin unknown; it never infers authorship or changes quarantine.
export const PROVIDED_ORIGIN_JOIN = `LEFT JOIN provided_evidence_origins o
 ON o.evidence_id=e.id AND o.workspace_id=e.workspace_id
 AND o.member_id=e.owner_principal_id AND o.storage_key=e.storage_key`;
export const PROVIDED_ORIGIN_SQL = `CASE WHEN o.evidence_id IS NULL THEN NULL ELSE
 jsonb_build_object('kind','platform-provided-invented','templateId',o.template_id,
 'templateVersion',o.template_version,'templateDigest',o.template_digest,
 'acknowledgedAt',o.acknowledged_at,'label','Provided invented example · local synthetic · unreviewed') END AS origin`;
