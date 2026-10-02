import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";
import { workflowBundle } from "./workflow-registry.ts";

export interface WorkflowReference {
  id: string;
  version: number;
}

export type ProposalState =
  | "draft"
  | "submitted"
  | "changes_requested"
  | "quarantined"
  | "rejected"
  | "withdrawn";
export interface Proposal {
  id: string;
  title: string | null;
  body: string | null;
  sources: string | null;
  workflowId?: string | null;
  workflowVersion?: number | null;
  state: ProposalState;
  revision: number;
  createdAt: Date;
  submittedAt: Date | null;
}
export interface OwnerProposal extends Proposal {
  feedback: {
    text: string;
    reviewedRevision: number;
    requestedAt: Date;
  } | null;
  rightsAttestedRevision: number | null;
  rightsAttestedAt: Date | null;
}
export interface ProposalStore {
  createDraft(
    token: string,
    value: { title: string; body: string; sources: string },
    sampleConfirmed: boolean,
    workflow?: WorkflowReference,
  ): Promise<string | null>;
  owned(token: string): Promise<Proposal[]>;
  preview(token: string, id: string): Promise<OwnerProposal | null>;
  requestChanges(
    token: string,
    id: string,
    input: { expectedRevision: number; feedback: string },
  ): Promise<"requested" | "replayed" | "conflict" | "denied" | "invalid">;
  editDraft(
    token: string,
    id: string,
    value: { title: string; body: string; sources: string },
    expectedRevision: number,
  ): Promise<"saved" | "conflict" | "denied" | "invalid">;
  submit(
    token: string,
    id: string,
    rightsConfirmed: boolean,
    expectedRevision: number,
  ): Promise<"submitted" | "replayed" | "conflict" | "denied">;
  withdraw(token: string, id: string): Promise<boolean>;
  moderationQueue(token: string): Promise<Proposal[] | null>;
  moderationPage(
    token: string,
    cursor?: unknown,
  ): Promise<{ items: Proposal[]; nextCursor: string | null } | null>;
  moderate(
    token: string,
    id: string,
    action: "quarantine" | "reject",
  ): Promise<boolean>;
}
export function validProposal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return Object.entries({ title: 160, body: 4000, sources: 1000 }).every(
    ([name, max]) => {
      const field = fields[name];
      return (
        typeof field === "string" &&
        field.trim().length > 0 &&
        field.length <= max &&
        !field.includes("\0")
      );
    },
  );
}
const proposalIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validRevision(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}
export function disabledProposalStore(): ProposalStore {
  return {
    createDraft: async () => null,
    owned: async () => [],
    preview: async () => null,
    requestChanges: async () => "denied",
    editDraft: async () => "denied",
    submit: async () => "denied",
    withdraw: async () => false,
    moderationQueue: async () => null,
    moderationPage: async () => null,
    moderate: async () => false,
  };
}
const columns = `mp.id,mp.title,mp.body,mp.sources,mp.state,mp.revision,
 mp.workflow_id AS "workflowId",mp.workflow_version AS "workflowVersion",
 mp.created_at AS "createdAt",mp.submitted_at AS "submittedAt"`;
const ownerColumns = `${columns},mp.change_feedback AS "feedbackText",
 mp.change_feedback_revision AS "feedbackRevision",mp.changes_requested_at AS "feedbackRequestedAt",
 mp.rights_attested_revision AS "rightsAttestedRevision",mp.rights_attested_at AS "rightsAttestedAt"`;
interface OwnerRow extends Proposal {
  feedbackText: string | null;
  feedbackRevision: number | null;
  feedbackRequestedAt: Date | null;
  rightsAttestedRevision: number | null;
  rightsAttestedAt: Date | null;
}
function projection(row: Proposal): Proposal {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sources: row.sources,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
  };
}
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
  feedback_matches?: boolean;
  feedback_revision?: number | null;
  decision_actor_id?: string | null;
}
export function proposalStore(
  pool: Pool,
  resolveWorkflow = workflowBundle,
): ProposalStore {
  // Continuation is intentionally local to this store instance. Restarting it
  // invalidates old links; the first page always remains available.
  const cursorKey = randomBytes(32);
  function cursorSignature(payload: string, actorId: string, token: string) {
    return createHmac("sha256", cursorKey)
      .update(
        JSON.stringify([
          "private-moderation-page",
          actorId,
          hash(token),
          payload,
        ]),
      )
      .digest("base64url");
  }
  function readCursor(cursor: unknown, actorId: string, token: string) {
    if (typeof cursor !== "string" || cursor.length > 512) return null;
    const match =
      /^v1\.([A-Za-z0-9_-]{1,128})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
        cursor,
      );
    if (!match || !proposalIdPattern.test(match[2]!)) return null;
    const payload = cursor.slice(0, cursor.lastIndexOf("."));
    if (
      !timingSafeEqual(
        Buffer.from(match[3]!),
        Buffer.from(cursorSignature(payload, actorId, token)),
      )
    )
      return null;
    // Only this instance can authenticate the exact PostgreSQL timestamp text.
    // Never round-trip it through JavaScript Date (which loses microseconds).
    return {
      submittedAt: Buffer.from(match[1]!, "base64url").toString("utf8"),
      id: match[2]!,
    };
  }
  async function withOwner<T>(
    token: string,
    id: string,
    denied: T,
    use: (client: PoolClient, row: OwnerRow) => Promise<T>,
    read = false,
  ): Promise<T> {
    if (!proposalIdPattern.test(id)) return denied;
    const client = await pool.connect();
    let releaseError: Error | undefined;
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      // Match deletion/moderation ordering. Authorization remains locked until
      // commit; row locking makes revision checks and state changes atomic.
      const principal = (
        await client.query<{ id: string; expires_at: Date }>(
          `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='member'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
          [hash(token)],
        )
      ).rows[0];
      if (!principal) {
        await client.query("ROLLBACK");
        return denied;
      }
      const workspace = await client.query(
        `SELECT id FROM workspaces WHERE owner_principal_id=$1
         AND deleting_at IS NULL FOR SHARE`,
        [principal.id],
      );
      if (!workspace.rows[0]) {
        await client.query("ROLLBACK");
        return denied;
      }
      const row = (
        await client.query<OwnerRow>(
          `SELECT ${ownerColumns} FROM member_proposals mp
           WHERE mp.member_id=$1 AND mp.id=$2 FOR ${read ? "SHARE" : "UPDATE"}`,
          [principal.id, id],
        )
      ).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return denied;
      }
      const result = await use(client, row);
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expires_at],
      );
      if (!current.rows[0]!.valid) {
        await client.query("ROLLBACK");
        return denied;
      }
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted)
        releaseError = new Error("Proposal commit outcome unconfirmed");
      try {
        await client.query("ROLLBACK");
      } catch {
        releaseError = new Error("Proposal mutation rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async function currentWorkflow(row: Proposal): Promise<boolean> {
    if (!row.workflowId) return true;
    const current = await resolveWorkflow(row.workflowId);
    return !!current && current.version === row.workflowVersion;
  }

  async function audit(
    client: PoolClient,
    actor: ModerationActor,
    row: ModerationProposal,
    action:
      | "proposal_read"
      | "proposal_quarantined"
      | "proposal_rejected"
      | "proposal_changes_requested",
    next: ProposalState,
  ) {
    await client.query(
      `INSERT INTO proposal_audit(actor_id,actor_role,workspace_id,member_id,
         proposal_id,action,old_state,new_state,reviewed_revision,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
      [
        actor.id,
        actor.role,
        row.workspace_id,
        row.member_id,
        row.id,
        action,
        row.state,
        next,
        row.revision,
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
      nextCursor: string | null,
    ) => Promise<T>,
    cursor?: unknown,
    change?: { expectedRevision: number; feedback: string },
  ): Promise<T> {
    const client = await pool.connect();
    let releaseError: Error | undefined;
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='5s'");
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
      const after =
        cursor === undefined ? null : readCursor(cursor, principal.id, token);
      if (cursor !== undefined && !after) {
        await client.query("ROLLBACK");
        return denied;
      }
      // Capture only identifiers and ordering metadata until all locks are held.
      // Exclude already deleting/absent workspaces before LIMIT so they cannot
      // permanently hide a later eligible proposal during deletion recovery.
      // A concurrently withdrawn/deleted candidate is excluded, never replaced
      // with an unlocked row beyond this invocation's ordered 100-row window.
      const states = change
        ? ["submitted", "changes_requested"]
        : ["submitted", "quarantined"];
      const candidates = (
        await client.query<{
          id: string;
          member_id: string;
          submitted_at: string;
        }>(
          `SELECT mp.id,mp.member_id,mp.submitted_at::text FROM member_proposals mp
         JOIN workspaces w ON w.owner_principal_id=mp.member_id
         WHERE w.deleting_at IS NULL AND mp.state=ANY($4::text[])
           AND ($1::uuid IS NULL OR mp.id=$1)
           AND ($2::timestamptz IS NULL OR (mp.submitted_at,mp.id)>($2::timestamptz,$3::uuid))
         ORDER BY mp.submitted_at,mp.id LIMIT 100`,
          [id, after?.submittedAt ?? null, after?.id ?? null, states],
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
             AND mp.state=ANY($3::text[])
           ORDER BY mp.id FOR UPDATE OF mp
         ) SELECT ${columns},mp.workspace_id,mp.member_id${change ? ",mp.change_feedback=$4 AS feedback_matches,mp.change_feedback_revision AS feedback_revision,mp.moderated_by AS decision_actor_id" : ""} FROM locked mp
         ORDER BY mp.submitted_at,mp.id`,
          [
            candidates.map((row) => row.id),
            workspaces.map((row) => row.id),
            states,
            ...(change ? [change.feedback] : []),
          ],
        )
      ).rows;
      // Advance past the candidate boundary even if it was withdrawn/deleted
      // while locks were acquired. Do not look ahead or refill the window.
      let nextCursor: string | null = null;
      if (candidates.length === 100) {
        const boundary = candidates[99]!;
        const payload = `v1.${Buffer.from(boundary.submitted_at).toString("base64url")}.${boundary.id}`;
        nextCursor = `${payload}.${cursorSignature(payload, principal.id, token)}`;
      }
      const result = await use(
        client,
        { ...principal, ...profile },
        rows,
        nextCursor,
      );
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
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted)
        releaseError = new Error("Proposal commit outcome unconfirmed");
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

  async function moderationPage(token: string, cursor?: unknown) {
    return withModerator<{
      items: Proposal[];
      nextCursor: string | null;
    } | null>(
      token,
      null,
      null,
      async (client, actor, rows, nextCursor) => {
        for (const row of rows)
          await audit(client, actor, row, "proposal_read", row.state);
        return {
          items: rows.map(projection),
          nextCursor,
        };
      },
      cursor,
    );
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
      return result.rows.map(projection);
    },
    async preview(token, id) {
      return withOwner<OwnerProposal | null>(
        token,
        id,
        null,
        async (_client, row) => ({
          ...projection(row),
          feedback:
            row.feedbackText === null
              ? null
              : {
                  text: row.feedbackText,
                  reviewedRevision: row.feedbackRevision!,
                  requestedAt: row.feedbackRequestedAt!,
                },
          rightsAttestedRevision: row.rightsAttestedRevision,
          rightsAttestedAt: row.rightsAttestedAt,
        }),
        true,
      );
    },
    async requestChanges(token, id, input) {
      if (!proposalIdPattern.test(id)) return "denied";
      if (
        !validRevision(input.expectedRevision) ||
        typeof input.feedback !== "string" ||
        input.feedback.trim().length === 0 ||
        input.feedback.length > 1000 ||
        /[\0\uD800-\uDFFF]/u.test(input.feedback)
      )
        return "invalid";
      return withModerator<"requested" | "replayed" | "conflict" | "denied">(
        token,
        id,
        "denied",
        async (client, actor, rows) => {
          const row = rows[0];
          if (!row || row.revision !== input.expectedRevision)
            return "conflict";
          if (row.state === "changes_requested")
            return row.feedback_matches &&
              row.feedback_revision === input.expectedRevision &&
              row.decision_actor_id === actor.id
              ? "replayed"
              : "conflict";
          if (row.state !== "submitted") return "conflict";
          await client.query(
            `UPDATE member_proposals SET state='changes_requested',
          change_feedback=$2,change_feedback_revision=revision,changes_requested_at=clock_timestamp(),
          rights_attested_at=NULL,rights_attested_revision=NULL,
          moderated_by=$3,moderated_at=clock_timestamp() WHERE id=$1`,
            [id, input.feedback, actor.id],
          );
          await audit(
            client,
            actor,
            row,
            "proposal_changes_requested",
            "changes_requested",
          );
          return "requested";
        },
        undefined,
        input,
      );
    },
    async editDraft(token, id, value, expectedRevision) {
      if (!validRevision(expectedRevision) || !validProposal(value))
        return "invalid";
      return withOwner<"saved" | "conflict" | "denied">(
        token,
        id,
        "denied",
        async (client, row) => {
          if (
            !["draft", "changes_requested"].includes(row.state) ||
            !(await currentWorkflow(row))
          )
            return "denied";
          if (row.revision !== expectedRevision || row.revision === 2147483647)
            return "conflict";
          // Keep owner/reference/sample attestation immutable; replace current text
          // in place without retaining prior-text history.
          await client.query(
            `UPDATE member_proposals SET title=$2,body=$3,sources=$4,
             revision=revision+1,rights_attested_at=NULL,rights_attested_revision=NULL WHERE id=$1`,
            [id, value.title, value.body, value.sources],
          );
          return "saved";
        },
      );
    },
    async submit(token, id, rightsConfirmed, expectedRevision) {
      if (!rightsConfirmed || !validRevision(expectedRevision)) return "denied";
      return withOwner<"submitted" | "replayed" | "conflict" | "denied">(
        token,
        id,
        "denied",
        async (client, row) => {
          if (
            !["draft", "changes_requested", "submitted"].includes(row.state) ||
            !(await currentWorkflow(row))
          )
            return "denied";
          if (row.revision !== expectedRevision) return "conflict";
          if (row.state === "submitted")
            return row.rightsAttestedRevision === expectedRevision
              ? "replayed"
              : "denied";
          if (
            row.state === "changes_requested" &&
            (row.feedbackRevision === null ||
              row.revision <= row.feedbackRevision)
          )
            return "conflict";
          await client.query(
            `UPDATE member_proposals SET state='submitted',
             rights_attested_revision=revision,rights_attested_at=clock_timestamp(),submitted_at=clock_timestamp()
             WHERE id=$1`,
            [id],
          );
          return "submitted";
        },
      );
    },
    async withdraw(token, id) {
      return withOwner(token, id, false, async (client, row) => {
        if (
          !["draft", "changes_requested", "submitted", "quarantined"].includes(
            row.state,
          )
        )
          return false;
        await client.query(
          `UPDATE member_proposals SET state='withdrawn',title=NULL,body=NULL,
           sources=NULL,workflow_id=NULL,workflow_version=NULL,
           change_feedback=NULL,change_feedback_revision=NULL,changes_requested_at=NULL,
           withdrawn_at=clock_timestamp() WHERE id=$1`,
          [id],
        );
        return true;
      });
    },
    async moderationQueue(token) {
      return (await moderationPage(token))?.items ?? null;
    },
    moderationPage,
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
             change_feedback=CASE WHEN $2='rejected' THEN NULL ELSE change_feedback END,
             change_feedback_revision=CASE WHEN $2='rejected' THEN NULL ELSE change_feedback_revision END,
             changes_requested_at=CASE WHEN $2='rejected' THEN NULL ELSE changes_requested_at END,
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
