import {
  createSupportGrantRecord,
  revokeSupportGrantRecord,
  sameSupportGrant,
} from "./support-grant-records.ts";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { performance } from "node:perf_hooks";
import { hash } from "./store.ts";
import {
  allocateSupportTime,
  cancelSupportTime,
  beginSupportTime,
  recordSupportTime,
  supportIntervalMinutes,
  supportTimeReceipt,
  supportTimeOperatorReceipt,
  type MemberSupportTimeStore,
  type SupportTimeReceipt,
  type SupportTimeScope,
} from "./support-time.ts";

export interface SupportPage<T> {
  items: T[];
  nextCursor: string | null;
}
export type SupportRead<T> =
  { kind: "ready"; value: T } | { kind: "denied" | "unavailable" };
export interface SupportReceipt {
  requestId: string;
  receivedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  withdrawnAt: Date | null;
  coverageState: "unverified";
}
export interface SupportRequestSummary extends SupportReceipt {
  subject: string | null;
}
export interface SupportMemberReply {
  id: string;
  body: string;
  createdAt: Date;
  attribution: "Synthetic operator";
}
export interface SupportMemberDetail extends SupportRequestSummary {
  supportTime?: SupportTimeReceipt;
  body: string | null;
  replies: SupportPage<SupportMemberReply>;
}
export interface SupportOperatorContext {
  observedAt: Date;
  elapsedSeconds: number;
  grantStartsAt: Date;
  grantExpiresAt: Date;
  allowedActions: ("acknowledge" | "note" | "reply" | "resolve")[];
}
export interface SupportOperatorSummary extends SupportRequestSummary {
  grantId: string;
  operatorContext: SupportOperatorContext;
  authorizedEffort?: SupportTimeReceipt & SupportTimeScope;
}
export interface SupportOperatorMessage extends SupportMemberReply {
  kind: "reply" | "internal-note";
}
export interface SupportOperatorDetail extends SupportOperatorSummary {
  body: string;
  messages: SupportPage<SupportOperatorMessage>;
}
export interface SupportMutationReceipt {
  requestId: string;
  eventId: string;
  occurredAt: Date;
  messageId: string | null;
}
export type SupportTransition =
  | { kind: "applied" | "replayed"; receipt: SupportMutationReceipt }
  | { kind: "denied" | "withdrawn" | "conflict" | "unavailable" };
export type SupportMessageTransition =
  SupportTransition | { kind: "invalid"; field: "body" };
export interface SupportOperatorScope {
  requestId: string;
  grantId: string;
}
export interface SupportGrantInput {
  idempotencyKey: string;
  requestId: string;
  staffId: string;
  role: "operator" | "platform_admin";
  startsAt: Date;
  expiresAt: Date;
}
export interface SupportRequestStore {
  readonly time?: MemberSupportTimeStore;
  create(
    token: string,
    input: { idempotencyKey: string; subject: string; body: string },
  ): Promise<
    | { kind: "created" | "replayed"; receipt: SupportReceipt }
    | { kind: "invalid"; field: "subject" | "body" | "idempotencyKey" }
    | { kind: "denied" | "withdrawn" | "conflict" | "unavailable" }
  >;
  receipt(
    token: string,
    intakeKey: string,
  ): Promise<
    | { kind: "found"; receipt: SupportReceipt }
    | { kind: "missing" | "denied" | "unavailable" }
  >;
  ownerHistory(
    token: string,
    after?: string,
  ): Promise<SupportRead<SupportPage<SupportRequestSummary>>>;
  memberDetail(
    token: string,
    requestId: string,
    after?: string,
  ): Promise<SupportRead<SupportMemberDetail>>;
  operatorWorklist(
    token: string,
    after?: string,
  ): Promise<SupportRead<SupportPage<SupportOperatorSummary>>>;
  operatorDetail(
    token: string,
    scope: SupportOperatorScope,
    after?: string,
  ): Promise<SupportRead<SupportOperatorDetail> | { kind: "withdrawn" }>;
  acknowledge(
    token: string,
    scope: SupportOperatorScope,
    key: string,
  ): Promise<SupportTransition>;
  reply(
    token: string,
    scope: SupportOperatorScope,
    key: string,
    body: string,
  ): Promise<SupportMessageTransition>;
  note(
    token: string,
    scope: SupportOperatorScope,
    key: string,
    body: string,
  ): Promise<SupportMessageTransition>;
  resolve(
    token: string,
    scope: SupportOperatorScope,
    key: string,
  ): Promise<SupportTransition>;
  withdraw(
    token: string,
    requestId: string,
  ): Promise<{
    kind: "withdrawn" | "already-withdrawn" | "denied" | "unavailable";
  }>;
  grant(
    token: string,
    input: SupportGrantInput,
  ): Promise<
    | { kind: "created" | "replayed"; grantId: string }
    | { kind: "denied" | "withdrawn" | "conflict" | "unavailable" }
  >;
  revoke(
    token: string,
    grantId: string,
  ): Promise<{
    kind: "revoked" | "already-revoked" | "denied" | "unavailable";
  }>;
}
export function disabledSupportRequestStore(): SupportRequestStore {
  const denied = async () => ({ kind: "denied" as const });
  return {
    create: denied,
    receipt: denied,
    ownerHistory: denied,
    memberDetail: denied,
    operatorWorklist: denied,
    operatorDetail: denied,
    acknowledge: denied,
    reply: denied,
    note: denied,
    resolve: denied,
    withdraw: denied,
    grant: denied,
    revoke: denied,
  };
}
export function supportTextValid(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    value.trim().length > 0 &&
    !/[\0\uD800-\uDFFF]/u.test(value)
  );
}
const purpose = "support-request-local-v1";
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const receiptColumns = `r.id AS "requestId",r.received_at AS "receivedAt",r.acknowledged_at AS "acknowledgedAt",
 r.resolved_at AS "resolvedAt",r.withdrawn_at AS "withdrawnAt",r.coverage_state AS "coverageState"`;
const metadataColumns = `${receiptColumns},r.member_id AS "memberId",r.workspace_id AS "workspaceId"`;
const at = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"`;
type Candidate = {
  requestId: string;
  memberId: string;
  workspaceId: string;
  grantId: string;
  cursorAt: string;
};
type RequestMeta = SupportReceipt & { memberId: string; workspaceId: string };
type GrantRow = {
  id: string;
  requestId: string;
  staffId: string;
  role: string;
  purpose: string;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  active: boolean;
  grantedBy: string;
  idempotencyKey: string;
};
const grantColumns = `id,request_id AS "requestId",staff_id AS "staffId",staff_role AS role,purpose,
 starts_at AS "startsAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",granted_by AS "grantedBy",idempotency_key AS "idempotencyKey",
 (revoked_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()) AS active`;
type Context = {
  client: PoolClient;
  actor: { id: string; kind: string };
  tokenHash: string;
  deadlines: Date[];
  operatorReads?: SupportOperatorSummary[];
};
type Cursor = [string, string, "reply" | "internal-note" | "", number];
class SupportFailure extends Error {
  readonly kind: "denied" | "unavailable";
  constructor(kind: "denied" | "unavailable") {
    super(kind);
    this.kind = kind;
  }
}
function requireAccess(
  condition: unknown,
  kind: "denied" | "unavailable" = "denied",
): asserts condition {
  if (!condition) throw new SupportFailure(kind);
}
function receipt(row: SupportReceipt): SupportReceipt {
  return {
    requestId: row.requestId,
    receivedAt: row.receivedAt,
    acknowledgedAt: row.acknowledgedAt,
    resolvedAt: row.resolvedAt,
    withdrawnAt: row.withdrawnAt,
    coverageState: row.coverageState,
  };
}
function validScope(scope: SupportOperatorScope): boolean {
  return uuid.test(scope.requestId) && uuid.test(scope.grantId);
}
export function supportRequestStore(
  pool: Pool,
  cursorSecret: Buffer = randomBytes(32),
  options: { timeWrites?: boolean } = {},
): SupportRequestStore {
  const timeWrites = options.timeWrites !== false;
  function signature(body: string, token: string, scope: string): string {
    return createHmac("sha256", cursorSecret)
      .update(hash(token))
      .update("\0")
      .update(scope)
      .update("\0")
      .update(body)
      .digest("base64url");
  }
  function cursor(
    after: string | undefined,
    token: string,
    scope: string,
  ): Cursor | null {
    if (after === undefined) return null;
    requireAccess(after.length <= 1024);
    const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(after);
    requireAccess(
      parts &&
        timingSafeEqual(
          Buffer.from(parts[2]!),
          Buffer.from(signature(parts[1]!, token, scope)),
        ),
    );
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch {
      throw new SupportFailure("denied");
    }
    requireAccess(
      Array.isArray(data) &&
        data.length === 4 &&
        typeof data[0] === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(data[0]) &&
        Number.isFinite(Date.parse(data[0])) &&
        new Date(data[0]).toISOString() === data[0].slice(0, 23) + "Z" &&
        typeof data[1] === "string" &&
        uuid.test(data[1]) &&
        ["", "reply", "internal-note"].includes(data[2]) &&
        Number.isSafeInteger(data[3]) &&
        data[3] > Date.now(),
    );
    return data as Cursor;
  }
  function page<T extends { cursorAt: string }>(
    rows: T[],
    token: string,
    scope: string,
    previous: Cursor | null,
    key: (row: T) => [string, "reply" | "internal-note" | ""],
  ): { rows: T[]; nextCursor: string | null } {
    const emitted = rows.slice(0, 20);
    if (rows.length <= 20) return { rows: emitted, nextCursor: null };
    const last = emitted[19]!,
      [id, kind] = key(last);
    const body = Buffer.from(
      JSON.stringify([
        last.cursorAt,
        id,
        kind,
        previous?.[3] ?? Date.now() + 900000,
      ]),
    ).toString("base64url");
    return {
      rows: emitted,
      nextCursor: `${body}.${signature(body, token, scope)}`,
    };
  }
  async function run<T>(
    token: string,
    use: (ctx: Context) => Promise<T>,
  ): Promise<T | { kind: "denied" | "unavailable" }> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return { kind: "denied" };
    let client: PoolClient | undefined, releaseError: Error | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      const tokenHash = hash(token);
      // Discovery contains identifiers only. Authorization follows canonical locks.
      const actor = (
        await client.query<{ id: string; kind: string }>(
          "SELECT id,kind FROM principals WHERE token_hash=$1",
          [tokenHash],
        )
      ).rows[0];
      requireAccess(actor);
      const ctx = { client, actor, tokenHash, deadlines: [] as Date[] };
      const result = await use(ctx);
      const current = (
        await client.query<{ valid: boolean }>(
          "SELECT bool_and(deadline>clock_timestamp()) AS valid FROM unnest($1::timestamptz[]) AS times(deadline)",
          [ctx.deadlines],
        )
      ).rows[0];
      requireAccess(current?.valid);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          releaseError = new Error("Support rollback failed");
        }
      }
      return {
        kind: error instanceof SupportFailure ? error.kind : "unavailable",
      };
    } finally {
      client?.release(releaseError);
    }
  }
  // Combined operator reads use one bounded transaction and one observation
  // instant. No independently committed request/time read is composed here.
  async function acquireOperator(): Promise<PoolClient> {
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = pool.connect().then((client) => {
        if (expired) {
          client.release(new Error("Support acquisition expired"));
          throw Error("Support operation unavailable");
        }
        return client;
      });
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(Error("Support operation unavailable"));
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function runOperator<T>(
    token: string,
    use: (ctx: Context) => Promise<T>,
  ): Promise<T | { kind: "denied" | "unavailable" }> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return { kind: "denied" };
    const started = performance.now();
    let client: PoolClient | undefined, releaseError: Error | undefined;
    let result: T | { kind: "denied" | "unavailable" };
    let checkedAt = 0,
      remaining = 0,
      accepted = false,
      queryExpired = false;
    try {
      const connection = await acquireOperator();
      // Server timeouts do not cover a withheld BEGIN/COMMIT reply. Keep a
      // client-side query deadline inside the same total operation budget;
      // discard the owned uncertain connection instead of queuing rollback.
      client = Object.create(connection) as PoolClient;
      client.query = (async (sql: string, values?: unknown[]) => {
        const remaining = 10000 - (performance.now() - started);
        if (remaining <= 0) {
          queryExpired = true;
          throw new SupportFailure("unavailable");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            connection.query(sql, values),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  queryExpired = true;
                  reject(new SupportFailure("unavailable"));
                },
                Math.min(5000, remaining),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }) as PoolClient["query"];
      client.release = (error) => connection.release(error);
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SELECT set_config('transaction_timeout',$1,true)", [
        `${Math.max(1, Math.floor(10000 - (performance.now() - started)))}ms`,
      ]);
      const tokenHash = hash(token);
      const actor = (
        await client.query<{ id: string; kind: string }>(
          "SELECT id,kind FROM principals WHERE token_hash=$1",
          [tokenHash],
        )
      ).rows[0];
      requireAccess(actor);
      const ctx: Context = {
        client,
        actor,
        tokenHash,
        deadlines: [],
        operatorReads: [],
      };
      result = await use(ctx);
      checkedAt = performance.now();
      const current = (
        await client.query<{
          valid: boolean;
          observedAt: Date;
          remainingMs: string;
        }>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() observed_at)
        SELECT bool_and(deadline>t.observed_at) AS valid,t.observed_at AS "observedAt",
        EXTRACT(EPOCH FROM (min(deadline)-t.observed_at))*1000 AS "remainingMs"
        FROM unnest($1::timestamptz[]) AS times(deadline) CROSS JOIN instant t GROUP BY t.observed_at`,
          [ctx.deadlines],
        )
      ).rows[0];
      remaining = Number(current?.remainingMs);
      requireAccess(
        current?.valid &&
          Number.isFinite(remaining) &&
          remaining > performance.now() - checkedAt,
      );
      requireAccess(performance.now() - started < 10000, "unavailable");
      for (const row of ctx.operatorReads!) {
        row.operatorContext.observedAt = current.observedAt;
        row.operatorContext.elapsedSeconds = Math.max(
          0,
          Math.floor(
            (current.observedAt.valueOf() - row.receivedAt.valueOf()) / 1000,
          ),
        );
      }
      await client.query("COMMIT");
      accepted = true;
    } catch (error) {
      result = {
        kind: error instanceof SupportFailure ? error.kind : "unavailable",
      };
      if (client) {
        if (!queryExpired) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* discard uncertain connection */
          }
        }
        releaseError = new Error("Support operator outcome unavailable");
      }
    } finally {
      try {
        client?.release(releaseError);
      } catch {
        accepted = false;
        result = { kind: "unavailable" };
      }
    }
    // Include final query, COMMIT and connection handback in the permission
    // lifetime. A late or uncertain result is withheld; never retry the read.
    if (accepted && performance.now() - started >= 10000)
      return { kind: "unavailable" };
    if (accepted && remaining <= performance.now() - checkedAt)
      return { kind: "denied" };
    return result;
  }
  async function principals(
    ctx: Context,
    owners: string[],
    staff: string[] = [],
    write = false,
  ): Promise<Map<string, { expiresAt: Date; active: boolean }>> {
    const ids = Array.from(new Set([ctx.actor.id, ...owners, ...staff])).sort();
    const rows = (
      await ctx.client.query<{
        id: string;
        kind: string;
        tokenHash: string;
        expiresAt: Date;
        active: boolean;
      }>(
        `SELECT id,kind,token_hash AS "tokenHash",expires_at AS "expiresAt",
       (revoked_at IS NULL AND expires_at>clock_timestamp()) AS active
       FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? "UPDATE" : "SHARE"}`,
        [ids],
      )
    ).rows;
    const found = new Map(rows.map((row) => [row.id, row]));
    const actor = found.get(ctx.actor.id);
    requireAccess(
      rows.length === ids.length &&
        actor?.active &&
        actor.tokenHash === ctx.tokenHash &&
        actor.kind === ctx.actor.kind &&
        owners.every((id) => found.get(id)!.kind === "member") &&
        staff.every((id) => found.get(id)!.kind === "staff"),
    );
    ctx.deadlines.push(actor.expiresAt);
    return found;
  }
  async function profiles(
    ctx: Context,
    ids: string[],
  ): Promise<Map<string, string>> {
    const rows = (
      await ctx.client.query<{ id: string; role: string }>(
        "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [Array.from(new Set(ids)).sort()],
      )
    ).rows;
    return new Map(rows.map((row) => [row.id, row.role]));
  }
  async function workspaces(
    ctx: Context,
    candidates: { workspaceId: string; memberId: string }[],
    write: boolean,
  ): Promise<void> {
    const ids = Array.from(
      new Set(candidates.map((c) => c.workspaceId)),
    ).sort();
    const rows = (
      await ctx.client.query<{
        id: string;
        memberId: string;
        deletingAt: Date | null;
      }>(
        `SELECT id,owner_principal_id AS "memberId",deleting_at AS "deletingAt" FROM workspaces
       WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? "UPDATE" : "SHARE"}`,
        [ids],
      )
    ).rows;
    requireAccess(
      candidates.every((c) =>
        rows.some(
          (r) =>
            r.id === c.workspaceId &&
            r.memberId === c.memberId &&
            !r.deletingAt,
        ),
      ),
    );
  }
  async function owner(ctx: Context, write: boolean): Promise<void> {
    requireAccess(ctx.actor.kind === "member");
    await principals(ctx, [ctx.actor.id]);
    await workspaces(
      ctx,
      [{ workspaceId: ctx.actor.id, memberId: ctx.actor.id }],
      write,
    );
  }
  async function requests(
    ctx: Context,
    ids: string[],
    write: boolean,
    memberId: string | null = null,
  ): Promise<RequestMeta[]> {
    return (
      await ctx.client.query<RequestMeta>(
        `SELECT ${metadataColumns} FROM support_requests r WHERE r.id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR r.member_id=$2) ORDER BY r.id FOR ${write ? "UPDATE" : "SHARE"} OF r`,
        [ids.slice().sort(), memberId],
      )
    ).rows;
  }
  async function ownRequest(
    ctx: Context,
    id: string,
    write: boolean,
  ): Promise<RequestMeta> {
    await owner(ctx, write);
    const rows = await requests(ctx, [id], write, ctx.actor.id);
    const row = rows[0];
    requireAccess(
      row && row.memberId === ctx.actor.id && row.workspaceId === ctx.actor.id,
    );
    return row;
  }
  async function grantRows(
    ctx: Context,
    ids: string[],
    write = false,
  ): Promise<GrantRow[]> {
    return (
      await ctx.client.query<GrantRow>(
        `SELECT ${grantColumns} FROM support_request_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? "UPDATE" : "SHARE"}`,
        [ids.slice().sort()],
      )
    ).rows;
  }
  type TimeCandidate = Candidate & { allocationId: string };
  async function timeScopes(
    ctx: Context,
    candidates: TimeCandidate[],
    write: boolean,
  ): Promise<RequestMeta[]> {
    requireAccess(ctx.actor.kind === "staff");
    const people = await principals(
      ctx,
      candidates.map((c) => c.memberId),
      [ctx.actor.id],
    );
    requireAccess(candidates.every((c) => people.get(c.memberId)!.active));
    ctx.deadlines.push(
      ...candidates.map((c) => people.get(c.memberId)!.expiresAt),
    );
    const roles = await profiles(ctx, [ctx.actor.id]),
      role = roles.get(ctx.actor.id);
    requireAccess(role === "operator" || role === "platform_admin");
    const grants = (
      await ctx.client.query<GrantRow & { allocationId: string }>(
        `SELECT ${grantColumns},allocation_id AS "allocationId" FROM support_time_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [candidates.map((c) => c.grantId).sort()],
      )
    ).rows;
    requireAccess(
      candidates.every((c) =>
        grants.some(
          (g) =>
            g.id === c.grantId &&
            g.requestId === c.requestId &&
            g.allocationId === c.allocationId &&
            g.staffId === ctx.actor.id &&
            g.role === role &&
            g.purpose === "support-time-local-v1" &&
            g.active,
        ),
      ),
    );
    ctx.deadlines.push(...grants.map((g) => g.expiresAt));
    if (write)
      await ctx.client.query(
        "SELECT pg_advisory_xact_lock(44154,hashtext($1))",
        [ctx.actor.id],
      );
    await workspaces(ctx, candidates, write);
    const rows = await requests(
      ctx,
      candidates.map((c) => c.requestId),
      write,
    );
    requireAccess(
      candidates.every((c) =>
        rows.some(
          (r) =>
            r.requestId === c.requestId &&
            r.memberId === c.memberId &&
            r.workspaceId === c.workspaceId,
        ),
      ),
    );
    // Scope deadlines can expire while workspace/request locks are awaited.
    // Revalidate before any time mutation reaches database transition guards.
    const current = (
      await ctx.client.query<{ valid: boolean }>(
        "SELECT bool_and(deadline>clock_timestamp()) AS valid FROM unnest($1::timestamptz[]) AS times(deadline)",
        [ctx.deadlines],
      )
    ).rows[0];
    requireAccess(current?.valid);
    return rows;
  }
  async function timeScope(
    ctx: Context,
    scope: SupportTimeScope,
    write: boolean,
  ): Promise<RequestMeta> {
    requireAccess(ctx.actor.kind === "staff");
    const discovered = (
      await ctx.client.query<TimeCandidate>(
        `SELECT r.id AS "requestId",r.member_id AS "memberId",r.workspace_id AS "workspaceId",g.id AS "grantId",g.allocation_id AS "allocationId"
      FROM support_time_grants g JOIN support_requests r ON r.id=g.request_id
      WHERE g.id=$1 AND g.request_id=$2 AND g.allocation_id=$3 AND g.staff_id=$4`,
        [scope.grantId, scope.requestId, scope.allocationId, ctx.actor.id],
      )
    ).rows[0];
    requireAccess(discovered);
    return (await timeScopes(ctx, [discovered], write))[0]!;
  }
  async function discover(
    ctx: Context,
    scope: SupportOperatorScope,
  ): Promise<Candidate> {
    requireAccess(ctx.actor.kind === "staff");
    const row = (
      await ctx.client.query<Candidate>(
        `SELECT r.id AS "requestId",r.member_id AS "memberId",r.workspace_id AS "workspaceId",g.id AS "grantId"
       FROM support_requests r JOIN support_request_grants g ON g.request_id=r.id
       WHERE r.id=$1 AND g.id=$2 AND g.staff_id=$3`,
        [scope.requestId, scope.grantId, ctx.actor.id],
      )
    ).rows[0];
    requireAccess(row);
    return row;
  }
  async function staffScope(
    ctx: Context,
    candidates: Candidate[],
    write: boolean,
  ): Promise<RequestMeta[]> {
    requireAccess(ctx.actor.kind === "staff");
    await principals(
      ctx,
      candidates.map((c) => c.memberId),
      [ctx.actor.id],
    );
    const roles = await profiles(ctx, [ctx.actor.id]),
      role = roles.get(ctx.actor.id);
    requireAccess(role === "operator" || role === "platform_admin");
    const grants = await grantRows(
      ctx,
      candidates.map((c) => c.grantId),
    );
    requireAccess(
      candidates.every((c) =>
        grants.some(
          (g) =>
            g.id === c.grantId &&
            g.requestId === c.requestId &&
            g.staffId === ctx.actor.id &&
            g.role === role &&
            g.purpose === purpose &&
            g.active,
        ),
      ),
    );
    ctx.deadlines.push(...grants.map((g) => g.expiresAt));
    await workspaces(ctx, candidates, write);
    const rows = await requests(
      ctx,
      candidates.map((c) => c.requestId),
      write,
    );
    requireAccess(
      candidates.every((c) =>
        rows.some(
          (r) =>
            r.requestId === c.requestId &&
            r.memberId === c.memberId &&
            r.workspaceId === c.workspaceId,
        ),
      ),
    );
    return rows;
  }
  type EffortCandidate = {
    requestId: string;
    grantId: string;
    allocationId: string;
  };
  async function connectedScope(
    ctx: Context,
    candidates: Candidate[],
    list: boolean,
  ) {
    requireAccess(ctx.actor.kind === "staff");
    // Identifiers only, one current association per request, including the
    // sentinel. No backfill if a discovered grant changes before its lock.
    const times = (
      await ctx.client.query<EffortCandidate>(
        `SELECT r.id AS "requestId",selected.id AS "grantId",selected.allocation_id AS "allocationId"
      FROM support_requests r JOIN LATERAL (
        SELECT g.id,g.allocation_id FROM support_time_grants g
        JOIN staff_profiles p ON p.principal_id=g.staff_id AND p.role=g.staff_role
        WHERE g.request_id=r.id AND g.staff_id=$2 AND g.purpose='support-time-local-v1'
        AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
        ORDER BY g.created_at DESC,g.id DESC LIMIT 1
      ) selected ON TRUE WHERE r.id=ANY($1::uuid[]) ORDER BY r.id`,
        [candidates.map((c) => c.requestId), ctx.actor.id],
      )
    ).rows;
    const people = await principals(
      ctx,
      candidates.map((c) => c.memberId),
      [ctx.actor.id],
    );
    requireAccess(candidates.every((c) => people.get(c.memberId)!.active));
    ctx.deadlines.push(
      ...candidates.map((c) => people.get(c.memberId)!.expiresAt),
    );
    const roles = await profiles(ctx, [ctx.actor.id]),
      role = roles.get(ctx.actor.id);
    requireAccess(role === "operator" || role === "platform_admin");
    const grants = await grantRows(
      ctx,
      candidates.map((c) => c.grantId),
    );
    requireAccess(
      candidates.every((c) =>
        grants.some(
          (g) =>
            g.id === c.grantId &&
            g.requestId === c.requestId &&
            g.staffId === ctx.actor.id &&
            g.role === role &&
            g.purpose === purpose &&
            g.active,
        ),
      ),
      list ? "unavailable" : "denied",
    );
    ctx.deadlines.push(...grants.map((g) => g.expiresAt));
    const timeGrants = (
      await ctx.client.query<GrantRow & { allocationId: string }>(
        `SELECT ${grantColumns},allocation_id AS "allocationId" FROM support_time_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [times.map((t) => t.grantId).sort()],
      )
    ).rows;
    requireAccess(
      times.every((t) =>
        timeGrants.some(
          (g) =>
            g.id === t.grantId &&
            g.requestId === t.requestId &&
            g.allocationId === t.allocationId &&
            g.staffId === ctx.actor.id &&
            g.role === role &&
            g.purpose === "support-time-local-v1" &&
            g.active,
        ),
      ),
      "unavailable",
    );
    ctx.deadlines.push(...timeGrants.map((g) => g.expiresAt));
    await workspaces(ctx, candidates, false);
    const rows = await requests(
      ctx,
      candidates.map((c) => c.requestId),
      false,
    );
    requireAccess(
      candidates.every((c) =>
        rows.some(
          (r) =>
            r.requestId === c.requestId &&
            r.memberId === c.memberId &&
            r.workspaceId === c.workspaceId &&
            (!list || !r.withdrawnAt),
        ),
      ),
      list ? "unavailable" : "denied",
    );
    const allocations = (
      await ctx.client.query<{
        id: string;
        requestId: string;
        memberId: string;
      }>(
        `SELECT id,request_id AS "requestId",member_id AS "memberId" FROM support_time_allocations WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [times.map((t) => t.allocationId).sort()],
      )
    ).rows;
    requireAccess(
      times.every((t) =>
        allocations.some(
          (a) =>
            a.id === t.allocationId &&
            a.requestId === t.requestId &&
            rows.some(
              (r) => r.requestId === a.requestId && r.memberId === a.memberId,
            ),
        ),
      ),
      "unavailable",
    );
    return { rows, grants, times };
  }
  async function operatorSummary(
    ctx: Context,
    value: SupportRequestSummary,
    candidate: Candidate,
    scope: Awaited<ReturnType<typeof connectedScope>>,
  ): Promise<SupportOperatorSummary> {
    const grant = scope.grants.find((g) => g.id === candidate.grantId)!;
    const time = scope.times.find((t) => t.requestId === candidate.requestId);
    const result: SupportOperatorSummary = {
      ...receipt(value),
      subject: value.subject,
      grantId: candidate.grantId,
      operatorContext: {
        observedAt: new Date(0),
        elapsedSeconds: 0,
        grantStartsAt: grant.startsAt,
        grantExpiresAt: grant.expiresAt,
        allowedActions: value.resolvedAt
          ? []
          : value.acknowledgedAt
            ? ["note", "reply", "resolve"]
            : ["acknowledge", "note", "reply", "resolve"],
      },
      ...(time
        ? {
            authorizedEffort: {
              ...(await supportTimeReceipt(ctx.client, time.allocationId)),
              ...time,
            },
          }
        : {}),
    };
    ctx.operatorReads!.push(result);
    return result;
  }
  async function content(
    ctx: Context,
    id: string,
  ): Promise<SupportRequestSummary & { body: string | null }> {
    return (
      await ctx.client.query<SupportRequestSummary & { body: string | null }>(
        `SELECT ${receiptColumns},r.subject,r.body FROM support_requests r WHERE r.id=$1`,
        [id],
      )
    ).rows[0]!;
  }
  async function event(
    ctx: Context,
    requestId: string,
    action: string,
    grantId: string | null = null,
    messageId: string | null = null,
  ): Promise<SupportMutationReceipt> {
    return (
      await ctx.client.query<SupportMutationReceipt>(
        `INSERT INTO support_request_events(id,request_id,actor_id,grant_id,action,message_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING request_id AS "requestId",id AS "eventId",occurred_at AS "occurredAt",message_id AS "messageId"`,
        [randomUUID(), requestId, ctx.actor.id, grantId, action, messageId],
      )
    ).rows[0]!;
  }
  async function messages(
    ctx: Context,
    id: string,
    staff: boolean,
    token: string,
    scope: string,
    after: Cursor | null,
  ): Promise<SupportPage<SupportOperatorMessage>> {
    // Parent locks make immutable children stable; members query replies only.
    const rows = (
      await ctx.client.query<SupportOperatorMessage & { cursorAt: string }>(
        `SELECT id,body,created_at AS "createdAt",kind,'Synthetic operator'::text AS attribution,${at("created_at")}
       FROM (SELECT id,body,created_at,'reply'::text AS kind FROM support_request_replies WHERE request_id=$1
       ${staff ? "UNION ALL SELECT id,body,created_at,'internal-note'::text AS kind FROM support_request_notes WHERE request_id=$1" : ""}) messages
       WHERE ($2::timestamptz IS NULL OR (created_at,id,kind)<($2::timestamptz,$3::uuid,$4::text))
       ORDER BY created_at DESC,id DESC,kind DESC LIMIT 21`,
        [id, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? ""],
      )
    ).rows;
    const selected = page(rows, token, scope, after, (r) => [r.id, r.kind]);
    return {
      items: selected.rows.map(({ cursorAt: _at, ...row }) => row),
      nextCursor: selected.nextCursor,
    };
  }
  async function transition(
    token: string,
    scope: SupportOperatorScope,
    key: string,
    action: "acknowledged" | "replied" | "noted" | "resolved",
    body?: string,
  ): Promise<SupportTransition> {
    if (!validScope(scope) || !uuid.test(key)) return { kind: "denied" };
    return run<SupportTransition>(token, async (ctx) => {
      const candidate = await discover(ctx, scope);
      const row = (await staffScope(ctx, [candidate], true))[0]!;
      if (row.withdrawnAt) return { kind: "withdrawn" };
      const existing = (
        await ctx.client.query<SupportMutationReceipt>(
          `SELECT request_id AS "requestId",event_id AS "eventId",message_id AS "messageId",occurred_at AS "occurredAt"
         FROM support_request_mutations WHERE request_id=$1 AND actor_id=$2 AND action=$3 AND idempotency_key=$4`,
          [scope.requestId, ctx.actor.id, action, key],
        )
      ).rows[0];
      if (row.resolvedAt)
        return action === "resolved" && existing
          ? { kind: "replayed", receipt: existing }
          : { kind: "conflict" };
      if (existing) {
        if (body !== undefined) {
          const saved = (
            await ctx.client.query<{ body: string }>(
              `SELECT body FROM ${action === "noted" ? "support_request_notes" : "support_request_replies"} WHERE id=$1 AND request_id=$2`,
              [existing.messageId, scope.requestId],
            )
          ).rows[0];
          if (saved?.body !== body) return { kind: "conflict" };
        }
        return { kind: "replayed", receipt: existing };
      }
      if (action === "acknowledged" && row.acknowledgedAt)
        return { kind: "conflict" };
      let messageId: string | null = null;
      if (action === "replied" || action === "noted") {
        messageId = randomUUID();
        await ctx.client.query(
          `INSERT INTO ${action === "noted" ? "support_request_notes" : "support_request_replies"}(id,request_id,actor_id,body) VALUES($1,$2,$3,$4)`,
          [messageId, scope.requestId, ctx.actor.id, body],
        );
      } else {
        const prefix = action === "acknowledged" ? "acknowledged" : "resolved";
        await ctx.client.query(
          `UPDATE support_requests SET ${prefix}_by=$2,${prefix}_at=clock_timestamp() WHERE id=$1`,
          [scope.requestId, ctx.actor.id],
        );
      }
      const receipt = await event(
        ctx,
        scope.requestId,
        action,
        scope.grantId,
        messageId,
      );
      await ctx.client.query(
        `INSERT INTO support_request_mutations(request_id,actor_id,action,idempotency_key,event_id,message_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          scope.requestId,
          ctx.actor.id,
          action,
          key,
          receipt.eventId,
          receipt.messageId,
          receipt.occurredAt,
        ],
      );
      return { kind: "applied", receipt };
    });
  }
  return {
    time: {
      writesEnabled: timeWrites,
      async cancel(token, requestId, allocationId) {
        if (!timeWrites) return { kind: "denied" };
        if (![requestId, allocationId].every((v) => uuid.test(v)))
          return { kind: "denied" };
        return run(token, async (ctx) => {
          await ownRequest(ctx, requestId, true);
          return cancelSupportTime(
            ctx.client,
            requestId,
            allocationId,
            ctx.actor.id,
            ctx.deadlines,
          );
        });
      },
      async operatorDetail(token, scope) {
        if (
          ![scope.requestId, scope.allocationId, scope.grantId].every((v) =>
            uuid.test(v),
          )
        )
          return { kind: "denied" };
        return run(token, async (ctx) => {
          await timeScope(ctx, scope, false);
          return {
            kind: "ready" as const,
            value: {
              ...(await supportTimeOperatorReceipt(
                ctx.client,
                ctx.actor.id,
                scope,
              )),
              ...(!timeWrites ? { canBegin: false, canRecord: false } : {}),
            },
          };
        });
      },
      async operatorWorklist(token, after) {
        return run(token, async (ctx) => {
          requireAccess(ctx.actor.kind === "staff");
          const scope = "support-time-worklist",
            previous = cursor(after, token, scope);
          const candidates = (
            await ctx.client.query<TimeCandidate>(
              `SELECT r.id AS "requestId",r.member_id AS "memberId",r.workspace_id AS "workspaceId",g.id AS "grantId",g.allocation_id AS "allocationId",${at("g.created_at")}
            FROM support_time_grants g JOIN support_requests r ON r.id=g.request_id
            JOIN principals p ON p.id=r.member_id AND p.kind='member'
            JOIN staff_profiles profile ON profile.principal_id=g.staff_id AND profile.role=g.staff_role
            WHERE g.staff_id=$1 AND g.purpose='support-time-local-v1' AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
            AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
            AND ($2::timestamptz IS NULL OR (g.created_at,g.id)<($2::timestamptz,$3::uuid))
            ORDER BY g.created_at DESC,g.id DESC LIMIT 21`,
              [ctx.actor.id, previous?.[0] ?? null, previous?.[1] ?? null],
            )
          ).rows;
          await timeScopes(ctx, candidates, false);
          const selected = page(candidates, token, scope, previous, (r) => [
            r.grantId,
            "",
          ]);
          const items = [];
          for (const c of selected.rows)
            items.push(
              await supportTimeOperatorReceipt(ctx.client, ctx.actor.id, c),
            );
          if (previous) requireAccess(previous[3] > Date.now());
          return {
            kind: "ready" as const,
            value: { items, nextCursor: selected.nextCursor },
          };
        });
      },
      async record(token, scope, key, intervals) {
        if (!timeWrites) return { kind: "denied" };
        if (
          ![scope.requestId, scope.allocationId, scope.grantId, key].every(
            (v) => uuid.test(v),
          ) ||
          !supportIntervalMinutes(intervals)
        )
          return { kind: "denied" };
        return run(token, async (ctx) => {
          await timeScope(ctx, scope, true);
          return recordSupportTime(
            ctx.client,
            ctx.actor.id,
            scope,
            key,
            intervals,
            ctx.deadlines,
          );
        });
      },
      async grant(token, input) {
        if (!timeWrites) return { kind: "denied" };
        if (
          ![
            input.requestId,
            input.allocationId,
            input.staffId,
            input.idempotencyKey,
          ].every((v) => uuid.test(v)) ||
          !["operator", "platform_admin"].includes(input.role) ||
          !(input.startsAt instanceof Date) ||
          !(input.expiresAt instanceof Date) ||
          !Number.isFinite(input.startsAt.valueOf()) ||
          !Number.isFinite(input.expiresAt.valueOf()) ||
          input.expiresAt <= input.startsAt
        )
          return { kind: "denied" };
        return run(token, async (ctx) => {
          requireAccess(ctx.actor.kind === "staff");
          const discovered = (
            await ctx.client.query<Candidate>(
              `SELECT r.member_id AS "memberId",r.workspace_id AS "workspaceId",r.id AS "requestId" FROM support_requests r JOIN support_time_allocations a ON a.request_id=r.id AND a.member_id=r.member_id WHERE r.id=$1 AND a.id=$2`,
              [input.requestId, input.allocationId],
            )
          ).rows[0];
          requireAccess(discovered);
          const people = await principals(
            ctx,
            [discovered.memberId],
            [ctx.actor.id, input.staffId],
            true,
          );
          const roles = await profiles(ctx, [ctx.actor.id, input.staffId]);
          requireAccess(
            roles.get(ctx.actor.id) === "platform_admin" &&
              roles.get(input.staffId) === input.role &&
              people.get(input.staffId)!.active &&
              people.get(discovered.memberId)!.active,
          );
          ctx.deadlines.push(
            people.get(input.staffId)!.expiresAt,
            people.get(discovered.memberId)!.expiresAt,
          );
          const existing = (
            await ctx.client.query<GrantRow & { allocationId: string }>(
              `SELECT ${grantColumns},allocation_id AS "allocationId" FROM support_time_grants WHERE granted_by=$1 AND idempotency_key=$2 FOR UPDATE`,
              [ctx.actor.id, input.idempotencyKey],
            )
          ).rows[0];
          await workspaces(ctx, [discovered], true);
          const row = (await requests(ctx, [input.requestId], true))[0];
          requireAccess(
            row &&
              row.memberId === discovered.memberId &&
              row.workspaceId === discovered.workspaceId,
          );
          const allocation = (
            await ctx.client.query<{ state: string }>(
              "SELECT state FROM support_time_allocations WHERE id=$1 AND request_id=$2 AND member_id=$3 FOR UPDATE",
              [input.allocationId, input.requestId, discovered.memberId],
            )
          ).rows[0];
          requireAccess(allocation);
          if (existing)
            return existing.requestId === input.requestId &&
              existing.allocationId === input.allocationId &&
              existing.staffId === input.staffId &&
              existing.role === input.role &&
              existing.startsAt.valueOf() === input.startsAt.valueOf() &&
              existing.expiresAt.valueOf() === input.expiresAt.valueOf() &&
              !existing.revokedAt
              ? { kind: "replayed" as const, grantId: existing.id }
              : { kind: "conflict" as const };
          if (row.withdrawnAt) return { kind: "withdrawn" as const };
          if (row.resolvedAt || allocation.state !== "allocated")
            return { kind: "conflict" as const };
          ctx.deadlines.push(input.expiresAt);
          const id = randomUUID();
          await ctx.client.query(
            "INSERT INTO support_time_grants(id,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              id,
              input.allocationId,
              input.requestId,
              input.staffId,
              input.role,
              input.startsAt,
              input.expiresAt,
              ctx.actor.id,
              input.idempotencyKey,
            ],
          );
          await ctx.client.query(
            "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'grant-created')",
            [
              randomUUID(),
              input.allocationId,
              discovered.memberId,
              ctx.actor.id,
            ],
          );
          return { kind: "created" as const, grantId: id };
        });
      },
      async revoke(token, id) {
        if (!timeWrites) return { kind: "denied" };
        if (!uuid.test(id)) return { kind: "denied" };
        return run(token, async (ctx) => {
          requireAccess(ctx.actor.kind === "staff");
          const discovered = (
            await ctx.client.query<
              Candidate & { staffId: string; allocationId: string }
            >(
              `SELECT g.request_id AS "requestId",g.staff_id AS "staffId",g.allocation_id AS "allocationId",r.member_id AS "memberId",r.workspace_id AS "workspaceId" FROM support_time_grants g JOIN support_requests r ON r.id=g.request_id WHERE g.id=$1`,
              [id],
            )
          ).rows[0];
          requireAccess(discovered);
          await principals(
            ctx,
            [discovered.memberId],
            [ctx.actor.id, discovered.staffId],
          );
          const roles = await profiles(ctx, [ctx.actor.id, discovered.staffId]);
          requireAccess(roles.get(ctx.actor.id) === "platform_admin");
          const grant = (
            await ctx.client.query<GrantRow & { allocationId: string }>(
              `SELECT ${grantColumns},allocation_id AS "allocationId" FROM support_time_grants WHERE id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          requireAccess(
            grant &&
              grant.requestId === discovered.requestId &&
              grant.staffId === discovered.staffId &&
              grant.allocationId === discovered.allocationId,
          );
          await workspaces(ctx, [discovered], true);
          const row = (await requests(ctx, [discovered.requestId], true))[0];
          requireAccess(
            row &&
              row.memberId === discovered.memberId &&
              row.workspaceId === discovered.workspaceId,
          );
          await ctx.client.query(
            "SELECT id FROM support_time_allocations WHERE id=$1 FOR UPDATE",
            [grant.allocationId],
          );
          if (grant.revokedAt) return { kind: "already-revoked" as const };
          await ctx.client.query(
            "UPDATE support_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
            [id],
          );
          await ctx.client.query(
            "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'grant-revoked')",
            [
              randomUUID(),
              grant.allocationId,
              discovered.memberId,
              ctx.actor.id,
            ],
          );
          return { kind: "revoked" as const };
        });
      },
      async begin(token, scope, key) {
        if (!timeWrites) return { kind: "denied" };
        if (
          ![scope.requestId, scope.allocationId, scope.grantId, key].every(
            (v) => uuid.test(v),
          )
        )
          return { kind: "denied" };
        return run(token, async (ctx) => {
          const row = await timeScope(ctx, scope, true);
          return beginSupportTime(
            ctx.client,
            ctx.actor.id,
            scope,
            row,
            key,
            ctx.deadlines,
          );
        });
      },
      async allocate(token, requestId, key, ceiling) {
        if (!timeWrites) return { kind: "denied" };
        if (
          !uuid.test(requestId) ||
          !uuid.test(key) ||
          !Number.isSafeInteger(ceiling) ||
          ceiling < 1 ||
          ceiling > 120
        )
          return { kind: "denied" };
        return run(token, async (ctx) => {
          const row = await ownRequest(ctx, requestId, true);
          return allocateSupportTime(
            ctx.client,
            row,
            key,
            ceiling,
            ctx.deadlines,
          );
        });
      },
      async receipt(token, requestId) {
        if (!uuid.test(requestId)) return { kind: "denied" };
        return run(token, async (ctx) => {
          await ownRequest(ctx, requestId, false);
          const latest = (
            await ctx.client.query<{ id: string }>(
              "SELECT id FROM support_time_allocations WHERE request_id=$1 AND member_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
              [requestId, ctx.actor.id],
            )
          ).rows[0];
          return {
            kind: "ready" as const,
            value: latest
              ? await supportTimeReceipt(ctx.client, latest.id)
              : null,
          };
        });
      },
    },
    async create(token, input) {
      for (const field of ["idempotencyKey", "subject", "body"] as const) {
        if (
          field === "idempotencyKey"
            ? !uuid.test(input[field])
            : !supportTextValid(input[field], field === "subject" ? 120 : 2000)
        )
          return { kind: "invalid", field };
      }
      return run(token, async (ctx) => {
        await owner(ctx, true);
        const existing = (
          await ctx.client.query<
            SupportRequestSummary & { body: string | null }
          >(
            `SELECT ${receiptColumns},r.subject,r.body FROM support_requests r WHERE r.member_id=$1 AND r.intake_key=$2 FOR UPDATE OF r`,
            [ctx.actor.id, input.idempotencyKey],
          )
        ).rows[0];
        if (existing?.withdrawnAt) return { kind: "withdrawn" as const };
        if (existing?.resolvedAt) return { kind: "conflict" as const };
        if (existing)
          return existing.subject === input.subject &&
            existing.body === input.body
            ? { kind: "replayed" as const, receipt: receipt(existing) }
            : { kind: "conflict" as const };
        const id = randomUUID();
        const saved = (
          await ctx.client.query<SupportReceipt>(
            `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body) VALUES($1,$2,$2,$3,$4,$5)
           RETURNING id AS "requestId",received_at AS "receivedAt",acknowledged_at AS "acknowledgedAt",resolved_at AS "resolvedAt",withdrawn_at AS "withdrawnAt",coverage_state AS "coverageState"`,
            [id, ctx.actor.id, input.idempotencyKey, input.subject, input.body],
          )
        ).rows[0]!;
        await event(ctx, id, "received");
        return { kind: "created" as const, receipt: saved };
      });
    },
    async receipt(token, key) {
      if (!uuid.test(key)) return { kind: "denied" };
      return run(token, async (ctx) => {
        await owner(ctx, false);
        const row = (
          await ctx.client.query<SupportReceipt>(
            `SELECT ${receiptColumns} FROM support_requests r WHERE r.member_id=$1 AND r.intake_key=$2 FOR SHARE OF r`,
            [ctx.actor.id, key],
          )
        ).rows[0];
        return row
          ? { kind: "found" as const, receipt: receipt(row) }
          : { kind: "missing" as const };
      });
    },
    async ownerHistory(token, after) {
      return run(token, async (ctx) => {
        const scope = "owner-history",
          previous = cursor(after, token, scope);
        await owner(ctx, false);
        const rows = (
          await ctx.client.query<SupportRequestSummary & { cursorAt: string }>(
            `SELECT ${receiptColumns},r.subject,${at("r.received_at")} FROM support_requests r
           WHERE r.member_id=$1 AND ($2::timestamptz IS NULL OR (r.received_at,r.id)<($2::timestamptz,$3::uuid))
           ORDER BY r.received_at DESC,r.id DESC LIMIT 21 FOR SHARE OF r`,
            [ctx.actor.id, previous?.[0] ?? null, previous?.[1] ?? null],
          )
        ).rows;
        const selected = page(rows, token, scope, previous, (r) => [
          r.requestId,
          "",
        ]);
        if (previous) requireAccess(previous[3] > Date.now());
        return {
          kind: "ready" as const,
          value: {
            items: selected.rows.map(({ cursorAt: _at, ...row }) => row),
            nextCursor: selected.nextCursor,
          },
        };
      });
    },
    async memberDetail(token, id, after) {
      if (!uuid.test(id)) return { kind: "denied" };
      return run(token, async (ctx) => {
        const scope = `member:${id}`,
          previous = cursor(after, token, scope);
        const row = await ownRequest(ctx, id, false);
        const detail = await content(ctx, id);
        const allocation = (
          await ctx.client.query<{ id: string }>(
            "SELECT id FROM support_time_allocations WHERE request_id=$1 AND member_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
            [id, ctx.actor.id],
          )
        ).rows[0];
        const supportTime = allocation
          ? await supportTimeReceipt(ctx.client, allocation.id)
          : undefined;
        const replies = row.withdrawnAt
          ? { items: [], nextCursor: null }
          : await messages(ctx, id, false, token, scope, previous);
        if (previous) requireAccess(previous[3] > Date.now());
        return {
          kind: "ready" as const,
          value: {
            ...detail,
            ...(supportTime ? { supportTime } : {}),
            replies: {
              ...replies,
              items: replies.items.map(({ kind: _kind, ...reply }) => reply),
            },
          },
        };
      });
    },
    async operatorWorklist(token, after) {
      return runOperator(token, async (ctx) => {
        const scope = "operator-worklist",
          previous = cursor(after, token, scope);
        requireAccess(ctx.actor.kind === "staff");
        const candidates = (
          await ctx.client.query<Candidate>(
            `SELECT r.id AS "requestId",r.member_id AS "memberId",r.workspace_id AS "workspaceId",selected.id AS "grantId",${at("r.received_at")}
           FROM support_requests r JOIN workspaces w ON w.id=r.workspace_id AND w.deleting_at IS NULL
           JOIN LATERAL (SELECT g.id FROM support_request_grants g JOIN staff_profiles p ON p.principal_id=g.staff_id AND p.role=g.staff_role
             WHERE g.request_id=r.id AND g.staff_id=$1 AND g.purpose=$4 AND g.revoked_at IS NULL
             AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp() ORDER BY g.id LIMIT 1) selected ON TRUE
           WHERE r.withdrawn_at IS NULL AND ($2::timestamptz IS NULL OR (r.received_at,r.id)<($2::timestamptz,$3::uuid))
           ORDER BY r.received_at DESC,r.id DESC LIMIT 21`,
            [
              ctx.actor.id,
              previous?.[0] ?? null,
              previous?.[1] ?? null,
              purpose,
            ],
          )
        ).rows;
        const connected = await connectedScope(ctx, candidates, true);
        const selected = page(candidates, token, scope, previous, (r) => [
          r.requestId,
          "",
        ]);
        const items: SupportOperatorSummary[] = [];
        for (const candidate of selected.rows) {
          const row = await content(ctx, candidate.requestId);
          items.push(await operatorSummary(ctx, row, candidate, connected));
          await event(
            ctx,
            candidate.requestId,
            "worklist-read",
            candidate.grantId,
          );
        }
        if (previous) requireAccess(previous[3] > Date.now());
        return {
          kind: "ready" as const,
          value: { items, nextCursor: selected.nextCursor },
        };
      });
    },
    async operatorDetail(token, input, after) {
      if (!validScope(input)) return { kind: "denied" };
      return runOperator(token, async (ctx) => {
        const scope = `operator:${input.requestId}:${input.grantId}`,
          previous = cursor(after, token, scope);
        const candidate = await discover(ctx, input);
        const connected = await connectedScope(ctx, [candidate], false);
        const row = connected.rows[0]!;
        if (row.withdrawnAt) return { kind: "withdrawn" as const };
        const detail = await content(ctx, row.requestId);
        const result = await messages(
          ctx,
          row.requestId,
          true,
          token,
          scope,
          previous,
        );
        await event(ctx, row.requestId, "detail-read", input.grantId);
        if (previous) requireAccess(previous[3] > Date.now());
        const summary = await operatorSummary(
          ctx,
          detail,
          candidate,
          connected,
        );
        return {
          kind: "ready" as const,
          value: { ...summary, body: detail.body!, messages: result },
        };
      });
    },
    acknowledge: (token, scope, key) =>
      transition(token, scope, key, "acknowledged"),
    resolve: (token, scope, key) => transition(token, scope, key, "resolved"),
    async reply(token, scope, key, body) {
      return supportTextValid(body, 2000)
        ? transition(token, scope, key, "replied", body)
        : { kind: "invalid", field: "body" };
    },
    async note(token, scope, key, body) {
      return supportTextValid(body, 2000)
        ? transition(token, scope, key, "noted", body)
        : { kind: "invalid", field: "body" };
    },
    async withdraw(token, id) {
      if (!uuid.test(id)) return { kind: "denied" };
      return run(token, async (ctx) => {
        const row = await ownRequest(ctx, id, true);
        if (row.withdrawnAt) return { kind: "already-withdrawn" as const };
        await ctx.client.query(
          "DELETE FROM support_request_notes WHERE request_id=$1",
          [id],
        );
        await ctx.client.query(
          "DELETE FROM support_request_replies WHERE request_id=$1",
          [id],
        );
        await ctx.client.query(
          "DELETE FROM support_request_mutations WHERE request_id=$1",
          [id],
        );
        await ctx.client.query(
          "UPDATE support_requests SET subject=NULL,body=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await event(ctx, id, "withdrawn");
        return { kind: "withdrawn" as const };
      });
    },
    async grant(token, input) {
      if (
        ![input.requestId, input.staffId, input.idempotencyKey].every((v) =>
          uuid.test(v),
        ) ||
        !["operator", "platform_admin"].includes(input.role) ||
        !(input.startsAt instanceof Date) ||
        !(input.expiresAt instanceof Date) ||
        !Number.isFinite(input.startsAt.valueOf()) ||
        !Number.isFinite(input.expiresAt.valueOf()) ||
        input.expiresAt <= input.startsAt
      )
        return { kind: "denied" };
      return run(token, async (ctx) => {
        requireAccess(ctx.actor.kind === "staff");
        const discovered = (
          await ctx.client.query<{ memberId: string; workspaceId: string }>(
            'SELECT member_id AS "memberId",workspace_id AS "workspaceId" FROM support_requests WHERE id=$1',
            [input.requestId],
          )
        ).rows[0];
        requireAccess(discovered);
        // Lock the administrator exclusively before discovering its absent
        // idempotency slot, including retries targeting different requests.
        const people = await principals(
          ctx,
          [discovered.memberId],
          [ctx.actor.id, input.staffId],
          true,
        );
        const roles = await profiles(ctx, [ctx.actor.id, input.staffId]);
        requireAccess(
          roles.get(ctx.actor.id) === "platform_admin" &&
            roles.get(input.staffId) === input.role &&
            people.get(input.staffId)!.active,
        );
        ctx.deadlines.push(
          people.get(input.staffId)!.expiresAt,
          input.expiresAt,
        );
        const existing = (
          await ctx.client.query<GrantRow>(
            `SELECT ${grantColumns} FROM support_request_grants WHERE granted_by=$1 AND idempotency_key=$2 ORDER BY id FOR UPDATE`,
            [ctx.actor.id, input.idempotencyKey],
          )
        ).rows[0];
        await workspaces(ctx, [discovered], true);
        const row = (await requests(ctx, [input.requestId], true))[0];
        requireAccess(
          row &&
            row.memberId === discovered.memberId &&
            row.workspaceId === discovered.workspaceId,
        );
        if (row.withdrawnAt) return { kind: "withdrawn" as const };
        if (existing)
          return sameSupportGrant(existing, input)
            ? { kind: "replayed" as const, grantId: existing.id }
            : { kind: "conflict" as const };
        const id = await createSupportGrantRecord(
          ctx.client,
          ctx.actor.id,
          input,
        );
        return { kind: "created" as const, grantId: id };
      });
    },
    async revoke(token, id) {
      if (!uuid.test(id)) return { kind: "denied" };
      return run(token, async (ctx) => {
        requireAccess(ctx.actor.kind === "staff");
        const discovered = (
          await ctx.client.query<Candidate & { staffId: string }>(
            `SELECT g.request_id AS "requestId",g.staff_id AS "staffId",r.member_id AS "memberId",r.workspace_id AS "workspaceId"
           FROM support_request_grants g JOIN support_requests r ON r.id=g.request_id WHERE g.id=$1`,
            [id],
          )
        ).rows[0];
        requireAccess(discovered);
        await principals(
          ctx,
          [discovered.memberId],
          [ctx.actor.id, discovered.staffId],
        );
        const roles = await profiles(ctx, [ctx.actor.id, discovered.staffId]);
        requireAccess(roles.get(ctx.actor.id) === "platform_admin");
        const grant = (await grantRows(ctx, [id], true))[0];
        requireAccess(
          grant &&
            grant.requestId === discovered.requestId &&
            grant.staffId === discovered.staffId,
        );
        await workspaces(ctx, [discovered], true);
        const row = (await requests(ctx, [discovered.requestId], true))[0];
        requireAccess(
          row &&
            row.memberId === discovered.memberId &&
            row.workspaceId === discovered.workspaceId,
        );
        if (grant.revokedAt) return { kind: "already-revoked" as const };
        await revokeSupportGrantRecord(
          ctx.client,
          ctx.actor.id,
          discovered.requestId,
          id,
        );
        return { kind: "revoked" as const };
      });
    },
  };
}
