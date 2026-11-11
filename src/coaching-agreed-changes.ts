import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  activeStudent,
  coachingRun,
  type TermsResult,
} from "./coaching-terms.ts";
import {
  invoiceDigest,
  invoiceText,
  invoiceUuid,
} from "./simple-invoice-values.ts";
import type { PracticeTransaction } from "./practice-session-lifetime.ts";
import { escape } from "./views.ts";
import { SERVICE_CONTACT } from "./demo-terms.ts";

// #94 under the owner's 9 and 10 November 2026 decisions: there are no
// automatic cancellation or refund rules. A student contacts
// info@deepnative.io; when staff and the student agree a change, a platform
// administrator records what was agreed and why. Records are append-only and
// change nothing by themselves: an agreed early end is saved as new coaching
// terms, and an agreed refund is recorded on its invoice.

export const AGREED_KINDS = ["early_release", "refund", "other"] as const;
export type AgreedKind = (typeof AGREED_KINDS)[number];
export const AGREED_FIELDS = ["kind", "agreed", "reason", "confirm"] as const;
export const AGREED_TEXT_LIMIT = 1000;
/** How many records a page lists, newest first. */
export const AGREED_LIST_LIMIT = 200;
export interface AgreedChangeValues {
  kind: AgreedKind;
  agreed: string;
  reason: string;
}
export interface AgreedChange extends AgreedChangeValues {
  recordedAt: Date;
}
const KIND_LABELS: Record<AgreedKind, string> = {
  early_release: "Early release",
  refund: "Refund",
  other: "Other change",
};

/** AGREED94-04: the posted form, or null when anything is missing or malformed. */
export function parseAgreedChange(body: unknown): AgreedChangeValues | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (
    b.confirm !== "agreed-change" ||
    !AGREED_KINDS.includes(b.kind as AgreedKind) ||
    !invoiceText(b.agreed, AGREED_TEXT_LIMIT) ||
    !invoiceText(b.reason, AGREED_TEXT_LIMIT)
  )
    return null;
  return {
    kind: b.kind as AgreedKind,
    agreed: b.agreed.trim(),
    reason: b.reason.trim(),
  };
}

const columns = `kind,agreed,reason,created_at AS "recordedAt"`;

export function coachingAgreedChangesStore(pool: Pool) {
  const list = async (tx: PracticeTransaction, ownerId: string) =>
    (
      await tx.query<AgreedChange>(
        `SELECT ${columns} FROM coaching_agreed_changes WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT ${AGREED_LIST_LIMIT}`,
        [ownerId],
      )
    ).rows;
  return {
    /** AGREED94-03: the signed-in student's own records, without staff identity. */
    async own(token: string): Promise<TermsResult<AgreedChange[]>> {
      return coachingRun(pool, token, false, async (tx, actor) => ({
        kind: "ready",
        value: await list(tx, actor),
      }));
    },
    /** A platform administrator reads one student's records. */
    async forStudent(
      token: string,
      ownerId: string,
    ): Promise<TermsResult<AgreedChange[]>> {
      if (!invoiceUuid(ownerId)) return { kind: "invalid" };
      return coachingRun(pool, token, true, async (tx) => {
        await activeStudent(tx, ownerId);
        return { kind: "ready", value: await list(tx, ownerId) };
      });
    },
    /** AGREED94-01/02/04/05: append one record; a replay is the same record. */
    async record(
      token: string,
      input: AgreedChangeValues & { ownerId: string; operationId: string },
    ): Promise<TermsResult<{ id: string }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !invoiceUuid(input.operationId) ||
        !AGREED_KINDS.includes(input.kind) ||
        !invoiceText(input.agreed, AGREED_TEXT_LIMIT) ||
        !invoiceText(input.reason, AGREED_TEXT_LIMIT)
      )
        return { kind: "invalid" };
      const values: AgreedChangeValues = {
        kind: input.kind,
        agreed: input.agreed.trim(),
        reason: input.reason.trim(),
      };
      const digest = invoiceDigest({
        action: "agreed-change",
        ownerId: input.ownerId,
        values,
      });
      return coachingRun<{ id: string }>(
        pool,
        token,
        true,
        async (tx, actor) => {
          await activeStudent(tx, input.ownerId);
          const earlier = (
            await tx.query<{ id: string; digest: string }>(
              "SELECT id,digest FROM coaching_agreed_changes WHERE actor_id=$1 AND operation_id=$2",
              [actor, input.operationId],
            )
          ).rows[0];
          if (earlier)
            return earlier.digest === digest
              ? { kind: "ready", value: { id: earlier.id } }
              : { kind: "conflict" };
          const id = randomUUID();
          await tx.query(
            "INSERT INTO coaching_agreed_changes(id,owner_id,kind,agreed,reason,actor_id,operation_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              input.ownerId,
              values.kind,
              values.agreed,
              values.reason,
              actor,
              input.operationId,
              digest,
            ],
          );
          return { kind: "ready", value: { id } };
        },
      );
    },
  };
}
export type CoachingAgreedChangesStore = ReturnType<
  typeof coachingAgreedChangesStore
>;

const recorded = (at: Date) =>
  at.toLocaleDateString("en-CA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Toronto",
  });
function records(rows: AgreedChange[], none: string) {
  return `<ul class="portal-list agreed-changes">${
    rows
      .map(
        (r) =>
          `<li><strong>${KIND_LABELS[r.kind]}</strong> · recorded ${recorded(r.recordedAt)}<p>Agreed: ${escape(r.agreed)}</p><p>Reason: ${escape(r.reason)}</p></li>`,
      )
      .join("") || `<li>${none}</li>`
  }</ul>${rows.length >= AGREED_LIST_LIMIT ? `<p>Showing the latest ${AGREED_LIST_LIMIT} records.</p>` : ""}`;
}
const NO_AUTOMATIC_RULES = "No cancellation or refund happens automatically.";

/** AGREED94-03: what the student sees, read-only. */
export function memberAgreedSection(rows: AgreedChange[]) {
  return `<section class="portal-card" aria-labelledby="agreed-changes"><h2 id="agreed-changes">Changes agreed with you</h2><p>${NO_AUTOMATIC_RULES} To ask to end coaching early, for a refund or for another change, contact <a href="mailto:${SERVICE_CONTACT}">${SERVICE_CONTACT}</a>. What you and our staff agree is recorded here.</p>${records(rows, "No agreed changes are recorded.")}</section>`;
}
/** AGREED94-01: the student's records and the form an administrator adds one with. */
export function adminAgreedSection(
  rows: AgreedChange[],
  action: string,
  hiddenFields: string,
) {
  return `<section class="portal-card" aria-labelledby="agreed-changes"><h2 id="agreed-changes">Changes agreed with this student</h2><p>${NO_AUTOMATIC_RULES} The student contacts ${SERVICE_CONTACT}. Record here what you and the student agreed, and why.</p>${records(rows, "No agreed changes are recorded for this student.")}<h3>Record an agreed change</h3><p>A record is kept as written and can't be edited or removed; the student sees it. Recording changes nothing else: to end coaching early, also save new coaching terms with the agreed end date, and to refund, also record the refund on its invoice.</p><form method="post" action="${action}">${hiddenFields}<label>Kind of change<select name="kind" required>${AGREED_KINDS.map((k) => `<option value="${k}">${KIND_LABELS[k]}</option>`).join("")}</select></label><label>What was agreed<textarea name="agreed" maxlength="${AGREED_TEXT_LIMIT}" rows="3" required></textarea></label><label>Reason<textarea name="reason" maxlength="${AGREED_TEXT_LIMIT}" rows="3" required></textarea></label><label class="check"><input type="checkbox" name="confirm" value="agreed-change" required><span>This is what the student and staff agreed.</span></label><button>Record agreed change</button></form></section>`;
}
