import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export type ProposalState =
  "draft" | "submitted" | "quarantined" | "rejected" | "withdrawn";
export interface Proposal {
  id: string;
  title: string | null;
  body: string | null;
  sources: string | null;
  state: ProposalState;
  createdAt: Date;
  submittedAt: Date | null;
}
export interface ProposalStore {
  createDraft(
    token: string,
    value: { title: string; body: string; sources: string },
    sampleConfirmed: boolean,
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
 mp.created_at AS "createdAt",mp.submitted_at AS "submittedAt"`;
const member = `p.token_hash=$1 AND p.kind='member'
 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`;
const moderator = `p.token_hash=$1 AND p.kind='staff'
 AND s.role IN ('moderator','platform_admin')
 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`;
export function proposalStore(pool: Pool): ProposalStore {
  return {
    async createDraft(token, value, sampleConfirmed) {
      if (!sampleConfirmed || !validProposal(value)) return null;
      const id = randomUUID();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
         SELECT $2,p.id,$3,$4,$5,CURRENT_TIMESTAMP FROM principals p
         JOIN learners l ON l.id=p.id WHERE ${member}
         RETURNING id`,
        [hash(token), id, value.title, value.body, value.sources],
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
           sources=NULL,withdrawn_at=CURRENT_TIMESTAMP
         FROM principals p WHERE p.id=mp.member_id AND ${member}
           AND mp.id=$2 AND mp.state IN ('draft','submitted','quarantined')`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
    async moderationQueue(token) {
      const result = await pool.query<Proposal & { allowed: boolean }>(
        `SELECT access.allowed, items.* FROM (
           SELECT EXISTS(SELECT 1 FROM principals p
             JOIN staff_profiles s ON s.principal_id=p.id
             WHERE ${moderator}) AS allowed
         ) access LEFT JOIN LATERAL (
           SELECT ${columns} FROM member_proposals mp
           WHERE access.allowed AND mp.state IN ('submitted','quarantined')
           ORDER BY mp.created_at LIMIT 100
         ) items ON true`,
        [hash(token)],
      );
      if (!result.rows[0]?.allowed) return null;
      return result.rows
        .filter((row) => row.id !== null)
        .map(({ allowed: _allowed, ...proposal }) => proposal);
    },
    async moderate(token, id, action) {
      if (action !== "quarantine" && action !== "reject") return false;
      const result = await pool.query(
        `UPDATE member_proposals mp SET state=$3,
           title=CASE WHEN $3='rejected' THEN NULL ELSE mp.title END,
           body=CASE WHEN $3='rejected' THEN NULL ELSE mp.body END,
           sources=CASE WHEN $3='rejected' THEN NULL ELSE mp.sources END,
           moderated_by=p.id,moderated_at=CURRENT_TIMESTAMP
         FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
         WHERE ${moderator} AND mp.id=$2
           AND (mp.state='submitted' OR ($3='rejected' AND mp.state='quarantined'))`,
        [hash(token), id, action === "quarantine" ? "quarantined" : "rejected"],
      );
      return result.rowCount === 1;
    },
  };
}
