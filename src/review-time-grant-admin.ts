import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { sampleAssignmentCursor } from "./sample-assignment-cursor.ts";
import {
  sampleAssignmentActors,
  sampleAssignmentDeny,
  sampleAssignmentExecute,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import { sampleAssignmentEligible } from "./sample-assignment-source.ts";
import {
  createReviewTimeGrantRecord,
  revokeReviewTimeGrantRecord,
} from "./review-time-grants.ts";
import {
  reviewGrantCandidates,
  reviewGrantHistoryLocks,
  reviewGrantProject,
  type ReviewGrantCandidate,
} from "./review-time-grant-history.ts";
import {
  REVIEW_GRANT_PAGE_SIZE,
  REVIEW_GRANT_PATH,
  reviewGrantInput,
  reviewGrantReferences,
  reviewGrantRevokeInput,
  type ReviewGrantAdministration,
  type ReviewGrantInput,
  type ReviewGrantReferences,
  type ReviewGrantRevocation,
  type ReviewGrantRow,
} from "./review-time-grant-values.ts";
const cursorScope = { evidenceId: REVIEW_GRANT_PATH, sourceRevision: 1 };
const candidates = (
  context: SampleAssignmentContext,
  key: string,
  operation = false,
) =>
  reviewGrantCandidates(
    context,
    `WHERE g.granted_by=$1 AND g.${operation ? "idempotency_key" : "id"}=$2`,
    [context.actorId, key],
  );
const same = (row: ReviewGrantCandidate, input: ReviewGrantInput) =>
  row.allocationId === input.allocationId &&
  row.reviewerId === input.reviewerId &&
  row.startsAt.toISOString() === input.startsAt &&
  row.expiresAt.toISOString() === input.expiresAt;
const actorIds = (rows: ReviewGrantCandidate[]) =>
  rows.flatMap((r) => [r.ownerId, r.reviewerId]);
interface Allocation {
  allocationId: string;
  ownerId: string;
  workspaceId: string;
  evidenceId: string | null;
  sourceRevision: number;
}
async function discover(
  context: SampleAssignmentContext,
  allocationId: string,
) {
  return (
    await context.tx.query<Allocation>(
      'SELECT id AS "allocationId",member_id AS "ownerId",workspace_id AS "workspaceId",evidence_id AS "evidenceId",source_revision AS "sourceRevision" FROM review_time_allocations WHERE id=$1',
      [allocationId],
    )
  ).rows[0];
}
async function eligible(
  context: SampleAssignmentContext,
  refs: ReviewGrantReferences,
  allocation: Allocation | undefined,
  actors: Awaited<ReturnType<typeof sampleAssignmentActors>>,
) {
  if (!allocation?.evidenceId) return sampleAssignmentDeny();
  const source = await sampleAssignmentEligible(
    context,
    {
      evidenceId: allocation.evidenceId,
      sourceRevision: allocation.sourceRevision,
      reviewerId: refs.reviewerId,
    },
    allocation,
    actors,
  );
  const current = (
    await context.tx.query<{ ceiling: number }>(
      `SELECT ceiling FROM review_time_allocations WHERE id=$1 AND member_id=$2 AND workspace_id=$3 AND evidence_id=$4 AND submission_id=$5 AND source_revision=$6 AND state='allocated' AND source_unavailable_at IS NULL FOR UPDATE`,
      [
        refs.allocationId,
        allocation.ownerId,
        allocation.workspaceId,
        allocation.evidenceId,
        source.submissionId,
        allocation.sourceRevision,
      ],
    )
  ).rows[0];
  if (!current) return sampleAssignmentDeny();
  return {
    ...refs,
    sourceRevision: allocation.sourceRevision,
    ceiling: current.ceiling,
    allocationState: "allocated",
    authorityExpiresAt: new Date(
      Math.min(
        +source.reviewerExpires,
        +actors.principals.get(context.actorId)!.expires,
      ),
    ).toISOString(),
  };
}
async function retained(
  context: SampleAssignmentContext,
  rows: ReviewGrantCandidate[],
  writing = false,
) {
  await reviewGrantHistoryLocks(context, rows, writing);
  const projected: ReviewGrantRow[] = [];
  for (const row of rows)
    projected.push(await reviewGrantProject(context, row));
  return projected;
}
interface Revocation extends ReviewGrantRevocation {
  grantId: string;
}
async function revocation(
  context: SampleAssignmentContext,
  operationId: string,
) {
  return (
    await context.tx.query<Revocation>(
      'SELECT id AS "revocationReceiptId",grant_id AS "grantId",outcome FROM review_time_grant_revocations WHERE administrator_id=$1 AND operation_id=$2',
      [context.actorId, operationId],
    )
  ).rows[0];
}
export function reviewTimeGrantAdminStore(
  pool: Pool,
  options: { mode: ApplicationMode; administration: ReviewGrantAdministration },
  secret: Buffer = randomBytes(32),
) {
  const cursor = sampleAssignmentCursor(secret),
    available =
      options.mode !== "live" && options.administration !== "disabled",
    creation = available && options.administration === "enabled";
  const unavailable = () => ({ kind: "unavailable" as const }),
    invalid = () => ({ kind: "invalid" as const });
  const read = async (token: string, key: string, operation: boolean) => {
    if (!available) return unavailable();
    if (!sampleUuid(key)) return invalid();
    return sampleAssignmentExecute(pool, token, false, async (context) => {
      const rows = await candidates(context, key.toLowerCase(), operation);
      await sampleAssignmentActors(context, actorIds(rows));
      if (!rows.length) return { kind: "absent" as const };
      return {
        kind: "ready" as const,
        row: (await retained(context, rows))[0]!,
      };
    });
  };
  return {
    async open(token: string) {
      if (!available) return unavailable();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        await sampleAssignmentActors(context, []);
        return { kind: "ready" as const, creationEnabled: creation };
      });
    },
    async selfReference(token: string) {
      if (!creation) return unavailable();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const actors = await sampleAssignmentActors(
          context,
          [],
          false,
          "reviewer",
        );
        return {
          kind: "ready" as const,
          reference: {
            reviewerId: context.actorId,
            expiresAt: actors.principals
              .get(context.actorId)!
              .expires.toISOString(),
          },
        };
      });
    },
    async check(token: string, value: ReviewGrantReferences) {
      if (!creation) return unavailable();
      const refs = reviewGrantReferences(value);
      if (!refs) return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const allocation = await discover(context, refs.allocationId);
        const actors = await sampleAssignmentActors(context, [
          refs.reviewerId,
          ...(allocation ? [allocation.ownerId] : []),
        ]);
        return {
          kind: "ready" as const,
          check: await eligible(context, refs, allocation, actors),
        };
      });
    },
    async grant(token: string, value: ReviewGrantInput) {
      if (!creation) return unavailable();
      const input = reviewGrantInput(value);
      if (!input) return invalid();
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const earlier = (await candidates(context, input.operationId, true))[0];
        if (earlier && !same(earlier, input)) {
          await sampleAssignmentActors(context, [], true);
          return { kind: "conflict" as const };
        }
        const allocation =
          earlier ?? (await discover(context, input.allocationId));
        const actors = await sampleAssignmentActors(
          context,
          [input.reviewerId, ...(allocation ? [allocation.ownerId] : [])],
          true,
        );
        const existing = (
          await candidates(context, input.operationId, true)
        )[0];
        if (existing) {
          if (!same(existing, input)) return { kind: "conflict" as const };
          if (
            !allocation ||
            allocation.ownerId !== existing.ownerId ||
            allocation.workspaceId !== existing.workspaceId
          )
            return sampleAssignmentDeny();
          return {
            kind: "replayed" as const,
            row: (await retained(context, [existing]))[0]!,
          };
        }
        const check = await eligible(context, input, allocation, actors);
        if (input.expiresAt > check.authorityExpiresAt)
          return sampleAssignmentDeny();
        context.expires.push(new Date(input.expiresAt));
        await context.tx.observe(context.expires);
        const grantId = await createReviewTimeGrantRecord(
          context.tx,
          context.actorId,
          input.allocationId,
          input.reviewerId,
          new Date(input.startsAt),
          new Date(input.expiresAt),
          input.operationId,
        );
        const created = (await candidates(context, grantId))[0];
        if (!created) return sampleAssignmentDeny();
        return {
          kind: "applied" as const,
          row: await reviewGrantProject(context, created),
        };
      });
    },
    async history(token: string, after?: string) {
      if (!available) return unavailable();
      const continuation = cursor.decode(token, cursorScope, after);
      if (continuation === "invalid") return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        if (continuation) context.expires.push(new Date(continuation.expires));
        const candidates = await reviewGrantCandidates(
          context,
          "WHERE g.granted_by=$1 AND ($2::timestamptz IS NULL OR (g.created_at,g.id)<($2::timestamptz,$3::uuid)) ORDER BY g.created_at DESC,g.id DESC LIMIT 21",
          [context.actorId, continuation?.at ?? null, continuation?.id ?? null],
        );
        const rows = candidates.slice(0, REVIEW_GRANT_PAGE_SIZE);
        await sampleAssignmentActors(context, actorIds(rows));
        const projected = await retained(context, rows),
          last = rows.at(-1);
        return {
          kind: "ready" as const,
          history: {
            rows: projected,
            next:
              candidates.length > REVIEW_GRANT_PAGE_SIZE
                ? cursor.encode(
                    token,
                    cursorScope,
                    { at: last!.at, id: last!.grantId },
                    continuation?.expires,
                  )
                : null,
          },
        };
      });
    },
    receipt: (token: string, grantId: string) => read(token, grantId, false),
    recover: (token: string, operationId: string) =>
      read(token, operationId, true),
    async revoke(
      token: string,
      value: { grantId: string; operationId: string },
    ) {
      if (!available) return unavailable();
      const input = reviewGrantRevokeInput(value);
      if (!input) return invalid();
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const earlier = await revocation(context, input.operationId);
        if (earlier && earlier.grantId !== input.grantId) {
          await sampleAssignmentActors(context, [], true);
          return { kind: "conflict" as const };
        }
        const rows = await candidates(context, input.grantId);
        await sampleAssignmentActors(context, actorIds(rows), true);
        const prior = await revocation(context, input.operationId);
        if (prior && prior.grantId !== input.grantId)
          return { kind: "conflict" as const };
        if (!rows.length) return sampleAssignmentDeny();
        let row = (await retained(context, rows, true))[0]!;
        if (prior)
          return {
            kind: "replayed" as const,
            row,
            revocationReceiptId: prior.revocationReceiptId,
            outcome: prior.outcome,
          };
        const outcome = row.canRevoke
          ? ("revoked" as const)
          : ("unchanged" as const);
        if (row.canRevoke) {
          await revokeReviewTimeGrantRecord(
            context.tx,
            context.actorId,
            input.grantId,
          );
          row = await reviewGrantProject(context, rows[0]!);
        }
        const revocationReceiptId = randomUUID();
        await context.tx.query(
          "INSERT INTO review_time_grant_revocations(id,administrator_id,operation_id,grant_id,allocation_id,outcome,observed_revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            revocationReceiptId,
            context.actorId,
            input.operationId,
            input.grantId,
            row.allocationId,
            outcome,
            row.revokedAt,
          ],
        );
        return { kind: outcome, row, revocationReceiptId, outcome };
      });
    },
    async recoverRevoke(token: string, operationId: string) {
      if (!available) return unavailable();
      if (!sampleUuid(operationId)) return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const operation = await revocation(context, operationId.toLowerCase());
        const rows = operation
          ? await candidates(context, operation.grantId)
          : [];
        await sampleAssignmentActors(context, actorIds(rows));
        if (!operation || !rows.length) return { kind: "absent" as const };
        return {
          kind: "ready" as const,
          row: (await retained(context, rows))[0]!,
          revocationReceiptId: operation.revocationReceiptId,
          outcome: operation.outcome,
        };
      });
    },
  };
}
