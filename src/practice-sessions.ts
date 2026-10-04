import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import type { Goal } from "./content.ts";
import { hash } from "./store.ts";

export interface PracticeSessionSource {
  contentId: string;
  contentVersion: number;
  title: string;
  goal: Goal;
  promptVersion: string;
  prompt: string;
  sourceExcerpt: string;
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
export interface PracticeSessionExchange {
  sequence: number;
  response: string;
  comparison: string;
  sourceExcerpt: string;
  acceptedAt: Date;
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
}
export type PracticeSessionStart =
  | { kind: "started" | "replayed"; sessionId: string }
  | { kind: "unavailable" | "withdrawn" };
export type PracticeSessionAppend =
  "saved" | "replayed" | "conflict" | "full" | "withdrawn" | "unavailable";
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
const templates = {
  everyday:
    "Using an invented everyday example, write an instruction and explain what you would check against the lesson.",
  work: "Using an invented workplace example, write an instruction and explain what you would verify before using its result.",
  build:
    "Using an invented technical workflow, write an instruction and explain how you would test its result. No code is required.",
} as const;
const currentPrompt = "practice-v1";
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
  return version === currentPrompt ? templates[goal] : null;
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
export function practiceSessionStore(pool: Pool): PracticeSessionStore {
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
    return (
      await client.query<PracticeSessionExchange>(
        `SELECT sequence,response,comparison,source_excerpt AS "sourceExcerpt",accepted_at AS "acceptedAt"
       FROM private_practice_exchanges WHERE session_id=$1 ORDER BY sequence LIMIT 15`,
        [id],
      )
    ).rows;
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
          prompt: templates[row.goal],
          sourceExcerpt: excerpt(row.body),
        };
      });
    },
    async start(token, input) {
      if (
        !idPattern.test(input.contentId) ||
        !Number.isInteger(input.contentVersion) ||
        input.contentVersion < 1 ||
        input.contentVersion > 2147483647 ||
        !Object.hasOwn(templates, input.goal) ||
        input.promptVersion !== currentPrompt
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
        return {
          ...row,
          prompt: row.withdrawnAt ? null : instruction,
          availability,
          exchanges: pairs,
          nextSequence: availability === "available" ? pairs.length + 1 : null,
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
              "Compare the two yourself and identify a detail to verify. This deterministic comparison does not verify accuracy and cannot judge competence. Uncertainty remains; no qualified review has occurred.";
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
  };
}
