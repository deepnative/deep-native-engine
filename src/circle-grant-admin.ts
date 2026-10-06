import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import { CIRCLE_DISCUSSION_POLICY } from "./circle-discussion.ts";
import {
  CircleGrantFailure,
  circleGrantTransaction,
  type CircleGrantTransaction,
} from "./circle-grant-lifetime.ts";
import {
  circleGrantCursor,
  readCircleGrantCursor,
} from "./circle-grant-cursor.ts";
import {
  circleGrantId,
  circleGrantCircle,
  circleGrantRole,
  type CircleGrantAdminStore,
  type CircleGrantResult,
  type CircleGrantScope,
  type RetainedCircleGrant,
  type CircleGrantRecord,
  type AbsentCircleGrant,
} from "./circle-grant-values.ts";

interface Person {
  id: string;
  kind: string;
  tokenHash: string;
  expiresAt: Date;
  active: boolean;
}
type Grant = Omit<RetainedCircleGrant, "source" | "state"> & {
  idempotencyKey: string;
};
interface Context {
  tx: CircleGrantTransaction;
  actorId: string;
  tokenHash: string;
  dates: Date[];
  people: Map<string, Person>;
  roles: Map<string, string>;
}
const demand: (
  value: unknown,
  kind?: "denied" | "invalid" | "conflict" | "unavailable",
) => asserts value = (value, kind = "denied") => {
  if (!value) throw new CircleGrantFailure(kind);
};
const columns = `id AS "grantId",staff_id AS "staffId",staff_role AS role,circle_id AS "circleId",purpose,granted_by AS "createdBy",idempotency_key AS "idempotencyKey",starts_at AS "startsAt",expires_at AS "expiresAt",granted_at AS "createdAt",revoked_at AS "revokedAt"`;
const validScope = (scope: CircleGrantScope) =>
  circleGrantId(scope.staffId) && circleGrantCircle(scope.circleId);
const finiteDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(+value);
export function circleGrantAdminStore(
  pool: Pool,
  secret: string,
  options: { mode: ApplicationMode; writes: boolean; discussion: boolean },
): CircleGrantAdminStore {
  const creationEnabled = options.writes && options.discussion;
  function run<T>(
    token: string,
    writing: boolean,
    use: (ctx: Context) => Promise<(at: Date) => T>,
  ): Promise<CircleGrantResult<T>> {
    if (!staffCredential(token) || !["test", "demo"].includes(options.mode))
      return Promise.resolve({ kind: "denied" });
    return circleGrantTransaction(pool, writing, async (tx) => {
      const tokenHash = hash(token),
        actor = (
          await tx.query<{ id: string }>(
            "SELECT id FROM principals WHERE token_hash=$1 AND kind='staff'",
            [tokenHash],
          )
        ).rows[0];
      demand(actor);
      const ctx: Context = {
        tx,
        actorId: actor.id,
        tokenHash,
        dates: [],
        people: new Map(),
        roles: new Map(),
      };
      const project = await use(ctx);
      await tx.observe(ctx.dates);
      return project;
    });
  }
  async function circleLock(ctx: Context, circle: string) {
    await ctx.tx.query(
      "SELECT pg_advisory_xact_lock(7529,hashtext($1::text))",
      [circle],
    );
  }
  async function locks(
    ctx: Context,
    staffId?: string,
    currentTarget = false,
    ownReference = false,
  ) {
    const ids = [
      ...new Set([ctx.actorId, ...(staffId ? [staffId] : [])]),
    ].sort();
    const people = (
      await ctx.tx.query<Person>(
        `SELECT id,kind,token_hash AS "tokenHash",expires_at AS "expiresAt",(revoked_at IS NULL AND expires_at>clock_timestamp()) active FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [ids],
      )
    ).rows;
    ctx.people = new Map(people.map((person) => [person.id, person]));
    const actor = ctx.people.get(ctx.actorId);
    demand(
      actor?.kind === "staff" &&
        actor.active &&
        actor.tokenHash === ctx.tokenHash,
    );
    ctx.dates.push(actor.expiresAt);
    await ctx.tx.observe(ctx.dates);
    const profiles = (
      await ctx.tx.query<{ id: string; role: string }>(
        "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [ids],
      )
    ).rows;
    ctx.roles = new Map(profiles.map((profile) => [profile.id, profile.role]));
    demand(
      ownReference
        ? circleGrantRole(ctx.roles.get(ctx.actorId))
        : ctx.roles.get(ctx.actorId) === "platform_admin",
    );
    if (currentTarget) {
      const target = ctx.people.get(staffId!);
      demand(
        target?.kind === "staff" &&
          target.active &&
          circleGrantRole(ctx.roles.get(staffId!)) &&
          finiteDate(target.expiresAt),
      );
      ctx.dates.push(target.expiresAt);
      await ctx.tx.observe(ctx.dates);
    }
    return actor;
  }
  function retained(ctx: Context, grant: Grant, at: Date): RetainedCircleGrant {
    const target = ctx.people.get(grant.staffId);
    const effective =
      target?.kind === "staff" &&
      target.active &&
      finiteDate(target.expiresAt) &&
      target.expiresAt > at &&
      ctx.roles.get(grant.staffId) === grant.role;
    return {
      source: "retained",
      grantId: grant.grantId,
      staffId: grant.staffId,
      circleId: grant.circleId,
      role: grant.role,
      purpose: grant.purpose,
      createdBy: grant.createdBy,
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt,
      state: grant.revokedAt
        ? "revoked"
        : grant.expiresAt <= at
          ? "expired"
          : !effective
            ? "ineffective"
            : grant.startsAt > at
              ? "future"
              : "current",
    };
  }
  async function records(ctx: Context, scope: CircleGrantScope, ids: string[]) {
    const grants = (
      await ctx.tx.query<Grant>(
        `SELECT ${columns} FROM preview_circle_moderator_grants WHERE id=ANY($1::uuid[]) AND staff_id=$2 AND circle_id=$3 ORDER BY id FOR SHARE`,
        [ids.slice().sort(), scope.staffId, scope.circleId],
      )
    ).rows;
    const byId = new Map(grants.map((grant) => [grant.grantId, grant]));
    const absent = ids.filter((id) => !byId.has(id));
    const audit = (
      await ctx.tx.query<{
        grantId: string;
        actorId: string;
        action: "created" | "revoked";
        at: Date;
      }>(
        `SELECT grant_id AS "grantId",actor_id AS "actorId",action,occurred_at AS at FROM preview_circle_grant_audit WHERE staff_id=$1 AND circle_id=$2 AND grant_id=ANY($3::uuid[]) ORDER BY grant_id,id`,
        [scope.staffId, scope.circleId, absent],
      )
    ).rows;
    return (at: Date): CircleGrantRecord[] =>
      ids.flatMap<CircleGrantRecord>((id) => {
        const grant = byId.get(id);
        if (grant) return [retained(ctx, grant, at)];
        const events = audit
          .filter((event) => event.grantId === id)
          .map((event) => ({
            action: event.action,
            actorId: event.actorId,
            at: event.at,
          }));
        const stub: AbsentCircleGrant = {
          ...scope,
          source: "absent",
          grantId: id,
          state: "source-absent",
          audit: events,
        };
        return events.length ? [stub] : [];
      });
  }
  return {
    admin(token) {
      return run(token, false, async (ctx) => {
        const actor = await locks(ctx);
        return () => ({
          reference: {
            staffId: actor.id,
            role: "platform_admin" as const,
            expiresAt: actor.expiresAt,
          },
          creationEnabled,
        });
      });
    },
    reference(token) {
      return run(token, false, async (ctx) => {
        const actor = await locks(ctx, undefined, false, true),
          role = ctx.roles.get(actor.id);
        demand(circleGrantRole(role));
        return () => ({ staffId: actor.id, role, expiresAt: actor.expiresAt });
      });
    },
    check(token, staffId, circleId) {
      if (
        (staffId !== "self" && !circleGrantId(staffId)) ||
        !circleGrantCircle(circleId)
      )
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        const targetId = staffId === "self" ? ctx.actorId : staffId;
        await locks(ctx, targetId, true);
        const target = ctx.people.get(targetId)!,
          role = ctx.roles.get(targetId);
        demand(circleGrantRole(role));
        return () => ({
          staffId: target.id,
          role,
          expiresAt: target.expiresAt,
          circleId,
          creationEnabled,
        });
      });
    },
    create(token, input) {
      if (!creationEnabled) return Promise.resolve({ kind: "denied" });
      if (
        !validScope(input) ||
        !circleGrantId(input.idempotencyKey) ||
        !finiteDate(input.expiresAt)
      )
        return Promise.resolve({ kind: "invalid" });
      return run(token, true, async (ctx) => {
        await circleLock(ctx, input.circleId);
        await locks(ctx, input.staffId, true);
        demand(
          input.expiresAt <= ctx.people.get(input.staffId)!.expiresAt,
          "invalid",
        );
        const future = (
          await ctx.tx.query<{ valid: boolean }>(
            "SELECT $1::timestamptz>clock_timestamp() valid",
            [input.expiresAt],
          )
        ).rows[0];
        demand(future?.valid, "invalid");
        ctx.dates.push(input.expiresAt);
        await ctx.tx.observe(ctx.dates);
        const prior = async () =>
          (
            await ctx.tx.query<Grant>(
              `SELECT ${columns} FROM preview_circle_moderator_grants WHERE idempotency_key=$1 FOR SHARE`,
              [input.idempotencyKey],
            )
          ).rows[0];
        const replay = (grant: Grant) => {
          demand(
            grant.staffId === input.staffId &&
              grant.circleId === input.circleId &&
              grant.createdBy === ctx.actorId &&
              +grant.expiresAt === +input.expiresAt,
            "conflict",
          );
          return (at: Date) => retained(ctx, grant, at);
        };
        const existing = await prior();
        if (existing) return replay(existing);
        const role = ctx.roles.get(input.staffId)!;
        const inserted = (
          await ctx.tx.query<Grant>(
            `INSERT INTO preview_circle_moderator_grants(id,staff_id,staff_role,circle_id,purpose,granted_by,idempotency_key,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8) ON CONFLICT(idempotency_key) DO NOTHING RETURNING ${columns}`,
            [
              randomUUID(),
              input.staffId,
              role,
              input.circleId,
              CIRCLE_DISCUSSION_POLICY,
              ctx.actorId,
              input.idempotencyKey,
              input.expiresAt,
            ],
          )
        ).rows[0];
        if (!inserted) {
          const winner = await prior();
          demand(winner, "unavailable");
          return replay(winner);
        }
        await ctx.tx.query(
          "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) VALUES($1,$2,$3,$4,'created')",
          [ctx.actorId, input.staffId, inserted.grantId, input.circleId],
        );
        return (at) => retained(ctx, inserted, at);
      });
    },
    inspect(token, scope, lookup) {
      if (
        !validScope(scope) ||
        !circleGrantId(lookup.value) ||
        !["key", "grant"].includes(lookup.kind)
      )
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        await locks(ctx, scope.staffId);
        const found =
          lookup.kind === "key"
            ? (
                await ctx.tx.query<{ id: string }>(
                  "SELECT id FROM preview_circle_moderator_grants WHERE idempotency_key=$1 AND granted_by=$2 AND staff_id=$3 AND circle_id=$4",
                  [lookup.value, ctx.actorId, scope.staffId, scope.circleId],
                )
              ).rows[0]?.id
            : lookup.value;
        if (!found) return () => null;
        const project = await records(ctx, scope, [found]);
        return (at) => project(at)[0] ?? null;
      });
    },
    history(token, scope, after) {
      if (!validScope(scope)) return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        await locks(ctx, scope.staffId);
        const cursor = readCircleGrantCursor(after, ctx.actorId, scope, secret);
        const candidates = (
          await ctx.tx.query<{ id: string }>(
            `WITH retained AS (
          SELECT id FROM preview_circle_moderator_grants WHERE staff_id=$1 AND circle_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21
        ), absent AS (
          SELECT DISTINCT a.grant_id AS id FROM preview_circle_grant_audit a WHERE a.staff_id=$1 AND a.circle_id=$2 AND ($3::uuid IS NULL OR a.grant_id>$3)
          AND NOT EXISTS(SELECT 1 FROM preview_circle_moderator_grants g WHERE g.id=a.grant_id) ORDER BY a.grant_id LIMIT 21
        ) SELECT id FROM (SELECT id FROM retained UNION SELECT id FROM absent) candidates ORDER BY id LIMIT 21`,
            [scope.staffId, scope.circleId, cursor],
          )
        ).rows;
        const ids = candidates.slice(0, 20).map((row) => row.id),
          project = await records(ctx, scope, ids);
        return (at) => ({
          ...scope,
          observedAt: at,
          items: project(at),
          nextCursor:
            candidates.length > 20
              ? circleGrantCursor(ids[19]!, ctx.actorId, scope, secret)
              : null,
        });
      });
    },
    revoke(token, scope, grantId) {
      if (!validScope(scope) || !circleGrantId(grantId))
        return Promise.resolve({ kind: "invalid" });
      return run(token, true, async (ctx) => {
        await circleLock(ctx, scope.circleId);
        await locks(ctx, scope.staffId);
        const grant = (
          await ctx.tx.query<Grant>(
            `SELECT ${columns} FROM preview_circle_moderator_grants WHERE id=$1 AND staff_id=$2 AND circle_id=$3 FOR UPDATE`,
            [grantId, scope.staffId, scope.circleId],
          )
        ).rows[0];
        demand(grant);
        if (!grant.revokedAt) {
          const changed = (
            await ctx.tx.query<{ revokedAt: Date }>(
              `UPDATE preview_circle_moderator_grants SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING revoked_at AS "revokedAt"`,
              [grantId],
            )
          ).rows[0];
          demand(changed, "unavailable");
          grant.revokedAt = changed.revokedAt;
          await ctx.tx.query(
            "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) VALUES($1,$2,$3,$4,'revoked')",
            [ctx.actorId, scope.staffId, grantId, scope.circleId],
          );
        }
        return (at) => retained(ctx, grant, at);
      });
    },
  };
}
