import { sampleAssignmentUtc } from "./sample-assignment-values.ts";
import { workflowReviewWorklist } from "./workflow-review-worklist.ts";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { workflowBundle } from "./workflow-registry.ts";
import {
  reviewExecute,
  reviewActors,
  reviewWorkspace,
  reviewDeny,
  type WorkflowReviewContext,
} from "./workflow-review-transaction.ts";

interface ExactRequest {
  createdAt: Date;
  id: string;
  memberId: string;
  instanceId: string;
  workflowId: string;
  workflowVersion: number;
  revision: number;
  expires: Date;
  withdrawn: Date | null;
}
interface Checked {
  startsAt: string;
  actorId: string;
  requestId: string;
  moderatorId: string;
  instanceId: string;
  revision: number;
  expiresAt: string;
}
export interface WorkflowReviewGrant {
  startsAt: string;
  grantId: string;
  requestId: string;
  moderatorId: string;
  expiresAt: string;
  revokedAt: string | null;
  state?:
    | "scheduled"
    | "recorded"
    | "revoked"
    | "withdrawn"
    | "expired"
    | "superseded"
    | "unavailable";
}
const columns = `id,member_id AS "memberId",source_instance_id AS "instanceId",workflow_id AS "workflowId",
 workflow_version AS "workflowVersion",source_revision AS revision,created_at AS "createdAt",expires_at AS expires,withdrawn_at AS withdrawn`;
async function discover(c: WorkflowReviewContext, id: string) {
  const r = (
    await c.tx.query<ExactRequest>(
      `SELECT ${columns} FROM workflow_review_requests WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!r) return reviewDeny();
  return r;
}
async function exact(
  c: WorkflowReviewContext,
  discovered: ExactRequest,
  lock: "SHARE" | "UPDATE",
) {
  // Lock the source before the request. Do not select private text for staff
  // until current intent, exact grant and source authority are all fenced.
  const source = (
    await c.tx.query<{ instanceId: string; revision: number }>(
      `SELECT instance_id AS "instanceId",revision FROM workflow_feedback WHERE member_id=$1 AND workflow_id=$2 AND workflow_version=$3 FOR SHARE`,
      [discovered.memberId, discovered.workflowId, discovered.workflowVersion],
    )
  ).rows[0];
  const row = (
    await c.tx.query<ExactRequest>(
      `SELECT ${columns} FROM workflow_review_requests WHERE id=$1 FOR ${lock}`,
      [discovered.id],
    )
  ).rows[0];
  const bundle = await c.tx.bounded(() =>
    workflowBundle(discovered.workflowId),
  );
  if (
    !row ||
    !isDeepStrictEqual(row, discovered) ||
    row.withdrawn ||
    !source ||
    source.instanceId !== row.instanceId ||
    source.revision !== row.revision ||
    !bundle ||
    bundle.version !== row.workflowVersion
  )
    return reviewDeny();
  c.expires.push(row.expires);
  await c.tx.observe(c.expires);
  return row;
}
async function authorities(
  c: WorkflowReviewContext,
  owner: string,
  moderator: string,
  administrator: string,
  role: "platform_admin" | "moderator",
) {
  const { principals, profiles } = await reviewActors(
    c,
    [owner, moderator, administrator],
    role,
  );
  for (const [id, kind, required] of [
    [owner, "member", null],
    [moderator, "staff", "moderator"],
    [administrator, "staff", "platform_admin"],
  ] as const) {
    const p = principals.get(id);
    if (
      !p ||
      p.kind !== kind ||
      p.revoked ||
      (required && profiles.get(id) !== required)
    )
      return reviewDeny();
    c.expires.push(p.expires);
  }
  await c.tx.observe(c.expires);
  return reviewWorkspace(c, owner);
}
async function historicalGrant(
  c: WorkflowReviewContext,
  grantId: string,
  fromOwnedOperation = false,
) {
  const discovered = (
    await c.tx.query<{
      request: string;
      moderator: string;
      administrator: string;
    }>(
      `SELECT request_id AS request,moderator_id AS moderator,administrator_id AS administrator FROM workflow_review_grants WHERE id=$1`,
      [grantId],
    )
  ).rows[0];
  if (!discovered) return reviewDeny();
  const owner = await discover(c, discovered.request);
  await reviewActors(
    c,
    [owner.memberId, discovered.moderator, discovered.administrator],
    "platform_admin",
  );
  if (
    !fromOwnedOperation &&
    discovered.administrator !== c.actorId &&
    !(
      await c.tx.query(
        `SELECT operation_id FROM workflow_review_operations WHERE actor_id=$1 AND receipt_id=$2 AND kind IN ('assign','revoke') LIMIT 1`,
        [c.actorId, grantId],
      )
    ).rowCount
  )
    return reviewDeny();
  await reviewWorkspace(c, owner.memberId);
  const source = (
    await c.tx.query<{ instanceId: string; revision: number }>(
      `SELECT instance_id AS "instanceId",revision FROM workflow_feedback WHERE member_id=$1 AND workflow_id=$2 AND workflow_version=$3 FOR SHARE`,
      [owner.memberId, owner.workflowId, owner.workflowVersion],
    )
  ).rows[0];
  const intent = (
    await c.tx.query<ExactRequest>(
      `SELECT ${columns} FROM workflow_review_requests WHERE id=$1 FOR SHARE`,
      [owner.id],
    )
  ).rows[0];
  const grant = (
    await c.tx.query<{
      request: string;
      moderator: string;
      administrator: string;
      starts: Date;
      expires: Date;
      revoked: Date | null;
      expired: boolean;
      scheduled: boolean;
      authority: boolean;
    }>(
      `SELECT g.request_id AS request,g.moderator_id AS moderator,g.administrator_id AS administrator,g.starts_at AS starts,g.expires_at AS expires,g.revoked_at AS revoked,
    (g.expires_at<=clock_timestamp() OR r.expires_at<=clock_timestamp()) AS expired,
    g.starts_at>clock_timestamp() AS scheduled,
    EXISTS(SELECT 1 FROM principals owner JOIN principals m ON m.id=g.moderator_id JOIN staff_profiles mp ON mp.principal_id=m.id AND mp.role='moderator'
      JOIN principals a ON a.id=g.administrator_id JOIN staff_profiles ap ON ap.principal_id=a.id AND ap.role='platform_admin'
      WHERE owner.id=r.member_id AND owner.kind='member' AND m.kind='staff' AND a.kind='staff'
      AND owner.revoked_at IS NULL AND m.revoked_at IS NULL AND a.revoked_at IS NULL
      AND owner.expires_at>clock_timestamp() AND m.expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()) AS authority
    FROM workflow_review_grants g JOIN workflow_review_requests r ON r.id=g.request_id WHERE g.id=$1 FOR SHARE OF g`,
      [grantId],
    )
  ).rows[0];
  if (
    !intent ||
    !grant ||
    intent.memberId !== owner.memberId ||
    intent.instanceId !== owner.instanceId ||
    intent.revision !== owner.revision ||
    grant.request !== owner.id ||
    grant.moderator !== discovered.moderator ||
    grant.administrator !== discovered.administrator
  )
    return reviewDeny();
  const bundle = await c.tx.bounded(() => workflowBundle(owner.workflowId));
  const state: NonNullable<WorkflowReviewGrant["state"]> = grant.revoked
    ? "revoked"
    : intent.withdrawn
      ? "withdrawn"
      : grant.expired
        ? "expired"
        : !source ||
            source.instanceId !== intent.instanceId ||
            source.revision !== intent.revision
          ? "superseded"
          : !bundle ||
              bundle.version !== intent.workflowVersion ||
              !grant.authority
            ? "unavailable"
            : grant.scheduled
              ? "scheduled"
              : "recorded";
  return {
    grantId,
    requestId: grant.request,
    moderatorId: grant.moderator,
    startsAt: grant.starts.toISOString(),
    expiresAt: grant.expires.toISOString(),
    revokedAt: grant.revoked?.toISOString() ?? null,
    state,
  };
}
function signedCheck(secret: string) {
  const mac = (text: string) =>
    createHmac("sha256", secret)
      .update("workflow-review-assignment-v1\0" + text)
      .digest();
  return {
    sign(value: Checked) {
      const text = Buffer.from(JSON.stringify(value)).toString("base64url");
      return text + "." + mac(text).toString("base64url");
    },
    read(value: unknown): Checked | null {
      if (
        typeof value !== "string" ||
        value.length > 2048 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
      )
        return null;
      const [text, sig] = value.split(".") as [string, string];
      const actual = Buffer.from(sig, "base64url");
      const expected = mac(text);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return null;
      try {
        const p = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
        if (
          !p ||
          typeof p !== "object" ||
          Array.isArray(p) ||
          Object.keys(p).length !== 7 ||
          !["actorId", "requestId", "moderatorId", "instanceId"].every((k) =>
            sampleUuid(p[k]),
          ) ||
          !Number.isSafeInteger(p.revision) ||
          p.revision < 1 ||
          !sampleAssignmentUtc(p.startsAt) ||
          typeof p.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(p.expiresAt)) ||
          new Date(p.expiresAt).toISOString() !== p.expiresAt ||
          Date.parse(p.startsAt) >= Date.parse(p.expiresAt) ||
          Date.parse(p.expiresAt) - Date.parse(p.startsAt) > 3600000
        )
          return null;
        return p as Checked;
      } catch {
        return null;
      }
    },
  };
}
export function workflowReviewStaffStore(
  pool: Pool,
  options: { enabled: boolean; mode: ApplicationMode },
  secret: string,
) {
  const checks = signedCheck(secret);
  const allowed = options.mode !== "live";
  const worklist = workflowReviewWorklist(pool, secret);
  return {
    async receipt(token: string, grantId: string) {
      if (!allowed) return { kind: "unavailable" as const };
      if (!sampleUuid(grantId)) return { kind: "invalid" as const };
      return reviewExecute(pool, token, false, async (c) => ({
        kind: "ready" as const,
        grant: await historicalGrant(c, grantId),
      }));
    },
    async inspect(token: string, operationId: string) {
      if (!allowed) return { kind: "unavailable" as const };
      if (!sampleUuid(operationId)) return { kind: "invalid" as const };
      return reviewExecute(pool, token, false, async (c) => {
        const op = (
          await c.tx.query<{
            actor: string | null;
            kind: string | null;
            receipt: string | null;
          }>(
            `SELECT actor_id AS actor,kind,receipt_id AS receipt FROM workflow_review_operations WHERE operation_id=$1`,
            [operationId],
          )
        ).rows[0];
        if (!op) {
          await reviewActors(c, [], "platform_admin");
          return { kind: "ready" as const, grant: null };
        }
        if (
          op.actor !== c.actorId ||
          !op.receipt ||
          !["assign", "revoke"].includes(op.kind ?? "")
        ) {
          await reviewActors(c, [], "platform_admin");
          return reviewDeny();
        }
        const grant = await historicalGrant(c, op.receipt, true);
        const current = (
          await c.tx.query<{
            actor: string | null;
            kind: string | null;
            receipt: string | null;
          }>(
            `SELECT actor_id AS actor,kind,receipt_id AS receipt FROM workflow_review_operations WHERE operation_id=$1 FOR SHARE`,
            [operationId],
          )
        ).rows[0];
        if (!isDeepStrictEqual(op, current)) return reviewDeny();
        return { kind: "ready" as const, grant };
      });
    },
    async list(token: string, cursor?: string) {
      if (!allowed) return { kind: "unavailable" as const };
      return worklist(token, cursor);
    },
    async entry(token: string, role: "platform_admin" | "moderator") {
      if (!allowed) return { kind: "unavailable" as const };
      return reviewExecute(pool, token, false, async (c) => {
        await reviewActors(c, [], role);
        const clock = (
          await c.tx.query<{ starts: Date; ends: Date }>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS starts,date_trunc('milliseconds',LEAST($1::timestamptz,clock_timestamp()+interval '15 minutes')) AS ends`,
            [new Date(Math.min(...c.expires.map(Number)))],
          )
        ).rows[0]!;
        return {
          kind: "ready" as const,
          startsAt: clock.starts.toISOString(),
          endsAt: clock.ends.toISOString(),
          actorId: c.actorId,
          expiresAt: new Date(Math.min(...c.expires.map(Number))).toISOString(),
          enabled: options.enabled,
        };
      });
    },
    async check(
      token: string,
      requestId: string,
      moderatorId: string,
      window?: { startsAt: string; expiresAt: string },
    ) {
      if (!allowed || !options.enabled) return { kind: "unavailable" as const };
      if (!sampleUuid(requestId) || !sampleUuid(moderatorId))
        return { kind: "invalid" as const };
      if (
        window !== undefined &&
        (!window ||
          Object.keys(window).length !== 2 ||
          !sampleAssignmentUtc(window.startsAt) ||
          !sampleAssignmentUtc(window.expiresAt) ||
          Date.parse(window.startsAt) >= Date.parse(window.expiresAt) ||
          Date.parse(window.expiresAt) - Date.parse(window.startsAt) > 3600000)
      )
        return { kind: "invalid" as const };
      return reviewExecute(pool, token, false, async (c) => {
        const discovered = await discover(c, requestId);
        await authorities(
          c,
          discovered.memberId,
          moderatorId,
          c.actorId,
          "platform_admin",
        );
        const row = await exact(c, discovered, "SHARE");
        const clock = (
          await c.tx.query<{ expires: Date; starts: Date }>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS starts,date_trunc('milliseconds',LEAST($1::timestamptz,clock_timestamp()+interval '1 hour')) AS expires`,
            [new Date(Math.min(...c.expires.map(Number)))],
          )
        ).rows[0]!;
        const starts = window ? new Date(window.startsAt) : clock.starts;
        const expiry = window ? new Date(window.expiresAt) : clock.expires;
        if (
          +expiry > +clock.expires ||
          +expiry <= +clock.starts ||
          +starts < +row.createdAt
        )
          return { kind: "invalid" as const };
        c.expires.push(expiry);
        await c.tx.observe(c.expires);
        const value: Checked = {
          startsAt: starts.toISOString(),
          actorId: c.actorId,
          requestId: row.id,
          moderatorId,
          instanceId: row.instanceId,
          revision: row.revision,
          expiresAt: expiry.toISOString(),
        };
        return {
          kind: "ready" as const,
          checked: checks.sign(value),
          workflowId: row.workflowId,
          workflowVersion: row.workflowVersion,
          revision: row.revision,
          requestId,
          moderatorId,
          startsAt: value.startsAt,
          expiresAt: value.expiresAt,
        };
      });
    },
    async assign(
      token: string,
      packet: unknown,
      operationId: string,
      confirm: string,
    ) {
      if (!allowed || !options.enabled) return { kind: "unavailable" as const };
      const value = checks.read(packet);
      if (!value || !sampleUuid(operationId) || confirm !== "yes")
        return { kind: "invalid" as const };
      return reviewExecute(pool, token, true, async (c) => {
        if (value.actorId !== c.actorId) return reviewDeny();
        const discovered = await discover(c, value.requestId);
        const workspace = await authorities(
          c,
          discovered.memberId,
          value.moderatorId,
          c.actorId,
          "platform_admin",
        );
        const row = await exact(c, discovered, "UPDATE");
        if (
          row.instanceId !== value.instanceId ||
          row.revision !== value.revision
        )
          return { kind: "conflict" as const };
        // Read the original operation after the exact-request fence settles;
        // foreign reservations still disclose no receipt or private metadata.
        const previous = (
          await c.tx.query<{
            actor: string | null;
            kind: string | null;
            instruction: unknown;
            receipt: string | null;
          }>(
            `SELECT actor_id AS actor,kind,instruction,receipt_id AS receipt FROM workflow_review_operations WHERE operation_id=$1`,
            [operationId],
          )
        ).rows[0];
        if (
          previous &&
          (previous.actor !== c.actorId ||
            previous.kind !== "assign" ||
            !isDeepStrictEqual(previous.instruction, value))
        )
          return { kind: "conflict" as const };
        if (previous) {
          const grant = (
            await c.tx.query<{
              id: string;
              request: string;
              moderator: string;
              starts: Date;
              expires: Date;
              revoked: Date | null;
            }>(
              `SELECT id,request_id AS request,moderator_id AS moderator,starts_at AS starts,expires_at AS expires,revoked_at AS revoked FROM workflow_review_grants WHERE id=$1 FOR SHARE`,
              [previous.receipt],
            )
          ).rows[0];
          if (!grant) return reviewDeny();
          return {
            kind: "replayed" as const,
            grant: {
              grantId: grant.id,
              requestId: grant.request,
              moderatorId: grant.moderator,
              startsAt: grant.starts.toISOString(),
              expiresAt: grant.expires.toISOString(),
              revokedAt: grant.revoked?.toISOString() ?? null,
            },
          };
        }
        c.expires.push(new Date(value.expiresAt));
        await c.tx.observe(c.expires);
        if (
          (
            await c.tx.query(
              `SELECT id FROM workflow_review_grants WHERE request_id=$1 AND revoked_at IS NULL FOR UPDATE`,
              [row.id],
            )
          ).rowCount
        )
          return { kind: "conflict" as const };
        const grantId = randomUUID();
        const reserved = await c.tx.query(
          `INSERT INTO workflow_review_operations(operation_id,actor_id,workspace_id,kind,instruction,receipt_id) VALUES($1,$2,$3,'assign',$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING operation_id`,
          [operationId, c.actorId, workspace, JSON.stringify(value), grantId],
        );
        if (reserved.rowCount !== 1) return { kind: "conflict" as const };
        await c.tx.query(
          `INSERT INTO workflow_review_grants(id,request_id,workspace_id,moderator_id,administrator_id,source_instance_id,source_revision,expires_at,starts_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            grantId,
            row.id,
            workspace,
            value.moderatorId,
            c.actorId,
            row.instanceId,
            row.revision,
            value.expiresAt,
            value.startsAt,
          ],
        );
        return {
          kind: "applied" as const,
          grant: {
            grantId,
            requestId: row.id,
            moderatorId: value.moderatorId,
            startsAt: value.startsAt,
            expiresAt: value.expiresAt,
            revokedAt: null,
          },
        };
      });
    },
    async revoke(
      token: string,
      grantId: string,
      operationId: string,
      confirm: string,
    ) {
      if (!allowed) return { kind: "unavailable" as const };
      if (!sampleUuid(grantId) || !sampleUuid(operationId) || confirm !== "yes")
        return { kind: "invalid" as const };
      return reviewExecute(pool, token, true, async (c) => {
        const discoveredGrant = (
          await c.tx.query<{
            request: string;
            moderator: string;
            administrator: string;
          }>(
            `SELECT request_id AS request,moderator_id AS moderator,administrator_id AS administrator FROM workflow_review_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0];
        if (!discoveredGrant) return reviewDeny();
        const row = await discover(c, discoveredGrant.request);
        await reviewActors(
          c,
          [
            row.memberId,
            discoveredGrant.moderator,
            discoveredGrant.administrator,
          ],
          "platform_admin",
        );
        const workspace = await reviewWorkspace(c, row.memberId);
        // Revocation remains available after note edits, expiry or withdrawal.
        // Lock the surviving source before intent/grant without copying text.
        await c.tx.query(
          `SELECT instance_id FROM workflow_feedback WHERE member_id=$1 AND workflow_id=$2 AND workflow_version=$3 FOR SHARE`,
          [row.memberId, row.workflowId, row.workflowVersion],
        );
        const intent = (
          await c.tx.query<ExactRequest>(
            `SELECT ${columns} FROM workflow_review_requests WHERE id=$1 FOR UPDATE`,
            [row.id],
          )
        ).rows[0];
        if (!intent || intent.memberId !== row.memberId) return reviewDeny();
        const grant = (
          await c.tx.query<{
            id: string;
            request: string;
            moderator: string;
            starts: Date;
            expires: Date;
            revoked: Date | null;
          }>(
            `SELECT id,request_id AS request,moderator_id AS moderator,starts_at AS starts,expires_at AS expires,revoked_at AS revoked FROM workflow_review_grants WHERE id=$1 FOR UPDATE`,
            [grantId],
          )
        ).rows[0];
        if (
          !grant ||
          grant.request !== row.id ||
          grant.moderator !== discoveredGrant.moderator
        )
          return reviewDeny();
        const instruction = { grantId };
        const previous = (
          await c.tx.query<{
            actor: string | null;
            kind: string | null;
            instruction: unknown;
            receipt: string | null;
          }>(
            `SELECT actor_id AS actor,kind,instruction,receipt_id AS receipt FROM workflow_review_operations WHERE operation_id=$1`,
            [operationId],
          )
        ).rows[0];
        if (
          previous &&
          (previous.actor !== c.actorId ||
            previous.kind !== "revoke" ||
            previous.receipt !== grantId ||
            !isDeepStrictEqual(previous.instruction, instruction))
        )
          return { kind: "conflict" as const };
        if (!previous) {
          const reserved = await c.tx.query(
            `INSERT INTO workflow_review_operations(operation_id,actor_id,workspace_id,kind,instruction,receipt_id) VALUES($1,$2,$3,'revoke',$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING operation_id`,
            [
              operationId,
              c.actorId,
              workspace,
              JSON.stringify(instruction),
              grantId,
            ],
          );
          if (reserved.rowCount !== 1) return { kind: "conflict" as const };
          if (!grant.revoked)
            grant.revoked = (
              await c.tx.query<{ revoked: Date }>(
                `UPDATE workflow_review_grants SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING revoked_at AS revoked`,
                [grantId],
              )
            ).rows[0]!.revoked;
        }
        return {
          kind: previous ? ("replayed" as const) : ("applied" as const),
          grant: {
            grantId,
            requestId: grant.request,
            moderatorId: grant.moderator,
            startsAt: grant.starts.toISOString(),
            expiresAt: grant.expires.toISOString(),
            revokedAt: grant.revoked?.toISOString() ?? null,
          },
        };
      });
    },
    async read(token: string, grantId: string) {
      if (!allowed) return { kind: "unavailable" as const };
      if (!sampleUuid(grantId)) return { kind: "invalid" as const };
      return reviewExecute(pool, token, false, async (c) => {
        const discovery = (
          await c.tx.query<{
            requestId: string;
            moderatorId: string;
            administratorId: string;
          }>(
            `SELECT request_id AS "requestId",moderator_id AS "moderatorId",administrator_id AS "administratorId" FROM workflow_review_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0];
        if (!discovery || discovery.moderatorId !== c.actorId)
          return reviewDeny();
        const discovered = await discover(c, discovery.requestId);
        await authorities(
          c,
          discovered.memberId,
          c.actorId,
          discovery.administratorId,
          "moderator",
        );
        const row = await exact(c, discovered, "SHARE");
        const grant = (
          await c.tx.query<{
            starts: Date;
            expires: Date;
            revoked: Date | null;
            instance: string;
            revision: number;
            moderator: string;
            administrator: string;
            request: string;
            scheduled: boolean;
          }>(
            `SELECT starts_at AS starts,starts_at>clock_timestamp() AS scheduled,expires_at AS expires,revoked_at AS revoked,source_instance_id AS instance,source_revision AS revision,moderator_id AS moderator,administrator_id AS administrator,request_id AS request FROM workflow_review_grants WHERE id=$1 FOR SHARE`,
            [grantId],
          )
        ).rows[0];
        if (
          !grant ||
          grant.revoked ||
          grant.scheduled ||
          grant.instance !== row.instanceId ||
          grant.revision !== row.revision ||
          grant.moderator !== c.actorId ||
          grant.administrator !== discovery.administratorId ||
          grant.request !== row.id
        )
          return reviewDeny();
        c.expires.push(grant.expires);
        await c.tx.observe(c.expires);
        const note = (
          await c.tx.query<{ note: string }>(
            `SELECT note FROM workflow_feedback WHERE instance_id=$1 AND revision=$2`,
            [row.instanceId, row.revision],
          )
        ).rows[0];
        if (!note) return reviewDeny();
        return {
          kind: "ready" as const,
          workflowId: row.workflowId,
          workflowVersion: row.workflowVersion,
          revision: row.revision,
          note: note.note,
          startsAt: grant.starts.toISOString(),
          expiresAt: grant.expires.toISOString(),
        };
      });
    },
  };
}
export type WorkflowReviewStaffStore = ReturnType<
  typeof workflowReviewStaffStore
>;
