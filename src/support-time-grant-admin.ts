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
import {
  createSupportTimeGrantRecord,
  revokeSupportTimeGrantRecord,
} from "./support-time-grant-records.ts";
import {
  supportMinuteCandidates,
  supportMinuteLocks,
  supportMinuteProject,
  type SupportMinuteCandidate,
} from "./support-time-grant-history.ts";
import {
  SUPPORT_GRANT_PATH,
  SUPPORT_GRANT_PAGE_SIZE,
  supportMinuteReferences,
  supportMinuteInput,
  supportMinuteRevokeInput,
  type SupportMinuteReferences,
  type SupportMinuteInput,
  type SupportMinuteRow,
  type SupportMinuteRevokeInput,
  type SupportGrantAdministration,
  type SupportMinuteRevocation,
} from "./support-time-grant-values.ts";
const scope = { evidenceId: SUPPORT_GRANT_PATH, sourceRevision: 1 };
const actorIds = (rows: SupportMinuteCandidate[]) =>
  rows.flatMap((r) => [r.ownerId, r.operatorId]);
const same = (row: SupportMinuteCandidate, input: SupportMinuteInput) =>
  row.requestId === input.requestId &&
  row.allocationId === input.allocationId &&
  row.operatorId === input.operatorId &&
  row.startsAt.toISOString() === input.startsAt &&
  row.expiresAt.toISOString() === input.expiresAt;
const candidates = (
  context: SampleAssignmentContext,
  key: string,
  operation = false,
) =>
  supportMinuteCandidates(
    context,
    `WHERE g.granted_by=$1 AND g.${operation ? "idempotency_key" : "id"}=$2`,
    [context.actorId, key],
  );
interface Allocation {
  allocationId: string;
  requestId: string;
  ownerId: string;
  workspaceId: string;
}
async function discover(
  context: SampleAssignmentContext,
  refs: SupportMinuteReferences,
) {
  return (
    await context.tx.query<Allocation>(
      'SELECT a.id AS "allocationId",a.request_id AS "requestId",a.member_id AS "ownerId",r.workspace_id AS "workspaceId" FROM support_time_allocations a JOIN support_requests r ON r.id=a.request_id AND r.member_id=a.member_id WHERE a.id=$1 AND a.request_id=$2',
      [refs.allocationId, refs.requestId],
    )
  ).rows[0];
}
async function eligible(
  context: SampleAssignmentContext,
  refs: SupportMinuteReferences,
  allocation: Allocation | undefined,
  actors: Awaited<ReturnType<typeof sampleAssignmentActors>>,
) {
  if (!allocation || refs.operatorId === context.actorId)
    return sampleAssignmentDeny();
  const target = actors.principals.get(refs.operatorId),
    owner = actors.principals.get(allocation.ownerId);
  if (
    !target ||
    target.kind !== "staff" ||
    target.revoked !== null ||
    actors.profiles.get(refs.operatorId) !== "operator" ||
    !owner ||
    owner.kind !== "member" ||
    owner.revoked !== null
  )
    return sampleAssignmentDeny();
  context.expires.push(target.expires, owner.expires);
  await context.tx.observe(context.expires);
  const workspace = (
    await context.tx.query(
      "SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$2 AND deleting_at IS NULL FOR UPDATE",
      [allocation.workspaceId, allocation.ownerId],
    )
  ).rows[0];
  if (!workspace) return sampleAssignmentDeny();
  const request = (
    await context.tx.query(
      "SELECT id FROM support_requests WHERE id=$1 AND member_id=$2 AND workspace_id=$3 AND withdrawn_at IS NULL AND resolved_at IS NULL FOR UPDATE",
      [refs.requestId, allocation.ownerId, allocation.workspaceId],
    )
  ).rows[0];
  if (!request) return sampleAssignmentDeny();
  const row = (
    await context.tx.query<{ ceiling: number }>(
      "SELECT ceiling FROM support_time_allocations WHERE id=$1 AND request_id=$2 AND member_id=$3 AND state='allocated' FOR UPDATE",
      [refs.allocationId, refs.requestId, allocation.ownerId],
    )
  ).rows[0];
  if (!row) return sampleAssignmentDeny();
  return {
    ...refs,
    ceiling: row.ceiling,
    allocationState: "allocated",
    authorityExpiresAt: new Date(
      Math.min(
        +target.expires,
        +actors.principals.get(context.actorId)!.expires,
      ),
    ).toISOString(),
  };
}
async function retained(
  context: SampleAssignmentContext,
  rows: SupportMinuteCandidate[],
  writing = false,
) {
  await supportMinuteLocks(context, rows, writing);
  const results: SupportMinuteRow[] = [];
  for (const row of rows)
    results.push(await supportMinuteProject(context, row));
  return results;
}
async function revocation(
  context: SampleAssignmentContext,
  operationId: string,
) {
  return (
    await context.tx.query<SupportMinuteRevocation & { grantId: string }>(
      'SELECT id AS "revocationReceiptId",grant_id AS "grantId",outcome FROM support_time_grant_revocations WHERE administrator_id=$1 AND operation_id=$2',
      [context.actorId, operationId],
    )
  ).rows[0];
}
export function supportTimeGrantAdminStore(
  pool: Pool,
  options: {
    mode: ApplicationMode;
    administration: SupportGrantAdministration;
    writes: boolean;
  },
  secret: Buffer = randomBytes(32),
) {
  const cursor = sampleAssignmentCursor(secret),
    available =
      options.mode !== "live" && options.administration !== "disabled",
    creation =
      available && options.administration === "enabled" && options.writes;
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
        writesEnabled: options.writes,
      };
    });
  };
  return {
    async open(token: string) {
      if (!available) return unavailable();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        await sampleAssignmentActors(context, []);
        return {
          kind: "ready" as const,
          creationEnabled: creation,
          writesEnabled: options.writes,
        };
      });
    },
    async check(token: string, value: SupportMinuteReferences) {
      if (!creation) return unavailable();
      const refs = supportMinuteReferences(value);
      if (!refs) return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const allocation = await discover(context, refs),
          actors = await sampleAssignmentActors(context, [
            refs.operatorId,
            ...(allocation ? [allocation.ownerId] : []),
          ]);
        return {
          kind: "ready" as const,
          check: await eligible(context, refs, allocation, actors),
        };
      });
    },
    async grant(token: string, value: SupportMinuteInput) {
      if (!available || !options.writes) return unavailable();
      const input = supportMinuteInput(value);
      if (!input) return invalid();
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const earlier = (await candidates(context, input.operationId, true))[0];
        if (earlier && !same(earlier, input)) {
          await sampleAssignmentActors(context, [], true);
          return { kind: "conflict" as const };
        }
        const allocation = await discover(context, input),
          actors = await sampleAssignmentActors(
            context,
            [input.operatorId, ...(allocation ? [allocation.ownerId] : [])],
            true,
          );
        // The actor lock serializes operation keys; repeat after acquiring it.
        const original = (
          await candidates(context, input.operationId, true)
        )[0];
        if (original) {
          if (!same(original, input)) return { kind: "conflict" as const };
          if (
            !allocation ||
            original.ownerId !== allocation.ownerId ||
            original.workspaceId !== allocation.workspaceId
          )
            return sampleAssignmentDeny();
          const row = (await retained(context, [original], true))[0]!;
          if (row.revokedAt !== null) return { kind: "conflict" as const };
          return {
            kind: "replayed" as const,
            row,
            writesEnabled: options.writes,
          };
        }
        if (!creation) return { kind: "unavailable" as const };
        const checked = await eligible(context, input, allocation, actors);
        if (input.expiresAt > checked.authorityExpiresAt)
          return { kind: "invalid" as const };
        context.expires.push(new Date(input.expiresAt));
        await context.tx.observe(context.expires);
        const grantId = await createSupportTimeGrantRecord(
          context.tx,
          context.actorId,
          allocation!.ownerId,
          {
            requestId: input.requestId,
            allocationId: input.allocationId,
            staffId: input.operatorId,
            role: "operator",
            idempotencyKey: input.operationId,
            startsAt: new Date(input.startsAt),
            expiresAt: new Date(input.expiresAt),
          },
        );
        const row = (
          await retained(context, await candidates(context, grantId), true)
        )[0]!;
        return { kind: "applied" as const, row, writesEnabled: options.writes };
      });
    },
    async history(token: string, after?: string) {
      if (!available) return unavailable();
      const continuation = cursor.decode(token, scope, after);
      if (continuation === "invalid") return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        if (continuation) context.expires.push(new Date(continuation.expires));
        const rows = await supportMinuteCandidates(
          context,
          `WHERE g.granted_by=$1 ${continuation ? "AND (g.created_at,g.id)<($2::timestamptz,$3::uuid)" : ""} ORDER BY g.created_at DESC,g.id DESC LIMIT 21`,
          continuation
            ? [context.actorId, continuation.at, continuation.id]
            : [context.actorId],
        );
        await sampleAssignmentActors(context, actorIds(rows));
        const displayed = rows.slice(0, SUPPORT_GRANT_PAGE_SIZE),
          projected = await retained(context, displayed),
          last = displayed.at(-1);
        return {
          kind: "ready" as const,
          rows: projected,
          next:
            rows.length > SUPPORT_GRANT_PAGE_SIZE
              ? cursor.encode(
                  token,
                  scope,
                  { at: last!.at, id: last!.grantId },
                  continuation?.expires,
                )
              : null,
        };
      });
    },
    exact(token: string, id: string) {
      return read(token, id, false);
    },
    recover(token: string, key: string) {
      return read(token, key, true);
    },
    async revoke(token: string, value: SupportMinuteRevokeInput) {
      if (!available || !options.writes) return unavailable();
      const input = supportMinuteRevokeInput(value);
      if (!input) return invalid();
      return sampleAssignmentExecute(pool, token, true, async (context) => {
        const rows = await candidates(context, input.grantId);
        await sampleAssignmentActors(context, actorIds(rows), true);
        const previous = await revocation(context, input.operationId);
        if (previous && previous.grantId !== input.grantId)
          return { kind: "conflict" as const };
        if (!rows.length) return sampleAssignmentDeny();
        const row = (await retained(context, rows, true))[0]!;
        if (previous)
          return {
            kind: "replayed" as const,
            row,
            revocation: previous,
            writesEnabled: options.writes,
          };
        if (row.revokedAt === null)
          await revokeSupportTimeGrantRecord(
            context.tx,
            context.actorId,
            rows[0]!.ownerId,
            row.allocationId,
            row.grantId,
          );
        const saved = await supportMinuteProject(context, rows[0]!),
          receipt = {
            revocationReceiptId: randomUUID(),
            outcome:
              row.revokedAt === null
                ? ("revoked" as const)
                : ("unchanged" as const),
          };
        await context.tx.query(
          "INSERT INTO support_time_grant_revocations(id,administrator_id,operation_id,grant_id,allocation_id,outcome,observed_revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            receipt.revocationReceiptId,
            context.actorId,
            input.operationId,
            row.grantId,
            row.allocationId,
            receipt.outcome,
            saved.revokedAt,
          ],
        );
        return {
          kind: "applied" as const,
          row: saved,
          revocation: receipt,
          writesEnabled: options.writes,
        };
      });
    },
    async recoverRevocation(token: string, key: string) {
      if (!available) return unavailable();
      if (!sampleUuid(key)) return invalid();
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const original = await revocation(context, key.toLowerCase());
        const rows = original
          ? await candidates(context, original.grantId)
          : [];
        await sampleAssignmentActors(context, actorIds(rows));
        if (!original) return { kind: "absent" as const };
        if (!rows.length) return sampleAssignmentDeny();
        return {
          kind: "ready" as const,
          row: (await retained(context, rows))[0]!,
          revocation: original,
          writesEnabled: options.writes,
        };
      });
    },
  };
}
