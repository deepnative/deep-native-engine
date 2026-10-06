import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import {
  sampleFeedbackTransaction,
  SampleFeedbackFailure,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import {
  createSupportGrantRecord,
  revokeSupportGrantRecord,
  sameSupportGrant,
} from "./support-grant-records.ts";
import {
  assignmentId,
  assignmentCursor,
  readAssignmentCursor,
} from "./support-assignment-cursor.ts";

export interface AssignmentReference {
  staffId: string;
  expiresAt: Date;
}
export interface AssignmentCheck extends AssignmentReference {
  requestId: string;
}
export type AssignmentState =
  "scheduled" | "current" | "expired" | "revoked" | "ineffective";
export interface AssignmentGrant {
  grantId: string;
  requestId: string;
  staffId: string;
  role: "operator" | "platform_admin";
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  state: AssignmentState;
}
export interface AssignmentHistory {
  requestId: string;
  observedAt: Date;
  withdrawn: boolean;
  items: AssignmentGrant[];
  nextCursor: string | null;
}
export interface AssignmentInput {
  requestId: string;
  staffId: string;
  idempotencyKey: string;
  startsAt: Date;
  expiresAt: Date;
}
export type AssignmentResult<T> =
  | { kind: "ready"; value: T; observedAt: Date; deadline: number }
  | { kind: "denied" | "invalid" | "conflict" | "unavailable" };
export interface AssignmentReceipt {
  requestId: string;
  grantId: string;
  disposition: "created" | "replayed" | "revoked" | "already-revoked";
}
export interface SupportAssignmentStore {
  admin(token: string): Promise<AssignmentResult<null>>;
  reference(token: string): Promise<AssignmentResult<AssignmentReference>>;
  check(
    token: string,
    requestId: string,
    staffId: string,
  ): Promise<AssignmentResult<AssignmentCheck>>;
  assign(
    token: string,
    input: AssignmentInput,
  ): Promise<AssignmentResult<AssignmentReceipt>>;
  history(
    token: string,
    requestId: string,
    after?: string,
    key?: string,
  ): Promise<AssignmentResult<AssignmentHistory>>;
  revoke(
    token: string,
    requestId: string,
    grantId: string,
  ): Promise<AssignmentResult<AssignmentReceipt>>;
}
type Person = {
  id: string;
  kind: string;
  tokenHash: string;
  expiresAt: Date;
  active: boolean;
};
type RequestMeta = {
  requestId: string;
  memberId: string;
  workspaceId: string;
  withdrawnAt: Date | null;
};
type Grant = Omit<AssignmentGrant, "grantId" | "state"> & {
  id: string;
  cursorAt: string;
};
type Context = {
  tx: SampleTransaction;
  actorId: string;
  tokenHash: string;
  deadlines: Date[];
};
type Locks = { people: Map<string, Person>; roles: Map<string, string> };
const requireState: (
  value: unknown,
  kind?: "denied" | "invalid" | "conflict" | "unavailable",
) => asserts value = (value, kind = "denied") => {
  if (!value) throw new SampleFeedbackFailure(kind);
};
const grantColumns = `id,request_id AS "requestId",staff_id AS "staffId",staff_role AS role,starts_at AS "startsAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"`;
export function supportAssignmentStore(
  pool: Pool,
  secret = randomBytes(32).toString("hex"),
): SupportAssignmentStore {
  async function run<T>(
    token: string,
    writing: boolean,
    use: (ctx: Context) => Promise<(at: Date) => T>,
  ): Promise<AssignmentResult<T>> {
    if (!staffCredential(token)) return { kind: "denied" };
    const requestDeadline = performance.now() + 10000;
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const tokenHash = hash(token),
          actor = (
            await tx.query<{ id: string }>(
              "SELECT id FROM principals WHERE token_hash=$1 AND kind='staff'",
              [tokenHash],
            )
          ).rows[0];
        requireState(actor);
        const ctx: Context = {
            tx,
            actorId: actor.id,
            tokenHash,
            deadlines: [],
          },
          project = await use(ctx);
        await tx.observe(ctx.deadlines);
        const entered = performance.now(),
          observation = (
            await tx.query<{ remaining: string; observed: Date }>(
              `WITH handoff AS MATERIALIZED (SELECT clock_timestamp() AS observed) SELECT observed,EXTRACT(EPOCH FROM ($1::timestamptz-observed))*1000 AS remaining FROM handoff`,
              [new Date(Math.min(...ctx.deadlines.map(Number)))],
            )
          ).rows[0];
        requireState(
          observation &&
            typeof observation.remaining === "string" &&
            observation.remaining.trim() &&
            Number.isFinite(Number(observation.remaining)) &&
            observation.observed instanceof Date &&
            Number.isFinite(+observation.observed),
          "unavailable",
        );
        const deadline = Math.min(
          requestDeadline,
          entered + Number(observation.remaining),
        );
        requireState(performance.now() < deadline);
        return {
          kind: "ready" as const,
          value: project(observation.observed),
          observedAt: observation.observed,
          deadline,
        };
      });
    } catch (error) {
      return {
        kind:
          error instanceof SampleFeedbackFailure ? error.kind : "unavailable",
      };
    }
  }
  async function locks(
    ctx: Context,
    owners: string[],
    staff: string[],
    role: "operator" | "platform_admin",
    write = false,
  ): Promise<Locks> {
    const ids = [...new Set([ctx.actorId, ...owners, ...staff])].sort();
    const rows = (
      await ctx.tx.query<Person>(
        `SELECT id,kind,token_hash AS "tokenHash",expires_at AS "expiresAt",(revoked_at IS NULL AND expires_at>clock_timestamp()) AS active FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? "UPDATE" : "SHARE"}`,
        [ids],
      )
    ).rows;
    const people = new Map(rows.map((p) => [p.id, p])),
      actor = people.get(ctx.actorId);
    requireState(
      rows.length === ids.length &&
        actor?.kind === "staff" &&
        actor.active &&
        actor.tokenHash === ctx.tokenHash &&
        owners.every((id) => people.get(id)!.kind === "member") &&
        staff.every((id) => people.get(id)!.kind === "staff"),
    );
    ctx.deadlines.push(actor.expiresAt);
    await ctx.tx.observe(ctx.deadlines);
    const profiles = (
      await ctx.tx.query<{ id: string; role: string }>(
        "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [[...new Set([ctx.actorId, ...staff])].sort()],
      )
    ).rows;
    const roles = new Map(profiles.map((p) => [p.id, p.role]));
    requireState(roles.get(ctx.actorId) === role);
    return { people, roles };
  }
  async function discover(ctx: Context, id: string) {
    const row = (
      await ctx.tx.query<RequestMeta>(
        'SELECT id AS "requestId",member_id AS "memberId",workspace_id AS "workspaceId",withdrawn_at AS "withdrawnAt" FROM support_requests WHERE id=$1',
        [id],
      )
    ).rows[0];
    requireState(row);
    return row;
  }
  async function request(ctx: Context, candidate: RequestMeta, write: boolean) {
    const workspace = (
      await ctx.tx.query<{ memberId: string; deletingAt: Date | null }>(
        `SELECT owner_principal_id AS "memberId",deleting_at AS "deletingAt" FROM workspaces WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
        [candidate.workspaceId],
      )
    ).rows[0];
    requireState(
      workspace &&
        workspace.memberId === candidate.memberId &&
        !workspace.deletingAt,
    );
    const row = (
      await ctx.tx.query<RequestMeta>(
        `SELECT id AS "requestId",member_id AS "memberId",workspace_id AS "workspaceId",withdrawn_at AS "withdrawnAt" FROM support_requests WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
        [candidate.requestId],
      )
    ).rows[0];
    requireState(
      row &&
        row.memberId === candidate.memberId &&
        row.workspaceId === candidate.workspaceId,
    );
    return row;
  }
  async function eligible(
    ctx: Context,
    scope: Locks,
    row: RequestMeta,
    staffId: string,
  ) {
    const target = scope.people.get(staffId)!,
      owner = scope.people.get(row.memberId)!;
    requireState(
      staffId !== ctx.actorId &&
        scope.roles.get(staffId) === "operator" &&
        target.active &&
        owner.active &&
        !row.withdrawnAt,
    );
    ctx.deadlines.push(target.expiresAt, owner.expiresAt);
    await ctx.tx.observe(ctx.deadlines);
    return target;
  }
  async function grants(ctx: Context, ids: string[], write = false) {
    return (
      await ctx.tx.query<Grant>(
        `SELECT ${grantColumns} FROM support_request_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? "UPDATE" : "SHARE"}`,
        [ids.slice().sort()],
      )
    ).rows;
  }
  return {
    admin(token) {
      return run(token, false, async (ctx) => {
        await locks(ctx, [], [], "platform_admin");
        return () => null;
      });
    },
    reference(token) {
      return run(token, false, async (ctx) => {
        const scope = await locks(ctx, [], [], "operator"),
          actor = scope.people.get(ctx.actorId)!;
        return () => ({ staffId: actor.id, expiresAt: actor.expiresAt });
      });
    },
    check(token, requestId, staffId) {
      if (![requestId, staffId].every(assignmentId))
        return Promise.resolve({ kind: "denied" });
      return run(token, false, async (ctx) => {
        const found = await discover(ctx, requestId),
          scope = await locks(
            ctx,
            [found.memberId],
            [staffId],
            "platform_admin",
          ),
          row = await request(ctx, found, false),
          target = await eligible(ctx, scope, row, staffId);
        return () => ({ requestId, staffId, expiresAt: target.expiresAt });
      });
    },
    assign(token, input) {
      if (
        ![input.requestId, input.staffId, input.idempotencyKey].every(
          assignmentId,
        ) ||
        !(input.startsAt instanceof Date) ||
        !(input.expiresAt instanceof Date) ||
        !Number.isFinite(+input.startsAt) ||
        !Number.isFinite(+input.expiresAt) ||
        input.expiresAt <= input.startsAt
      )
        return Promise.resolve({ kind: "denied" });
      return run<AssignmentReceipt>(token, true, async (ctx) => {
        const found = await discover(ctx, input.requestId),
          scope = await locks(
            ctx,
            [found.memberId],
            [input.staffId],
            "platform_admin",
            true,
          );
        const existing = (
          await ctx.tx.query<Grant>(
            `SELECT ${grantColumns} FROM support_request_grants WHERE granted_by=$1 AND idempotency_key=$2 ORDER BY id FOR UPDATE`,
            [ctx.actorId, input.idempotencyKey],
          )
        ).rows[0];
        const row = await request(ctx, found, true),
          record = { ...input, role: "operator" as const };
        if (existing) {
          requireState(sameSupportGrant(existing, record), "conflict");
          return () => ({
            requestId: input.requestId,
            grantId: existing.id,
            disposition: "replayed" as const,
          });
        }
        const target = await eligible(ctx, scope, row, input.staffId);
        requireState(input.expiresAt <= target.expiresAt, "invalid");
        ctx.deadlines.push(input.expiresAt);
        await ctx.tx.observe(ctx.deadlines);
        const grantId = await createSupportGrantRecord(
          ctx.tx,
          ctx.actorId,
          record,
        );
        return () => ({
          requestId: input.requestId,
          grantId,
          disposition: "created" as const,
        });
      });
    },
    history(token, requestId, after, key) {
      if (
        !assignmentId(requestId) ||
        (key !== undefined && (!assignmentId(key) || after !== undefined))
      )
        return Promise.resolve({ kind: "denied" });
      return run(token, false, async (ctx) => {
        const cursor = readAssignmentCursor(
            after,
            ctx.actorId,
            requestId,
            secret,
          ),
          found = await discover(ctx, requestId);
        const candidates = (
          await ctx.tx.query<Grant>(
            `SELECT ${grantColumns} FROM support_request_grants WHERE request_id=$1 AND ($2::uuid IS NULL OR (granted_by=$3 AND idempotency_key=$2)) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`,
            [
              requestId,
              key ?? null,
              ctx.actorId,
              cursor?.at ?? null,
              cursor?.id ?? null,
            ],
          )
        ).rows;
        const scope = await locks(
            ctx,
            [found.memberId],
            candidates.map((g) => g.staffId),
            "platform_admin",
          ),
          locked = await grants(
            ctx,
            candidates.map((g) => g.id),
          ),
          byId = new Map(locked.map((g) => [g.id, g]));
        requireState(
          candidates.every((g) => {
            const current = byId.get(g.id);
            return (
              current &&
              current.requestId === requestId &&
              current.staffId === g.staffId &&
              current.cursorAt === g.cursorAt
            );
          }),
        );
        const row = await request(ctx, found, false),
          items = candidates.slice(0, 20).map((g) => byId.get(g.id)!);
        return (at) => ({
          requestId,
          observedAt: at,
          withdrawn: !!row.withdrawnAt,
          items: items.map((g) => {
            const target = scope.people.get(g.staffId)!,
              owner = scope.people.get(row.memberId)!;
            const state: AssignmentState = g.revokedAt
              ? "revoked"
              : g.expiresAt <= at
                ? "expired"
                : row.withdrawnAt ||
                    !target.active ||
                    target.expiresAt <= at ||
                    scope.roles.get(g.staffId) !== g.role ||
                    !owner.active ||
                    owner.expiresAt <= at
                  ? "ineffective"
                  : g.startsAt > at
                    ? "scheduled"
                    : "current";
            return {
              grantId: g.id,
              requestId: g.requestId,
              staffId: g.staffId,
              role: g.role,
              startsAt: g.startsAt,
              expiresAt: g.expiresAt,
              createdAt: g.createdAt,
              revokedAt: g.revokedAt,
              state,
            };
          }),
          nextCursor:
            candidates.length > 20
              ? assignmentCursor(
                  { at: items[19]!.cursorAt, id: items[19]!.id },
                  ctx.actorId,
                  requestId,
                  secret,
                )
              : null,
        });
      });
    },
    revoke(token, requestId, grantId) {
      if (![requestId, grantId].every(assignmentId))
        return Promise.resolve({ kind: "denied" });
      return run<AssignmentReceipt>(token, true, async (ctx) => {
        const candidate = (
          await ctx.tx.query<Grant>(
            `SELECT ${grantColumns} FROM support_request_grants WHERE id=$1 AND request_id=$2`,
            [grantId, requestId],
          )
        ).rows[0];
        requireState(candidate);
        const found = await discover(ctx, requestId);
        await locks(
          ctx,
          [found.memberId],
          [candidate.staffId],
          "platform_admin",
        );
        const grant = (await grants(ctx, [grantId], true))[0];
        requireState(
          grant &&
            grant.requestId === requestId &&
            grant.staffId === candidate.staffId,
        );
        await request(ctx, found, true);
        if (grant.revokedAt)
          return () => ({
            requestId,
            grantId,
            disposition: "already-revoked" as const,
          });
        await revokeSupportGrantRecord(ctx.tx, ctx.actorId, requestId, grantId);
        return () => ({ requestId, grantId, disposition: "revoked" as const });
      });
    },
  };
}
