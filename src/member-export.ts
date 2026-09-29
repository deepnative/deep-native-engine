import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export const MAX_MEMBER_EXPORT_RECORDS = 100;
export const MAX_MEMBER_EXPORT_BYTES = 256 * 1024;

// Keys are immutable primary keys, with one stable order per section. Each
// query filters before LIMIT/locking; lookahead never advances continuation.
function section(fields: string, source: string, keys: string, lock = false) {
  const key = `jsonb_build_array(${keys})`;
  return `SELECT ${key} AS "_key",${fields} FROM ${source}
    AND ${key}>$3::jsonb ORDER BY ${key} LIMIT $2${lock ? " FOR SHARE" : ""}`;
}
const sections = {
  exercises: section(
    `lesson_id AS "lessonId",lesson_version AS "lessonVersion",
    instruction,verification,completed_at AS "completedAt",goal_at_start AS "goalAtStart",
    CASE WHEN withdrawn_at IS NULL THEN 'saved' ELSE 'withdrawn' END AS state,
    withdrawn_at AS "withdrawnAt"`,
    "exercises WHERE learner_id=$1",
    "lesson_id,lesson_version",
    true,
  ),
  lessonActivity: section(
    `content_id AS "contentId",content_version AS "contentVersion",
    opened_at AS "openedAt",started_at AS "startedAt",self_assessed_at AS "selfAssessedAt"`,
    "lesson_activity WHERE member_id=$1",
    "content_id,content_version",
  ),
  lessonUsefulness: section(
    `content_id AS "contentId",content_version AS "contentVersion",
    choice,revision,reported_at AS "reportedAt",updated_at AS "updatedAt"`,
    "lesson_usefulness WHERE member_id=$1",
    "content_id,content_version",
  ),
  assignmentChoices: section(
    `content_id AS "contentId",content_version AS "contentVersion",
    chosen_at AS "chosenAt"`,
    "learner_assignment_choices WHERE member_id=$1",
    "member_id",
  ),
  assignmentAttempts: section(
    `id,content_id AS "contentId",content_version AS "contentVersion",
    goal_at_start AS "goalAtStart",response,revision,
    submission_count AS "submissionCount",started_at AS "startedAt",
    saved_at AS "savedAt",submitted_at AS "submittedAt"`,
    "assignment_attempts WHERE member_id=$1",
    "id",
    true,
  ),
  assignmentSubmissions: section(
    `s.attempt_id AS "attemptId",s.sequence,s.response,
    s.submitted_at AS "submittedAt"`,
    `assignment_submission_snapshots s
    JOIN assignment_attempts a ON a.id=s.attempt_id
    WHERE a.member_id=$1 AND a.id=ANY($4::uuid[])`,
    "s.attempt_id,s.sequence",
  ),
  adapterJobs: section(
    `j.id,j.adapter,j.mode,j.status,j.attempt_count AS attempts,
    j.max_attempts AS "maxAttempts",j.safe_error AS "safeError",
    j.created_at AS "createdAt",j.updated_at AS "updatedAt",r.id AS "localAiReceiptId"`,
    `adapter_jobs j LEFT JOIN local_ai_receipts r
      ON r.id=j.local_ai_receipt_id AND r.member_id=j.member_id
    WHERE j.member_id=$1`,
    "j.id",
  ),
  localAiReceipts: section(
    `id,evidence_id AS "evidenceId",
    revision_number AS "revisionNumber",purpose,statement_version AS "statementVersion",
    granted_at AS "grantedAt",withdrawn_at AS "withdrawnAt"`,
    "local_ai_receipts WHERE member_id=$1",
    "id",
  ),
  milestones: section(
    `id,goal_title AS "goalTitle",milestone_title AS "milestoneTitle",
    evidence_note AS "evidenceNote",next_action AS "nextAction",
    reminder_date AS "reminderDate",reminder_time AS "reminderTime",
    reminder_time_zone AS "reminderTimeZone",self_reported_complete AS "selfReportedComplete",
    version,created_at AS "createdAt",updated_at AS "updatedAt"`,
    "learning_milestones WHERE member_id=$1",
    "id",
    true,
  ),
  careerPreferences: section(
    `opted_in_at AS "optedInAt"`,
    "career_preferences WHERE member_id=$1",
    "member_id",
  ),
  careerEntries: section(
    `id,kind,title,note,next_action AS "nextAction",
    self_reported_outcome AS "selfReportedOutcome",version,
    created_at AS "createdAt",updated_at AS "updatedAt"`,
    "career_entries WHERE member_id=$1",
    "id",
    true,
  ),
  careerDrafts: section(
    `id,kind,title,body,approved,version,
    created_at AS "createdAt",updated_at AS "updatedAt"`,
    "career_drafts WHERE member_id=$1",
    "id",
    true,
  ),
  proposals: section(
    `id,title,body,sources,state,revision,
    workflow_id AS "workflowId",workflow_version AS "workflowVersion",
    created_at AS "createdAt",submitted_at AS "submittedAt",withdrawn_at AS "withdrawnAt"`,
    "member_proposals WHERE member_id=$1",
    "id",
    true,
  ),
  workflowFeedback: section(
    `workflow_id AS "workflowId",
    workflow_version AS "workflowVersion",note,revision,
    created_at AS "createdAt",updated_at AS "updatedAt"`,
    "workflow_feedback WHERE member_id=$1",
    "workflow_id,workflow_version",
    true,
  ),
  privatePractice: section(
    `content_id AS "contentId",content_version AS "contentVersion",
    goal_at_save AS "goalAtSave",response,saved_at AS "savedAt",
    CASE WHEN withdrawn_at IS NULL THEN 'saved' ELSE 'withdrawn' END AS state,
    withdrawn_at AS "withdrawnAt"`,
    "private_practice WHERE member_id=$1",
    "content_id,content_version",
    true,
  ),
  circleMemberships: section(
    `circle_id AS "circleId",joined_at AS "joinedAt",left_at AS "leftAt"`,
    "preview_circle_memberships WHERE member_id=$1",
    "circle_id",
  ),
} as const;
const entries = Object.entries(sections);
export const MEMBER_EXPORT_CURSOR_TTL_MS = 15 * 60 * 1000;
type Key = (string | number)[];
type Cursor = [
  version: 1,
  section: number,
  key: Key,
  page: number,
  expires: number,
];
export interface MemberExportPayload {
  kind: "ready";
  version: "local-member-records-v10";
  profile: Record<string, unknown>;
  records: Record<string, Record<string, unknown>[]>;
  page: {
    number: number;
    recordCount: number;
    consistency: "live-pages";
    complete: boolean;
    nextCursor: string | null;
  };
}

export type MemberExport =
  | { kind: "denied" }
  | { kind: "limit" }
  | { kind: "unavailable" }
  | { kind: "ready"; payload: MemberExportPayload };
export interface MemberExportStore {
  exportOwned(token: string, cursor?: string): Promise<MemberExport>;
}
export function disabledMemberExportStore(): MemberExportStore {
  return { exportOwned: async () => ({ kind: "denied" }) };
}

export function memberExportStore(
  pool: Pool,
  cursorSecret: Buffer = randomBytes(32),
): MemberExportStore {
  function sign(body: string, token: string) {
    return createHmac("sha256", cursorSecret)
      .update(hash(token))
      .update(".")
      .update(body)
      .digest("base64url");
  }
  function encode(data: Cursor, token: string) {
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${body}.${sign(body, token)}`;
  }
  function decode(value: string, token: string): Cursor | null {
    if (value.length > 1024) return null;
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (
      !match ||
      !timingSafeEqual(
        Buffer.from(match[2]!),
        Buffer.from(sign(match[1]!, token)),
      )
    )
      return null;
    try {
      const data: unknown = JSON.parse(
        Buffer.from(match[1]!, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(data) ||
        data.length !== 5 ||
        data[0] !== 1 ||
        !Number.isInteger(data[1]) ||
        data[1] < 0 ||
        data[1] >= entries.length ||
        !Array.isArray(data[2]) ||
        data[2].length < 1 ||
        data[2].length > 2 ||
        !data[2].every((key: unknown) =>
          typeof key === "string"
            ? key.length <= 160
            : Number.isSafeInteger(key) && Number(key) >= 0,
        ) ||
        !Number.isSafeInteger(data[3]) ||
        data[3] < 2 ||
        !Number.isSafeInteger(data[4]) ||
        data[4] <= Date.now()
      )
        return null;
      return data as Cursor;
    } catch {
      return null;
    }
  }
  return {
    async exportOwned(token, continuation) {
      const cursor =
        continuation === undefined ? undefined : decode(continuation, token);
      if (cursor === null) return { kind: "denied" };
      const expires = cursor?.[4] ?? Date.now() + MEMBER_EXPORT_CURSOR_TTL_MS;
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          // Match the runtime's five-second statement bound for lock acquisition,
          // including callers that supply a pool without runtime configuration.
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='5s'");
          // Keep revocation state and the deletion marker stable through COMMIT;
          // metadata-only changes remain a repeatable snapshot; text rows lock below.
          const owner = await client.query<Record<string, unknown>>(
            `SELECT l.id,l.background,l.goal,l.background_tags AS "backgroundTags",
              l.domain_tags AS "domainTags",l.it_roles AS "itRoles",l.experience,
              l.exploratory,l.time_zone AS "timeZone",l.weekly_minutes AS "weeklyMinutes"
              FROM principals p JOIN learners l ON l.id=p.id
              JOIN workspaces w ON w.owner_principal_id=p.id
              WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
                AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
              FOR SHARE OF p,w`,
            [hash(token)],
          );
          if (!owner.rows[0]) return { kind: "denied" };
          const memberId = owner.rows[0].id;
          const records: MemberExportPayload["records"] = Object.fromEntries(
            entries.map(([name]) => [name, []]),
          );
          const payload: MemberExportPayload = {
            kind: "ready",
            version: "local-member-records-v10",
            profile: owner.rows[0],
            records,
            page: {
              number: cursor?.[3] ?? 1,
              recordCount: 0,
              consistency: "live-pages",
              complete: true,
              nextCursor: null,
            },
          };
          if (
            Buffer.byteLength(JSON.stringify(payload)) > MAX_MEMBER_EXPORT_BYTES
          )
            return { kind: "limit" };
          let more = false;
          pages: for (
            let index = cursor?.[1] ?? 0;
            index < entries.length;
            index++
          ) {
            const [name, sql] = entries[index]!;
            const key = index === cursor?.[1] ? cursor[2] : [];
            const values: unknown[] = [
              memberId,
              MAX_MEMBER_EXPORT_RECORDS - payload.page.recordCount + 1,
              JSON.stringify(key),
            ];
            if (name === "assignmentSubmissions") {
              // A continuation can start here, bypassing assignmentAttempts.
              // Await bounded parent locks FIRST, matching series deletion; do
              // not acquire child locks ahead of the parent via a joined lock.
              const parents = await client.query<{ id: string }>(
                `SELECT a.id
                FROM assignment_attempts a WHERE a.member_id=$1 AND EXISTS (
                  SELECT 1 FROM assignment_submission_snapshots s WHERE s.attempt_id=a.id
                    AND jsonb_build_array(s.attempt_id,s.sequence)>$3::jsonb)
                ORDER BY a.id LIMIT $2 FOR SHARE OF a`,
                values,
              );
              values.push(parents.rows.map((row) => row.id));
            }
            const rows = (
              await client.query<{ _key: Key; [key: string]: unknown }>(
                sql,
                values,
              )
            ).rows;
            for (const row of rows) {
              if (payload.page.recordCount === MAX_MEMBER_EXPORT_RECORDS) {
                more = true;
                break pages;
              }
              const { _key, ...record } = row;
              const next = encode(
                [1, index, _key, payload.page.number + 1, expires],
                token,
              );
              const previous = payload.page.nextCursor;
              records[name]!.push(record);
              payload.page.recordCount++;
              payload.page.complete = false;
              payload.page.nextCursor = next;
              if (
                Buffer.byteLength(JSON.stringify(payload)) >
                MAX_MEMBER_EXPORT_BYTES
              ) {
                records[name]!.pop();
                payload.page.recordCount--;
                payload.page.nextCursor = previous;
                if (payload.page.recordCount === 0) return { kind: "limit" };
                more = true;
                break pages;
              }
            }
          }
          payload.page.complete = !more;
          if (!more) payload.page.nextCursor = null;
          if (expires <= Date.now()) return { kind: "denied" };
          // CURRENT_TIMESTAMP is frozen at BEGIN; assembly may outlive a session.
          const current = await client.query(
            "SELECT id FROM principals WHERE id=$1 AND expires_at>clock_timestamp()",
            [memberId],
          );
          if (!current.rows[0]) return { kind: "denied" };
          await client.query("COMMIT");
          return { kind: "ready", payload };
        } finally {
          let rollbackError: Error | undefined;
          try {
            await client.query("ROLLBACK");
          } catch {
            // A failed rollback may leave authorization locks on a live client.
            rollbackError = new Error("Member export rollback failed");
          }
          client.release(rollbackError);
        }
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
