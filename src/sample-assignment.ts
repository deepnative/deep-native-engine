import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import {
  SAMPLE_FEEDBACK_PURPOSE,
  sampleUuid,
} from "./sample-feedback-values.ts";
import {
  sampleAssignmentInput,
  sampleAssignmentReferences,
  sampleAssignmentSource,
} from "./sample-assignment-input.ts";
import { sampleAssignmentCursor } from "./sample-assignment-cursor.ts";
import {
  sampleAssignmentActors,
  sampleAssignmentDeny,
  sampleAssignmentExecute,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import {
  sampleAssignmentDiscover,
  sampleAssignmentEligible,
} from "./sample-assignment-source.ts";
import {
  sampleAssignmentCandidates,
  sampleAssignmentHistoryLocks,
  sampleAssignmentProject,
  type SampleAssignmentCandidate,
} from "./sample-assignment-history.ts";
import {
  SAMPLE_ASSIGNMENT_PAGE_SIZE,
  type SampleAssignmentInput,
  type SampleAssignmentStore,
} from "./sample-assignment-values.ts";

const receipt = async (context: SampleAssignmentContext, operationId: string) =>
  (
    await sampleAssignmentCandidates(
      context,
      "WHERE c.administrator_id=$1 AND c.operation_id=$2",
      [context.actorId, operationId],
    )
  )[0];
const sameOperation = (
  row: SampleAssignmentCandidate,
  input: SampleAssignmentInput,
) =>
  row.evidenceId === input.evidenceId &&
  row.sourceRevision === input.sourceRevision &&
  row.reviewerId === input.reviewerId &&
  row.startsAt.toISOString() === input.startsAt &&
  row.expiresAt.toISOString() === input.expiresAt;

/** Only creation/UI entry are rollout-gated. Trusted recovery, history and exact
 * revocation remain available to a current administrator during rollback. */
export function sampleAssignmentStore(
  pool: Pool,
  options: { enabled: boolean; mode: ApplicationMode },
  secret: Buffer = randomBytes(32),
): SampleAssignmentStore {
  const cursor = sampleAssignmentCursor(secret);
  const enabled = options.enabled && options.mode !== "live";
  return {
    async open(token) {
      if (!enabled) return { kind: "unavailable" };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        await sampleAssignmentActors(context, []);
        return { kind: "ready" as const };
      });
    },
    async selfReference(token) {
      if (!enabled) return { kind: "unavailable" };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const { principals } = await sampleAssignmentActors(
          context,
          [],
          false,
          "reviewer",
        );
        return {
          kind: "ready" as const,
          reference: {
            reviewerId: context.actorId,
            expiresAt: principals.get(context.actorId)!.expires.toISOString(),
          },
        };
      });
    },
    async check(token, value) {
      if (!enabled) return { kind: "unavailable" };
      const refs = sampleAssignmentReferences(value);
      if (!refs) return { kind: "invalid" };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const discovered = await sampleAssignmentDiscover(
          context,
          refs.evidenceId,
        );
        const actors = await sampleAssignmentActors(context, [
          refs.reviewerId,
          ...(discovered ? [discovered.ownerId] : []),
        ]);
        const eligible = await sampleAssignmentEligible(
          context,
          refs,
          discovered,
          actors,
        );
        return {
          kind: "ready" as const,
          check: {
            ...refs,
            sourceStatus: "eligible" as const,
            reviewerExpiresAt: eligible.reviewerExpires.toISOString(),
          },
        };
      });
    },
    async assign(token, value) {
      if (!enabled) return { kind: "unavailable" };
      const input = sampleAssignmentInput(value);
      if (!input) return { kind: "invalid" };
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const earlier = await receipt(context, input.operationId);
        // An unrelated payload collision establishes only current admin authority;
        // it never looks up the winning source or returns its identifiers.
        if (earlier && !sameOperation(earlier, input)) {
          await sampleAssignmentActors(context, [], true);
          return { kind: "conflict" as const };
        }
        const discovered = earlier
          ? { workspaceId: earlier.workspaceId, ownerId: earlier.ownerId }
          : await sampleAssignmentDiscover(context, input.evidenceId);
        const actors = await sampleAssignmentActors(
          context,
          [input.reviewerId, ...(discovered ? [discovered.ownerId] : [])],
          true,
        );
        const existing = await receipt(context, input.operationId);
        if (existing) {
          if (!sameOperation(existing, input))
            return { kind: "conflict" as const };
          // Never expand the lock set after taking principal/profile locks.
          if (
            !discovered ||
            discovered.ownerId !== existing.ownerId ||
            discovered.workspaceId !== existing.workspaceId
          )
            return sampleAssignmentDeny();
          await sampleAssignmentHistoryLocks(context, [existing]);
          return {
            kind: "replayed" as const,
            row: await sampleAssignmentProject(context, existing),
          };
        }
        const eligible = await sampleAssignmentEligible(
          context,
          input,
          discovered,
          actors,
        );
        const expires = new Date(input.expiresAt);
        if (+expires > +eligible.reviewerExpires) return sampleAssignmentDeny();
        context.expires.push(expires);
        await context.tx.observe(context.expires);
        const assignmentId = randomUUID(),
          exactGrantId = randomUUID(),
          receiptId = randomUUID();
        await context.tx.query(
          `INSERT INTO assignment_grants(id,staff_id,staff_role,workspace_id,purpose,starts_at,expires_at,granted_by)
           VALUES($1,$2,'reviewer',$3,$4,$5,$6,$7)`,
          [
            assignmentId,
            input.reviewerId,
            eligible.workspaceId,
            SAMPLE_FEEDBACK_PURPOSE,
            input.startsAt,
            input.expiresAt,
            context.actorId,
          ],
        );
        await context.tx.query(
          `INSERT INTO reviewer_evidence_grants(id,reviewer_id,assignment_id,submission_id,purpose,starts_at,expires_at,granted_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            exactGrantId,
            input.reviewerId,
            assignmentId,
            eligible.submissionId,
            SAMPLE_FEEDBACK_PURPOSE,
            input.startsAt,
            input.expiresAt,
            context.actorId,
          ],
        );
        await context.tx.query(
          `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action)
           VALUES($1,$2,$3,'assignment',$4,'grant_created'),($1,$2,$3,'evidence_review',$5,'grant_created')`,
          [
            context.actorId,
            input.reviewerId,
            eligible.workspaceId,
            assignmentId,
            exactGrantId,
          ],
        );
        await context.tx.query(
          `INSERT INTO private_sample_assignment_operations(id,workspace_id,administrator_id,operation_id,reviewer_id,evidence_id,
           source_revision,submission_id,assignment_id,exact_grant_id,starts_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            receiptId,
            eligible.workspaceId,
            context.actorId,
            input.operationId,
            input.reviewerId,
            input.evidenceId,
            input.sourceRevision,
            eligible.submissionId,
            assignmentId,
            exactGrantId,
            input.startsAt,
            input.expiresAt,
          ],
        );
        const created = await receipt(context, input.operationId);
        if (!created) return sampleAssignmentDeny();
        return {
          kind: "applied" as const,
          row: await sampleAssignmentProject(context, created),
        };
      });
    },
    async history(token, value, after) {
      if (options.mode === "live") return { kind: "unavailable" };
      const source = sampleAssignmentSource(value);
      if (!source) return { kind: "invalid" };
      const previous = cursor.decode(token, source, after);
      if (previous === "invalid") return { kind: "invalid" };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        if (previous) {
          context.expires.push(new Date(previous.expires));
          await context.tx.observe(context.expires);
        }
        const rows = await sampleAssignmentCandidates(
          context,
          `WHERE c.evidence_id=$1 AND c.source_revision=$2 AND ($3::timestamptz IS NULL OR (c.created_at,c.exact_grant_id)>($3::timestamptz,$4::uuid))
           ORDER BY c.created_at,c.exact_grant_id LIMIT 21`,
          [
            source.evidenceId,
            source.sourceRevision,
            previous?.at ?? null,
            previous?.id ?? null,
          ],
        );
        const discovered = rows.length
          ? undefined
          : await sampleAssignmentDiscover(context, source.evidenceId);
        await sampleAssignmentActors(context, [
          ...rows.flatMap((row) => [row.reviewerId, row.ownerId]),
          ...(discovered ? [discovered.ownerId] : []),
        ]);
        if (!rows.length) {
          if (!discovered) return sampleAssignmentDeny();
          const workspace = (
            await context.tx.query(
              "SELECT id FROM workspaces WHERE id=$1 AND deleting_at IS NULL FOR SHARE",
              [discovered.workspaceId],
            )
          ).rows[0];
          if (!workspace) return sampleAssignmentDeny();
          const valid = (
            await context.tx.query(
              `SELECT id FROM evidence_objects WHERE workspace_id=$1 AND id=$2 AND revision_number=$3 FOR SHARE`,
              [
                discovered.workspaceId,
                source.evidenceId,
                source.sourceRevision,
              ],
            )
          ).rows[0];
          if (!valid) return sampleAssignmentDeny();
        }
        await sampleAssignmentHistoryLocks(context, rows);
        const emitted = rows.slice(0, SAMPLE_ASSIGNMENT_PAGE_SIZE),
          last = emitted.at(-1);
        const projections = [];
        for (const row of emitted)
          projections.push(await sampleAssignmentProject(context, row));
        return {
          kind: "ready" as const,
          history: {
            ...source,
            rows: projections,
            next:
              rows.length > SAMPLE_ASSIGNMENT_PAGE_SIZE && last
                ? cursor.encode(
                    token,
                    source,
                    { at: last.at, id: last.exactGrantId },
                    previous?.expires,
                  )
                : null,
          },
        };
      });
    },
    async recover(token, operationId) {
      if (options.mode === "live") return { kind: "unavailable" };
      if (!sampleUuid(operationId)) return { kind: "invalid" };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const row = await receipt(context, operationId);
        await sampleAssignmentActors(
          context,
          row ? [row.reviewerId, row.ownerId] : [],
        );
        if (!row) return { kind: "absent" as const };
        await sampleAssignmentHistoryLocks(context, [row]);
        return {
          kind: "ready" as const,
          row: await sampleAssignmentProject(context, row),
        };
      });
    },
    async revoke(token, value, exactGrantId) {
      if (options.mode === "live") return { kind: "unavailable" };
      const source = sampleAssignmentSource(value);
      if (!source || !sampleUuid(exactGrantId)) return { kind: "invalid" };
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const row = (
          await sampleAssignmentCandidates(
            context,
            "WHERE c.evidence_id=$1 AND c.source_revision=$2 AND c.exact_grant_id=$3",
            [source.evidenceId, source.sourceRevision, exactGrantId],
          )
        )[0];
        await sampleAssignmentActors(
          context,
          row ? [row.reviewerId, row.ownerId] : [],
        );
        if (!row) return sampleAssignmentDeny();
        await sampleAssignmentHistoryLocks(context, [row], true);
        const before = await sampleAssignmentProject(context, row);
        if (!before.canRevoke)
          return { kind: "unchanged" as const, row: before };
        await context.tx.query(
          "UPDATE reviewer_evidence_grants SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL",
          [row.exactGrantId],
        );
        await context.tx.query(
          `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action)
           VALUES($1,$2,$3,'evidence_review',$4,'grant_revoked')`,
          [context.actorId, row.reviewerId, row.workspaceId, row.exactGrantId],
        );
        return {
          kind: "revoked" as const,
          row: await sampleAssignmentProject(context, row),
        };
      });
    },
  };
}
