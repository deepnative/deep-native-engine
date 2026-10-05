import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
export const HOLD_INSPECTION_PURPOSE = "local-ai-hold-inspection-test-v1";
export type HoldGrantResult =
  | { kind: "applied" | "replayed"; grantId: string }
  | { kind: "denied" | "conflict" | "unavailable" };
export function denyHoldInspection(): never {
  throw new SampleFeedbackFailure("denied");
}
export function holdInspectionFailure(
  error: unknown,
): "denied" | "unavailable" {
  return error instanceof SampleFeedbackFailure && error.kind === "denied"
    ? "denied"
    : "unavailable";
}
interface Principal {
  id: string;
  tokenHash: string;
  kind: string;
  expires: Date;
}
/** Discover IDs without locks first; acquire all principal/profile fences before
 * workspaces/jobs/grants. Owner session expiry does not grant or revoke staff
 * metadata authority, but owner erasure must serialize with this operation. */
export async function holdInspectionAuthority(
  tx: SampleTransaction,
  token: string,
  role: "platform_admin" | "operator",
  memberIds: string[],
  operatorId?: string,
): Promise<{ actorId: string; deadlines: Date[] }> {
  const ids = [
    ...new Set([...memberIds, ...(operatorId ? [operatorId] : [])]),
  ].sort();
  const principals = (
    await tx.query<Principal>(
      `SELECT id,token_hash AS "tokenHash",kind,expires_at AS expires FROM principals
     WHERE (token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp())
       OR id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [hash(token), ids],
    )
  ).rows;
  const actor = principals.find((p) => p.tokenHash === hash(token));
  if (
    !actor ||
    actor.kind !== "staff" ||
    memberIds.some(
      (id) => !principals.some((p) => p.id === id && p.kind === "member"),
    )
  )
    return denyHoldInspection();
  const staffIds = [
    ...new Set([actor.id, ...(operatorId ? [operatorId] : [])]),
  ].sort();
  const roles = (
    await tx.query<{ id: string; role: string }>(
      "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
      [staffIds],
    )
  ).rows;
  if (roles.find((p) => p.id === actor.id)?.role !== role)
    return denyHoldInspection();
  const deadlines = [actor.expires];
  if (operatorId) {
    const operator = principals.find((p) => p.id === operatorId);
    if (
      !operator ||
      operator.kind !== "staff" ||
      operator.id === actor.id ||
      roles.find((p) => p.id === operatorId)?.role !== "operator"
    )
      return denyHoldInspection();
    // The ID branch of discovery must not bypass current operator authority.
    if (
      !(
        await tx.query(
          "SELECT id FROM principals WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
          [operatorId],
        )
      ).rowCount
    )
      return denyHoldInspection();
    deadlines.push(operator.expires);
  }
  await tx.observe(deadlines);
  return { actorId: actor.id, deadlines };
}
export async function holdInspectionWorkspaces(
  tx: SampleTransaction,
  members: string[],
) {
  const unique = [...new Set(members)].sort();
  const rows = (
    await tx.query<{ memberId: string }>(
      'SELECT owner_principal_id AS "memberId" FROM workspaces WHERE owner_principal_id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY id FOR SHARE',
      [unique],
    )
  ).rows;
  if (
    rows.length !== unique.length ||
    unique.some((id) => !rows.some((row) => row.memberId === id))
  )
    return denyHoldInspection();
}
export function localAiHoldInspectionGrants(pool: Pool, available: boolean) {
  return {
    async grant(
      token: string,
      jobId: string,
      operatorId: string,
      starts: Date,
      expires: Date,
      key: string,
    ): Promise<HoldGrantResult> {
      if (!available) return { kind: "unavailable" };
      if (
        !sampleToken(token) ||
        ![jobId, operatorId, key].every(sampleUuid) ||
        !(starts instanceof Date) ||
        !(expires instanceof Date) ||
        !Number.isFinite(+starts) ||
        !Number.isFinite(+expires) ||
        +expires <= +starts
      )
        return { kind: "denied" };
      const start = new Date(+starts),
        end = new Date(+expires);
      try {
        return await sampleFeedbackTransaction(pool, true, async (tx) => {
          const target = (
            await tx.query<{ memberId: string }>(
              'SELECT member_id AS "memberId" FROM local_ai_test_unit_jobs WHERE job_id=$1',
              [jobId],
            )
          ).rows[0];
          if (!target) return denyHoldInspection();
          const authority = await holdInspectionAuthority(
            tx,
            token,
            "platform_admin",
            [target.memberId],
            operatorId,
          );
          await holdInspectionWorkspaces(tx, [target.memberId]);
          const job = (
            await tx.query(
              `SELECT j.id FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
             JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
             JOIN synthetic_entitlement_grants g ON g.id=r.grant_id AND g.member_id=b.member_id
             WHERE j.id=$1 AND j.member_id=$2 AND j.adapter='ai' AND j.mode IN ('demo','test')
              AND j.operation='evidence-summary-local-v1' AND b.policy='deterministic-request-test-v1'
              AND j.prompt_template_version='local-simulation-v1' AND j.model_contract_version='deterministic-local-v1'
              AND r.quantity=1 AND g.category='study_requests' FOR SHARE OF j`,
              [jobId, target.memberId],
            )
          ).rows[0];
          if (
            !job ||
            +end > Math.min(...authority.deadlines.map(Number)) ||
            !(
              await tx.query(
                "SELECT 1 WHERE $1::timestamptz>clock_timestamp()",
                [end],
              )
            ).rowCount
          )
            return denyHoldInspection();
          const id = randomUUID();
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO local_ai_hold_inspection_grants(id,job_id,member_id,staff_id,purpose,starts_at,expires_at,granted_by,idempotency_key)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(granted_by,idempotency_key) DO NOTHING RETURNING id`,
            [
              id,
              jobId,
              target.memberId,
              operatorId,
              HOLD_INSPECTION_PURPOSE,
              start,
              end,
              authority.actorId,
              key,
            ],
          );
          if (!inserted.rowCount) {
            const prior = (
              await tx.query<{
                id: string;
                jobId: string;
                staffId: string;
                starts: Date;
                expires: Date;
              }>(
                `SELECT id,job_id AS "jobId",staff_id AS "staffId",starts_at AS starts,expires_at AS expires
               FROM local_ai_hold_inspection_grants WHERE granted_by=$1 AND idempotency_key=$2 FOR SHARE`,
                [authority.actorId, key],
              )
            ).rows[0];
            if (!prior) throw new SampleFeedbackFailure("unavailable");
            await tx.observe(authority.deadlines);
            return prior.jobId === jobId &&
              prior.staffId === operatorId &&
              +prior.starts === +start &&
              +prior.expires === +end
              ? { kind: "replayed", grantId: prior.id }
              : { kind: "conflict" };
          }
          await tx.query(
            "INSERT INTO local_ai_hold_inspection_events(id,grant_id,job_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,$5,'grant-created')",
            [randomUUID(), id, jobId, target.memberId, authority.actorId],
          );
          await tx.observe(authority.deadlines);
          return { kind: "applied", grantId: id };
        });
      } catch (error) {
        return { kind: holdInspectionFailure(error) };
      }
    },
    async revoke(token: string, grantId: string): Promise<HoldGrantResult> {
      // Revocation remains available while new inspection/grant creation is paused.
      if (!sampleToken(token) || !sampleUuid(grantId))
        return { kind: "denied" };
      try {
        return await sampleFeedbackTransaction(pool, true, async (tx) => {
          const target = (
            await tx.query<{ memberId: string; jobId: string }>(
              'SELECT member_id AS "memberId",job_id AS "jobId" FROM local_ai_hold_inspection_grants WHERE id=$1',
              [grantId],
            )
          ).rows[0];
          if (!target) return denyHoldInspection();
          const authority = await holdInspectionAuthority(
            tx,
            token,
            "platform_admin",
            [target.memberId],
          );
          await holdInspectionWorkspaces(tx, [target.memberId]);
          if (
            !(
              await tx.query(
                "SELECT id FROM adapter_jobs WHERE id=$1 AND member_id=$2 FOR SHARE",
                [target.jobId, target.memberId],
              )
            ).rowCount
          )
            return denyHoldInspection();
          const grant = (
            await tx.query<{ revoked: Date | null }>(
              "SELECT revoked_at AS revoked FROM local_ai_hold_inspection_grants WHERE id=$1 AND job_id=$2 AND member_id=$3 AND purpose=$4 FOR UPDATE",
              [grantId, target.jobId, target.memberId, HOLD_INSPECTION_PURPOSE],
            )
          ).rows[0];
          if (!grant) return denyHoldInspection();
          if (!grant.revoked) {
            await tx.query(
              "UPDATE local_ai_hold_inspection_grants SET revoked_at=clock_timestamp() WHERE id=$1",
              [grantId],
            );
            await tx.query(
              "INSERT INTO local_ai_hold_inspection_events(id,grant_id,job_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,$5,'grant-revoked')",
              [
                randomUUID(),
                grantId,
                target.jobId,
                target.memberId,
                authority.actorId,
              ],
            );
          }
          await tx.observe(authority.deadlines);
          return { kind: grant.revoked ? "replayed" : "applied", grantId };
        });
      } catch (error) {
        return { kind: holdInspectionFailure(error) };
      }
    },
  };
}
