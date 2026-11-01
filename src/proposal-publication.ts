import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
  type SampleFailureKind,
} from "./sample-feedback-lifetime.ts";

export const DISPLAY_PERMISSION = "member-display-v1";
export interface PublicationSource {
  id: string;
  memberId: string;
  workspaceId: string;
  title: string | null;
  body: string | null;
  sources: string | null;
  origin: "sample" | "member";
  state: string;
  revision: number;
  rightsRevision: number | null;
}
export interface PublicationReceipt {
  id: string;
  proposalId: string;
  revision: number;
  state: "accepted" | "published" | "withdrawn";
  acceptedAt: Date;
  operationId: string | null;
  attribution: string | null;
  audience: "members" | null;
  permissionVersion: string | null;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
}
export interface PublicationInstruction {
  operationId: string;
  proposalId: string;
  revision: number;
  attribution: string;
  audience: "members";
  permissionVersion: typeof DISPLAY_PERMISSION;
  confirmed: true;
}
export type PublicationResult<T> =
  | { kind: SampleFailureKind | "disabled" }
  | { kind: "ready"; value: T; deadline: number };
export interface PublicationStore {
  owner(
    token: string,
    proposalId: string,
  ): Promise<
    PublicationResult<{
      source: PublicationSource;
      receipt: PublicationReceipt | null;
    }>
  >;
  accept(
    token: string,
    proposalId: string,
    revision: number,
    confirmed: boolean,
  ): Promise<PublicationResult<PublicationReceipt>>;
  publish(
    token: string,
    input: unknown,
  ): Promise<PublicationResult<PublicationReceipt>>;
  inspect(
    token: string,
    operationId: string,
  ): Promise<PublicationResult<PublicationReceipt | null>>;
  withdraw(
    token: string,
    proposalId: string,
    revision: number,
  ): Promise<PublicationResult<PublicationReceipt>>;
  list(
    token: string,
  ): Promise<
    PublicationResult<
      Array<{ receipt: PublicationReceipt; source: PublicationSource }>
    >
  >;
  detail(
    token: string,
    id: string,
  ): Promise<
    PublicationResult<{
      receipt: PublicationReceipt;
      source: PublicationSource;
    }>
  >;
}
export const publicationRevision = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
export function publicationInstruction(
  value: unknown,
): PublicationInstruction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 7 ||
    !sampleUuid(v.operationId) ||
    !sampleUuid(v.proposalId) ||
    !publicationRevision(v.revision) ||
    typeof v.attribution !== "string" ||
    !v.attribution.trim() ||
    v.attribution.length > 80 ||
    /[\0\uD800-\uDFFF]/u.test(v.attribution) ||
    v.audience !== "members" ||
    v.permissionVersion !== DISPLAY_PERMISSION ||
    v.confirmed !== true
  )
    return null;
  return v as unknown as PublicationInstruction;
}
const fail = (kind: SampleFailureKind): never => {
  throw new SampleFeedbackFailure(kind);
};
const fields = `id,proposal_id AS "proposalId",revision,state,accepted_at AS "acceptedAt",operation_id AS "operationId",attribution,audience,
 permission_version AS "permissionVersion",published_at AS "publishedAt",withdrawn_at AS "withdrawnAt"`;
const sourceFields = `p.id,p.member_id AS "memberId",w.id AS "workspaceId",p.title,p.body,p.sources,p.origin,p.state,p.revision,p.rights_attested_revision AS "rightsRevision"`;
export function publicationStore(
  pool: Pool,
  options: { enabled: boolean },
): PublicationStore {
  async function run<T>(
    token: string,
    staff: boolean,
    writing: boolean,
    use: (
      tx: SampleTransaction,
      actor: { id: string; role: string },
    ) => Promise<T>,
  ): Promise<PublicationResult<T>> {
    if (!sampleToken(token)) return { kind: "denied" };
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const actor = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals
          WHERE token_hash=$1 AND kind=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token), staff ? "staff" : "member"],
          )
        ).rows[0];
        if (!actor) return fail("denied");
        await tx.observe([actor.expires]);
        let role = "member";
        if (staff) {
          const profile = (
            await tx.query<{ role: string }>(
              "SELECT role FROM authorized_staff_profiles WHERE principal_id=$1 AND role IN ('moderator','platform_admin') FOR SHARE",
              [actor.id],
            )
          ).rows[0];
          if (!profile) return fail("denied");
          role = profile.role;
        } else if (
          !(
            await tx.query(
              "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
              [actor.id],
            )
          ).rows[0]
        )
          return fail("denied");
        const value = await use(tx, { id: actor.id, role });
        await tx.observe([actor.expires]);
        return { kind: "ready" as const, value, deadline: tx.deadline() };
      });
    } catch (error) {
      return {
        kind:
          error instanceof SampleFeedbackFailure ? error.kind : "unavailable",
      };
    }
  }
  async function sources(
    tx: SampleTransaction,
    ids: string[],
    writing: boolean,
  ) {
    const refs = (
      await tx.query<{ member_id: string }>(
        "SELECT member_id FROM member_proposals WHERE id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    const members = refs.map((r) => r.member_id);
    await tx.query(
      "SELECT id FROM principals WHERE id=ANY($1::uuid[]) AND kind='member' ORDER BY id FOR SHARE",
      [members],
    );
    const workspaces = (
      await tx.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE owner_principal_id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY id FOR SHARE",
        [members],
      )
    ).rows;
    return (
      await tx.query<PublicationSource>(
        `SELECT ${sourceFields} FROM member_proposals p JOIN workspaces w ON w.owner_principal_id=p.member_id
      WHERE p.id=ANY($1::uuid[]) AND w.id=ANY($2::uuid[]) AND w.deleting_at IS NULL ORDER BY p.id FOR ${writing ? "UPDATE" : "SHARE"} OF p`,
        [ids, workspaces.map((w) => w.id)],
      )
    ).rows;
  }
  async function owned(
    tx: SampleTransaction,
    actor: string,
    id: string,
    writing: boolean,
  ) {
    // Verify ownership before looking up or locking any other owner's source.
    if (
      !(
        await tx.query(
          "SELECT id FROM member_proposals WHERE id=$1 AND member_id=$2",
          [id, actor],
        )
      ).rows[0]
    )
      return fail("denied");
    const row = (await sources(tx, [id], writing))[0];
    if (!row || row.memberId !== actor) return fail("denied");
    return row;
  }
  async function receipt(
    tx: SampleTransaction,
    id: string,
    revision: number,
    writing = false,
  ) {
    return (
      (
        await tx.query<PublicationReceipt>(
          `SELECT ${fields} FROM proposal_publications WHERE proposal_id=$1 AND revision=$2 FOR ${writing ? "UPDATE" : "SHARE"}`,
          [id, revision],
        )
      ).rows[0] ?? null
    );
  }
  async function readPublished(token: string, id?: string) {
    return run(token, false, false, async (tx) => {
      const refs = (
        await tx.query<{ id: string; proposal_id: string }>(
          `SELECT id,proposal_id FROM proposal_publications WHERE state='published'
        AND ($1::uuid IS NULL OR id=$1) ORDER BY id LIMIT 50`,
          [id ?? null],
        )
      ).rows;
      const rows = await sources(
        tx,
        refs.map((r) => r.proposal_id),
        false,
      );
      const publications = (
        await tx.query<PublicationReceipt>(
          `SELECT ${fields} FROM proposal_publications WHERE id=ANY($1::uuid[]) AND state='published' ORDER BY id FOR SHARE`,
          [refs.map((r) => r.id)],
        )
      ).rows;
      return publications.flatMap((r) => {
        const source = rows.find(
          (s) =>
            s.id === r.proposalId &&
            s.revision === r.revision &&
            s.state === "submitted" &&
            s.rightsRevision === r.revision,
        );
        return source ? [{ receipt: r, source }] : [];
      });
    });
  }
  return {
    async owner(token, id) {
      if (!sampleUuid(id)) return { kind: "invalid" };
      return run(token, false, false, async (tx, actor) => {
        const source = await owned(tx, actor.id, id, false);
        return { source, receipt: await receipt(tx, id, source.revision) };
      });
    },
    async accept(token, id, revision, confirmed) {
      if (!options.enabled) return { kind: "disabled" };
      if (
        !sampleUuid(id) ||
        !publicationRevision(revision) ||
        confirmed !== true
      )
        return { kind: "invalid" };
      return run(token, true, true, async (tx, actor) => {
        const source = (await sources(tx, [id], true))[0];
        if (!source) return fail("denied");
        if (
          source.state !== "submitted" ||
          source.revision !== revision ||
          source.rightsRevision !== revision
        )
          return fail("conflict");
        const prior = await receipt(tx, id, revision, true);
        if (prior) return prior;
        await tx.query(
          `INSERT INTO proposal_publications(id,proposal_id,member_id,workspace_id,revision,accepted_by,accepted_role)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            id,
            source.memberId,
            source.workspaceId,
            revision,
            actor.id,
            actor.role,
          ],
        );
        return (await receipt(tx, id, revision))!;
      });
    },
    async publish(token, value) {
      const input = publicationInstruction(value);
      if (!input) return { kind: "invalid" };
      return run(token, false, true, async (tx, actor) => {
        const source = await owned(tx, actor.id, input.proposalId, true);
        const row = await receipt(tx, input.proposalId, input.revision, true);
        if (!row) return fail("conflict");
        if (row.operationId === input.operationId) {
          if (
            row.state === "published" &&
            row.attribution !== input.attribution
          )
            return fail("conflict");
          return row;
        }
        if (!options.enabled) return fail("denied");
        if (
          source.state !== "submitted" ||
          source.revision !== input.revision ||
          source.rightsRevision !== input.revision ||
          row.state !== "accepted"
        )
          return fail("conflict");
        await tx.query(
          `UPDATE proposal_publications SET state='published',operation_id=$2,attribution=$3,audience=$4,permission_version=$5,published_at=clock_timestamp() WHERE id=$1`,
          [
            row.id,
            input.operationId,
            input.attribution,
            input.audience,
            input.permissionVersion,
          ],
        );
        return (await receipt(tx, input.proposalId, input.revision))!;
      });
    },
    async inspect(token, operationId) {
      if (!sampleUuid(operationId)) return { kind: "invalid" };
      return run(token, false, false, async (tx, actor) => {
        const ref = (
          await tx.query<{
            proposal_id: string;
            member_id: string;
            revision: number;
          }>(
            "SELECT proposal_id,member_id,revision FROM proposal_publications WHERE operation_id=$1",
            [operationId],
          )
        ).rows[0];
        if (!ref) return null;
        if (ref.member_id !== actor.id) return fail("denied");
        await owned(tx, actor.id, ref.proposal_id, false);
        return receipt(tx, ref.proposal_id, ref.revision);
      });
    },
    async withdraw(token, id, revision) {
      if (!sampleUuid(id) || !publicationRevision(revision))
        return { kind: "invalid" };
      return run(token, false, true, async (tx, actor) => {
        await owned(tx, actor.id, id, true);
        const row = await receipt(tx, id, revision, true);
        if (!row) return fail("denied");
        if (row.state !== "withdrawn")
          await tx.query(
            "UPDATE proposal_publications SET state='withdrawn',attribution=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
            [row.id],
          );
        return (await receipt(tx, id, revision))!;
      });
    },
    list: (token) => readPublished(token),
    async detail(token, id) {
      if (!sampleUuid(id)) return { kind: "invalid" };
      const result = await readPublished(token, id);
      if (result.kind !== "ready") return result;
      return result.value[0]
        ? { ...result, value: result.value[0] }
        : { kind: "denied" };
    },
  };
}
