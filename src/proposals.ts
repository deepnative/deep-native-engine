import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";
import { workflowBundle } from "./workflow-registry.ts";

export interface WorkflowReference {
  id: string;
  version: number;
}

export type ProposalState =
  "draft" | "submitted" | "quarantined" | "rejected" | "withdrawn";
export interface Proposal {
  id: string;
  title: string | null;
  body: string | null;
  sources: string | null;
  workflowId?: string | null;
  workflowVersion?: number | null;
  state: ProposalState;
  createdAt: Date;
  submittedAt: Date | null;
}
export interface ProposalStore {
  createDraft(
    token: string,
    value: { title: string; body: string; sources: string },
    sampleConfirmed: boolean,
    workflow?: WorkflowReference,
  ): Promise<string | null>;
  owned(token: string): Promise<Proposal[]>;
  preview(token: string, id: string): Promise<Proposal | null>;
  submit(token: string, id: string, rightsConfirmed: boolean): Promise<boolean>;
  withdraw(token: string, id: string): Promise<boolean>;
  moderationQueue(token: string): Promise<Proposal[] | null>;
  moderate(
    token: string,
    id: string,
    action: "quarantine" | "reject",
  ): Promise<boolean>;
}
export function validProposal(value: {
  title: string;
  body: string;
  sources: string;
}): boolean {
  return (
    value.title.trim().length > 0 &&
    value.title.length <= 160 &&
    value.body.trim().length > 0 &&
    value.body.length <= 4000 &&
    value.sources.trim().length > 0 &&
    value.sources.length <= 1000
  );
}
export function disabledProposalStore(): ProposalStore {
  return {
    createDraft: async () => null,
    owned: async () => [],
    preview: async () => null,
    submit: async () => false,
    withdraw: async () => false,
    moderationQueue: async () => null,
    moderate: async () => false,
  };
}
const columns = `mp.id,mp.title,mp.body,mp.sources,mp.state,
 mp.workflow_id AS "workflowId",mp.workflow_version AS "workflowVersion",
 mp.created_at AS "createdAt",mp.submitted_at AS "submittedAt"`;
const member = `p.token_hash=$1 AND p.kind='member'
 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`;
interface ModerationActor {
  id: string;
  expires_at: Date;
  role: "moderator" | "platform_admin";
}
interface ModerationProposal extends Proposal {
  workspace_id: string;
  member_id: string;
}
export function proposalStore(
  pool: Pool,
  resolveWorkflow = workflowBundle,
): ProposalStore {
  async function audit(
    client: PoolClient,
    actor: ModerationActor,
    row: ModerationProposal,
    action: "proposal_read" | "proposal_quarantined" | "proposal_rejected",
    next: ProposalState,
  ) {
    await client.query(
      `INSERT INTO proposal_audit(actor_id,actor_role,workspace_id,member_id,
         proposal_id,action,old_state,new_state,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
      [
        actor.id,
        actor.role,
        row.workspace_id,
        row.member_id,
        row.id,
        action,
        row.state,
        next,
      ],
    );
  }

  async function withModerator<T>(
    token: string,
    id: string | null,
    denied: T,
    use: (
      client: PoolClient,
      actor: ModerationActor,
      rows: ModerationProposal[],
    ) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      // Lock order: staff principal, profile, member principals, workspaces,
      // proposals. Member principal locks precede both deletion cascades.
      const principal = (
        await client.query<{ id: string; expires_at: Date }>(
          `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='staff'
         AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
          [hash(token)],
        )
      ).rows[0];
      if (!principal) {
        await client.query("ROLLBACK");
        return denied;
      }
      const profile = (
        await client.query<{ role: ModerationActor["role"] }>(
          `SELECT role FROM staff_profiles WHERE principal_id=$1
         AND role IN ('moderator','platform_admin') FOR SHARE`,
          [principal.id],
        )
      ).rows[0];
      if (!profile) {
        await client.query("ROLLBACK");
        return denied;
      }
      // Capture only identifiers until all ownership/state locks are held.
      // Exclude already deleting/absent workspaces before LIMIT so they cannot
      // permanently hide a later eligible proposal during deletion recovery.
      // A concurrently withdrawn/deleted candidate is excluded, never replaced
      // with an unlocked row beyond this invocation's ordered 100-row window.
      const candidates = (
        await client.query<{ id: string; member_id: string }>(
          `SELECT mp.id,mp.member_id FROM member_proposals mp
         JOIN workspaces w ON w.owner_principal_id=mp.member_id
         WHERE w.deleting_at IS NULL AND mp.state IN ('submitted','quarantined')
           AND ($1::uuid IS NULL OR mp.id=$1)
         ORDER BY mp.submitted_at,mp.id LIMIT 100`,
          [id],
        )
      ).rows;
      const members = candidates.map((row) => row.member_id);
      await client.query(
        `SELECT id FROM principals WHERE id=ANY($1::uuid[]) AND kind='member'
         ORDER BY id FOR SHARE`,
        [members],
      );
      const workspaces = (
        await client.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE owner_principal_id=ANY($1::uuid[])
         AND deleting_at IS NULL ORDER BY id FOR SHARE`,
          [members],
        )
      ).rows;
      const rows = (
        await client.query<ModerationProposal>(
          `WITH locked AS MATERIALIZED (
           SELECT mp.*,w.id AS workspace_id FROM member_proposals mp
           JOIN workspaces w ON w.owner_principal_id=mp.member_id
           WHERE mp.id=ANY($1::uuid[]) AND w.id=ANY($2::uuid[])
             AND mp.state IN ('submitted','quarantined')
           ORDER BY mp.id FOR UPDATE OF mp
         ) SELECT ${columns},mp.workspace_id,mp.member_id FROM locked mp
         ORDER BY mp.submitted_at,mp.id`,
          [candidates.map((row) => row.id), workspaces.map((row) => row.id)],
        )
      ).rows;
      const result = await use(client, { ...principal, ...profile }, rows);
      // BEGIN time is frozen. Audit insertion can itself wait; check actual
      // wall time after every lock/write, before COMMIT and private output.
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expires_at],
      );
      if (!current.rows[0]!.valid) {
        await client.query("ROLLBACK");
        return denied;
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        releaseError = new Error("Proposal audit rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  return {
    async createDraft(token, value, sampleConfirmed, workflow) {
      if (!sampleConfirmed || !validProposal(value)) return null;
      if (workflow) {
        if (!Number.isSafeInteger(workflow.version) || workflow.version < 1)
          return null;
        const current = await resolveWorkflow(workflow.id);
        if (!current || current.version !== workflow.version) return null;
      }
      const id = randomUUID();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO member_proposals(id,member_id,title,body,sources,
           workflow_id,workflow_version,sample_attested_at)
         SELECT $2,p.id,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP FROM principals p
         JOIN learners l ON l.id=p.id WHERE ${member}
         RETURNING id`,
        [
          hash(token),
          id,
          value.title,
          value.body,
          value.sources,
          workflow?.id ?? null,
          workflow?.version ?? null,
        ],
      );
      return result.rows[0]?.id ?? null;
    },
    async owned(token) {
      const result = await pool.query<Proposal>(
        `SELECT ${columns} FROM member_proposals mp
         JOIN principals p ON p.id=mp.member_id
         WHERE ${member} ORDER BY mp.created_at DESC`,
        [hash(token)],
      );
      return result.rows;
    },
    async preview(token, id) {
      const result = await pool.query<Proposal>(
        `SELECT ${columns} FROM member_proposals mp
         JOIN principals p ON p.id=mp.member_id
         WHERE ${member} AND mp.id=$2`,
        [hash(token), id],
      );
      return result.rows[0] ?? null;
    },
    async submit(token, id, rightsConfirmed) {
      if (!rightsConfirmed) return false;
      const draft = await pool.query<{
        workflowId: string | null;
        workflowVersion: number | null;
      }>(
        `SELECT mp.workflow_id AS "workflowId",
           mp.workflow_version AS "workflowVersion"
         FROM member_proposals mp JOIN principals p ON p.id=mp.member_id
         WHERE ${member} AND mp.id=$2 AND mp.state='draft'`,
        [hash(token), id],
      );
      const reference = draft.rows[0];
      if (!reference) return false;
      if (reference.workflowId) {
        const current = await resolveWorkflow(reference.workflowId);
        if (!current || current.version !== reference.workflowVersion)
          return false;
      }
      const result = await pool.query(
        `UPDATE member_proposals mp SET state='submitted',
           rights_attested_at=CURRENT_TIMESTAMP,submitted_at=CURRENT_TIMESTAMP
         FROM principals p WHERE p.id=mp.member_id AND ${member}
           AND mp.id=$2 AND mp.state='draft'`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
    async withdraw(token, id) {
      const result = await pool.query(
        `UPDATE member_proposals mp SET state='withdrawn',title=NULL,body=NULL,
           sources=NULL,workflow_id=NULL,workflow_version=NULL,
           withdrawn_at=CURRENT_TIMESTAMP
         FROM principals p WHERE p.id=mp.member_id AND ${member}
           AND mp.id=$2 AND mp.state IN ('draft','submitted','quarantined')`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
    async moderationQueue(token) {
      return withModerator<Proposal[] | null>(
        token,
        null,
        null,
        async (client, actor, rows) => {
          for (const row of rows)
            await audit(client, actor, row, "proposal_read", row.state);
          return rows.map(
            ({ workspace_id: _workspace, member_id: _member, ...proposal }) =>
              proposal,
          );
        },
      );
    },
    async moderate(token, id, action) {
      if (action !== "quarantine" && action !== "reject") return false;
      return withModerator(token, id, false, async (client, actor, rows) => {
        const row = rows[0];
        if (!row || (action === "quarantine" && row.state !== "submitted"))
          return false;
        const next = action === "quarantine" ? "quarantined" : "rejected";
        await client.query(
          `UPDATE member_proposals SET state=$2,
             title=CASE WHEN $2='rejected' THEN NULL ELSE title END,
             body=CASE WHEN $2='rejected' THEN NULL ELSE body END,
             sources=CASE WHEN $2='rejected' THEN NULL ELSE sources END,
             workflow_id=CASE WHEN $2='rejected' THEN NULL ELSE workflow_id END,
             workflow_version=CASE WHEN $2='rejected' THEN NULL ELSE workflow_version END,
             moderated_by=$3,moderated_at=clock_timestamp() WHERE id=$1`,
          [row.id, next, actor.id],
        );
        await audit(
          client,
          actor,
          row,
          action === "quarantine"
            ? "proposal_quarantined"
            : "proposal_rejected",
          next,
        );
        return true;
      });
    },
  };
}
