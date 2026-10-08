import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken } from "./sample-feedback-values.ts";
import {
  eventCancellationTransaction,
  EventCancellationFailure,
  type EventCancellationTransaction,
} from "./event-cancellation-lifetime.ts";
import {
  STUDY_FIXTURE_POLICY,
  type StudyFixtureReceipt,
} from "./study-unit-fixture-values.ts";

export interface StudyFixtureContext {
  tx: EventCancellationTransaction;
  actorId: string;
  credentialHash: string;
  expires: Date[];
}
export interface StudyFixturePrincipal {
  id: string;
  kind: string;
  expires: Date;
  revoked: Date | null;
}
export const studyFixtureDeny = (): never => {
  throw new EventCancellationFailure("denied");
};
export const studyFixtureConflict = (): never => {
  throw new EventCancellationFailure("conflict");
};
export async function studyFixtureExecute<T>(
  pool: Pool,
  token: string,
  writing: boolean,
  use: (context: StudyFixtureContext) => Promise<T>,
) {
  if (!sampleToken(token)) return { kind: "denied" as const };
  return eventCancellationTransaction(pool, writing, async (tx) => {
    const actor = (
      await tx.query<{ id: string; expires: Date }>(
        `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [hash(token)],
      )
    ).rows[0];
    if (!actor) return studyFixtureDeny();
    const context = {
      tx,
      actorId: actor.id,
      credentialHash: hash(token),
      expires: [actor.expires],
    };
    await tx.observe(context.expires);
    const value = await use(context);
    await tx.observe(context.expires);
    return () => value;
  });
}
export async function studyFixtureActors(
  context: StudyFixtureContext,
  ids: string[],
  role: "member" | "platform_admin",
) {
  const ordered = [...new Set([context.actorId, ...ids])].sort();
  const principals = new Map<string, StudyFixturePrincipal>();
  for (const id of ordered) {
    const principal = (
      await context.tx.query<StudyFixturePrincipal>(
        `SELECT id,kind,expires_at AS expires,revoked_at AS revoked FROM principals
         WHERE id=$1 AND ($2::text IS NULL OR token_hash=$2) FOR SHARE`,
        [id, id === context.actorId ? context.credentialHash : null],
      )
    ).rows[0];
    if (principal) principals.set(id, principal);
  }
  const profiles = new Map(
    (
      await context.tx.query<{ id: string; role: string }>(
        `SELECT principal_id AS id,role FROM staff_profiles
         WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE`,
        [ordered],
      )
    ).rows.map((row) => [row.id, row.role]),
  );
  const actor = principals.get(context.actorId);
  if (
    !actor ||
    actor.revoked !== null ||
    actor.kind !== (role === "member" ? "member" : "staff") ||
    (role === "platform_admin" && profiles.get(actor.id) !== role)
  )
    return studyFixtureDeny();
  context.expires.push(actor.expires);
  await context.tx.observe(context.expires);
  return { principals, profiles };
}
export async function studyFixtureWorkspace(
  context: StudyFixtureContext,
  memberId: string,
) {
  const workspace = (
    await context.tx.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE`,
      [memberId],
    )
  ).rows[0];
  if (!workspace) return studyFixtureDeny();
  await context.tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`browser-study-fixture-slot:${memberId}`],
  );
  return workspace.id;
}
export interface StudyFixtureRow extends StudyFixtureReceipt {
  memberId: string;
  workspaceId: string;
  memberExpiresAt: Date;
  administratorExpiresAt: Date;
  checkedAt: Date;
}
const columns = `id,member_id AS "memberId",workspace_id AS "workspaceId",policy,
 administrator_id AS "administratorId",member_expires_at AS "memberExpiresAt",
 administrator_expires_at AS "administratorExpiresAt",checked_at AS "checkedAt",
 created_at AS "createdAt",expires_at AS "expiresAt",grant_id AS "grantId",
 issued_at AS "issuedAt",grant_expires_at AS "grantExpiresAt",withdrawn_at AS "withdrawnAt"`;
export async function studyFixtureOwned(
  context: StudyFixtureContext,
  memberId: string,
) {
  return (
    (
      await context.tx.query<StudyFixtureRow>(
        `SELECT ${columns} FROM browser_study_fixture_requests
       WHERE member_id=$1 AND policy=$2 FOR UPDATE`,
        [memberId, STUDY_FIXTURE_POLICY],
      )
    ).rows[0] ?? null
  );
}
export async function studyFixtureExact(
  context: StudyFixtureContext,
  requestId: string,
  memberId: string,
) {
  const row = await studyFixtureOwned(context, memberId);
  if (!row || row.id !== requestId) return studyFixtureDeny();
  return row;
}
export const studyFixtureReceipt = (
  row: StudyFixtureRow,
): StudyFixtureReceipt => ({
  id: row.id,
  policy: row.policy,
  administratorId: row.administratorId,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  grantId: row.grantId,
  issuedAt: row.issuedAt,
  grantExpiresAt: row.grantExpiresAt,
  withdrawnAt: row.withdrawnAt,
});
export async function studyFixtureOperation(
  context: StudyFixtureContext,
  workspaceId: string,
  key: string,
  kind: "request" | "issue" | "withdraw",
  digest: string,
  requestId?: string,
) {
  await context.tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [key],
  );
  const original = (
    await context.tx.query<{
      actorId: string | null;
      workspaceId: string | null;
      requestId: string | null;
      kind: string | null;
      digest: string | null;
    }>(
      `SELECT actor_id AS "actorId",workspace_id AS "workspaceId",request_id AS "requestId",
       kind,instruction_hash AS digest FROM browser_study_fixture_operations WHERE operation_id=$1 FOR UPDATE`,
      [key],
    )
  ).rows[0];
  if (!original) return null;
  if (
    original.actorId !== context.actorId ||
    original.workspaceId !== workspaceId ||
    original.kind !== kind ||
    original.digest !== digest ||
    !original.requestId ||
    (requestId !== undefined && original.requestId !== requestId)
  )
    return studyFixtureConflict();
  return original.requestId;
}
export async function studyFixtureReserveOperation(
  context: StudyFixtureContext,
  workspaceId: string,
  key: string,
  kind: "request" | "issue" | "withdraw",
  digest: string,
  requestId: string,
) {
  await context.tx.query(
    `INSERT INTO browser_study_fixture_operations(operation_id,actor_id,workspace_id,request_id,kind,instruction_hash)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [key, context.actorId, workspaceId, requestId, kind, digest],
  );
}
