import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export const STAFF_ROLES = [
  "coach",
  "reviewer",
  "editor",
  "moderator",
  "operator",
  "platform_admin",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type AssignmentRole = "coach" | "reviewer";
export type SupportRole = "operator" | "platform_admin";

export type WorkspaceAccess =
  | { kind: "denied" }
  | {
      kind: "allowed";
      via: "member" | "assignment" | "support";
      workspaceId: string;
      purpose: string | null;
      records: Array<{
        lessonId: string;
        lessonVersion: number;
        instruction: string;
        verification: string;
        completedAt: Date | null;
      }>;
    };

export type CohortAccess =
  | { kind: "denied" }
  | { kind: "allowed"; cohortId: string; contentId: string; body: string };

export interface AuthorizationStore {
  provisionStaff(
    token: string,
    role: StaffRole,
    expiresAt: Date,
  ): Promise<string>;
  grantAssignment(
    adminId: string,
    staffId: string,
    workspaceId: string,
    role: AssignmentRole,
    purpose: string,
    expiresAt: Date,
  ): Promise<string>;
  revokeAssignment(adminId: string, grantId: string): Promise<boolean>;
  grantEvidenceReview(
    adminId: string,
    reviewerId: string,
    assignmentId: string,
    submissionId: string,
    purpose: string,
    expiresAt: Date,
  ): Promise<string>;
  revokeEvidenceReview(adminId: string, grantId: string): Promise<boolean>;
  grantSupport(
    adminId: string,
    staffId: string,
    workspaceId: string,
    role: SupportRole,
    purpose: string,
    expiresAt: Date,
  ): Promise<string>;
  revokeSupport(adminId: string, grantId: string): Promise<boolean>;
  readWorkspace(
    token: string,
    workspaceId: string,
    purpose?: string,
  ): Promise<WorkspaceAccess>;
  readCohort(
    token: string,
    cohortId: string,
    contentId: string,
  ): Promise<CohortAccess>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validToken(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

function validDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function normalizedPurpose(value: string) {
  const purpose = value.trim();
  if (!purpose || purpose.length > 200)
    throw new Error("Access purpose must be between 1 and 200 characters.");
  return purpose;
}

function isRole(value: string): value is StaffRole {
  return STAFF_ROLES.includes(value as StaffRole);
}

interface WorkspaceRow {
  via: "member" | "assignment" | "support";
  purpose: string | null;
  lesson_id: string | null;
  lesson_version: number | null;
  instruction: string | null;
  verification: string | null;
  completed_at: Date | null;
}

export function disabledAuthorizationStore(): AuthorizationStore {
  const denied = async () => ({ kind: "denied" }) as const;
  const unavailable = async () => {
    throw new Error("Privileged authorization is not configured.");
  };
  return {
    provisionStaff: unavailable,
    grantAssignment: unavailable,
    revokeAssignment: async () => false,
    grantEvidenceReview: unavailable,
    revokeEvidenceReview: async () => false,
    grantSupport: unavailable,
    revokeSupport: async () => false,
    readWorkspace: denied,
    readCohort: denied,
  };
}

export function authorizationStore(pool: Pool): AuthorizationStore {
  async function grant(
    table: "assignment_grants" | "support_access_grants",
    adminId: string,
    staffId: string,
    workspaceId: string,
    role: AssignmentRole | SupportRole,
    purpose: string,
    expiresAt: Date,
  ) {
    if (
      !uuidPattern.test(adminId) ||
      !uuidPattern.test(staffId) ||
      !uuidPattern.test(workspaceId) ||
      !validDate(expiresAt)
    )
      throw new Error("Privileged grant denied.");
    const row = (
      await pool.query<{ id: string }>(
        `INSERT INTO ${table}(
           id,staff_id,staff_role,workspace_id,purpose,expires_at,granted_by
         )
         SELECT $1,$2,$3,$4,$5,$6,$7
         WHERE $6>CURRENT_TIMESTAMP
           AND EXISTS(
             SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
             WHERE p.id=$7 AND p.kind='staff' AND s.role='platform_admin'
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
           )
           AND EXISTS(
             SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
             WHERE p.id=$2 AND p.kind='staff' AND s.role=$3
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
           )
         RETURNING id`,
        [
          randomUUID(),
          staffId,
          role,
          workspaceId,
          normalizedPurpose(purpose),
          expiresAt,
          adminId,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("Privileged grant denied.");
    return row.id;
  }

  async function revoke(
    table:
      | "assignment_grants"
      | "support_access_grants"
      | "reviewer_evidence_grants",
    adminId: string,
    grantId: string,
  ) {
    if (!uuidPattern.test(adminId) || !uuidPattern.test(grantId)) return false;
    return Boolean(
      (
        await pool.query(
          `UPDATE ${table} g SET revoked_at=CURRENT_TIMESTAMP
           WHERE g.id=$2 AND g.revoked_at IS NULL
             AND EXISTS(
               SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
               WHERE p.id=$1 AND p.kind='staff' AND s.role='platform_admin'
                 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             )
           RETURNING g.id`,
          [adminId, grantId],
        )
      ).rows[0],
    );
  }

  return {
    async provisionStaff(token, role, expiresAt) {
      if (!validToken(token) || !isRole(role) || !validDate(expiresAt))
        throw new Error("Staff identity could not be provisioned.");
      const row = (
        await pool.query<{ id: string }>(
          `WITH identity AS (
             INSERT INTO principals(id,token_hash,kind,expires_at)
             SELECT $1,$2,'staff',$3 WHERE $3>CURRENT_TIMESTAMP
             ON CONFLICT(token_hash) DO NOTHING RETURNING id
           )
           INSERT INTO staff_profiles(principal_id,role)
           SELECT id,$4 FROM identity RETURNING principal_id AS id`,
          [randomUUID(), hash(token), expiresAt, role],
        )
      ).rows[0];
      if (!row) throw new Error("Staff identity could not be provisioned.");
      return row.id;
    },
    grantAssignment(adminId, staffId, workspaceId, role, purpose, expiresAt) {
      return grant(
        "assignment_grants",
        adminId,
        staffId,
        workspaceId,
        role,
        purpose,
        expiresAt,
      );
    },
    revokeAssignment(adminId, grantId) {
      return revoke("assignment_grants", adminId, grantId);
    },
    async grantEvidenceReview(
      adminId,
      reviewerId,
      assignmentId,
      submissionId,
      purpose,
      expiresAt,
    ) {
      if (
        !uuidPattern.test(adminId) ||
        !uuidPattern.test(reviewerId) ||
        !uuidPattern.test(assignmentId) ||
        !uuidPattern.test(submissionId) ||
        !validDate(expiresAt)
      )
        throw new Error("Privileged grant denied.");
      const row = (
        await pool.query<{ id: string }>(
          `INSERT INTO reviewer_evidence_grants(
             id,reviewer_id,assignment_id,submission_id,purpose,expires_at,granted_by
           )
           SELECT $1,$2,g.id,s.id,$5,$6,$7
           FROM evidence_review_submissions s
           JOIN evidence_objects e ON e.id=s.evidence_id
           JOIN assignment_grants g ON g.id=$3 AND g.staff_id=$2
             AND g.staff_role='reviewer' AND g.workspace_id=e.workspace_id
           WHERE s.id=$4 AND s.status IN ('queued','reviewed')
             AND s.submitted_by=e.owner_principal_id
             AND e.quarantine_state='clean' AND e.private_review_allowed
             AND $6>CURRENT_TIMESTAMP
             AND g.revoked_at IS NULL AND g.starts_at<=CURRENT_TIMESTAMP
             AND g.expires_at>CURRENT_TIMESTAMP
             AND EXISTS(
               SELECT 1 FROM principals p JOIN staff_profiles profile
                 ON profile.principal_id=p.id
               WHERE p.id=$7 AND p.kind='staff' AND profile.role='platform_admin'
                 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             )
             AND EXISTS(
               SELECT 1 FROM principals p JOIN staff_profiles profile
                 ON profile.principal_id=p.id
               WHERE p.id=$2 AND p.kind='staff' AND profile.role='reviewer'
                 AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             )
           RETURNING id`,
          [
            randomUUID(),
            reviewerId,
            assignmentId,
            submissionId,
            normalizedPurpose(purpose),
            expiresAt,
            adminId,
          ],
        )
      ).rows[0];
      if (!row) throw new Error("Privileged grant denied.");
      return row.id;
    },
    revokeEvidenceReview(adminId, grantId) {
      return revoke("reviewer_evidence_grants", adminId, grantId);
    },
    grantSupport(adminId, staffId, workspaceId, role, purpose, expiresAt) {
      return grant(
        "support_access_grants",
        adminId,
        staffId,
        workspaceId,
        role,
        purpose,
        expiresAt,
      );
    },
    revokeSupport(adminId, grantId) {
      return revoke("support_access_grants", adminId, grantId);
    },
    async readWorkspace(token, workspaceId, suppliedPurpose) {
      if (!validToken(token) || !uuidPattern.test(workspaceId))
        return { kind: "denied" };
      const purpose = suppliedPurpose?.trim();
      if (purpose !== undefined && (!purpose || purpose.length > 200))
        return { kind: "denied" };
      const rows = (
        await pool.query<WorkspaceRow>(
          `WITH identity AS (
             SELECT p.id,p.kind,s.role
             FROM principals p LEFT JOIN staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.revoked_at IS NULL
               AND p.expires_at>CURRENT_TIMESTAMP
           ), authorized AS (
             SELECT * FROM (
               SELECT 'member'::text AS via,NULL::uuid AS support_id,
                      NULL::text AS purpose
               FROM identity i JOIN workspaces w ON w.owner_principal_id=i.id
               WHERE i.kind='member' AND w.id=$2
               UNION ALL
               SELECT 'assignment',NULL::uuid,g.purpose
               FROM identity i JOIN assignment_grants g
                 ON g.staff_id=i.id AND g.staff_role=i.role
               WHERE i.kind='staff' AND g.workspace_id=$2
                 AND g.revoked_at IS NULL AND g.starts_at<=CURRENT_TIMESTAMP
                 AND g.expires_at>CURRENT_TIMESTAMP
               UNION ALL
               SELECT 'support',g.id,g.purpose
               FROM identity i JOIN support_access_grants g
                 ON g.staff_id=i.id AND g.staff_role=i.role
               WHERE i.kind='staff' AND g.workspace_id=$2 AND g.purpose=$3
                 AND g.revoked_at IS NULL AND g.starts_at<=CURRENT_TIMESTAMP
                 AND g.expires_at>CURRENT_TIMESTAMP
             ) candidates ORDER BY CASE via WHEN 'member' THEN 1 WHEN 'assignment' THEN 2 ELSE 3 END
             LIMIT 1
           ), audited AS (
             INSERT INTO authorization_audit(
               staff_id,workspace_id,support_access_id,action,purpose
             )
             SELECT i.id,$2,a.support_id,'support_content_read',a.purpose
             FROM authorized a CROSS JOIN identity i WHERE a.via='support'
             RETURNING id
           )
           SELECT a.via,a.purpose,e.lesson_id,e.lesson_version,e.instruction,
                  e.verification,e.completed_at,(SELECT count(*) FROM audited)
           FROM authorized a LEFT JOIN exercises e ON e.workspace_id=$2
           ORDER BY e.lesson_id,e.lesson_version`,
          [hash(token), workspaceId, purpose ?? null],
        )
      ).rows;
      if (!rows[0]) return { kind: "denied" };
      return {
        kind: "allowed",
        via: rows[0].via,
        workspaceId,
        purpose: rows[0].purpose,
        records: rows.flatMap((row) =>
          row.lesson_id === null
            ? []
            : [
                {
                  lessonId: row.lesson_id,
                  lessonVersion: row.lesson_version!,
                  instruction: row.instruction!,
                  verification: row.verification!,
                  completedAt: row.completed_at,
                },
              ],
        ),
      };
    },
    async readCohort(token, cohortId, contentId) {
      if (
        !validToken(token) ||
        !slugPattern.test(cohortId) ||
        !slugPattern.test(contentId)
      )
        return { kind: "denied" };
      const row = (
        await pool.query<{ body: string }>(
          `SELECT c.body FROM principals p
           JOIN cohort_memberships m ON m.member_id=p.id
           JOIN cohort_content c ON c.cohort_id=m.cohort_id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP AND m.cohort_id=$2
             AND c.content_id=$3 AND m.can_read_shared_content
             AND m.revoked_at IS NULL
             AND (m.expires_at IS NULL OR m.expires_at>CURRENT_TIMESTAMP)`,
          [hash(token), cohortId, contentId],
        )
      ).rows[0];
      return row
        ? { kind: "allowed", cohortId, contentId, body: row.body }
        : { kind: "denied" };
    },
  };
}
