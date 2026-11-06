import type { PoolClient } from "pg";
import { portalActions } from "./backend-portal-presentation.ts";
import { escape } from "./views.ts";

export const CHANGE_HISTORY_PAGE = 30;

export type ChangeEntry = {
  source: "billing" | "role";
  action: string;
  at: Date;
  /** The administrator; `actorFound` is false once their account is gone. */
  actorFound: boolean;
  actorName: string | null;
  /** The member affected; `personFound` is false once their account is gone. */
  personFound: boolean;
  personName: string | null;
  /** The role holder, known by their verified email's account. */
  holderFound: boolean;
  holderName: string | null;
  role: string | null;
  month: string | null;
  amountCents: number | null;
};
export type ChangeHistory = { entries: ChangeEntry[]; older: string | null };
export type ChangeHistoryResult =
  | { kind: "ready"; value: ChangeHistory }
  | { kind: "invalid" }
  | { kind: "denied" | "unavailable" };

// Selects no email, hash, token, staff ID or reason, so the page can't show one.
const HISTORY = `
WITH events AS (
  SELECT 'role' AS source,id,occurred_at,actor_id,action,role,email_hash,learner_id AS member_id,NULL::text AS month,NULL::bigint AS amount_cents
    FROM account_role_events
  UNION ALL
  SELECT 'billing',id,occurred_at,actor_id,action,NULL,NULL,member_id,month,amount_cents
    FROM billing_change_events
)
SELECT e.source,e.id::text AS id,e.action,e.occurred_at AS at,e.role,e.month,
  e.amount_cents::integer AS "amountCents",
  to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key,
  actor.id IS NOT NULL AS "actorFound",actor.display_name AS "actorName",
  person.id IS NOT NULL AS "personFound",person.display_name AS "personName",
  holder.id IS NOT NULL AS "holderFound",holder.display_name AS "holderName"
FROM events e
LEFT JOIN administrator_sessions s ON s.staff_id=e.actor_id
LEFT JOIN learners actor ON actor.id=s.member_id
LEFT JOIN learners person ON person.id=e.member_id
LEFT JOIN LATERAL (
  SELECT l.id,l.display_name FROM member_email_identities i
    JOIN learners l ON l.id=i.principal_id
   WHERE i.email_hash=e.email_hash ORDER BY l.id LIMIT 1
) holder ON true
WHERE $1::timestamptz IS NULL OR (e.occurred_at,e.source,e.id)<($1::timestamptz,$2::text,$3::bigint)
ORDER BY e.occurred_at DESC,e.source DESC,e.id DESC LIMIT $4`;

const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(billing|role)\|(\d{1,18})$/;

function position(before: string | undefined) {
  if (before === undefined) return [null, null, null];
  const match = CURSOR.exec(Buffer.from(before, "base64url").toString());
  return match && !Number.isNaN(Date.parse(match[1]!))
    ? [match[1]!, match[2]!, match[3]!]
    : null;
}

/** #40 CHANGELOG-02/11: both logs, newest first; the caller has checked the administrator. */
export async function readChangeHistory(
  tx: PoolClient,
  before: string | undefined,
): Promise<Extract<ChangeHistoryResult, { kind: "ready" | "invalid" }>> {
  const from = position(before);
  if (!from) return { kind: "invalid" };
  const found = await tx.query<ChangeEntry & { id: string; key: string }>(
    HISTORY,
    [...from, CHANGE_HISTORY_PAGE + 1],
  );
  const rows = found.rows.slice(0, CHANGE_HISTORY_PAGE);
  const last = rows[CHANGE_HISTORY_PAGE - 1];
  return {
    kind: "ready",
    value: {
      entries: rows.map(({ id: _id, key: _key, ...entry }) => entry),
      older:
        found.rows.length > CHANGE_HISTORY_PAGE
          ? Buffer.from(`${last!.key}|${last!.source}|${last!.id}`).toString(
              "base64url",
            )
          : null,
    },
  };
}

const NAMELESS = "someone with no name set";
const money = (cents: number | null) =>
  cents === null ? "" : ` of CAD ${(cents / 100).toFixed(2)}`;
const roleName = (role: string | null) =>
  role === "admin" ? "Admin" : role === "coach" ? "Coach" : "staff";

function actorText(entry: ChangeEntry) {
  if (!entry.actorFound) return "A former administrator";
  return entry.actorName
    ? escape(entry.actorName)
    : "An administrator with no name set";
}
function personText(entry: ChangeEntry) {
  if (!entry.personFound) return "a deleted account";
  return entry.personName ? escape(entry.personName) : NAMELESS;
}
function holderText(entry: ChangeEntry) {
  if (!entry.holderFound) return "an email not linked to an account";
  return entry.holderName ? escape(entry.holderName) : NAMELESS;
}

/** One plain sentence, so a later kind of record still shows rather than vanishing. */
export function changeText(entry: ChangeEntry) {
  const who = actorText(entry),
    person = personText(entry),
    holder = holderText(entry),
    month = entry.month ? escape(entry.month) : "";
  const change: Record<string, string> = {
    "role:granted": `gave ${holder} the ${roleName(entry.role)} role`,
    "role:removed": `removed the ${roleName(entry.role)} role from ${holder}`,
    "role:assigned": `made ${holder} a coach for ${person}`,
    "role:cleared": `removed ${holder} as a coach for ${person}`,
    "billing:plan_offered": `offered ${person} a course plan${money(entry.amountCents)}`,
    "billing:rate_set": `set the coaching rate for ${person} to${money(entry.amountCents).replace(" of", "")} per hour from ${month}`,
    "billing:hours_returned": `returned the coaching hours for ${person} for ${month}`,
    "billing:coaching_invoice_issued": `issued ${person} a coaching invoice${money(entry.amountCents)} for ${month}`,
    "billing:monthly_invoice_issued": `issued ${person} a monthly invoice${money(entry.amountCents)}`,
    "billing:payment_recorded": `recorded a payment${money(entry.amountCents)} from ${person}`,
    "billing:invoice_voided": `voided an invoice${money(entry.amountCents)} for ${person}`,
  };
  return `${who} ${change[`${entry.source}:${entry.action}`] ?? "made a change"}.`;
}

const when = (at: Date) =>
  `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function changeHistoryBody(history: ChangeHistory, first: boolean) {
  const items = history.entries
    .map(
      (entry) =>
        `<li><time datetime="${entry.at.toISOString()}">${when(entry.at)}</time><br>${changeText(entry)}</li>`,
    )
    .join("");
  return `<div class="portal-page"><div class="portal-intro"><h1>Change history</h1><p>Who changed a role, a learner's coaches or someone's billing, and when, newest first. Entries can't be edited, and they stay when an account is deleted.</p></div><section class="portal-card" aria-labelledby="change-entries"><h2 id="change-entries">Changes</h2>${
    items
      ? `<ul>${items}</ul>`
      : `<p role="status">${first ? "No changes are recorded." : "There are no older entries."}</p>`
  }${
    history.older
      ? `<p><a href="/operator/changes?before=${encodeURIComponent(history.older)}">Older entries</a></p>`
      : ""
  }</section><section class="portal-card" aria-labelledby="change-covers"><h2 id="change-covers">What this covers</h2><p>Roles and coach assignments, offering plans, setting coaching rates, returning hours, issuing invoices, recording payments and voiding invoices.</p><p>It doesn't list what members do themselves, invoices the scheduled run creates, or invoices being emailed. It doesn't list time-limited staff access to a member's work. Members see that under When staff opened my work.</p><p>Issuing invoices, returning hours and setting rates are listed only from when this history began. Older records didn't say who did them.</p></section><div class="portal-footer">${portalActions(
    [
      ["/operator/roles", "Roles"],
      ["/operator", "Administration console"],
    ],
  )}</div></div>`;
}
