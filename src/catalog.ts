import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { BACKGROUNDS, DOMAINS, GOALS } from "./content.ts";
import { hash } from "./store.ts";

export type ContentKind = "lesson" | "assignment" | "workflow" | "community";
export type ContentOrigin = "curated" | "member-proposal";
export type ContentState =
  "draft" | "in_review" | "approved" | "published" | "retired";
export interface DraftContent {
  id: string;
  version: number;
  kind: ContentKind;
  origin: ContentOrigin;
  title: string;
  body: string;
  owner: string;
  sources: string;
  rights: string;
  goals: string[];
  backgrounds: string[];
  domains: string[];
  prerequisites: string;
  rubric: string | null;
  rubricVersion: number | null;
}
export interface ContentVersion extends DraftContent {
  state: ContentState;
  requiresQualifiedSignoff: boolean;
  reviewedAt: Date | null;
  publishedAt: Date | null;
}
export interface CatalogStore {
  createDraft(token: string, draft: DraftContent): Promise<boolean>;
  submit(token: string, id: string, version: number): Promise<boolean>;
  approve(
    token: string,
    id: string,
    version: number,
    rightsConfirmed: boolean,
  ): Promise<boolean>;
  publish(token: string, id: string, version: number): Promise<boolean>;
  retire(token: string, id: string): Promise<boolean>;
  preview(
    token: string,
    id: string,
    version: number,
  ): Promise<ContentVersion | null>;
  staffList(token: string): Promise<ContentVersion[]>;
  published(id: string): Promise<ContentVersion | null>;
  search(filters: {
    q?: string;
    goal?: string;
    background?: string;
    domain?: string;
  }): Promise<ContentVersion[]>;
  assess(
    token: string,
    memberId: string,
    id: string,
    version: number,
    result: string,
  ): Promise<string | null>;
}
export function disabledCatalogStore(): CatalogStore {
  return {
    createDraft: async () => false,
    submit: async () => false,
    approve: async () => false,
    publish: async () => false,
    retire: async () => false,
    preview: async () => null,
    staffList: async () => [],
    published: async () => null,
    search: async () => [],
    assess: async () => null,
  };
}

const idPattern = /^[A-Z]{2,5}-[0-9]{3}$/;
function validTags(values: string[], options: object): boolean {
  return (
    Array.isArray(values) &&
    values.length <= Object.keys(options).length &&
    values.every((value) => Object.hasOwn(options, value)) &&
    new Set(values).size === values.length
  );
}
export function validDraft(item: DraftContent): boolean {
  return (
    idPattern.test(item.id) &&
    Number.isSafeInteger(item.version) &&
    item.version > 0 &&
    ["lesson", "assignment", "workflow", "community"].includes(item.kind) &&
    ["curated", "member-proposal"].includes(item.origin) &&
    item.title.trim().length > 0 &&
    item.title.length <= 160 &&
    item.body.trim().length > 0 &&
    item.body.length <= 20000 &&
    item.owner.trim().length > 0 &&
    item.owner.length <= 160 &&
    item.sources.trim().length > 0 &&
    item.sources.length <= 2000 &&
    item.rights.trim().length > 0 &&
    item.rights.length <= 2000 &&
    validTags(item.goals, GOALS) &&
    validTags(item.backgrounds, BACKGROUNDS) &&
    validTags(item.domains, DOMAINS) &&
    item.prerequisites.length <= 2000 &&
    ((item.rubric === null && item.rubricVersion === null) ||
      (typeof item.rubric === "string" &&
        item.rubric.trim().length > 0 &&
        item.rubric.length <= 10000 &&
        Number.isSafeInteger(item.rubricVersion) &&
        item.rubricVersion! > 0))
  );
}
const columns = `id,version,kind,origin,title,body,owner,sources,rights,goals,backgrounds,domains,prerequisites,
  rubric,rubric_version AS "rubricVersion",state,requires_qualified_signoff AS "requiresQualifiedSignoff",
  reviewed_at AS "reviewedAt",published_at AS "publishedAt"`;
function role(role: "editor" | "reviewer") {
  return `EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
    WHERE p.token_hash=$1 AND p.kind='staff' AND s.role='${role}'
      AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP)`;
}
export function catalogStore(pool: Pool): CatalogStore {
  return {
    async createDraft(token, item) {
      if (!validDraft(item)) return false;
      const result = await pool.query(
        `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights,
          goals,backgrounds,domains,prerequisites,rubric,rubric_version,created_by)
         SELECT $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,p.id
         FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
         WHERE p.token_hash=$1 AND p.kind='staff' AND s.role='editor'
           AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
           AND $3=(SELECT COALESCE(MAX(version),0)+1 FROM content_versions WHERE id=$2)
           AND NOT EXISTS(SELECT 1 FROM content_versions WHERE id=$2 AND state='retired')
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          hash(token),
          item.id,
          item.version,
          item.kind,
          item.origin,
          item.title,
          item.body,
          item.owner,
          item.sources,
          item.rights,
          item.goals,
          item.backgrounds,
          item.domains,
          item.prerequisites,
          item.rubric,
          item.rubricVersion,
        ],
      );
      return result.rowCount === 1;
    },
    async submit(token, id, version) {
      const result = await pool.query(
        `UPDATE content_versions SET state='in_review'
         WHERE id=$2 AND version=$3 AND state='draft' AND ${role("editor")}`,
        [hash(token), id, version],
      );
      return result.rowCount === 1;
    },
    async approve(token, id, version, rightsConfirmed) {
      if (!rightsConfirmed) return false;
      const result = await pool.query(
        `UPDATE content_versions SET state='approved',reviewed_by=p.id,
           reviewed_at=CURRENT_TIMESTAMP,rights_confirmed=true
         FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
         WHERE content_versions.id=$2 AND content_versions.version=$3
           AND content_versions.state='in_review' AND content_versions.created_by IS DISTINCT FROM p.id
           AND NOT content_versions.requires_qualified_signoff
           AND p.token_hash=$1 AND p.kind='staff' AND s.role='reviewer'
           AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`,
        [hash(token), id, version],
      );
      return result.rowCount === 1;
    },
    async publish(token, id, version) {
      const result = await pool.query(
        `UPDATE content_versions SET state='published',published_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND version=$3 AND state='approved' AND reviewed_at IS NOT NULL
           AND rights_confirmed AND ${role("editor")}`,
        [hash(token), id, version],
      );
      return result.rowCount === 1;
    },
    async retire(token, id) {
      const result = await pool.query(
        `UPDATE content_versions SET state='retired',retired_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND state='published' AND ${role("editor")}`,
        [hash(token), id],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async preview(token, id, version) {
      const result = await pool.query<ContentVersion>(
        `SELECT ${columns} FROM content_versions
         WHERE id=$2 AND version=$3 AND (${role("editor")} OR ${role("reviewer")})`,
        [hash(token), id, version],
      );
      return result.rows[0] ?? null;
    },
    async staffList(token) {
      const result = await pool.query<ContentVersion>(
        `SELECT ${columns} FROM content_versions
         WHERE (${role("editor")} OR ${role("reviewer")})
         ORDER BY id,version DESC LIMIT 100`,
        [hash(token)],
      );
      return result.rows;
    },
    async published(id) {
      const result = await pool.query<ContentVersion>(
        `SELECT ${columns} FROM content_versions WHERE id=$1 AND state='published'
         ORDER BY version DESC LIMIT 1`,
        [id],
      );
      return result.rows[0] ?? null;
    },
    async search({ q, goal, background, domain }) {
      if (
        (goal && !Object.hasOwn(GOALS, goal)) ||
        (background && !Object.hasOwn(BACKGROUNDS, background)) ||
        (domain && !Object.hasOwn(DOMAINS, domain))
      )
        return [];
      const result = await pool.query<ContentVersion>(
        `SELECT ${columns} FROM (
           SELECT DISTINCT ON (id) * FROM content_versions WHERE state='published'
           ORDER BY id,version DESC
         ) current_versions
         WHERE ($1='' OR title ILIKE '%'||$1||'%' OR body ILIKE '%'||$1||'%')
           AND ($2='' OR cardinality(goals)=0 OR $2=ANY(goals))
           AND ($3='' OR cardinality(backgrounds)=0 OR $3=ANY(backgrounds))
           AND ($4='' OR cardinality(domains)=0 OR $4=ANY(domains))
         ORDER BY id`,
        [
          (q ?? "").trim().slice(0, 100),
          goal ?? "",
          background ?? "",
          domain ?? "",
        ],
      );
      return result.rows;
    },
    async assess(token, memberId, id, version, result) {
      if (!result.trim() || result.length > 4000) return null;
      const assessmentId = randomUUID();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO content_assessments(id,member_id,content_id,content_version,
          rubric_version,reviewer_id,result)
         SELECT $1,$2,cv.id,cv.version,cv.rubric_version,p.id,$6
         FROM content_versions cv
         JOIN principals p ON p.token_hash=$3 AND p.kind='staff'
         JOIN staff_profiles s ON s.principal_id=p.id AND s.role='reviewer'
         JOIN assignment_grants g ON g.staff_id=p.id AND g.staff_role='reviewer'
           AND g.workspace_id=$2 AND g.revoked_at IS NULL
           AND g.starts_at<=CURRENT_TIMESTAMP AND g.expires_at>CURRENT_TIMESTAMP
         WHERE cv.id=$4 AND cv.version=$5 AND cv.state='published'
           AND cv.rubric_version IS NOT NULL AND p.revoked_at IS NULL
           AND p.expires_at>CURRENT_TIMESTAMP
         LIMIT 1
         RETURNING id`,
        [assessmentId, memberId, hash(token), id, version, result],
      );
      return inserted.rows[0]?.id ?? null;
    },
  };
}

const draftPaths: Array<[string, ContentKind]> = [
  ["foundation/FND-001-ai-literacy.md", "lesson"],
  ["foundation/FND-002-clear-requests.md", "lesson"],
  ["foundation/FND-003-check-outputs.md", "lesson"],
  ["foundation/FND-004-privacy-rights.md", "lesson"],
  ["foundation/FND-005-practical-workflows.md", "lesson"],
  ["foundation/FND-006-participation.md", "lesson"],
  ["assignments/ASN-001-signup-qa.md", "assignment"],
  ["assignments/ASN-002-meeting-actions.md", "assignment"],
  ["workflows/WF-001-requirements.md", "workflow"],
  ["workflows/WF-002-test-review.md", "workflow"],
  ["workflows/WF-003-meeting-actions.md", "workflow"],
  ["community/COMM-001-examples.md", "community"],
];
export function parseDraftFile(text: string, path: string) {
  const [, front, body] = text.split(/^---\s*$/m);
  if (!front || !body) throw new Error(`Invalid draft content file: ${path}`);
  const meta = Object.fromEntries(
    front
      .trim()
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  );
  return { meta, body: body.trim(), prerequisites: meta.prerequisites ?? "" };
}
export async function seedDraftPack(pool: Pool): Promise<number> {
  let seeded = 0;
  for (const [path, kind] of draftPaths) {
    const text = await readFile(
      new URL(`../assets/docs/content/${path}`, import.meta.url),
      "utf8",
    );
    const { meta, body, prerequisites } = parseDraftFile(text, path);
    const result = await pool.query(
      `INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights,
        goals,backgrounds,domains,prerequisites,rubric,rubric_version,requires_qualified_signoff)
       VALUES($1,$2,$3,'curated',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
       ON CONFLICT DO NOTHING`,
      [
        meta.id,
        Number(meta.version),
        kind,
        meta.title,
        body,
        meta.owner,
        meta.sources,
        meta.rights,
        kind === "lesson"
          ? Object.keys(GOALS)
          : kind === "assignment"
            ? [path.includes("ASN-001") ? "build" : "work"]
            : [],
        kind === "lesson" ? Object.keys(BACKGROUNDS) : [],
        [],
        prerequisites,
        kind === "assignment" ? body : null,
        kind === "assignment" ? 1 : null,
      ],
    );
    seeded += result.rowCount ?? 0;
  }
  return seeded;
}
