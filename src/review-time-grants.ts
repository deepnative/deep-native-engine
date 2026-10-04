import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
} from "./sample-feedback-lifetime.ts";
export type ReviewGrantResult =
  | { kind: "applied" | "replayed"; grantId: string }
  | { kind: "denied" | "conflict" | "unavailable" };
const deny = (): never => {
  throw new SampleFeedbackFailure("denied");
};
export function reviewTimeGrants(
  pool: Pool,
  options: { enabled: boolean; mode: ApplicationMode },
) {
  return {
    async grant(
      token: string,
      allocationId: string,
      reviewerId: string,
      starts: Date,
      expires: Date,
      key: string,
    ): Promise<ReviewGrantResult> {
      if (!options.enabled || options.mode === "live")
        return { kind: "unavailable" };
      if (
        !sampleToken(token) ||
        ![allocationId, reviewerId, key].every(sampleUuid) ||
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
          const principals = (
            await tx.query<{
              id: string;
              tokenHash: string;
              kind: string;
              expires: Date;
            }>(
              `SELECT id,token_hash AS "tokenHash",kind,expires_at AS expires FROM principals
             WHERE (token_hash=$1 OR id=$2) AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY id FOR SHARE`,
              [hash(token), reviewerId],
            )
          ).rows;
          const admin = principals.find((p) => p.tokenHash === hash(token)),
            reviewer = principals.find((p) => p.id === reviewerId);
          if (
            !admin ||
            !reviewer ||
            admin.kind !== "staff" ||
            reviewer.kind !== "staff" ||
            admin.id === reviewer.id
          )
            return deny();
          const roles = (
            await tx.query<{ id: string; role: string }>(
              "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
              [[admin.id, reviewer.id]],
            )
          ).rows;
          if (
            roles.find((p) => p.id === admin.id)?.role !== "platform_admin" ||
            roles.find((p) => p.id === reviewer.id)?.role !== "reviewer"
          )
            return deny();
          const deadlines = [admin.expires, reviewer.expires];
          await tx.observe(deadlines);
          const workspace = (
            await tx.query<{ id: string }>(
              `SELECT w.id FROM workspaces w JOIN review_time_allocations a ON a.workspace_id=w.id WHERE a.id=$1 AND w.deleting_at IS NULL FOR SHARE OF w`,
              [allocationId],
            )
          ).rows[0];
          if (!workspace) return deny();
          const source = (
            await tx.query(
              `SELECT e.id FROM evidence_objects e JOIN review_time_allocations a ON a.evidence_id=e.id WHERE a.id=$1 AND e.quarantine_state='clean' AND e.private_review_allowed FOR SHARE OF e`,
              [allocationId],
            )
          ).rows[0];
          if (!source) return deny();
          const allocation = (
            await tx.query(
              "SELECT id FROM review_time_allocations WHERE id=$1 AND state='allocated' AND source_unavailable_at IS NULL FOR UPDATE",
              [allocationId],
            )
          ).rows[0];
          if (!allocation) return deny();
          const prior = (
            await tx.query<{
              id: string;
              allocationId: string;
              reviewerId: string;
              starts: Date;
              expires: Date;
            }>(
              `SELECT id,allocation_id AS "allocationId",staff_id AS "reviewerId",starts_at AS starts,expires_at AS expires FROM review_time_grants WHERE granted_by=$1 AND idempotency_key=$2 FOR UPDATE`,
              [admin.id, key],
            )
          ).rows[0];
          if (prior) {
            await tx.observe(deadlines);
            return prior.allocationId === allocationId &&
              prior.reviewerId === reviewerId &&
              +prior.starts === +start &&
              +prior.expires === +end
              ? { kind: "replayed", grantId: prior.id }
              : { kind: "conflict" };
          }
          if (
            !(
              await tx.query(
                "SELECT 1 WHERE $1::timestamptz>clock_timestamp()",
                [end],
              )
            ).rowCount
          )
            return deny();
          const id = randomUUID();
          await tx.query(
            "INSERT INTO review_time_grants(id,allocation_id,staff_id,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [id, allocationId, reviewerId, start, end, admin.id, key],
          );
          await tx.query(
            "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) SELECT $1,id,member_id,$3,'grant-created' FROM review_time_allocations WHERE id=$2",
            [randomUUID(), allocationId, admin.id],
          );
          await tx.observe(deadlines);
          return { kind: "applied", grantId: id };
        });
      } catch (error) {
        return {
          kind:
            error instanceof SampleFeedbackFailure && error.kind === "denied"
              ? "denied"
              : "unavailable",
        };
      }
    },
    async revoke(token: string, grantId: string): Promise<ReviewGrantResult> {
      if (!sampleToken(token) || !sampleUuid(grantId))
        return { kind: "denied" };
      try {
        return await sampleFeedbackTransaction(pool, true, async (tx) => {
          const admin = (
            await tx.query<{ id: string; expires: Date }>(
              "SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
              [hash(token)],
            )
          ).rows[0];
          if (!admin) return deny();
          if (
            !(
              await tx.query(
                "SELECT 1 FROM staff_profiles WHERE principal_id=$1 AND role='platform_admin' FOR SHARE",
                [admin.id],
              )
            ).rowCount
          )
            return deny();
          const deadlines = [admin.expires];
          await tx.observe(deadlines);
          const workspace = (
            await tx.query(
              `SELECT w.id FROM workspaces w JOIN review_time_allocations a ON a.workspace_id=w.id JOIN review_time_grants g ON g.allocation_id=a.id WHERE g.id=$1 AND w.deleting_at IS NULL FOR SHARE OF w`,
              [grantId],
            )
          ).rows[0];
          if (!workspace) return deny();
          const grant = (
            await tx.query<{ revoked: Date | null }>(
              "SELECT revoked_at AS revoked FROM review_time_grants WHERE id=$1 FOR UPDATE",
              [grantId],
            )
          ).rows[0];
          if (!grant) return deny();
          if (!grant.revoked) {
            await tx.query(
              "UPDATE review_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
              [grantId],
            );
            await tx.query(
              "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) SELECT $1,a.id,a.member_id,$3,'grant-revoked' FROM review_time_allocations a JOIN review_time_grants g ON g.allocation_id=a.id WHERE g.id=$2",
              [randomUUID(), grantId, admin.id],
            );
          }
          await tx.observe(deadlines);
          return { kind: grant.revoked ? "replayed" : "applied", grantId };
        });
      } catch (error) {
        return {
          kind:
            error instanceof SampleFeedbackFailure && error.kind === "denied"
              ? "denied"
              : "unavailable",
        };
      }
    },
  };
}
