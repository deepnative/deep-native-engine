import { workflowReviewCursor } from "./workflow-review-cursor.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { workflowBundle } from "./workflow-registry.ts";
import { workflowReviewCheck } from "./workflow-review-check.ts";
import {
  reviewExecute,
  reviewActors,
  reviewWorkspace,
  reviewDeny,
  type WorkflowReviewContext,
} from "./workflow-review-transaction.ts";
export interface WorkflowReviewSource {
  workflowId: string;
  workflowVersion: number;
  instanceId: string;
  revision: number;
}
export interface WorkflowReviewChecked extends WorkflowReviewSource {
  memberId: string;
  expiresAt: string;
}
export interface WorkflowReviewPreview extends WorkflowReviewSource {
  note: string;
  title: string;
  expiresAt: string;
  checked: string;
}
export interface WorkflowReviewReceipt extends WorkflowReviewSource {
  requestId: string;
  expiresAt: string;
  createdAt: string;
  withdrawnAt: string | null;
  state:
    | "assigned"
    | "pending"
    | "withdrawn"
    | "expired"
    | "superseded"
    | "unavailable";
}
export type WorkflowReviewFailure = {
  kind: "denied" | "invalid" | "conflict" | "unavailable";
};
export type WorkflowReviewResult<T> =
  (T & { deadline: number }) | WorkflowReviewFailure;
export interface WorkflowReviewStore {
  receipt(
    token: string,
    requestId: string,
  ): Promise<
    WorkflowReviewResult<{ kind: "ready"; receipt: WorkflowReviewReceipt }>
  >;
  history(
    token: string,
    cursor?: string,
  ): Promise<
    WorkflowReviewResult<{
      kind: "ready";
      receipts: WorkflowReviewReceipt[];
      next: string | null;
    }>
  >;

  preview(
    token: string,
    workflowId: string,
  ): Promise<
    WorkflowReviewResult<{ kind: "ready"; preview: WorkflowReviewPreview }>
  >;
  request(
    token: string,
    input: unknown,
  ): Promise<
    WorkflowReviewResult<{
      kind: "applied" | "replayed";
      receipt: WorkflowReviewReceipt;
    }>
  >;
  inspect(
    token: string,
    operationId: string,
  ): Promise<
    WorkflowReviewResult<{
      kind: "ready";
      receipt: WorkflowReviewReceipt | null;
    }>
  >;
  withdraw(
    token: string,
    requestId: string,
    operationId: string,
    confirm: string,
  ): Promise<
    WorkflowReviewResult<{
      kind: "applied" | "replayed";
      receipt: WorkflowReviewReceipt;
    }>
  >;
}

interface SavedSource {
  instanceId: string;
  revision: number;
  note: string;
  workflowVersion: number;
}
interface SavedRequest {
  id: string;
  instanceId: string;
  workflowId: string;
  workflowVersion: number;
  revision: number;
  expiresAt: Date;
  createdAt: Date;
  withdrawnAt: Date | null;
}
interface SavedOperation {
  actorId: string | null;
  kind: string | null;
  instruction: unknown;
  receiptId: string | null;
}
const same = (a: unknown, b: object) => isDeepStrictEqual(a, b);
const conflict = () => ({ kind: "conflict" as const });
async function source(
  context: WorkflowReviewContext,
  workflowId: string,
  workflowVersion: number,
  lock: "SHARE" | "UPDATE",
) {
  return (
    await context.tx.query<SavedSource>(
      `SELECT instance_id AS "instanceId",revision,note,workflow_version AS "workflowVersion"
     FROM workflow_feedback WHERE member_id=$1 AND workflow_id=$2
      AND workflow_version=$3
     FOR ${lock}`,
      [context.actorId, workflowId, workflowVersion],
    )
  ).rows[0];
}
async function operation(context: WorkflowReviewContext, id: string) {
  return (
    await context.tx.query<SavedOperation>(
      `SELECT actor_id AS "actorId",kind,instruction,receipt_id AS "receiptId"
     FROM workflow_review_operations WHERE operation_id=$1`,
      [id],
    )
  ).rows[0];
}
async function owned(
  context: WorkflowReviewContext,
  id: string,
  lock: "SHARE" | "UPDATE",
) {
  return (
    await context.tx.query<SavedRequest>(
      `SELECT id,source_instance_id AS "instanceId",workflow_id AS "workflowId",workflow_version AS "workflowVersion",
      source_revision AS revision,expires_at AS "expiresAt",created_at AS "createdAt",withdrawn_at AS "withdrawnAt"
     FROM workflow_review_requests WHERE id=$1 AND member_id=$2 FOR ${lock}`,
      [id, context.actorId],
    )
  ).rows[0];
}
async function project(
  context: WorkflowReviewContext,
  row: SavedRequest,
  current: Omit<SavedSource, "note"> | undefined,
): Promise<WorkflowReviewReceipt> {
  const bundle = await context.tx.bounded(() => workflowBundle(row.workflowId));
  const status = (
    await context.tx.query<{ expired: boolean; assigned: boolean }>(
      `SELECT $1::timestamptz<=clock_timestamp() AS expired,EXISTS(SELECT 1 FROM workflow_review_grants WHERE request_id=$2 AND source_instance_id=$3 AND source_revision=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp()) AS assigned`,
      [row.expiresAt, row.id, row.instanceId, row.revision],
    )
  ).rows[0]!;
  return {
    requestId: row.id,
    instanceId: row.instanceId,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    revision: row.revision,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    state: row.withdrawnAt
      ? "withdrawn"
      : status.expired
        ? "expired"
        : !bundle || bundle.version !== row.workflowVersion
          ? "unavailable"
          : !current ||
              current.instanceId !== row.instanceId ||
              current.revision !== row.revision
            ? "superseded"
            : status.assigned
              ? "assigned"
              : "pending",
  };
}
async function reserve(
  context: WorkflowReviewContext,
  workspace: string,
  key: string,
  kind: string,
  instruction: object,
  receipt: string,
) {
  const result = await context.tx.query(
    `INSERT INTO workflow_review_operations(operation_id,actor_id,workspace_id,kind,instruction,receipt_id)
     VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING operation_id`,
    [
      key,
      context.actorId,
      workspace,
      kind,
      JSON.stringify(instruction),
      receipt,
    ],
  );
  return result.rowCount === 1;
}
export function workflowReviewStore(
  pool: Pool,
  options: { enabled: boolean; mode: ApplicationMode },
  secret: string,
): WorkflowReviewStore {
  const checks = workflowReviewCheck(secret);
  const cursors = workflowReviewCursor(secret, "member-history");
  const enabled = options.enabled && options.mode !== "live";
  return {
    async receipt(token, requestId) {
      if (options.mode === "live") return { kind: "unavailable" };
      if (!sampleUuid(requestId)) return { kind: "invalid" };
      return reviewExecute(pool, token, false, async (c) => {
        await reviewActors(c, [], "member");
        await reviewWorkspace(c, c.actorId);
        const d = (
          await c.tx.query<{ workflowId: string; workflowVersion: number }>(
            `SELECT workflow_id AS "workflowId",workflow_version AS "workflowVersion" FROM workflow_review_requests WHERE id=$1 AND member_id=$2`,
            [requestId, c.actorId],
          )
        ).rows[0];
        if (!d) return reviewDeny();
        const current = (
          await c.tx.query<Omit<SavedSource, "note">>(
            `SELECT instance_id AS "instanceId",revision,workflow_version AS "workflowVersion" FROM workflow_feedback WHERE member_id=$1 AND workflow_id=$2 AND workflow_version=$3 FOR SHARE`,
            [c.actorId, d.workflowId, d.workflowVersion],
          )
        ).rows[0];
        const row = await owned(c, requestId, "SHARE");
        if (!row) return reviewDeny();
        return {
          kind: "ready" as const,
          receipt: await project(c, row, current),
        };
      });
    },
    async history(token, cursor) {
      if (options.mode === "live") return { kind: "unavailable" };
      const after = cursor === undefined ? null : cursors.read(cursor);
      if (cursor !== undefined && !after) return { kind: "invalid" };
      return reviewExecute(pool, token, false, async (c) => {
        await reviewActors(c, [], "member");
        await reviewWorkspace(c, c.actorId);
        if (after && after.actorId !== c.actorId) return reviewDeny();
        const discovered = (
          await c.tx.query<{
            id: string;
            workflowId: string;
            workflowVersion: number;
            position: string;
          }>(
            `SELECT id,workflow_id AS "workflowId",workflow_version AS "workflowVersion",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
          FROM workflow_review_requests WHERE member_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid)) ORDER BY created_at,id LIMIT 21`,
            [c.actorId, after?.createdAt ?? null, after?.id ?? null],
          )
        ).rows;
        const scanned = discovered.slice(0, 20);
        const sources = (
          await c.tx.query<Omit<SavedSource, "note"> & { workflowId: string }>(
            `SELECT instance_id AS "instanceId",revision,workflow_id AS "workflowId",workflow_version AS "workflowVersion" FROM workflow_feedback f WHERE member_id=$1 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x("workflowId" text,"workflowVersion" integer) WHERE x."workflowId"=f.workflow_id AND x."workflowVersion"=f.workflow_version) ORDER BY workflow_id,workflow_version FOR SHARE`,
            [
              c.actorId,
              JSON.stringify(
                scanned.map((r) => ({
                  workflowId: r.workflowId,
                  workflowVersion: r.workflowVersion,
                })),
              ),
            ],
          )
        ).rows;
        const rows = (
          await c.tx.query<SavedRequest>(
            `SELECT id,source_instance_id AS "instanceId",workflow_id AS "workflowId",workflow_version AS "workflowVersion",source_revision AS revision,expires_at AS "expiresAt",created_at AS "createdAt",withdrawn_at AS "withdrawnAt" FROM workflow_review_requests WHERE member_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
            [c.actorId, scanned.map((r) => r.id)],
          )
        ).rows;
        const receipts = [];
        for (const item of scanned) {
          const row = rows.find((r) => r.id === item.id);
          if (row)
            receipts.push(
              await project(
                c,
                row,
                sources.find(
                  (s) =>
                    s.workflowId === row.workflowId &&
                    s.workflowVersion === row.workflowVersion,
                ),
              ),
            );
        }
        const last = scanned.at(-1);
        return {
          kind: "ready" as const,
          receipts,
          next:
            discovered.length > 20 && last
              ? cursors.sign({
                  actorId: c.actorId,
                  createdAt: last.position,
                  id: last.id,
                })
              : null,
        };
      });
    },
    async preview(token, workflowId) {
      if (!enabled) return { kind: "unavailable" };
      if (!/^WF-\d{3}$/.test(workflowId)) return { kind: "invalid" };
      return reviewExecute(pool, token, false, async (context) => {
        await reviewActors(context, [], "member");
        await reviewWorkspace(context, context.actorId);
        const bundle = await context.tx.bounded(() =>
          workflowBundle(workflowId),
        );
        if (!bundle) return reviewDeny();
        const current = await source(
          context,
          workflowId,
          bundle.version,
          "SHARE",
        );
        if (!bundle || !current || current.workflowVersion !== bundle.version)
          return reviewDeny();
        const expiry = (
          await context.tx.query<{ expires: Date }>(
            `SELECT date_trunc('milliseconds',LEAST($1::timestamptz,clock_timestamp()+interval '1 hour')) AS expires`,
            [new Date(Math.min(...context.expires.map(Number)))],
          )
        ).rows[0]!;
        context.expires.push(expiry.expires);
        await context.tx.observe(context.expires);
        const checked: WorkflowReviewChecked = {
          workflowId,
          workflowVersion: bundle.version,
          instanceId: current.instanceId,
          revision: current.revision,
          memberId: context.actorId,
          expiresAt: expiry.expires.toISOString(),
        };
        return {
          kind: "ready" as const,
          preview: {
            workflowId,
            workflowVersion: bundle.version,
            instanceId: current.instanceId,
            revision: current.revision,
            title: bundle.title,
            note: current.note,
            expiresAt: checked.expiresAt,
            checked: checks.sign(checked),
          },
        };
      });
    },
    async request(token, input) {
      if (!enabled) return { kind: "unavailable" };
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 3
      )
        return { kind: "invalid" };
      const value = input as Record<string, unknown>;
      const checked = checks.read(value.checked);
      if (!checked || !sampleUuid(value.operationId) || value.confirm !== "yes")
        return { kind: "invalid" };
      const key = value.operationId.toLowerCase();
      return reviewExecute(pool, token, true, async (context) => {
        await reviewActors(context, [], "member");
        const workspace = await reviewWorkspace(context, context.actorId);
        if (checked.memberId !== context.actorId) return reviewDeny();
        const current = await source(
          context,
          checked.workflowId,
          checked.workflowVersion,
          "UPDATE",
        );
        // Read original operation only after the exact-source fence settles.
        const earlier = await operation(context, key);
        if (
          earlier &&
          (earlier.actorId !== context.actorId ||
            earlier.kind !== "request" ||
            !same(earlier.instruction, checked))
        )
          return conflict();
        if (earlier?.receiptId) {
          const row = await owned(context, earlier.receiptId, "SHARE");
          if (!row) return reviewDeny();
          return {
            kind: "replayed" as const,
            receipt: await project(context, row, current),
          };
        }
        const bundle = await context.tx.bounded(() =>
          workflowBundle(checked.workflowId),
        );
        if (
          !current ||
          current.instanceId !== checked.instanceId ||
          current.revision !== checked.revision ||
          current.workflowVersion !== checked.workflowVersion ||
          bundle?.version !== checked.workflowVersion
        )
          return reviewDeny();
        context.expires.push(new Date(checked.expiresAt));
        await context.tx.observe(context.expires);
        const active = await context.tx.query(
          `SELECT id FROM workflow_review_requests WHERE source_instance_id=$1 AND source_revision=$2
           AND withdrawn_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
          [checked.instanceId, checked.revision],
        );
        if (active.rows.length) return conflict();
        const id = randomUUID();
        if (!(await reserve(context, workspace, key, "request", checked, id)))
          return conflict();
        await context.tx.query(
          `INSERT INTO workflow_review_requests(id,workspace_id,member_id,source_instance_id,workflow_id,workflow_version,source_revision,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            workspace,
            context.actorId,
            checked.instanceId,
            checked.workflowId,
            checked.workflowVersion,
            checked.revision,
            checked.expiresAt,
          ],
        );
        const row = (await owned(context, id, "SHARE"))!;
        return {
          kind: "applied" as const,
          receipt: await project(context, row, current),
        };
      });
    },
    async inspect(token, key) {
      if (options.mode === "live") return { kind: "unavailable" };
      if (!sampleUuid(key)) return { kind: "invalid" };
      return reviewExecute(pool, token, false, async (context) => {
        await reviewActors(context, [], "member");
        await reviewWorkspace(context, context.actorId);
        const earlier = await operation(context, key);
        if (!earlier) return { kind: "ready" as const, receipt: null };
        if (
          earlier.actorId !== context.actorId ||
          !earlier.receiptId ||
          !["request", "withdraw"].includes(earlier.kind!)
        )
          return reviewDeny();
        const discovered = (
          await context.tx.query<{
            workflowId: string;
            workflowVersion: number;
          }>(
            'SELECT workflow_id AS "workflowId",workflow_version AS "workflowVersion" FROM workflow_review_requests WHERE id=$1 AND member_id=$2',
            [earlier.receiptId, context.actorId],
          )
        ).rows[0];
        if (!discovered) return reviewDeny();
        const current = await source(
          context,
          discovered.workflowId,
          discovered.workflowVersion,
          "SHARE",
        );
        const row = await owned(context, earlier.receiptId, "SHARE");
        if (!row) return reviewDeny();
        return {
          kind: "ready" as const,
          receipt: await project(context, row, current),
        };
      });
    },
    async withdraw(token, requestId, key, confirm) {
      if (options.mode === "live") return { kind: "unavailable" };
      if (!sampleUuid(requestId) || !sampleUuid(key) || confirm !== "yes")
        return { kind: "invalid" };
      return reviewExecute(pool, token, true, async (context) => {
        await reviewActors(context, [], "member");
        const workspace = await reviewWorkspace(context, context.actorId);
        const instruction = { requestId };
        const discovered = (
          await context.tx.query<{
            workflowId: string;
            workflowVersion: number;
          }>(
            'SELECT workflow_id AS "workflowId",workflow_version AS "workflowVersion" FROM workflow_review_requests WHERE id=$1 AND member_id=$2',
            [requestId, context.actorId],
          )
        ).rows[0];
        if (!discovered) return reviewDeny();
        const current = await source(
          context,
          discovered.workflowId,
          discovered.workflowVersion,
          "SHARE",
        );
        const row = await owned(context, requestId, "UPDATE");
        if (!row) return reviewDeny();
        // A waiting withdrawal observes the operation after its intent fence.
        const earlier = await operation(context, key);
        if (
          earlier &&
          (earlier.actorId !== context.actorId ||
            earlier.kind !== "withdraw" ||
            !same(earlier.instruction, instruction))
        )
          return conflict();
        if (
          !earlier &&
          !(await reserve(
            context,
            workspace,
            key,
            "withdraw",
            instruction,
            requestId,
          ))
        )
          return conflict();
        if (!row.withdrawnAt)
          row.withdrawnAt = (
            await context.tx.query<{ at: Date }>(
              "UPDATE workflow_review_requests SET withdrawn_at=clock_timestamp() WHERE id=$1 RETURNING withdrawn_at AS at",
              [requestId],
            )
          ).rows[0]!.at;
        return {
          kind: earlier ? ("replayed" as const) : ("applied" as const),
          receipt: await project(context, row, current),
        };
      });
    },
  };
}
