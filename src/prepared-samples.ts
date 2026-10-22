import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
  type SampleFailureKind,
} from "./sample-feedback-lifetime.ts";
import {
  PREPARED_SAMPLES,
  preparedInstruction,
  preparedPayloadDigest,
  preparedSample,
  PROVIDED_SAMPLE_LABEL,
  type ProvidedSampleOrigin,
} from "./prepared-sample-values.ts";

export interface PreparedReceipt {
  receiptId: string;
  evidenceId: string | null;
  createdAt: Date;
  state: "available" | "withdrawn" | "removed";
  origin: ProvidedSampleOrigin | null;
}
type Failure = { kind: SampleFailureKind | "disabled" };
export interface PreparedSampleStore {
  open(
    token: string,
  ): Promise<Failure | { kind: "ready"; goal: string; deadline: number }>;
  create(
    token: string,
    input: unknown,
  ): Promise<
    | Failure
    | {
        kind: "created" | "replayed";
        receipt: PreparedReceipt;
        deadline: number;
      }
  >;
  inspect(
    token: string,
    operationId: string,
  ): Promise<
    | Failure
    | { kind: "ready"; receipt: PreparedReceipt; deadline: number }
    | { kind: "absent"; deadline: number }
  >;
}
interface Context {
  tx: SampleTransaction;
  memberId: string;
  workspaceId: string;
  expires: Date;
  goal: string;
}
const deny = (kind: SampleFailureKind): never => {
  throw new SampleFeedbackFailure(kind);
};
export function preparedSamplesEnabled(options: {
  enabled?: boolean;
  mode?: ApplicationMode;
  origin: string;
  hostedOrigin?: string;
}) {
  if (
    options.enabled !== true ||
    (options.mode !== "demo" && options.mode !== "test")
  )
    return false;
  try {
    const url = new URL(options.origin);
    if (options.hostedOrigin !== undefined)
      return (
        options.origin === options.hostedOrigin &&
        url.origin === options.origin &&
        url.protocol === "https:" &&
        url.port === "" &&
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          url.hostname,
        ) &&
        !url.hostname.endsWith(".localhost")
      );
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}
export function preparedSampleStore(
  pool: Pool,
  options: {
    enabled: boolean;
    mode: ApplicationMode;
    origin: string;
    hostedOrigin?: string;
  },
): PreparedSampleStore {
  const enabled = preparedSamplesEnabled(options);
  async function execute<T extends object>(
    token: string,
    writing: boolean,
    use: (context: Context) => Promise<T>,
  ): Promise<Failure | (T & { deadline: number })> {
    if (!sampleToken(token)) return { kind: "denied" };
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const principal = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='member'
            AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) return deny("denied");
        await tx.observe([principal.expires]);
        const workspace = (
          await tx.query<{ id: string; goal: string }>(
            `SELECT w.id,l.goal FROM workspaces w JOIN learners l ON l.id=w.owner_principal_id
            WHERE w.owner_principal_id=$1 AND w.deleting_at IS NULL FOR ${writing ? "UPDATE" : "SHARE"} OF w`,
            [principal.id],
          )
        ).rows[0];
        if (!workspace) return deny("denied");
        await tx.observe([principal.expires]);
        const result = await use({
          tx,
          memberId: principal.id,
          workspaceId: workspace.id,
          expires: principal.expires,
          goal: workspace.goal,
        });
        await tx.observe([principal.expires]);
        return { ...result, deadline: tx.deadline() };
      });
    } catch (error) {
      // The shared lifetime boundary normalizes acquisition, callback, COMMIT
      // and release failures to SampleFeedbackFailure before rejecting.
      return { kind: (error as SampleFeedbackFailure).kind };
    }
  }
  async function receipt(context: Context, operationId: string) {
    const { tx, memberId, workspaceId } = context;
    type Operation = {
      receiptId: string;
      evidenceId: string | null;
      createdAt: Date;
      digest: string;
      memberId: string;
      workspaceId: string;
    };
    const discover = `SELECT id AS "receiptId",evidence_id AS "evidenceId",created_at AS "createdAt",payload_digest AS digest,
       member_id AS "memberId",workspace_id AS "workspaceId" FROM provided_evidence_operations WHERE operation_id=$1`;
    // Discover without holding the child row: normal erasure locks its source
    // first, then clears the operation's FK. Match that order to avoid a cycle.
    const discovered = (await tx.query<Operation>(discover, [operationId]))
      .rows[0];
    if (!discovered) return undefined;
    if (
      discovered.memberId !== memberId ||
      discovered.workspaceId !== workspaceId
    )
      return deny("denied");
    type Source = {
      state: string;
      consent: boolean;
      templateId: string;
      templateVersion: number;
      templateDigest: string;
      acknowledgedAt: Date;
    };
    let source: Source | undefined;
    if (discovered.evidenceId !== null) {
      source = (
        await tx.query<Source>(
          `SELECT e.quarantine_state AS state,e.private_review_allowed AS consent,o.template_id AS "templateId",
          o.template_version AS "templateVersion",o.template_digest AS "templateDigest",o.acknowledged_at AS "acknowledgedAt"
         FROM evidence_objects e JOIN provided_evidence_origins o ON o.evidence_id=e.id
         AND o.workspace_id=e.workspace_id AND o.member_id=e.owner_principal_id AND o.storage_key=e.storage_key
         WHERE e.id=$1 AND e.workspace_id=$2 AND e.owner_principal_id=$3 FOR SHARE OF e`,
          [discovered.evidenceId, workspaceId, memberId],
        )
      ).rows[0];
    }
    // Re-read after the source wait; deletion may have committed SET NULL.
    const operation = (
      await tx.query<Operation>(
        `SELECT id AS "receiptId",evidence_id AS "evidenceId",created_at AS "createdAt",payload_digest AS digest,
       member_id AS "memberId",workspace_id AS "workspaceId" FROM provided_evidence_operations WHERE operation_id=$1 FOR SHARE`,
        [operationId],
      )
    ).rows[0];
    if (!operation) return undefined;
    if (
      operation.memberId !== memberId ||
      operation.workspaceId !== workspaceId
    )
      return deny("denied");
    let origin: ProvidedSampleOrigin | null = null,
      state: PreparedReceipt["state"] = "removed";
    if (operation.evidenceId !== null) {
      if (!source || operation.evidenceId !== discovered.evidenceId)
        return deny("unavailable");
      if (
        !preparedSample(
          source.templateId,
          source.templateVersion,
          source.templateDigest,
        )
      )
        return deny("unavailable");
      // Never expose a deleting source as reusable, and never recreate it.
      if (source.state !== "deleting") {
        origin = {
          kind: "platform-provided-invented",
          templateId: source.templateId,
          templateVersion: source.templateVersion,
          templateDigest: source.templateDigest,
          acknowledgedAt: source.acknowledgedAt,
          label: PROVIDED_SAMPLE_LABEL,
        };
        state = source.consent ? "available" : "withdrawn";
      }
    }
    return {
      digest: operation.digest,
      value: {
        receiptId: operation.receiptId,
        evidenceId: state === "removed" ? null : operation.evidenceId,
        createdAt: operation.createdAt,
        state,
        origin,
      } satisfies PreparedReceipt,
    };
  }
  return {
    async open(token) {
      if (!enabled) return { kind: "disabled" };
      return execute(token, false, async (context) => ({
        kind: "ready" as const,
        goal: context.goal,
      }));
    },
    async create(token, value) {
      if (!enabled) return { kind: "disabled" };
      const input = preparedInstruction(value);
      if (!input) return { kind: "invalid" };
      const sample = PREPARED_SAMPLES.find(
        (row) => row.id === input.templateId,
      )!;
      return execute(token, true, async (context) => {
        const { tx, memberId, workspaceId, expires } = context;
        await tx.query("SELECT pg_advisory_xact_lock(50301,hashtext($1))", [
          input.operationId,
        ]);
        await tx.observe([expires]);
        const previous = await receipt(context, input.operationId);
        const payload = preparedPayloadDigest(input);
        if (previous) {
          if (previous.digest !== payload) return deny("conflict");
          return { kind: "replayed" as const, receipt: previous.value };
        }
        const id = randomUUID(),
          key = randomUUID();
        await tx.query(
          `INSERT INTO evidence_objects(id,workspace_id,owner_principal_id,original_name,media_type,
          byte_size,sha256,storage_key,quarantine_state,private_review_allowed,community_publication_allowed,rights_attested_at)
          VALUES($1,$2,$3,$4,'text/plain',$5,$6,$7,'clean',true,false,clock_timestamp())`,
          [
            id,
            workspaceId,
            memberId,
            sample.name,
            Buffer.byteLength(sample.text),
            sample.digest,
            key,
          ],
        );
        await tx.query(
          `INSERT INTO provided_evidence_origins(evidence_id,workspace_id,member_id,storage_key,template_id,template_version,template_digest)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            workspaceId,
            memberId,
            key,
            sample.id,
            sample.version,
            sample.digest,
          ],
        );
        await tx.query(
          `INSERT INTO provided_evidence_operations(id,operation_id,workspace_id,member_id,payload_digest,evidence_id)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), input.operationId, workspaceId, memberId, payload, id],
        );
        const saved = await receipt(context, input.operationId);
        if (!saved) return deny("unavailable");
        return { kind: "created" as const, receipt: saved.value };
      });
    },
    async inspect(token, operationId) {
      // Rollback disables creation, not current-owner original-outcome reads.
      if (!sampleUuid(operationId)) return { kind: "invalid" };
      return execute(token, false, async (context) => {
        const retained = await receipt(context, operationId);
        return retained
          ? { kind: "ready" as const, receipt: retained.value }
          : { kind: "absent" as const };
      });
    },
  };
}
