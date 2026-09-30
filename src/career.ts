import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Fields } from "./validation.ts";

export type CareerKind = "career" | "opportunity" | "contract";
export type DraftKind = "professional" | "proposal" | "renewal";
export interface CareerEntryInput {
  kind: CareerKind;
  title: string;
  note: string;
  nextAction: string;
  selfReportedOutcome: string;
}
export interface CareerDraftInput {
  kind: DraftKind;
  title: string;
  body: string;
}
export interface CareerEntry extends CareerEntryInput {
  id: string;
  version: number;
}
export interface CareerDraft extends CareerDraftInput {
  id: string;
  approved: boolean;
  version: number;
}
export interface CareerSnapshot {
  enabled: boolean;
  entries: CareerEntry[];
  drafts: CareerDraft[];
}
export interface CareerStore {
  snapshot(memberId: string): Promise<CareerSnapshot | null>;
  enable(memberId: string): Promise<boolean>;
  disable(memberId: string): Promise<boolean>;
  createEntry(memberId: string, input: CareerEntryInput): Promise<boolean>;
  updateEntry(
    memberId: string,
    id: string,
    version: number,
    input: CareerEntryInput,
  ): Promise<boolean>;
  deleteEntry(memberId: string, id: string, version: number): Promise<boolean>;
  createDraft(memberId: string, input: CareerDraftInput): Promise<boolean>;
  updateDraft(
    memberId: string,
    id: string,
    version: number,
    input: CareerDraftInput,
  ): Promise<boolean>;
  approveDraft(memberId: string, id: string, version: number): Promise<boolean>;
  revokeDraft(memberId: string, id: string, version: number): Promise<boolean>;
  deleteDraft(memberId: string, id: string, version: number): Promise<boolean>;
}
const field = (fields: Fields, key: string) =>
  typeof fields[key] === "string" ? fields[key].trim() : "";
export const validCareerId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
export function parseCareerEntry(fields: Fields): {
  input: CareerEntryInput;
  errors: string[];
} {
  const kind = field(fields, "kind");
  const title = field(fields, "title");
  const note = field(fields, "note");
  const nextAction = field(fields, "next_action");
  const selfReportedOutcome = field(fields, "self_reported_outcome");
  const errors: string[] = [];
  if (!["career", "opportunity", "contract"].includes(kind))
    errors.push("Choose a valid planning kind.");
  if (title.length < 3 || title.length > 160)
    errors.push("Write a title between 3 and 160 characters.");
  if (note.length > 1000) errors.push("Keep the note within 1,000 characters.");
  if (nextAction.length < 3 || nextAction.length > 500)
    errors.push("Write a next action between 3 and 500 characters.");
  if (selfReportedOutcome.length > 500)
    errors.push("Keep the self-reported outcome within 500 characters.");
  if (fields.sample_only !== "yes")
    errors.push("Confirm that you used only invented or sample information.");
  return {
    input: {
      kind: kind as CareerKind,
      title,
      note,
      nextAction,
      selfReportedOutcome,
    },
    errors,
  };
}
export function parseCareerDraft(fields: Fields): {
  input: CareerDraftInput;
  errors: string[];
} {
  const kind = field(fields, "kind");
  const title = field(fields, "title");
  const body = field(fields, "body");
  const errors: string[] = [];
  if (!["professional", "proposal", "renewal"].includes(kind))
    errors.push("Choose a valid draft kind.");
  if (title.length < 3 || title.length > 160)
    errors.push("Write a title between 3 and 160 characters.");
  if (body.length < 20 || body.length > 4000)
    errors.push("Write a draft between 20 and 4,000 characters.");
  if (fields.sample_only !== "yes")
    errors.push("Confirm that you used only invented or sample information.");
  return { input: { kind: kind as DraftKind, title, body }, errors };
}
export function disabledCareerStore(): CareerStore {
  return {
    snapshot: async () => ({ enabled: false, entries: [], drafts: [] }),
    enable: async () => false,
    disable: async () => false,
    createEntry: async () => false,
    updateEntry: async () => false,
    deleteEntry: async () => false,
    createDraft: async () => false,
    updateDraft: async () => false,
    approveDraft: async () => false,
    revokeDraft: async () => false,
    deleteDraft: async () => false,
  };
}
export function careerStore(pool: Pool): CareerStore {
  const changed = async (sql: string, values: unknown[]) =>
    (await pool.query(sql, values)).rowCount === 1;
  return {
    async snapshot(memberId) {
      const client = await pool.connect();
      let committed = false;
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout='5s'");
        // Match deletion/export lock order and retain authorization while reading.
        const principal = (
          await client.query<{ expiresAt: Date }>(
            `SELECT expires_at AS "expiresAt" FROM principals WHERE id=$1
           AND kind='member' AND revoked_at IS NULL
           AND expires_at>clock_timestamp() FOR SHARE`,
            [memberId],
          )
        ).rows[0];
        if (!principal) return null;
        const workspace = await client.query(
          `SELECT id FROM workspaces WHERE owner_principal_id=$1
           AND deleting_at IS NULL FOR SHARE`,
          [memberId],
        );
        if (!workspace.rows[0]) return null;
        const enabled =
          (
            await client.query(
              "SELECT 1 FROM career_preferences WHERE member_id=$1",
              [memberId],
            )
          ).rowCount === 1;
        const snapshot: CareerSnapshot = { enabled, entries: [], drafts: [] };
        if (enabled) {
          snapshot.entries = (
            await client.query<CareerEntry>(
              `SELECT id,kind,title,note,next_action AS "nextAction",self_reported_outcome AS "selfReportedOutcome",version FROM career_entries WHERE member_id=$1 ORDER BY created_at DESC,id`,
              [memberId],
            )
          ).rows;
          snapshot.drafts = (
            await client.query<CareerDraft>(
              `SELECT id,kind,title,body,approved,version FROM career_drafts WHERE member_id=$1 ORDER BY created_at DESC,id`,
              [memberId],
            )
          ).rows;
        }
        // Wall time includes waits on the principal, workspace and private reads.
        const current = await client.query<{ valid: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS valid",
          [principal.expiresAt],
        );
        if (!current.rows[0]?.valid) return null;
        await client.query("COMMIT");
        committed = true;
        return snapshot;
      } finally {
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Career snapshot rollback failed");
          }
        }
        client.release(releaseError);
      }
    },
    enable: (memberId) =>
      changed(
        `INSERT INTO career_preferences(member_id) SELECT id FROM learners WHERE id=$1 ON CONFLICT(member_id) DO UPDATE SET member_id=EXCLUDED.member_id`,
        [memberId],
      ),
    disable: (memberId) =>
      changed("DELETE FROM career_preferences WHERE member_id=$1", [memberId]),
    createEntry: (memberId, input) =>
      changed(
        `INSERT INTO career_entries(id,member_id,kind,title,note,next_action,self_reported_outcome) SELECT $2,member_id,$3,$4,$5,$6,$7 FROM career_preferences WHERE member_id=$1`,
        [
          memberId,
          randomUUID(),
          input.kind,
          input.title,
          input.note,
          input.nextAction,
          input.selfReportedOutcome,
        ],
      ),
    updateEntry: (memberId, id, version, input) =>
      changed(
        `UPDATE career_entries SET kind=$4,title=$5,note=$6,next_action=$7,self_reported_outcome=$8,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE member_id=$1 AND id=$2 AND version=$3`,
        [
          memberId,
          id,
          version,
          input.kind,
          input.title,
          input.note,
          input.nextAction,
          input.selfReportedOutcome,
        ],
      ),
    deleteEntry: (memberId, id, version) =>
      changed(
        "DELETE FROM career_entries WHERE member_id=$1 AND id=$2 AND version=$3",
        [memberId, id, version],
      ),
    createDraft: (memberId, input) =>
      changed(
        `INSERT INTO career_drafts(id,member_id,kind,title,body) SELECT $2,member_id,$3,$4,$5 FROM career_preferences WHERE member_id=$1`,
        [memberId, randomUUID(), input.kind, input.title, input.body],
      ),
    updateDraft: (memberId, id, version, input) =>
      changed(
        `UPDATE career_drafts SET kind=$4,title=$5,body=$6,approved=false,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE member_id=$1 AND id=$2 AND version=$3`,
        [memberId, id, version, input.kind, input.title, input.body],
      ),
    approveDraft: (memberId, id, version) =>
      changed(
        "UPDATE career_drafts SET approved=true,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE member_id=$1 AND id=$2 AND version=$3 AND approved=false",
        [memberId, id, version],
      ),
    revokeDraft: (memberId, id, version) =>
      changed(
        "UPDATE career_drafts SET approved=false,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE member_id=$1 AND id=$2 AND version=$3 AND approved=true",
        [memberId, id, version],
      ),
    deleteDraft: (memberId, id, version) =>
      changed(
        "DELETE FROM career_drafts WHERE member_id=$1 AND id=$2 AND version=$3",
        [memberId, id, version],
      ),
  };
}
