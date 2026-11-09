import { randomUUID } from "node:crypto";
import {
  aiCostPoints,
  estimateAiRequest,
  readAiUsage,
} from "./ai-budget-policy.ts";
import { requestFingerprint } from "./jobs.ts";
import { LOCAL_AI_MEMBER_OPEN_LIMIT } from "./local-ai-consent.ts";
import {
  deterministicPracticeSuggestionProvider,
  PRACTICE_SUGGESTION_MODEL,
  PRACTICE_SUGGESTION_OPERATION,
  PRACTICE_SUGGESTION_PROMPT,
  validatePracticeSuggestion,
  type PracticeSuggestionInput,
  type PracticeSuggestionProvider,
} from "./practice-ai-suggestions.ts";
import type { Pool } from "pg";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import type { Goal } from "./content.ts";
import { hash } from "./store.ts";
import { practiceSessionLedgerOnConnection } from "./ledger.ts";
import {
  interviewNotice,
  interviewPromptVersion,
} from "./practice-session-purpose.ts";

export interface PracticeSessionSource {
  contentId: string;
  contentVersion: number;
  title: string;
  goal: Goal;
  promptVersion: string;
  prompt: string;
  sourceExcerpt: string;
  // Optional, member-chosen interview practice for the same exact source.
  interview: { promptVersion: string; prompt: string };
}
export interface PracticeSessionSummary {
  id: string;
  contentId: string;
  contentVersion: number;
  goal: Goal;
  promptVersion: string;
  createdAt: Date;
  withdrawnAt: Date | null;
}
// #200 PRACTICE-AI: a request whose outcome was never recorded is "unknown"
// and is never retried.
export interface PracticeSuggestionView {
  state: "ready" | "rejected" | "unknown";
  text: string | null;
  requestedAt: Date;
}
export interface PracticeSessionExchange {
  sequence: number;
  response: string;
  comparison: string;
  sourceExcerpt: string;
  acceptedAt: Date;
  suggestion?: PracticeSuggestionView | null;
}
export interface PracticeSessionDetail extends PracticeSessionSummary {
  title: string;
  prompt: string | null;
  availability:
    | "available"
    | "source-unavailable"
    | "unknown-template"
    | "withdrawn"
    | "full";
  exchanges: PracticeSessionExchange[];
  nextSequence: number | null;
  /** Absent when simulated suggestions are off for this service. */
  suggestions?: "available" | "paused";
}
export type PracticeSessionStart =
  | { kind: "started" | "replayed"; sessionId: string }
  | { kind: "unavailable" | "withdrawn" | "allowance-needed" };
export type PracticeSessionAppend =
  "saved" | "replayed" | "conflict" | "full" | "withdrawn" | "unavailable";
export type PracticeSuggestionOutcome =
  | "ready"
  | "rejected"
  | "unknown"
  | "replayed"
  | "paused"
  | "limit"
  | "ceiling"
  | "withdrawn"
  | "unavailable";
export type PracticeSessionWithdrawal =
  "withdrawn" | "already-withdrawn" | "unavailable";
export interface PracticeSessionStore {
  source(
    token: string,
    contentId: string,
  ): Promise<PracticeSessionSource | null>;
  start(
    token: string,
    input: {
      contentId: string;
      contentVersion: number;
      goal: Goal;
      promptVersion: string;
    },
  ): Promise<PracticeSessionStart>;
  history(
    token: string,
    after?: string,
  ): Promise<{
    items: PracticeSessionSummary[];
    nextCursor: string | null;
  } | null>;
  detail(
    token: string,
    sessionId: string,
  ): Promise<PracticeSessionDetail | null>;
  append(
    token: string,
    sessionId: string,
    input: { expectedSequence: number; response: string },
  ): Promise<PracticeSessionAppend>;
  withdraw(
    token: string,
    sessionId: string,
  ): Promise<PracticeSessionWithdrawal>;
  suggest?(
    token: string,
    sessionId: string,
    sequence: number,
  ): Promise<PracticeSuggestionOutcome>;
}
export function disabledPracticeSessionStore(): PracticeSessionStore {
  return {
    source: async () => null,
    start: async () => ({ kind: "unavailable" }),
    history: async () => null,
    detail: async () => null,
    append: async () => "unavailable",
    withdraw: async () => "unavailable",
  };
}
// Published templates are immutable: future wording requires a new version.
const currentPrompt = "practice-v1";
const templates: Record<string, Record<Goal, string>> = {
  [currentPrompt]: {
    everyday:
      "Using an invented everyday example, write an instruction and explain what you would check against the lesson.",
    work: "Using an invented workplace example, write an instruction and explain what you would verify before using its result.",
    build:
      "Using an invented technical workflow, write an instruction and explain how you would test its result. No code is required.",
  },
  // Interview practice is only ever chosen by the member. It names no job,
  // employer or career, and nothing in it predicts an outcome.
  [interviewPromptVersion]: {
    everyday:
      "Answer an invented interview question about an everyday task you might explain to someone, then say what in the lesson you would check before answering.",
    work: "Answer an invented interview question about checking a piece of work before relying on it, then say what in the lesson you would verify first.",
    build:
      "Answer an invented interview question about testing a technical workflow, then say how the lesson helps you test it. No code is required.",
  },
};

const idPattern = /^[A-Z]{2,5}-[0-9]{3}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const summaryColumns = `s.id,s.content_id AS "contentId",s.content_version AS "contentVersion",
 s.goal_at_start AS goal,s.prompt_version AS "promptVersion",s.created_at AS "createdAt",s.withdrawn_at AS "withdrawnAt"`;
type SessionRow = PracticeSessionSummary & { title: string };
type SourceRow = {
  contentId: string;
  contentVersion: number;
  title: string;
  body: string;
  goal: Goal;
};
function prompt(version: string, goal: Goal): string | null {
  return Object.hasOwn(templates, version) &&
    Object.hasOwn(templates[version]!, goal)
    ? templates[version]![goal]
    : null;
}
function excerpt(body: string): string {
  return Array.from(body).slice(0, 600).join("");
}
function decodeCursor(after: string): [string, string] | null {
  if (after.length > 200 || !/^[A-Za-z0-9_-]+$/.test(after)) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(after, "base64url").toString("utf8"),
    );
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [at, id] = decoded as unknown[];
    if (
      typeof at !== "string" ||
      typeof id !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) ||
      !uuidPattern.test(id) ||
      new Date(at).toISOString() !== at.slice(0, 23) + "Z"
    )
      return null;
    return [at, id];
  } catch {
    return null;
  }
}
// The member's workspace lock serializes starts, and the grant lock holds the
// balance against an expiry sweep, so the last unit can only be used once.
async function allowanceUnit(client: PracticeTransaction, memberId: string) {
  return (
    (
      await client.query<{ claimId: string; grantId: string }>(
        `SELECT c.id AS "claimId",c.grant_id AS "grantId" FROM study_allowance_claims c
         JOIN synthetic_entitlement_grants g ON g.id=c.grant_id
         WHERE c.member_id=$1 AND c.category='mock_sessions'
           AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
           AND g.expired_at IS NULL AND g.available>0
         ORDER BY c.period_start DESC LIMIT 1 FOR UPDATE OF g`,
        [memberId],
      )
    ).rows[0] ?? null
  );
}
const PROVIDER_LIMIT_MS = 5000;
async function bounded(
  provider: PracticeSuggestionProvider,
  input: PracticeSuggestionInput,
  limit: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.suggest(input)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function practiceSessionStore(
  pool: Pool,
  options: {
    allowance?: boolean;
    // #200 PRACTICE-AI: on only with a local deterministic (or test) provider.
    suggestions?: {
      mode: "demo" | "test";
      provider?: PracticeSuggestionProvider;
      /** Tests only: a shorter wait before an unanswered call is unknown. */
      providerLimitMs?: number;
    };
  } = {},
): PracticeSessionStore {
  async function transaction<T>(
    token: string,
    use: (client: PracticeTransaction, memberId: string) => Promise<T>,
  ): Promise<T | null> {
    if (typeof token !== "string" || !token.trim()) return null;
    try {
      return await practiceTransaction(pool, async (client) => {
        const principal = (
          await client.query<{ id: string; expires_at: Date }>(
            `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='member'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) throw new PracticeLifetimeFailure("denied");
        await client.observe([principal.expires_at]);
        // Retain owner-operation serialization with withdrawal and deletion.
        const workspace = await client.query(
          `SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1
           AND deleting_at IS NULL FOR UPDATE`,
          [principal.id],
        );
        if (!workspace.rows[0]) throw new PracticeLifetimeFailure("denied");
        const result = await use(client, principal.id);
        await client.observe([principal.expires_at]);
        return result;
      });
    } catch (error) {
      if (error instanceof PracticeLifetimeFailure && error.kind === "denied")
        return null;
    }
    // Raw driver errors can contain private parameters; expose only this boundary.
    throw new Error("Practice session unavailable");
  }

  async function source(
    client: PracticeTransaction,
    memberId: string,
    contentId: string,
    version?: number,
  ): Promise<SourceRow | null> {
    await client.query("SELECT goal FROM learners WHERE id=$1 FOR SHARE", [
      memberId,
    ]);
    // Lock source versions before evaluating eligibility; publication/retirement
    // of existing versions cannot slip through a wait on the session row.
    await client.query(
      "SELECT id,version FROM content_versions WHERE id=$1 ORDER BY version FOR SHARE",
      [contentId],
    );
    return (
      (
        await client.query<SourceRow>(
          `SELECT cv.id AS "contentId",cv.version AS "contentVersion",cv.title,cv.body,l.goal
       FROM learners l JOIN content_versions cv ON cv.kind='lesson' AND cv.origin='curated'
       AND cv.state='published' AND NOT cv.requires_qualified_signoff
       AND member_content_eligible(l.id,cv.id,cv.version)
       WHERE l.id=$1 AND cv.id=$2 AND ($3::integer IS NULL OR cv.version=$3)`,
          [memberId, contentId, version ?? null],
        )
      ).rows[0] ?? null
    );
  }
  async function session(
    client: PracticeTransaction,
    memberId: string,
    id: string,
    lock: boolean,
  ): Promise<SessionRow | null> {
    return (
      (
        await client.query<SessionRow>(
          `SELECT ${summaryColumns},cv.title FROM private_practice_sessions s
       JOIN content_versions cv ON cv.id=s.content_id AND cv.version=s.content_version
       WHERE s.member_id=$1 AND s.id=$2 ${lock ? "FOR UPDATE OF s" : ""}`,
          [memberId, id],
        )
      ).rows[0] ?? null
    );
  }
  async function exchanges(
    client: PracticeTransaction,
    id: string,
  ): Promise<PracticeSessionExchange[]> {
    const rows = (
      await client.query<
        Omit<PracticeSessionExchange, "suggestion"> & {
          suggestionState: "requested" | "ready" | "rejected" | null;
          suggestionText: string | null;
          suggestionRequestedAt: Date | null;
        }
      >(
        `SELECT e.sequence,e.response,e.comparison,e.source_excerpt AS "sourceExcerpt",e.accepted_at AS "acceptedAt",
         g.state AS "suggestionState",g.suggestion AS "suggestionText",g.requested_at AS "suggestionRequestedAt"
       FROM private_practice_exchanges e
       LEFT JOIN practice_ai_suggestions g ON g.session_id=e.session_id AND g.sequence=e.sequence
       WHERE e.session_id=$1 ORDER BY e.sequence LIMIT 15`,
        [id],
      )
    ).rows;
    return rows.map(
      ({
        suggestionState,
        suggestionText,
        suggestionRequestedAt,
        ...pair
      }) => ({
        ...pair,
        suggestion: suggestionState
          ? {
              state:
                suggestionState === "requested" ? "unknown" : suggestionState,
              text: suggestionText,
              requestedAt: suggestionRequestedAt!,
            }
          : null,
      }),
    );
  }
  return {
    async source(token, contentId) {
      if (!idPattern.test(contentId)) return null;
      return transaction(token, async (client, memberId) => {
        const row = await source(client, memberId, contentId);
        if (!row) return null;
        return {
          contentId: row.contentId,
          contentVersion: row.contentVersion,
          title: row.title,
          goal: row.goal,
          promptVersion: currentPrompt,
          prompt: prompt(currentPrompt, row.goal)!,
          sourceExcerpt: excerpt(row.body),
          interview: {
            promptVersion: interviewPromptVersion,
            prompt: prompt(interviewPromptVersion, row.goal)!,
          },
        };
      });
    },
    async start(token, input) {
      if (
        !idPattern.test(input.contentId) ||
        !Number.isInteger(input.contentVersion) ||
        input.contentVersion < 1 ||
        input.contentVersion > 2147483647 ||
        typeof input.promptVersion !== "string" ||
        !prompt(input.promptVersion, input.goal)
      )
        return { kind: "unavailable" };
      return (
        (await transaction<PracticeSessionStart>(
          token,
          async (client, memberId) => {
            const row = await source(
              client,
              memberId,
              input.contentId,
              input.contentVersion,
            );
            const existing = (
              await client.query<{ id: string; withdrawnAt: Date | null }>(
                `SELECT id,withdrawn_at AS "withdrawnAt" FROM private_practice_sessions
           WHERE member_id=$1 AND content_id=$2 AND content_version=$3 AND goal_at_start=$4 AND prompt_version=$5 FOR UPDATE`,
                [
                  memberId,
                  input.contentId,
                  input.contentVersion,
                  input.goal,
                  input.promptVersion,
                ],
              )
            ).rows[0];
            if (existing?.withdrawnAt) return { kind: "withdrawn" };
            if (!row || row.goal !== input.goal) return { kind: "unavailable" };
            if (existing) return { kind: "replayed", sessionId: existing.id };
            const unit = options.allowance
              ? await allowanceUnit(client, memberId)
              : null;
            if (options.allowance && !unit) return { kind: "allowance-needed" };
            const id = randomUUID();
            await client.query(
              `INSERT INTO private_practice_sessions(id,member_id,content_id,content_version,goal_at_start,prompt_version)
          VALUES($1,$2,$3,$4,$5,$6)`,
              [
                id,
                memberId,
                input.contentId,
                input.contentVersion,
                input.goal,
                input.promptVersion,
              ],
            );
            if (unit) {
              const reservationId = await practiceSessionLedgerOnConnection(
                client,
              ).spend(memberId, unit.grantId, id);
              await client.query(
                `INSERT INTO practice_session_allowance_uses(session_id,member_id,claim_id,reservation_id)
                 VALUES($1,$2,$3,$4)`,
                [id, memberId, unit.claimId, reservationId],
              );
            }
            return { kind: "started", sessionId: id };
          },
        )) ?? { kind: "unavailable" }
      );
    },
    async history(token, after) {
      const cursor = after === undefined ? null : decodeCursor(after);
      if (after !== undefined && !cursor) return null;
      return transaction(token, async (client, memberId) => {
        const rows = (
          await client.query<PracticeSessionSummary & { cursorAt: string }>(
            `SELECT ${summaryColumns},to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
           FROM private_practice_sessions s WHERE s.member_id=$1
           AND ($2::timestamptz IS NULL OR (s.created_at,s.id)<($2::timestamptz,$3::uuid))
           ORDER BY s.created_at DESC,s.id DESC LIMIT 21 FOR UPDATE OF s`,
            [memberId, cursor?.[0] ?? null, cursor?.[1] ?? null],
          )
        ).rows;
        const items = rows
          .slice(0, 20)
          .map(({ cursorAt: _cursorAt, ...item }) => item);
        const last = rows[19];
        return {
          items,
          nextCursor:
            rows.length > 20
              ? Buffer.from(
                  JSON.stringify([last!.cursorAt, last!.id]),
                ).toString("base64url")
              : null,
        };
      });
    },
    async detail(token, id) {
      if (!uuidPattern.test(id)) return null;
      return transaction(token, async (client, memberId) => {
        const metadata = await session(client, memberId, id, false);
        if (!metadata) return null;
        const current = await source(
          client,
          memberId,
          metadata.contentId,
          metadata.contentVersion,
        );
        const row = (await session(client, memberId, id, true))!;
        const instruction = prompt(row.promptVersion, row.goal);
        const pairs = row.withdrawnAt ? [] : await exchanges(client, id);
        const availability = row.withdrawnAt
          ? "withdrawn"
          : !instruction
            ? "unknown-template"
            : !current || current.goal !== row.goal
              ? "source-unavailable"
              : pairs.length === 15
                ? "full"
                : "available";
        const paused =
          options.suggestions && !row.withdrawnAt
            ? (
                await client.query<{ paused: unknown }>(
                  "SELECT paused FROM local_ai_control WHERE singleton=true",
                )
              ).rows[0]?.paused !== false
            : null;
        return {
          ...row,
          prompt: row.withdrawnAt ? null : instruction,
          availability,
          exchanges: pairs,
          nextSequence: availability === "available" ? pairs.length + 1 : null,
          ...(paused === null
            ? {}
            : { suggestions: paused ? "paused" : "available" }),
        };
      });
    },
    async append(token, id, input) {
      if (
        !uuidPattern.test(id) ||
        !Number.isInteger(input.expectedSequence) ||
        input.expectedSequence < 1 ||
        input.expectedSequence > 16 ||
        typeof input.response !== "string" ||
        input.response.trim().length === 0 ||
        input.response.length > 1000
      )
        return "unavailable";
      return (
        (await transaction<PracticeSessionAppend>(
          token,
          async (client, memberId) => {
            const metadata = await session(client, memberId, id, false);
            if (!metadata) return "unavailable";
            const current = await source(
              client,
              memberId,
              metadata.contentId,
              metadata.contentVersion,
            );
            const row = (await session(client, memberId, id, true))!;
            if (row.withdrawnAt) return "withdrawn";
            if (
              !current ||
              current.goal !== row.goal ||
              !prompt(row.promptVersion, row.goal)
            )
              return "unavailable";
            const pairs = await exchanges(client, id);
            const previous = pairs.find(
              (pair) => pair.sequence === input.expectedSequence,
            );
            if (previous)
              return previous.response === input.response
                ? "replayed"
                : "conflict";
            if (pairs.length === 15) return "full";
            if (input.expectedSequence !== pairs.length + 1) return "conflict";
            const sourceExcerpt = excerpt(current.body);
            const comparison =
              `Simulation — unreviewed local comparison. Your paired words: “${input.response}”\n` +
              `Exact source excerpt (${row.contentId} v${row.contentVersion}): “${sourceExcerpt}”\n` +
              "Compare the two yourself and identify a detail to verify. This deterministic comparison does not verify accuracy and cannot judge competence. Uncertainty remains; no qualified review has occurred." +
              (row.promptVersion === interviewPromptVersion
                ? `\n${interviewNotice}`
                : "");
            await client.query(
              `INSERT INTO private_practice_exchanges(session_id,sequence,response,comparison,source_excerpt)
          VALUES($1,$2,$3,$4,$5)`,
              [
                id,
                input.expectedSequence,
                input.response,
                comparison,
                sourceExcerpt,
              ],
            );
            return "saved";
          },
        )) ?? "unavailable"
      );
    },
    async withdraw(token, id) {
      if (!uuidPattern.test(id)) return "unavailable";
      return (
        (await transaction<PracticeSessionWithdrawal>(
          token,
          async (client, memberId) => {
            const row = await session(client, memberId, id, true);
            if (!row) return "unavailable";
            if (row.withdrawnAt) return "already-withdrawn";
            await client.query(
              "DELETE FROM private_practice_exchanges WHERE session_id=$1",
              [id],
            );
            await client.query(
              "UPDATE private_practice_sessions SET withdrawn_at=clock_timestamp() WHERE id=$1",
              [id],
            );
            return "withdrawn";
          },
        )) ?? "unavailable"
      );
    },
    async suggest(token, id, sequence) {
      const settings = options.suggestions;
      if (
        !settings ||
        !uuidPattern.test(id) ||
        !Number.isInteger(sequence) ||
        sequence < 1 ||
        sequence > 15
      )
        return "unavailable";
      const provider =
        settings.provider ??
        deterministicPracticeSuggestionProvider(settings.mode);
      type Begun = {
        jobId: string;
        attemptToken: string;
        input: PracticeSuggestionInput;
      };
      const begun = await transaction<Begun | PracticeSuggestionOutcome>(
        token,
        async (client, memberId) => {
          const metadata = await session(client, memberId, id, false);
          if (!metadata) return "unavailable";
          const current = await source(
            client,
            memberId,
            metadata.contentId,
            metadata.contentVersion,
          );
          // The session lock serializes requests for its pairs, so one pair
          // gets at most one request however many arrive together.
          const row = (await session(client, memberId, id, true))!;
          if (row.withdrawnAt) return "withdrawn";
          const pair = (
            await client.query<{ response: string; sourceExcerpt: string }>(
              `SELECT response,source_excerpt AS "sourceExcerpt" FROM private_practice_exchanges
               WHERE session_id=$1 AND sequence=$2`,
              [id, sequence],
            )
          ).rows[0];
          if (!pair) return "unavailable";
          if (
            (
              await client.query(
                "SELECT 1 FROM practice_ai_suggestions WHERE session_id=$1 AND sequence=$2",
                [id, sequence],
              )
            ).rows[0]
          )
            return "replayed";
          // Only for the exact source version still eligible for this goal.
          if (
            !current ||
            current.goal !== row.goal ||
            !prompt(row.promptVersion, row.goal)
          )
            return "unavailable";
          const control = (
            await client.query<{ paused: unknown }>(
              "SELECT paused FROM local_ai_control WHERE singleton=true FOR SHARE",
            )
          ).rows[0];
          if (control?.paused !== false) return "paused";
          // #190: the same per-member lock and limit as sample requests.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('local-ai-member-open:'||$1::text,0))",
            [memberId],
          );
          const open = (
            await client.query<{ open: number }>(
              `SELECT count(*)::int AS open FROM adapter_jobs WHERE member_id=$1 AND adapter='ai'
               AND status IN ('pending','running','failed','needs_reconciliation')`,
              [memberId],
            )
          ).rows[0]!.open;
          if (open >= LOCAL_AI_MEMBER_OPEN_LIMIT) return "limit";
          const input: PracticeSuggestionInput = {
            response: pair.response,
            contentId: row.contentId,
            contentVersion: row.contentVersion,
            sourceExcerpt: pair.sourceExcerpt,
            interview: row.promptVersion === interviewPromptVersion,
          };
          // #188: the request counts against the platform test spending
          // ceiling. Locked last, so two requests for the last room serialize
          // and a ceiling without room creates nothing and calls nothing.
          const estimate = estimateAiRequest(
            Buffer.byteLength(input.response) +
              Buffer.byteLength(input.sourceExcerpt),
          );
          if (
            !(
              await client.query(
                `SELECT 1 FROM ai_test_spending_ceiling WHERE singleton AND rate_version=$2
                 AND committed_points+$1<=ceiling_points FOR UPDATE`,
                [estimate.costPoints, estimate.rateVersion],
              )
            ).rows[0]
          )
            return "ceiling";
          const jobId = randomUUID(),
            attemptToken = randomUUID();
          // One attempt only: an unknown outcome is held, never retried.
          await client.query(
            `INSERT INTO adapter_jobs(id,adapter,mode,operation,idempotency_key,request_fingerprint,
             status,attempt_count,max_attempts,attempt_token,lease_until,
             prompt_template_version,model_contract_version,member_id)
             VALUES($1,'ai',$2,$3,$4,$5,'running',1,1,$6,clock_timestamp()+INTERVAL '5 minutes',$7,$8,$9)`,
            [
              jobId,
              settings.mode,
              PRACTICE_SUGGESTION_OPERATION,
              `practice-suggestion:${id}:${sequence}`,
              requestFingerprint(input),
              attemptToken,
              PRACTICE_SUGGESTION_PROMPT,
              PRACTICE_SUGGESTION_MODEL,
              memberId,
            ],
          );
          await client.query(
            `INSERT INTO practice_ai_suggestions(session_id,sequence,member_id,job_id)
             VALUES($1,$2,$3,$4)`,
            [id, sequence, memberId, jobId],
          );
          // Committed before the provider call, at the labelled estimate.
          await client.query(
            `INSERT INTO ai_usage_estimates(job_id,member_id,rate_version,model_version,input_tokens,output_tokens,cost_points)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              jobId,
              memberId,
              estimate.rateVersion,
              estimate.modelVersion,
              estimate.inputTokens,
              estimate.outputTokens,
              estimate.costPoints,
            ],
          );
          await client.query(
            `INSERT INTO ai_spending_commitments(job_id,attempt,estimated_points,state)
             VALUES($1,1,$2,'committed')`,
            [jobId, estimate.costPoints],
          );
          return { jobId, attemptToken, input };
        },
      );
      if (begun === null) return "unavailable";
      if (typeof begun === "string") return begun;
      let raw: unknown,
        reached = true;
      try {
        raw = await bounded(
          provider,
          begun.input,
          settings.providerLimitMs ?? PROVIDER_LIMIT_MS,
        );
      } catch {
        reached = false;
      }
      const valid = reached
        ? validatePracticeSuggestion(raw, begun.input)
        : null;
      // Without reported usage the spend is unknown, so the estimate stays
      // committed; an error or timeout keeps it too.
      const usage = reached ? readAiUsage(raw) : null;
      try {
        return (
          (await transaction<PracticeSuggestionOutcome>(
            token,
            async (client, memberId) => {
              const job = (
                await client.query<{
                  status: string;
                  attempt_token: string | null;
                }>(
                  "SELECT status,attempt_token FROM adapter_jobs WHERE id=$1 AND member_id=$2 FOR UPDATE",
                  [begun.jobId, memberId],
                )
              ).rows[0];
              if (
                !job ||
                job.status !== "running" ||
                job.attempt_token !== begun.attemptToken
              )
                return "unknown";
              if (usage) {
                await client.query(
                  `INSERT INTO ai_usage_settlements(job_id,member_id,input_tokens,output_tokens,cost_points)
                   VALUES($1,$2,$3,$4,$5)`,
                  [
                    begun.jobId,
                    memberId,
                    usage.inputTokens,
                    usage.outputTokens,
                    aiCostPoints(usage),
                  ],
                );
                // The ceiling moves from the estimate to the reported cost,
                // including an overrun.
                await client.query(
                  `UPDATE ai_spending_commitments SET state='settled',actual_points=$2
                   WHERE job_id=$1 AND attempt=1 AND state='committed'`,
                  [begun.jobId, aiCostPoints(usage)],
                );
              }
              if (!reached) {
                await client.query(
                  `UPDATE adapter_jobs SET status='needs_reconciliation',safe_error='provider_outcome_unknown',
                   attempt_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,
                  [begun.jobId],
                );
                return "unknown";
              }
              if (!valid) {
                await client.query(
                  `UPDATE adapter_jobs SET status='exhausted',safe_error='invalid_provider_response',
                   attempt_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,
                  [begun.jobId],
                );
                await client.query(
                  `UPDATE practice_ai_suggestions SET state='rejected',completed_at=clock_timestamp()
                   WHERE job_id=$1`,
                  [begun.jobId],
                );
                return "rejected";
              }
              await client.query(
                `UPDATE adapter_jobs SET status='succeeded',safe_error=NULL,attempt_token=NULL,lease_until=NULL,
                 provider_operation_reference=$2,updated_at=clock_timestamp() WHERE id=$1`,
                [begun.jobId, valid.reference],
              );
              // Withdrawn meanwhile: the pair and its request row are gone, so
              // the answer is not kept anywhere.
              const kept = await client.query(
                `UPDATE practice_ai_suggestions SET state='ready',suggestion=$2,completed_at=clock_timestamp()
                 WHERE job_id=$1 RETURNING 1`,
                [begun.jobId, valid.text],
              );
              return kept.rows[0] ? "ready" : "withdrawn";
            },
          )) ?? "unknown"
        );
      } catch {
        return "unknown";
      }
    },
  };
}
