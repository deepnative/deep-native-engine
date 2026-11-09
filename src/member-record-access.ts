import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
  MEMBER_EXPORT_SECTIONS,
} from "./member-export.ts";
import { hash } from "./store.ts";

/**
 * #40 RECACCESS: a member lets operators download one scope of their records
 * for seven days. Each scope names Download my records sections that need no
 * parent lock; nothing else, and never another member's rows, can leave.
 */
export const RECORD_SCOPES = {
  learning: [
    "lessonActivity",
    "lessonUsefulness",
    "assignmentChoices",
    "assignmentAttempts",
    "exercises",
    "milestones",
    "contentAssessments",
  ],
  support: ["supportRequests"],
  billing: [
    "billingProfile",
    "invoices",
    "invoicePayments",
    "invoicePlans",
    "manualPaymentObservations",
  ],
} as const satisfies Record<
  string,
  readonly (keyof typeof MEMBER_EXPORT_SECTIONS)[]
>;
export type RecordScope = keyof typeof RECORD_SCOPES;
export const isRecordScope = (value: unknown): value is RecordScope =>
  typeof value === "string" && Object.hasOwn(RECORD_SCOPES, value);
export const RECORD_ACCESS_DAYS = 7;
export const RECORD_ACCESS_CURSOR_TTL_MS = 15 * 60 * 1000;

export type RecordAccessEntry = {
  id: string;
  scope: RecordScope;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  current: boolean;
  downloads: number;
};
export type RecordAccessList =
  | { kind: "ready"; value: RecordAccessEntry[] }
  | { kind: "denied" | "unavailable" };
export type RecordAccessChange = {
  kind: "ready" | "denied" | "invalid" | "unavailable";
};
export interface OperatorRecordsPayload {
  kind: "ready";
  version: "operator-member-records-v1";
  reference: string;
  scope: RecordScope;
  accessExpiresAt: Date;
  records: Record<string, Record<string, unknown>[]>;
  page: {
    number: number;
    recordCount: number;
    complete: boolean;
    nextCursor: string | null;
  };
}
export type OperatorRecords =
  | { kind: "ready"; payload: OperatorRecordsPayload }
  | { kind: "denied" | "invalid" | "limit" | "unavailable" };
export interface MemberRecordAccess {
  list(memberToken: string): Promise<RecordAccessList>;
  grant(memberToken: string, scope: unknown): Promise<RecordAccessChange>;
  revoke(memberToken: string, id: unknown): Promise<RecordAccessChange>;
  /** Whether this staff session may use the operator download form at all. */
  operator(staffToken: string): Promise<"allowed" | "denied" | "unavailable">;
  download(
    staffToken: string,
    reference: unknown,
    scope: unknown,
    cursor?: unknown,
  ): Promise<OperatorRecords>;
}

const TOKEN = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEMBER = `SELECT p.id FROM principals p
 JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
 WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
   AND p.expires_at>clock_timestamp()`;
const STAFF = `SELECT p.id FROM principals p
 JOIN authorized_staff_profiles s ON s.principal_id=p.id
 WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
   AND p.expires_at>clock_timestamp() AND s.role IN ('operator','platform_admin')
 LIMIT 1`;
const LIST = `SELECT a.id,a.scope,a.created_at AS "createdAt",a.expires_at AS "expiresAt",
   a.revoked_at AS "revokedAt",
   (a.revoked_at IS NULL AND a.expires_at>clock_timestamp()) AS current,
   (SELECT count(*)::integer FROM member_record_access_downloads d WHERE d.access_id=a.id) AS downloads
 FROM member_record_access a WHERE a.member_id=$1
 ORDER BY a.created_at DESC,a.id DESC LIMIT 20`;
const GRANT = `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
 INSERT INTO member_record_access(id,member_id,scope,created_at,expires_at)
 SELECT $2,$1,$3,t.now,t.now+make_interval(days=>$4) FROM t
 WHERE NOT EXISTS(SELECT 1 FROM member_record_access a WHERE a.member_id=$1
   AND a.scope=$3 AND a.revoked_at IS NULL AND a.expires_at>t.now)`;
const REVOKE = `UPDATE member_record_access SET revoked_at=clock_timestamp()
 WHERE id=$2 AND member_id=$1 AND revoked_at IS NULL RETURNING id`;
// The workspace is shared-locked, as Download my records does, so deletion
// waits; the authorization is shared-locked so a revocation waits for this
// download to finish and every later page sees it.
const TARGET = `SELECT l.id FROM learners l
 JOIN workspaces w ON w.owner_principal_id=l.id AND w.deleting_at IS NULL
 WHERE l.id=$1 FOR SHARE OF w`;
const ACCESS = `SELECT a.id,a.expires_at AS "expiresAt" FROM member_record_access a
 WHERE a.member_id=$1 AND a.scope=$2 AND a.revoked_at IS NULL
   AND a.created_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
 ORDER BY a.expires_at DESC,a.id LIMIT 1 FOR SHARE`;
const LOG = `INSERT INTO member_record_access_downloads(id,access_id,member_id,staff_id,scope)
 VALUES($1,$2,$3,$4,$5)`;

type Key = (string | number)[];
type Cursor = [
  version: 1,
  section: number,
  key: Key,
  page: number,
  expires: number,
];

class Denied extends Error {}

async function withMember<T extends { kind: string }>(
  pool: Pool,
  memberToken: string,
  work: (client: PoolClient, memberId: string) => Promise<T>,
): Promise<T | { kind: "denied" } | { kind: "unavailable" }> {
  if (typeof memberToken !== "string" || !TOKEN.test(memberToken))
    return { kind: "denied" };
  let client: PoolClient | undefined, failure: Error | undefined;
  let result: T | { kind: "denied" } | { kind: "unavailable" };
  let committed = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const member = (
      await client.query<{ id: string }>(`${MEMBER} LIMIT 1 FOR SHARE OF w`, [
        hash(memberToken),
      ])
    ).rows[0];
    if (!member) throw new Denied();
    result = await work(client, member.id);
    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    result = { kind: error instanceof Denied ? "denied" : "unavailable" };
  }
  if (client) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        failure = new Error("Record access rollback failed");
      }
    }
    client.release(failure);
  }
  return result;
}

export function memberRecordAccessStore(
  pool: Pool,
  cursorSecret: Buffer = randomBytes(32),
): MemberRecordAccess {
  // A cursor is bound to the staff session, the member and the scope, so it
  // can't continue another member's or another scope's download.
  const sign = (body: string, bound: string) =>
    createHmac("sha256", cursorSecret)
      .update(bound)
      .update(".")
      .update(body)
      .digest("base64url");
  const encode = (data: Cursor, bound: string) => {
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${body}.${sign(body, bound)}`;
  };
  function decode(value: unknown, bound: string): Cursor | null {
    if (typeof value !== "string" || value.length > 1024) return null;
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (
      !match ||
      !timingSafeEqual(
        Buffer.from(match[2]!),
        Buffer.from(sign(match[1]!, bound)),
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
        !Number.isSafeInteger(data[1]) ||
        data[1] < 0 ||
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
    async list(memberToken) {
      return withMember(pool, memberToken, async (client, memberId) => ({
        kind: "ready" as const,
        value: (await client.query<RecordAccessEntry>(LIST, [memberId])).rows,
      }));
    },
    async grant(memberToken, scope) {
      if (!isRecordScope(scope)) return { kind: "invalid" };
      return withMember(pool, memberToken, async (client, memberId) => {
        await client.query(GRANT, [
          memberId,
          randomUUID(),
          scope,
          RECORD_ACCESS_DAYS,
        ]);
        return { kind: "ready" as const };
      });
    },
    async revoke(memberToken, id) {
      if (typeof id !== "string" || !UUID.test(id)) return { kind: "invalid" };
      return withMember(pool, memberToken, async (client, memberId) => {
        if ((await client.query(REVOKE, [memberId, id])).rows[0])
          return { kind: "ready" as const };
        // Already revoked or never this member's: nothing changes either way.
        const owned = await client.query(
          "SELECT 1 FROM member_record_access WHERE id=$1 AND member_id=$2",
          [id, memberId],
        );
        return owned.rows[0]
          ? { kind: "ready" as const }
          : { kind: "invalid" as const };
      });
    },
    async operator(staffToken) {
      if (typeof staffToken !== "string" || !TOKEN.test(staffToken))
        return "denied";
      try {
        return (await pool.query(STAFF, [hash(staffToken)])).rows[0]
          ? "allowed"
          : "denied";
      } catch {
        return "unavailable";
      }
    },
    async download(staffToken, reference, scope, continuation) {
      if (typeof staffToken !== "string" || !TOKEN.test(staffToken))
        return { kind: "denied" };
      if (
        typeof reference !== "string" ||
        !UUID.test(reference) ||
        !isRecordScope(scope)
      )
        return { kind: "invalid" };
      const bound = `${hash(staffToken)}.${reference}.${scope}`;
      const cursor =
        continuation === undefined ? undefined : decode(continuation, bound);
      if (cursor === null) return { kind: "denied" };
      const names = RECORD_SCOPES[scope];
      if (cursor && cursor[1] >= names.length) return { kind: "denied" };
      const expires = cursor?.[4] ?? Date.now() + RECORD_ACCESS_CURSOR_TTL_MS;
      let client: PoolClient | undefined, failure: Error | undefined;
      let result: OperatorRecords;
      try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL lock_timeout='5s'");
        const staff = (
          await client.query<{ id: string }>(STAFF, [hash(staffToken)])
        ).rows[0];
        // An absent member and an absent authorization look the same.
        const member =
          staff && (await client.query(TARGET, [reference])).rows[0];
        const access =
          member &&
          (
            await client.query<{ id: string; expiresAt: Date }>(ACCESS, [
              reference,
              scope,
            ])
          ).rows[0];
        if (!access) throw new Denied();
        const records: OperatorRecordsPayload["records"] = Object.fromEntries(
          names.map((name) => [name, []]),
        );
        const payload: OperatorRecordsPayload = {
          kind: "ready",
          version: "operator-member-records-v1",
          reference,
          scope,
          accessExpiresAt: access.expiresAt,
          records,
          page: {
            number: cursor?.[3] ?? 1,
            recordCount: 0,
            complete: true,
            nextCursor: null,
          },
        };
        let more = false,
          limit = false;
        pages: for (
          let index = cursor?.[1] ?? 0;
          index < names.length;
          index++
        ) {
          const name = names[index]!;
          const key = index === cursor?.[1] ? cursor[2] : [];
          const rows = (
            await client.query<{ _key: Key; [field: string]: unknown }>(
              MEMBER_EXPORT_SECTIONS[name],
              [
                reference,
                MAX_MEMBER_EXPORT_RECORDS - payload.page.recordCount + 1,
                JSON.stringify(key),
              ],
            )
          ).rows;
          for (const { _key, ...record } of rows) {
            if (payload.page.recordCount === MAX_MEMBER_EXPORT_RECORDS) {
              more = true;
              break pages;
            }
            const previous = payload.page.nextCursor;
            records[name]!.push(record);
            payload.page.recordCount++;
            payload.page.nextCursor = encode(
              [1, index, _key, payload.page.number + 1, expires],
              bound,
            );
            if (
              Buffer.byteLength(JSON.stringify(payload)) >
              MAX_MEMBER_EXPORT_BYTES
            ) {
              records[name]!.pop();
              payload.page.recordCount--;
              payload.page.nextCursor = previous;
              limit = payload.page.recordCount === 0;
              more = true;
              break pages;
            }
          }
        }
        payload.page.complete = !more;
        if (!more) payload.page.nextCursor = null;
        if (limit) result = { kind: "limit" };
        else {
          // One line per download, on its first page; later pages continue it.
          if (!cursor)
            await client.query(LOG, [
              randomUUID(),
              access.id,
              reference,
              staff!.id,
              scope,
            ]);
          await client.query("COMMIT");
          result = { kind: "ready", payload };
        }
      } catch (error) {
        result = { kind: error instanceof Denied ? "denied" : "unavailable" };
      }
      if (client) {
        if (result.kind !== "ready") {
          try {
            await client.query("ROLLBACK");
          } catch {
            failure = new Error("Record download rollback failed");
          }
        }
        client.release(failure);
      }
      if (result.kind === "ready" && expires <= Date.now())
        return { kind: "denied" };
      return result;
    },
  };
}

export function disabledMemberRecordAccess(): MemberRecordAccess {
  return {
    list: async () => ({ kind: "unavailable" }),
    grant: async () => ({ kind: "unavailable" }),
    revoke: async () => ({ kind: "unavailable" }),
    operator: async () => "unavailable",
    download: async () => ({ kind: "unavailable" }),
  };
}
