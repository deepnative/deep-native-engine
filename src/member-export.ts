import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
    "lesson_id,lesson_version,goal_slot",
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
  assignmentReflections: section(
    `r.attempt_id AS "attemptId",r.sequence,
    a.content_id AS "contentId",a.content_version AS "contentVersion",
    r.evidence,r.gaps,r.intention,r.revision,
    'SELF-REPORTED · SIMULATED · UNREVIEWED' AS label,
    r.created_at AS "createdAt",r.updated_at AS "updatedAt"`,
    `assignment_submission_reflections r
    JOIN assignment_attempts a ON a.id=r.attempt_id
    WHERE a.member_id=$1 AND a.id=ANY($4::uuid[])
      AND r.deleted_at IS NULL`,
    "r.attempt_id,r.sequence",
    true,
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
    created_at AS "createdAt",submitted_at AS "submittedAt",withdrawn_at AS "withdrawnAt",
    rights_attested_revision AS "rightsAttestedRevision",rights_attested_at AS "rightsAttestedAt",
    CASE WHEN change_feedback IS NULL THEN NULL ELSE jsonb_build_object(
      'text',change_feedback,'reviewedRevision',change_feedback_revision,
      'requestedAt',changes_requested_at) END AS feedback`,
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
  // Append new sections: cursor v2's existing section indices stay stable.
  practiceSessions: section(
    `id,content_id AS "contentId",content_version AS "contentVersion",
    goal_at_start AS "goalAtStart",prompt_version AS "promptVersion",
    created_at AS "createdAt",withdrawn_at AS "withdrawnAt",
    CASE WHEN withdrawn_at IS NULL THEN 'active' ELSE 'withdrawn' END AS state`,
    "private_practice_sessions WHERE member_id=$1",
    "id",
    true,
  ),
  practiceExchanges: section(
    `e.session_id AS "sessionId",e.sequence,e.response,e.comparison,
    e.source_excerpt AS "sourceExcerpt",e.accepted_at AS "acceptedAt"`,
    `private_practice_exchanges e
    JOIN private_practice_sessions s ON s.id=e.session_id
    WHERE s.member_id=$1 AND s.withdrawn_at IS NULL AND s.id=ANY($4::uuid[])`,
    "e.session_id,e.sequence",
  ),
  // Support sections append after indices 17/18; existing cursor v2 keeps its meaning.
  supportRequests: section(
    `id,subject,body,received_at AS "receivedAt",
    acknowledged_at AS "acknowledgedAt",resolved_at AS "resolvedAt",
    withdrawn_at AS "withdrawnAt",coverage_state AS "coverageState",
    CASE WHEN withdrawn_at IS NOT NULL THEN 'withdrawn'
      WHEN resolved_at IS NOT NULL THEN 'resolved' ELSE 'open' END AS state`,
    "support_requests WHERE member_id=$1",
    "id",
    true,
  ),
  supportReplies: section(
    `e.id,e.request_id AS "requestId",e.body,e.created_at AS "createdAt",
    'Synthetic operator' AS attribution`,
    `support_request_replies e JOIN support_requests r ON r.id=e.request_id
    WHERE r.member_id=$1 AND r.withdrawn_at IS NULL AND r.id=ANY($4::uuid[])`,
    "e.request_id,e.id",
  ),
  // Append after the existing support sections; cursor v2 indices remain stable.
  supportTimeAllocations: section(
    `a.id,a.request_id AS "requestId",a.policy,a.ceiling,a.state,
    a.created_at AS "createdAt",a.begun_at AS "begunAt",a.settled_at AS "settledAt",
    CASE WHEN a.begun_by IS NULL THEN NULL ELSE 'Synthetic operator' END AS attribution,
    (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='reserved') AS held,
    (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='consumed') AS consumed,
    (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='released') AS released`,
    "support_time_allocations a WHERE a.member_id=$1",
    "a.id",
    true,
  ),
  supportTimeEntries: section(
    `e.allocation_id AS "allocationId",a.request_id AS "requestId",
    e.support_start AS "supportStart",e.support_end AS "supportEnd",
    e.preparation_start AS "preparationStart",e.preparation_end AS "preparationEnd",
    e.support_minutes AS "supportMinutes",e.preparation_minutes AS "preparationMinutes",
    e.created_at AS "createdAt",'Synthetic operator' AS attribution`,
    "support_time_entries e JOIN support_time_allocations a ON a.id=e.allocation_id WHERE a.member_id=$1",
    "e.allocation_id",
  ),
  // Append after v16's index 22; existing cursor v2 section indices do not move.
  circleChoices: section(
    `id,circle_id AS "circleId",generation,policy_version AS "policyVersion",
    chosen_at AS "chosenAt",revoked_at AS "revokedAt"`,
    "preview_circle_choices WHERE member_id=$1",
    "id",
    true,
  ),
  circlePosts: section(
    `id,circle_id AS "circleId",choice_id AS "choiceId",body,state,revision,
    CASE WHEN root_id IS NULL THEN 'question' ELSE 'reply' END AS kind,
    created_at AS "createdAt",changed_at AS "changedAt",withdrawn_at AS "withdrawnAt"`,
    "preview_circle_posts WHERE member_id=$1",
    "id",
    true,
  ),
  circleReports: section(
    `id,circle_id AS "circleId",category,created_at AS "createdAt",'retained' AS state`,
    "preview_circle_reports WHERE member_id=$1",
    "id",
    true,
  ),
  circleMembershipHistory: section(
    `circle_id AS "circleId",generation,joined_at AS "joinedAt",left_at AS "leftAt"`,
    "preview_circle_membership_history WHERE member_id=$1",
    "circle_id,generation",
    true,
  ),
  // Append after v17's indices 0–26. Historical IDs only correlate owned
  // records; internal replay, source and staff fields are never selected.
  testUnitGrants: section(
    `g.id,g.category,g.quantity,g.available,g.reserved,g.consumed,g.expired,g.adjusted,
    g.created_at AS "createdAt",g.starts_at AS "startsAt",g.expires_at AS "expiresAt",
    g.expired_at AS "expiredAt"`,
    "synthetic_entitlement_grants g WHERE g.member_id=$1",
    "g.id",
  ),
  testUnitReservations: section(
    `r.id,r.grant_id AS "grantId",g.category,r.quantity,r.state,r.created_at AS "createdAt"`,
    `synthetic_entitlement_reservations r
    JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
    WHERE g.member_id=$1`,
    "r.id",
  ),
  testUnitEvents: section(
    `e.id,e.grant_id AS "grantId",e.reservation_id AS "reservationId",
    g.category,e.operation,e.quantity,e.created_at AS "createdAt"`,
    `synthetic_entitlement_events e
    JOIN synthetic_entitlement_grants g ON g.id=e.grant_id
    LEFT JOIN synthetic_entitlement_reservations r ON r.id=e.reservation_id
    WHERE e.member_id=$1 AND g.member_id=$1
      AND (e.reservation_id IS NULL OR r.grant_id=g.id)`,
    "e.id",
  ),
  testUnitSettlements: section(
    `s.id,s.grant_id AS "grantId",s.reservation_id AS "reservationId",s.category,s.quantity,
    s.delivered_minutes AS "deliveredMinutes",s.preparation_minutes AS "preparationMinutes",
    s.created_at AS "createdAt"`,
    `synthetic_entitlement_settlements s
    JOIN synthetic_entitlement_grants g ON g.id=s.grant_id
    JOIN synthetic_entitlement_reservations r ON r.id=s.reservation_id AND r.grant_id=g.id
    JOIN synthetic_entitlement_events e ON e.id=s.id AND e.grant_id=g.id
      AND e.reservation_id=r.id AND e.member_id=s.member_id
      AND e.operation='consume' AND e.quantity=s.quantity
    WHERE s.member_id=$1 AND g.member_id=$1 AND s.category=g.category`,
    "s.id",
  ),
  // Append after existing indices; never export another actor's private draft.
  sampleFeedback: section(
    `f.id,e.id AS "evidenceId",s.id AS "submissionId",f.reviewer_id AS "authorId",
     f.source_sha256 AS "sourceSha256",f.source_revision AS "sourceRevision",f.criteria,
     f.preparation_minutes AS "selfReportedPreparationMinutes",f.review_minutes AS "selfReportedReviewMinutes",
     f.published_at AS "publishedAt",f.clarification,f.clarified_at AS "clarifiedAt",f.answer,f.answered_at AS "answeredAt",
     e.private_review_allowed AS "consentActive",'human-authored-private-sample-not-formal' AS label`,
    `private_sample_feedback f JOIN evidence_review_submissions s ON s.id=f.submission_id
     JOIN evidence_objects e ON e.id=s.evidence_id
     WHERE e.owner_principal_id=$1 AND e.quarantine_state<>'deleting'
      AND f.published_at IS NOT NULL AND e.id=ANY($4::uuid[])`,
    "e.id,f.id",
    true,
  ),
  eventEnrollments: section(
    `e.id,e.event_id AS "eventId",e.event_version AS "eventVersion",i.title,
     i.starts_at AS "startsAt",i.ends_at AS "endsAt",e.created_at AS "createdAt",e.withdrawn_at AS "withdrawnAt",c.cancelled_at AS "cancelledAt"`,
    `private_event_enrollments e JOIN private_event_inventory i
     ON i.event_id=e.event_id AND i.event_version=e.event_version AND i.capacity=e.capacity
     LEFT JOIN private_event_cancellations c ON c.event_id=e.event_id AND c.event_version=e.event_version
     JOIN workspaces w ON w.id=e.workspace_id AND w.owner_principal_id=e.member_id
     WHERE e.member_id=$1 AND w.deleting_at IS NULL`,
    "e.id",
  ),
  // v21 appends accounting sections; all prior cursor indices remain stable.
  reviewTimeAllocations: section(
    `a.id,a.evidence_id AS "evidenceId",a.policy,a.ceiling,a.state,
     a.created_at AS "createdAt",a.begun_at AS "begunAt",a.settled_at AS "settledAt",
     a.source_unavailable_at AS "sourceUnavailableAt",
     (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.grant_id=a.grant_id AND r.state='reserved') AS held,
     (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.grant_id=a.grant_id AND r.state='consumed') AS consumed,
     (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.grant_id=a.grant_id AND r.state='released') AS released`,
    `review_time_allocations a JOIN workspaces w ON w.id=a.workspace_id AND w.owner_principal_id=a.member_id
     WHERE a.member_id=$1 AND w.deleting_at IS NULL`,
    "a.id",
    true,
  ),
  reviewTimeEntries: section(
    `e.allocation_id AS "allocationId",e.review_start AS "reviewStart",e.review_end AS "reviewEnd",
     e.preparation_start AS "preparationStart",e.preparation_end AS "preparationEnd",
     e.review_minutes AS "reviewMinutes",e.preparation_minutes AS "preparationMinutes",e.created_at AS "createdAt",
     'Local sample reviewer' AS attribution`,
    `review_time_entries e JOIN review_time_allocations a ON a.id=e.allocation_id
     JOIN workspaces w ON w.id=a.workspace_id AND w.owner_principal_id=a.member_id
     WHERE a.member_id=$1 AND w.deleting_at IS NULL`,
    "e.allocation_id",
  ),
  reviewTimeEvents: section(
    `e.id,e.allocation_id AS "allocationId",e.action,e.occurred_at AS "occurredAt"`,
    `review_time_events e JOIN review_time_allocations a ON a.id=e.allocation_id AND a.member_id=e.member_id
     JOIN workspaces w ON w.id=a.workspace_id AND w.owner_principal_id=a.member_id
     WHERE a.member_id=$1 AND w.deleting_at IS NULL`,
    "e.id",
  ),
  // Append after v21's index 35. Receipts are owned structural metadata even
  // after source deletion; neither staff identities nor operation keys export.
  sampleAssignmentOperations: section(
    `o.id AS "receiptId",o.evidence_id AS "evidenceId",o.source_revision AS "sourceRevision",
     o.starts_at AS "startsAt",o.expires_at AS "expiresAt",o.created_at AS "createdAt",
     'retained-structural-receipt' AS state`,
    `private_sample_assignment_operations o JOIN workspaces w ON w.id=o.workspace_id
     WHERE w.owner_principal_id=$1 AND w.deleting_at IS NULL`,
    "o.id",
  ),
  // v24 appends owned private workflow permission metadata. Existing section
  // positions and cursor v2 continue unchanged. Never copy notes, staff IDs,
  // credential/operation keys or grant any new permission through an export.
  workflowReviewRequests: section(
    `r.id AS "requestId",r.workflow_id AS "workflowId",r.workflow_version AS "workflowVersion",
     r.source_instance_id AS "sourceInstanceId",r.source_revision AS "sourceRevision",
     r.expires_at AS "expiresAt",r.created_at AS "createdAt",r.withdrawn_at AS "withdrawnAt"`,
    `workflow_review_requests r JOIN workspaces w ON w.id=r.workspace_id AND w.owner_principal_id=r.member_id
     WHERE r.member_id=$1 AND w.deleting_at IS NULL`,
    "r.id",
  ),
  workflowReviewAssignments: section(
    `g.id AS "grantId",g.request_id AS "requestId",g.source_instance_id AS "sourceInstanceId",
     g.source_revision AS "sourceRevision",g.starts_at AS "startsAt",g.expires_at AS "expiresAt",g.created_at AS "createdAt",g.revoked_at AS "revokedAt",
     'Local workflow moderator' AS attribution`,
    `workflow_review_grants g JOIN workflow_review_requests r ON r.id=g.request_id AND r.workspace_id=g.workspace_id
     JOIN workspaces w ON w.id=g.workspace_id AND w.owner_principal_id=r.member_id
     WHERE r.member_id=$1 AND w.deleting_at IS NULL`,
    "g.id",
  ),
} as const;
const entries = Object.entries(sections);
export const MEMBER_EXPORT_CURSOR_TTL_MS = 15 * 60 * 1000;
type Key = (string | number)[];
type Cursor = [
  version: 2,
  section: number,
  key: Key,
  page: number,
  expires: number,
];
export interface MemberExportPayload {
  kind: "ready";
  version: "local-member-records-v24";
  profile: Record<string, unknown>;
  records: Record<string, Record<string, unknown>[]>;
  testUnitHistory: {
    scope: "private-local-test-units";
    snapshotStartedAt: Date;
    observedAt: Date;
    availableMeaning: "stored-counter-not-usable-balance";
  };
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
        data[0] !== 2 ||
        !Number.isInteger(data[1]) ||
        data[1] < 0 ||
        data[1] >= entries.length ||
        !Array.isArray(data[2]) ||
        data[2].length < 1 ||
        data[2].length > 3 ||
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
      const started = performance.now();
      let client: PoolClient | undefined, releaseError: Error | undefined;
      let result: MemberExport;
      let queryExpired = false,
        committed = false,
        checkedAt = 0,
        remaining = 0;
      const readPage = async (client: PoolClient): Promise<MemberExport> => {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        // Match the runtime's five-second statement bound for lock acquisition,
        // including callers that supply a pool without runtime configuration.
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        // Keep revocation state and the deletion marker stable through COMMIT;
        // metadata-only changes remain a repeatable snapshot; text rows lock below.
        await client.query("SELECT set_config('transaction_timeout',$1,true)", [
          `${Math.max(1, Math.floor(10000 - (performance.now() - started)))}ms`,
        ]);
        // Lock the member first, then the workspace, matching erasure/withdrawal.
        const principal = await client.query(
          "SELECT id FROM principals WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
          [hash(token)],
        );
        if (!principal.rows[0]) return { kind: "denied" };
        const owner = await client.query<Record<string, unknown>>(
          `SELECT l.id,l.background,l.goal,l.background_tags AS "backgroundTags",
            l.domain_tags AS "domainTags",l.it_roles AS "itRoles",l.experience,
            l.exploratory,l.time_zone AS "timeZone",l.weekly_minutes AS "weeklyMinutes"
            FROM principals p JOIN learners l ON l.id=p.id
            JOIN workspaces w ON w.owner_principal_id=p.id
            WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
              AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
            FOR SHARE OF w`,
          [hash(token)],
        );
        if (!owner.rows[0]) return { kind: "denied" };
        const memberId = owner.rows[0].id;
        const records: MemberExportPayload["records"] = Object.fromEntries(
          entries.map(([name]) => [name, []]),
        );
        const payload: MemberExportPayload = {
          kind: "ready",
          version: "local-member-records-v24",
          profile: owner.rows[0],
          records,
          testUnitHistory: {
            scope: "private-local-test-units",
            snapshotStartedAt: new Date(0),
            observedAt: new Date(0),
            availableMeaning: "stored-counter-not-usable-balance",
          },
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
          if (
            name === "assignmentSubmissions" ||
            name === "assignmentReflections"
          ) {
            // A continuation can start here, bypassing assignmentAttempts.
            // Await bounded parent locks FIRST, matching series deletion; do
            // not acquire child locks ahead of the parent via a joined lock.
            const childTable =
              name === "assignmentSubmissions"
                ? "assignment_submission_snapshots"
                : "assignment_submission_reflections";
            const retained =
              name === "assignmentReflections"
                ? "AND s.deleted_at IS NULL"
                : "";
            const parents = await client.query<{ id: string }>(
              `SELECT a.id
              FROM assignment_attempts a WHERE a.member_id=$1 AND EXISTS (
                SELECT 1 FROM ${childTable} s WHERE s.attempt_id=a.id
                  ${retained}
                  AND jsonb_build_array(s.attempt_id,s.sequence)>$3::jsonb)
              ORDER BY a.id LIMIT $2 FOR SHARE OF a`,
              values,
            );
            values.push(parents.rows.map((row) => row.id));
          }
          if (name === "practiceExchanges") {
            // Continuation may skip practiceSessions. Lock owned parents before
            // reading response-derived bytes, matching session withdrawal.
            const parents = await client.query<{ id: string }>(
              `SELECT s.id FROM private_practice_sessions s
              WHERE s.member_id=$1 AND s.withdrawn_at IS NULL AND EXISTS (
                SELECT 1 FROM private_practice_exchanges e WHERE e.session_id=s.id
                  AND jsonb_build_array(e.session_id,e.sequence)>$3::jsonb)
              ORDER BY s.id LIMIT $2 FOR SHARE OF s`,
              values,
            );
            values.push(parents.rows.map((row) => row.id));
          }
          if (name === "supportReplies") {
            // Direct continuation may bypass receipts. Lock parents first,
            // matching withdrawal's request-before-messages order.
            const parents = await client.query<{ id: string }>(
              `SELECT r.id FROM support_requests r
              WHERE r.member_id=$1 AND r.withdrawn_at IS NULL AND EXISTS (
                SELECT 1 FROM support_request_replies e WHERE e.request_id=r.id
                  AND jsonb_build_array(e.request_id,e.id)>$3::jsonb)
              ORDER BY r.id LIMIT $2 FOR SHARE OF r`,
              values,
            );
            values.push(parents.rows.map((row) => row.id));
          }
          if (name === "sampleFeedback") {
            // Continuations may start here. Fence source before submission and
            // feedback, matching publication/withdrawal/deletion; never acquire
            // a feedback lock first through a planner-chosen joined scan.
            const parents = await client.query<{ id: string }>(
              `SELECT e.id FROM evidence_objects e
               WHERE e.owner_principal_id=$1 AND e.quarantine_state<>'deleting' AND EXISTS(
                 SELECT 1 FROM evidence_review_submissions s JOIN private_sample_feedback f ON f.submission_id=s.id
                 WHERE s.evidence_id=e.id AND f.published_at IS NOT NULL
                   AND jsonb_build_array(e.id,f.id)>$3::jsonb)
               ORDER BY e.id LIMIT $2 FOR SHARE OF e`,
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
              [2, index, _key, payload.page.number + 1, expires],
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
        return { kind: "ready", payload };
      };
      try {
        let acquisitionExpired = false;
        let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
        let connection: PoolClient;
        try {
          connection = await Promise.race([
            pool.connect().then((value) => {
              if (acquisitionExpired) {
                value.release(new Error("Member export acquisition expired"));
                throw Error("Member export unavailable");
              }
              return value;
            }),
            new Promise<never>((_, reject) => {
              acquisitionTimer = setTimeout(() => {
                acquisitionExpired = true;
                reject(Error("Member export unavailable"));
              }, 3000);
            }),
          ]);
        } finally {
          clearTimeout(acquisitionTimer);
        }
        if (performance.now() - started >= 3000) {
          connection.release(new Error("Member export acquisition expired"));
          throw Error("Member export unavailable");
        }
        client = Object.create(connection) as PoolClient;
        // SQL deadlines do not cover a withheld driver BEGIN/COMMIT reply.
        // Every query shares the same operation budget; uncertain connections
        // are discarded without queuing rollback behind the stalled query.
        client.query = (async (sql: string, values?: unknown[]) => {
          const queryStarted = performance.now();
          const budget = Math.min(5000, 10000 - (queryStarted - started));
          if (budget <= 0) {
            queryExpired = true;
            throw Error("Member export unavailable");
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([
              connection.query(sql, values),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  queryExpired = true;
                  reject(Error("Member export unavailable"));
                }, budget);
              }),
            ]);
            if (performance.now() - queryStarted >= budget) {
              queryExpired = true;
              throw Error("Member export unavailable");
            }
            return value;
          } finally {
            clearTimeout(timer);
          }
        }) as PoolClient["query"];
        client.release = (error) => connection.release(error);
        result = await readPage(client);
        if (result.kind === "ready") {
          if (expires <= Date.now()) {
            result = { kind: "denied" };
          } else {
            checkedAt = performance.now();
            const current = (
              await client.query<{
                id: string;
                observedAt: Date;
                snapshotStartedAt: Date;
                remainingMs: string;
              }>(
                `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS observed_at)
              SELECT p.id,t.observed_at AS "observedAt",transaction_timestamp() AS "snapshotStartedAt",
                EXTRACT(EPOCH FROM (LEAST(p.expires_at,$2::timestamptz)-t.observed_at))*1000 AS "remainingMs"
              FROM principals p CROSS JOIN instant t
              WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
                AND p.expires_at>t.observed_at AND $2::timestamptz>t.observed_at`,
                [result.payload.profile.id, new Date(expires)],
              )
            ).rows[0];
            remaining = Number(current?.remainingMs);
            if (
              !current ||
              !Number.isFinite(remaining) ||
              remaining <= performance.now() - checkedAt
            ) {
              result = { kind: "denied" };
            } else if (
              !(current.observedAt instanceof Date) ||
              !(current.snapshotStartedAt instanceof Date) ||
              !Number.isFinite(+current.observedAt) ||
              !Number.isFinite(+current.snapshotStartedAt) ||
              +current.snapshotStartedAt > +current.observedAt
            ) {
              throw Error("Member export unavailable");
            } else {
              result.payload.testUnitHistory.observedAt = current.observedAt;
              result.payload.testUnitHistory.snapshotStartedAt =
                current.snapshotStartedAt;
              if (
                Buffer.byteLength(JSON.stringify(result.payload)) >
                MAX_MEMBER_EXPORT_BYTES
              ) {
                result = { kind: "limit" };
              } else {
                await client.query("COMMIT");
                committed = true;
              }
            }
          }
        }
      } catch {
        result = { kind: "unavailable" };
        releaseError = new Error("Member export outcome unavailable");
      } finally {
        if (client && !committed && !queryExpired) {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Member export rollback failed");
            result = { kind: "unavailable" };
          }
        }
        try {
          client?.release(
            queryExpired
              ? new Error("Member export query expired")
              : releaseError,
          );
        } catch {
          result = { kind: "unavailable" };
        }
      }
      if (result.kind === "ready") {
        if (!committed || performance.now() - started >= 10000)
          return { kind: "unavailable" };
        if (remaining <= performance.now() - checkedAt || expires <= Date.now())
          return { kind: "denied" };
      }
      return result;
    },
  };
}
