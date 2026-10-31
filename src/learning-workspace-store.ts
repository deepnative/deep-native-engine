import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  decodeLearningText,
  encodeLearningText,
} from "./learning-workspace-text.ts";
import {
  emptyLearningSnapshot,
  joinLearningSnapshot,
  learningDigest,
  learningInteger,
  learningObject,
  learningUuid,
  splitLearningSnapshot,
  validLearningDecision,
  validLearningIdentity,
  validLearningSnapshot,
  type LearningBundle,
  type LearningBundleLoader,
  type LearningDecision,
  type LearningIdentity,
  type LearningSnapshot,
} from "./learning-workspace-values.ts";

export type LearningFailure = {
  kind:
    | "denied"
    | "unavailable"
    | "invalid"
    | "conflict"
    | "deleted"
    | "source-unavailable"
    | "not-found";
};
export type LearningResult<T> = { kind: "ok"; value: T } | LearningFailure;
export interface LearningSaved {
  kind: "saved" | "replayed";
  notebookId: string;
  revision: number;
  decisionSequence: number;
  savedAt: Date;
}
export type LearningMutation = LearningSaved | LearningFailure;
export interface LearningSummary extends LearningIdentity {
  id: string;
  revision: number;
  decisionSequence: number;
  draftRevision: number;
  draftBasedOnDecisionSequence: number;
  savedAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
}
export interface LearningRead extends LearningSummary {
  state: LearningSnapshot;
  availability: "available" | "source-unavailable";
  currentArtifact: { id: number; text: string } | null;
}
export interface LearningWrite {
  operationId: string;
  expectedRevision: number;
}
export interface LearningWorkspaceStore {
  source(
    token: string,
    identity: LearningIdentity,
  ): Promise<LearningResult<LearningBundle>>;
  create(
    token: string,
    input: LearningIdentity & { operationId: string },
  ): Promise<LearningMutation>;
  list(
    token: string,
    after?: string,
  ): Promise<
    LearningResult<{ items: LearningSummary[]; nextCursor: string | null }>
  >;
  read(token: string, id: string): Promise<LearningResult<LearningRead>>;
  find(
    token: string,
    identity: LearningIdentity,
  ): Promise<LearningResult<LearningRead>>;
  save(
    token: string,
    id: string,
    input: LearningWrite & {
      state: LearningSnapshot;
      basedOnDecisionSequence: number;
    },
  ): Promise<LearningMutation>;
  append(
    token: string,
    id: string,
    input: LearningWrite & { decision: LearningDecision },
  ): Promise<LearningMutation>;
  history(
    token: string,
    id: string,
    afterSequence?: number,
  ): Promise<
    LearningResult<{
      items: Array<LearningDecision & { acceptedAt: Date }>;
      nextSequence: number | null;
    }>
  >;
  remove(
    token: string,
    id: string,
    input: LearningWrite,
  ): Promise<LearningMutation>;
  operation(token: string, operationId: string): Promise<LearningMutation>;
}
type Notebook = LearningSummary & { metadata: LearningSnapshot | null };
type Tx = PracticeTransaction;
const columns = `id,content_id AS "contentId",content_version AS "contentVersion",content_hash AS "contentHash",variant,revision,decision_sequence AS "decisionSequence",draft_revision AS "draftRevision",draft_based_on_sequence AS "draftBasedOnDecisionSequence",metadata,created_at AS "createdAt",saved_at AS "savedAt",deleted_at AS "deletedAt"`;
const decisionTextKeys = [
  "text",
  "reason",
  "question",
  "proposedText",
] as const;
const failure = (kind: LearningFailure["kind"]): LearningFailure => ({ kind });
const identityOf = (row: LearningIdentity): LearningIdentity => ({
  contentId: row.contentId,
  contentVersion: row.contentVersion,
  contentHash: row.contentHash,
  variant: row.variant,
});
const summaryOf = ({
  metadata: _metadata,
  ...summary
}: Notebook): LearningSummary => summary;
const writeValid = (input: LearningWrite) =>
  learningUuid(input.operationId) &&
  learningInteger(input.expectedRevision) &&
  input.expectedRevision > 0;

export function learningWorkspaceStore(
  pool: Pool,
  loadBundle: LearningBundleLoader,
): LearningWorkspaceStore {
  async function transaction<T>(
    token: string,
    use: (tx: Tx, memberId: string) => Promise<T>,
  ): Promise<T | LearningFailure> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return failure("denied");
    try {
      return await practiceTransaction(pool, async (tx) => {
        const principal = (
          await tx.query<{ id: string; expires_at: Date }>(
            `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) throw new PracticeLifetimeFailure("denied");
        await tx.observe([principal.expires_at]);
        const workspace = await tx.query(
          "SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE",
          [principal.id],
        );
        if (!workspace.rows[0]) throw new PracticeLifetimeFailure("denied");
        const result = await use(tx, principal.id);
        await tx.observe([principal.expires_at]);
        return result;
      });
    } catch (error) {
      return failure(
        error instanceof PracticeLifetimeFailure && error.kind === "denied"
          ? "denied"
          : "unavailable",
      );
    }
  }
  async function bundle(
    tx: Tx,
    memberId: string,
    identity: LearningIdentity,
  ): Promise<LearningBundle | null> {
    const loaded = await tx.bounded(async () => {
      try {
        return await loadBundle(identity);
      } catch {
        // Missing teaching assets stop new study, not access to saved writing.
        // A deadline failure from bounded() still escapes this callback.
        return null;
      }
    });
    if (
      !loaded ||
      loaded.contentHash !== identity.contentHash ||
      loaded.publication.id !== identity.contentId ||
      loaded.publication.version !== identity.contentVersion
    )
      return null;
    await tx.query("SELECT id FROM learners WHERE id=$1 FOR SHARE", [memberId]);
    const row = (
      await tx.query(
        `SELECT * FROM content_versions WHERE id=$1 AND version=$2 FOR SHARE`,
        [identity.contentId, identity.contentVersion],
      )
    ).rows[0];
    if (!row || row.state !== "published" || row.requires_qualified_signoff)
      return null;
    const item = loaded.publication;
    const expected = {
      id: item.id,
      version: item.version,
      kind: item.kind,
      origin: item.origin,
      title: item.title,
      body: item.body,
      owner: item.owner,
      sources: item.sources,
      rights: item.rights,
      goals: item.goals,
      backgrounds: item.backgrounds,
      domains: item.domains,
      prerequisites: item.prerequisites,
      structured_prerequisites: item.structuredPrerequisites ?? null,
      minimum_experience: item.minimumExperience ?? "new",
      rubric: item.rubric,
      rubric_version: item.rubricVersion,
    };
    if (
      !Object.entries(expected).every(([key, value]) =>
        isDeepStrictEqual(row[key], value),
      )
    )
      return null;
    const eligible = (
      await tx.query<{ eligible: boolean }>(
        "SELECT member_content_eligible($1,$2,$3) AS eligible",
        [memberId, identity.contentId, identity.contentVersion],
      )
    ).rows[0];
    return eligible?.eligible ? loaded : null;
  }
  async function notebook(
    tx: Tx,
    memberId: string,
    id: string,
  ): Promise<Notebook | undefined> {
    return (
      await tx.query<Notebook>(
        `SELECT ${columns} FROM learning_workspace_notebooks WHERE id=$1 AND member_id=$2 FOR UPDATE`,
        [id, memberId],
      )
    ).rows[0];
  }
  async function receipt(
    tx: Tx,
    memberId: string,
    operationId: string,
    digest?: string,
  ): Promise<LearningMutation | null> {
    const row = (
      await tx.query<{
        notebookId: string;
        revision: number;
        decisionSequence: number;
        savedAt: Date;
        request_digest: string;
        deleted_at: Date | null;
        kind: string;
      }>(
        `SELECT o.notebook_id AS "notebookId",o.revision,o.decision_sequence AS "decisionSequence",o.saved_at AS "savedAt",o.request_digest,n.deleted_at,o.kind FROM learning_workspace_operations o JOIN learning_workspace_notebooks n ON n.id=o.notebook_id WHERE o.member_id=$1 AND o.operation_id=$2`,
        [memberId, operationId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.deleted_at && row.kind !== "remove") return failure("deleted");
    if (digest !== undefined && row.request_digest !== digest)
      return failure("conflict");
    return {
      kind: "replayed",
      notebookId: row.notebookId,
      revision: row.revision,
      decisionSequence: row.decisionSequence,
      savedAt: row.savedAt,
    };
  }
  async function record(
    tx: Tx,
    memberId: string,
    operationId: string,
    kind: string,
    digest: string,
    row: Notebook,
  ): Promise<LearningSaved> {
    await tx.query(
      `INSERT INTO learning_workspace_operations(member_id,operation_id,notebook_id,kind,request_digest,revision,decision_sequence,saved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        memberId,
        operationId,
        row.id,
        kind,
        digest,
        row.revision,
        row.decisionSequence,
        row.savedAt,
      ],
    );
    return {
      kind: "saved",
      notebookId: row.id,
      revision: row.revision,
      decisionSequence: row.decisionSequence,
      savedAt: row.savedAt,
    };
  }
  async function fields(tx: Tx, id: string, state: LearningSnapshot) {
    const { metadata, fields } = splitLearningSnapshot(state);
    await tx.query(
      "DELETE FROM learning_workspace_fields WHERE notebook_id=$1",
      [id],
    );
    await tx.query(
      `INSERT INTO learning_workspace_fields(notebook_id,field_key,value_json) SELECT $1,key,value FROM jsonb_each_text($2::jsonb)`,
      [
        id,
        JSON.stringify(
          Object.fromEntries(
            fields.map(([key, text]) => [key, encodeLearningText(text)]),
          ),
        ),
      ],
    );
    return metadata;
  }
  async function decisionRows(
    tx: Tx,
    id: string,
    after: number,
    limit: number,
  ) {
    const rows = (
      await tx.query<{
        sequence: number;
        metadata: LearningDecision;
        acceptedAt: Date;
      }>(
        `SELECT sequence,metadata,accepted_at AS "acceptedAt" FROM learning_workspace_decisions WHERE notebook_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,
        [id, after, limit],
      )
    ).rows;
    const textRows = (
      await tx.query<{
        sequence: number;
        field_key: string;
        value_json: string;
      }>(
        `SELECT sequence,field_key,value_json FROM learning_workspace_decision_fields WHERE notebook_id=$1 AND sequence=ANY($2::integer[]) ORDER BY sequence,field_key`,
        [id, rows.map((row) => row.sequence)],
      )
    ).rows;
    return rows.map((row) => {
      const texts = textRows.filter((text) => text.sequence === row.sequence);
      if (texts.length !== 4) throw Error("Learning history unavailable");
      return {
        ...row.metadata,
        ...Object.fromEntries(
          texts.map((text) => [
            text.field_key,
            decodeLearningText(text.value_json),
          ]),
        ),
        acceptedAt: row.acceptedAt,
      };
    });
  }
  async function currentArtifact(
    tx: Tx,
    row: Notebook,
    loaded: LearningBundle | null,
  ) {
    if (!row.decisionSequence)
      return loaded?.routes[row.variant].feedback.initial ?? null;
    const current = (
      await decisionRows(tx, row.id, row.decisionSequence - 1, 1)
    )[0];
    if (!current) throw Error("Learning history unavailable");
    return { id: current.toVersion, text: current.text };
  }
  async function readSaved(
    tx: Tx,
    row: Notebook,
    loaded: LearningBundle | null,
  ): Promise<LearningResult<LearningRead>> {
    const texts = (
      await tx.query<{ field_key: string; value_json: string }>(
        "SELECT field_key,value_json FROM learning_workspace_fields WHERE notebook_id=$1 ORDER BY field_key",
        [row.id],
      )
    ).rows;
    const state = joinLearningSnapshot(
      row.metadata!,
      texts.map((text) => [
        text.field_key,
        decodeLearningText(text.value_json),
      ]),
    );
    return {
      kind: "ok",
      value: {
        ...summaryOf(row),
        state,
        availability: loaded ? "available" : "source-unavailable",
        currentArtifact: await currentArtifact(tx, row, loaded),
      },
    };
  }
  async function mutate(
    token: string,
    id: string,
    input: LearningWrite,
    kind: "save" | "append" | "remove",
    use: (
      tx: Tx,
      row: Notebook,
      loaded: LearningBundle | null,
    ) => Promise<LearningFailure | void>,
  ): Promise<LearningMutation> {
    if (!learningUuid(id) || !writeValid(input)) return failure("invalid");
    const digest = learningDigest({ kind, id, input });
    return transaction(token, async (tx, memberId) => {
      const previous = await receipt(tx, memberId, input.operationId, digest);
      if (previous) return previous;
      // Workspace serialization makes the identity read stable; lock the exact
      // publication before the notebook, consistently with source retirement.
      const identity = (
        await tx.query<LearningIdentity>(
          `SELECT content_id AS "contentId",content_version AS "contentVersion",content_hash AS "contentHash",variant FROM learning_workspace_notebooks WHERE id=$1 AND member_id=$2`,
          [id, memberId],
        )
      ).rows[0];
      if (!identity) return failure("not-found");
      const loaded =
        kind === "remove" ? null : await bundle(tx, memberId, identity);
      const row = (await notebook(tx, memberId, id))!;
      if (row.deletedAt) return failure("deleted");
      if (row.revision !== input.expectedRevision) return failure("conflict");
      if (kind !== "remove" && !loaded) return failure("source-unavailable");
      const rejected = await use(tx, row, loaded);
      if (rejected) return rejected;
      return record(
        tx,
        memberId,
        input.operationId,
        kind,
        digest,
        (await notebook(tx, memberId, id))!,
      );
    });
  }
  return {
    async source(token, identity) {
      if (!validLearningIdentity(identity)) return failure("invalid");
      return transaction(token, async (tx, memberId) => {
        const value = await bundle(tx, memberId, identity);
        return value ? { kind: "ok", value } : failure("source-unavailable");
      });
    },
    async create(token, input) {
      if (
        !learningObject(input, [
          "contentId",
          "contentVersion",
          "contentHash",
          "variant",
          "operationId",
        ]) ||
        !learningUuid(input.operationId)
      )
        return failure("invalid");
      const identity = identityOf(input);
      if (!validLearningIdentity(identity)) return failure("invalid");
      const digest = learningDigest({ kind: "create", input });
      return transaction(token, async (tx, memberId) => {
        const previous = await receipt(tx, memberId, input.operationId, digest);
        if (previous) return previous;
        const loaded = await bundle(tx, memberId, identity);
        if (!loaded) return failure("source-unavailable");
        const existing = (
          await tx.query<{ id: string }>(
            `SELECT id FROM learning_workspace_notebooks WHERE member_id=$1 AND content_id=$2 AND content_version=$3 AND content_hash=$4 AND variant=$5 AND deleted_at IS NULL`,
            [
              memberId,
              identity.contentId,
              identity.contentVersion,
              identity.contentHash,
              identity.variant,
            ],
          )
        ).rows[0];
        const id = existing?.id ?? randomUUID();
        if (!existing) {
          const state = emptyLearningSnapshot(loaded, identity.variant);
          await tx.query(
            `INSERT INTO learning_workspace_notebooks(id,member_id,workspace_id,content_id,content_version,content_hash,variant,metadata) VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              memberId,
              identity.contentId,
              identity.contentVersion,
              identity.contentHash,
              identity.variant,
              splitLearningSnapshot(state).metadata,
            ],
          );
          await fields(tx, id, state);
        }
        return record(
          tx,
          memberId,
          input.operationId,
          "create",
          digest,
          (await notebook(tx, memberId, id))!,
        );
      });
    },
    async list(token, after) {
      if (after !== undefined && !learningUuid(after))
        return failure("invalid");
      return transaction(token, async (tx, memberId) => {
        const rows = (
          await tx.query<Notebook>(
            `SELECT ${columns} FROM learning_workspace_notebooks WHERE member_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 21`,
            [memberId, after ?? null],
          )
        ).rows;
        return {
          kind: "ok",
          value: {
            items: rows.slice(0, 20).map(summaryOf),
            nextCursor: rows.length > 20 ? rows[19]!.id : null,
          },
        };
      });
    },
    async read(token, id) {
      if (!learningUuid(id)) return failure("invalid");
      return transaction(token, async (tx, memberId) => {
        const raw = (
          await tx.query<Notebook>(
            `SELECT ${columns} FROM learning_workspace_notebooks WHERE id=$1 AND member_id=$2`,
            [id, memberId],
          )
        ).rows[0];
        if (!raw) return failure("not-found");
        if (raw.deletedAt) return failure("deleted");
        const loaded = await bundle(tx, memberId, identityOf(raw));
        const row = (await notebook(tx, memberId, id))!;
        return readSaved(tx, row, loaded);
      });
    },
    async find(token, identity) {
      if (!validLearningIdentity(identity)) return failure("invalid");
      return transaction(token, async (tx, memberId) => {
        const loaded = await bundle(tx, memberId, identity);
        if (!loaded) return failure("source-unavailable");
        const row = (
          await tx.query<Notebook>(
            `SELECT ${columns} FROM learning_workspace_notebooks WHERE member_id=$1 AND content_id=$2 AND content_version=$3 AND content_hash=$4 AND variant=$5 AND deleted_at IS NULL FOR UPDATE`,
            [
              memberId,
              identity.contentId,
              identity.contentVersion,
              identity.contentHash,
              identity.variant,
            ],
          )
        ).rows[0];
        return row ? readSaved(tx, row, loaded) : failure("not-found");
      });
    },
    async save(token, id, input) {
      if (
        !learningObject(input, [
          "operationId",
          "expectedRevision",
          "state",
          "basedOnDecisionSequence",
        ]) ||
        !learningInteger(input.basedOnDecisionSequence)
      )
        return failure("invalid");
      return mutate(token, id, input, "save", async (tx, row, loaded) => {
        if (!validLearningSnapshot(input.state, loaded!, row.variant))
          return failure("invalid");
        if (input.basedOnDecisionSequence !== row.decisionSequence)
          return failure("conflict");
        const metadata = await fields(tx, id, input.state);
        await tx.query(
          "UPDATE learning_workspace_notebooks SET revision=revision+1,draft_revision=revision+1,draft_based_on_sequence=decision_sequence,metadata=$2,saved_at=clock_timestamp() WHERE id=$1",
          [id, metadata],
        );
      });
    },
    async append(token, id, input) {
      if (
        !learningObject(input, ["operationId", "expectedRevision", "decision"])
      )
        return failure("invalid");
      return mutate(token, id, input, "append", async (tx, row, loaded) => {
        const current = (await currentArtifact(tx, row, loaded))!;
        if (
          !validLearningDecision(
            input.decision,
            loaded!,
            row.variant,
            row.decisionSequence,
            current,
          )
        )
          return failure("invalid");
        const metadata = { ...input.decision };
        for (const key of decisionTextKeys) metadata[key] = "";
        await tx.query(
          "INSERT INTO learning_workspace_decisions(notebook_id,sequence,metadata) VALUES($1,$2,$3)",
          [id, input.decision.id, metadata],
        );
        await tx.query(
          `INSERT INTO learning_workspace_decision_fields(notebook_id,sequence,field_key,value_json) SELECT $1,$2,key,value FROM jsonb_each_text($3::jsonb)`,
          [
            id,
            input.decision.id,
            JSON.stringify(
              Object.fromEntries(
                decisionTextKeys.map((key) => [
                  key,
                  encodeLearningText(input.decision[key]),
                ]),
              ),
            ),
          ],
        );
        await tx.query(
          "UPDATE learning_workspace_notebooks SET revision=revision+1,decision_sequence=decision_sequence+1,saved_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      });
    },
    async history(token, id, afterSequence = 0) {
      if (!learningUuid(id) || !learningInteger(afterSequence))
        return failure("invalid");
      return transaction(token, async (tx, memberId) => {
        const row = await notebook(tx, memberId, id);
        if (!row) return failure("not-found");
        if (row.deletedAt) return failure("deleted");
        const rows = await decisionRows(tx, id, afterSequence, 21);
        return {
          kind: "ok",
          value: {
            items: rows.slice(0, 20),
            nextSequence: rows.length > 20 ? rows[19]!.id : null,
          },
        };
      });
    },
    async remove(token, id, input) {
      if (!learningObject(input, ["operationId", "expectedRevision"]))
        return failure("invalid");
      return mutate(token, id, input, "remove", async (tx) => {
        await tx.query(
          "DELETE FROM learning_workspace_fields WHERE notebook_id=$1",
          [id],
        );
        await tx.query(
          "DELETE FROM learning_workspace_decisions WHERE notebook_id=$1",
          [id],
        );
        // Keep receipt identities/digests with the tombstone: a delayed create
        // retry must not resurrect a notebook after its writing was erased.
        await tx.query(
          "UPDATE learning_workspace_notebooks SET revision=revision+1,metadata=NULL,deleted_at=clock_timestamp(),saved_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      });
    },
    async operation(token, operationId) {
      if (!learningUuid(operationId)) return failure("invalid");
      return transaction(
        token,
        async (tx, memberId) =>
          (await receipt(tx, memberId, operationId)) ?? failure("not-found"),
      );
    },
  };
}
