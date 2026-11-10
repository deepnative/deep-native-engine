import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  invoiceDate,
  invoiceDigest,
  invoiceUuid,
  parseInvoiceMoney,
  salesTaxCents,
  taxRate,
  type InvoiceTax,
} from "./simple-invoice-values.ts";
import { escape } from "./views.ts";
import type { CoachingTermsInvoiceView } from "./simple-invoice-store.ts";
import { SERVICE_CONTACT } from "./demo-terms.ts";
import { coachingAllowanceLedgerOnConnection } from "./ledger.ts";

// #316 owner decisions of 9 November 2026: an administrator sets each student's
// coaching price, length, renewal date and allowances. The student's own price
// covers the allowances. Saving terms turns expert review minutes and AI
// requests into ledger units for the coaching period (#27); coaching sessions
// stay an agreed number. Nothing here cancels (#319). No cancellation or refund
// rules; students contact info@deepnative.io. #317: renewal is the admin-set
// date only. Nothing renews or charges automatically; administrators see whose
// renewal date has passed or is near, and renew by saving new terms.

export interface CoachingTermsValues {
  priceCents: number;
  startsOn: string;
  endsOn: string;
  renewsOn: string;
  reviewMinutes: number;
  coachingSessions: number;
  aiRequests: number;
}
export interface AllowanceBalance {
  left: number;
  held: number;
  used: number;
}
export interface CoachingTerms extends CoachingTermsValues {
  version: number;
  savedAt: Date;
  /** #27: units for this period's allowances; null when none were recorded. */
  balances?: {
    reviewMinutes: AllowanceBalance;
    aiRequests: AllowanceBalance;
  } | null;
}
/** RENEW317-01: a student whose current renewal date has passed or is near. */
export interface RenewalDue {
  ownerId: string;
  displayName: string | null;
  renewsOn: string;
  /** Days from today (UTC) to the renewal date; negative when it has passed. */
  days: number;
}
/** How far ahead the renewals list looks. */
export const RENEWAL_WINDOW_DAYS = 30;
export type TermsFailure = {
  kind: "denied" | "invalid" | "conflict" | "unavailable";
};
export type TermsResult<T> = { kind: "ready"; value: T } | TermsFailure;
const fail = (kind: TermsFailure["kind"]): TermsFailure => ({ kind });

export const TERMS_FIELDS = [
  "price",
  "startsOn",
  "endsOn",
  "renewsOn",
  "reviewMinutes",
  "coachingSessions",
  "aiRequests",
] as const;
const LIMITS = {
  reviewMinutes: 100000,
  coachingSessions: 1000,
  aiRequests: 1000000,
};

function whole(value: unknown, maximum: number): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,6})$/.test(value))
    return null;
  const n = Number(value);
  return n <= maximum ? n : null;
}
/** TERMS316-04: a form's strings as terms, or null when any field is wrong. */
export function parseCoachingTerms(
  form: Record<string, unknown>,
): CoachingTermsValues | null {
  const priceCents = parseInvoiceMoney(form.price);
  const values = {
    priceCents: priceCents ?? 0,
    startsOn: form.startsOn,
    endsOn: form.endsOn,
    renewsOn: form.renewsOn,
    reviewMinutes: whole(form.reviewMinutes, LIMITS.reviewMinutes),
    coachingSessions: whole(form.coachingSessions, LIMITS.coachingSessions),
    aiRequests: whole(form.aiRequests, LIMITS.aiRequests),
  };
  return validTerms(values) ? values : null;
}
function validTerms(
  value: Record<string, unknown>,
): value is CoachingTermsValues & Record<string, unknown> {
  return (
    Number.isSafeInteger(value.priceCents) &&
    Number(value.priceCents) >= 1 &&
    Number(value.priceCents) <= 1_000_000_000 &&
    invoiceDate(value.startsOn) &&
    invoiceDate(value.endsOn) &&
    invoiceDate(value.renewsOn) &&
    value.endsOn >= value.startsOn &&
    value.renewsOn >= value.startsOn &&
    (["reviewMinutes", "coachingSessions", "aiRequests"] as const).every(
      (key) =>
        Number.isSafeInteger(value[key]) &&
        Number(value[key]) >= 0 &&
        Number(value[key]) <= LIMITS[key],
    )
  );
}

const columns = `version,price_cents AS "priceCents",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(ends_on,'YYYY-MM-DD') AS "endsOn",to_char(renews_on,'YYYY-MM-DD') AS "renewsOn",review_minutes AS "reviewMinutes",coaching_sessions AS "coachingSessions",ai_requests AS "aiRequests",created_at AS "savedAt"`;

// #27: the ledger categories two of the allowances draw from. Review-time
// allocations reserve review_minutes; metered AI requests reserve study_requests.
const ALLOWANCE_UNITS = [
  ["review_minutes", "reviewMinutes"],
  ["study_requests", "aiRequests"],
] as const;
const GRANT_LIMIT = 100_000;
// Coaching grants of this student and category whose period overlaps [from, to].
const overlapping = `SELECT g.id,(c.starts_on=$3::date AND c.ends_on=$4::date) AS same,
 g.available,g.reserved,g.consumed,(g.expired_at IS NULL AND g.expires_at>clock_timestamp()) AS live
 FROM coaching_allowance_grants c JOIN synthetic_entitlement_grants g ON g.id=c.grant_id
 WHERE c.owner_id=$1 AND c.category=$2 AND c.starts_on<=$4::date AND c.ends_on>=$3::date`;
interface OverlapRow {
  id: string;
  same: boolean;
  available: number;
  reserved: number;
  consumed: number;
  live: boolean;
}

/**
 * ALLOW27-01..06, 08: make this period's units match the saved allowance. The
 * caller holds the student's terms lock in the same transaction.
 * - Units of an overlapping, different period (a date correction) that are
 *   still unused are written off.
 * - Units already held or used in the overlapping periods count towards the
 *   new number; only the remainder is granted, in grants of at most 100,000.
 * - A lower number writes off unused units of this period, never used ones.
 * A period that has ended, or a student whose account isn't active, gets none.
 */
async function matchAllowances(
  tx: PracticeTransaction,
  ownerId: string,
  termsId: string,
  terms: CoachingTermsValues,
) {
  const window = (
    await tx.query<{ starts: Date; expires: Date; open: boolean }>(
      `SELECT ($1::date::timestamp AT TIME ZONE 'America/Toronto') AS starts,
       (($2::date+1)::timestamp AT TIME ZONE 'America/Toronto') AS expires,
       (($2::date+1)::timestamp AT TIME ZONE 'America/Toronto')>clock_timestamp()
        AND EXISTS(SELECT 1 FROM principals WHERE id=$3 AND kind='member'
         AND revoked_at IS NULL AND expires_at>clock_timestamp()) AS open`,
      [terms.startsOn, terms.endsOn, ownerId],
    )
  ).rows[0]!;
  if (!window.open) return;
  const ledger = coachingAllowanceLedgerOnConnection(tx);
  const writeOff = (row: OverlapRow, quantity: number) =>
    ledger.adjust(
      ownerId,
      row.id,
      quantity,
      `coaching-allowance-writeoff:${termsId}:${row.id}`,
    );
  for (const [category, field] of ALLOWANCE_UNITS) {
    const rows = (
      await tx.query<OverlapRow>(
        `${overlapping} ORDER BY g.expires_at DESC,c.created_at DESC,g.id FOR UPDATE OF g`,
        [ownerId, category, terms.startsOn, terms.endsOn],
      )
    ).rows;
    let inUse = 0;
    for (const row of rows) {
      if (row.live && !row.same && row.available > 0) {
        await writeOff(row, row.available);
        row.available = 0;
      }
      inUse += row.reserved + row.consumed + (row.live ? row.available : 0);
    }
    let excess = inUse - terms[field];
    for (const row of rows) {
      if (excess <= 0) break;
      if (!row.live || !row.same || row.available === 0) continue;
      const quantity = Math.min(excess, row.available);
      await writeOff(row, quantity);
      excess -= quantity;
    }
    for (let part = 0, missing = terms[field] - inUse; missing > 0; part++) {
      const quantity = Math.min(missing, GRANT_LIMIT);
      const grantId = await ledger.grant(
        ownerId,
        category,
        quantity,
        `coaching-allowance:${termsId}:${category}:${part}`,
        {
          startsAt: window.starts.toISOString(),
          expiresAt: window.expires.toISOString(),
        },
      );
      await tx.query(
        "INSERT INTO coaching_allowance_grants(grant_id,owner_id,terms_id,category,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6)",
        [grantId, ownerId, termsId, category, terms.startsOn, terms.endsOn],
      );
      missing -= quantity;
    }
  }
}

/** ALLOW27-07: what's left, held and used of the current period's units. */
async function allowanceBalances(
  tx: PracticeTransaction,
  ownerId: string,
  terms: CoachingTerms,
): Promise<CoachingTerms["balances"]> {
  const balances: AllowanceBalance[] = [];
  let recorded = false;
  for (const [category] of ALLOWANCE_UNITS) {
    const rows = (
      await tx.query<OverlapRow>(overlapping, [
        ownerId,
        category,
        terms.startsOn,
        terms.endsOn,
      ])
    ).rows;
    recorded ||= rows.length > 0;
    balances.push(
      rows.reduce(
        (sum, row) => ({
          left: sum.left + (row.live ? row.available : 0),
          held: sum.held + row.reserved,
          used: sum.used + row.consumed,
        }),
        { left: 0, held: 0, used: 0 },
      ),
    );
  }
  return recorded
    ? { reviewMinutes: balances[0]!, aiRequests: balances[1]! }
    : null;
}

export function coachingTermsStore(pool: Pool) {
  async function run<T>(
    token: string,
    admin: boolean,
    use: (tx: PracticeTransaction, actor: string) => Promise<TermsResult<T>>,
  ): Promise<TermsResult<T>> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return fail("denied");
    try {
      return await practiceTransaction(pool, async (tx) => {
        const actor = (
          await tx.query<{ id: string; kind: string; expires: Date }>(
            "SELECT id,kind,expires_at AS expires FROM principals WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
            [hash(token)],
          )
        ).rows[0];
        if (!actor || actor.kind !== (admin ? "staff" : "member"))
          throw new PracticeLifetimeFailure("denied");
        await tx.observe([actor.expires]);
        if (admin) {
          const role = (
            await tx.query<{ role: string }>(
              "SELECT role FROM authorized_staff_profiles WHERE principal_id=$1 FOR SHARE",
              [actor.id],
            )
          ).rows[0];
          if (role?.role !== "platform_admin")
            throw new PracticeLifetimeFailure("denied");
        }
        const result = await use(tx, actor.id);
        await tx.observe([actor.expires]);
        return result;
      });
    } catch (error) {
      return fail(
        error instanceof PracticeLifetimeFailure && error.kind === "denied"
          ? "denied"
          : "unavailable",
      );
    }
  }
  async function student(tx: PracticeTransaction, id: string) {
    const found = await tx.query(
      "SELECT 1 FROM principals p JOIN learners l ON l.id=p.id JOIN workspaces w ON w.id=p.id AND w.owner_principal_id=p.id AND w.deleting_at IS NULL WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL FOR SHARE OF p",
      [id],
    );
    if (!found.rowCount) throw new PracticeLifetimeFailure("denied");
  }
  const current = async (tx: PracticeTransaction, ownerId: string) =>
    (
      await tx.query<CoachingTerms>(
        `SELECT ${columns} FROM coaching_terms WHERE owner_id=$1 ORDER BY version DESC LIMIT 1`,
        [ownerId],
      )
    ).rows[0] ?? null;
  const withBalances = async (tx: PracticeTransaction, ownerId: string) => {
    const terms = await current(tx, ownerId);
    return terms
      ? { ...terms, balances: await allowanceBalances(tx, ownerId, terms) }
      : null;
  };
  return {
    /** TERMS316-06: the signed-in student's own current terms. */
    async own(token: string): Promise<TermsResult<CoachingTerms | null>> {
      return run(token, false, async (tx, actor) => ({
        kind: "ready",
        value: await withBalances(tx, actor),
      }));
    },
    /** A platform administrator reads one student's current terms. */
    async forStudent(
      token: string,
      ownerId: string,
    ): Promise<TermsResult<CoachingTerms | null>> {
      if (!invoiceUuid(ownerId)) return fail("invalid");
      return run(token, true, async (tx) => {
        await student(tx, ownerId);
        return { kind: "ready", value: await withBalances(tx, ownerId) };
      });
    },
    /** RENEW317-01/02: current renewal dates that have passed or fall within
     * the window, oldest first. Read-only: it renews and charges nothing. */
    async renewalsDue(token: string): Promise<TermsResult<RenewalDue[]>> {
      return run(token, true, async (tx) => ({
        kind: "ready",
        value: (
          await tx.query<RenewalDue>(
            `SELECT t.owner_id AS "ownerId",l.display_name AS "displayName",to_char(t.renews_on,'YYYY-MM-DD') AS "renewsOn",(t.renews_on-d.today)::integer AS days FROM (SELECT DISTINCT ON (owner_id) owner_id,renews_on FROM coaching_terms ORDER BY owner_id,version DESC) t JOIN principals p ON p.id=t.owner_id AND p.kind='member' AND p.revoked_at IS NULL JOIN learners l ON l.id=p.id JOIN workspaces w ON w.id=p.id AND w.owner_principal_id=p.id AND w.deleting_at IS NULL CROSS JOIN (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS today) d WHERE t.renews_on<=d.today+${RENEWAL_WINDOW_DAYS} ORDER BY t.renews_on,t.owner_id LIMIT 200`,
          )
        ).rows,
      }));
    },
    /** TERMS316-01..05: a new immutable version, refused when the form is stale. */
    async save(
      token: string,
      input: CoachingTermsValues & {
        ownerId: string;
        expectedVersion: number;
        operationId: string;
      },
    ): Promise<TermsResult<{ version: number }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !invoiceUuid(input.operationId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        !validTerms(input as unknown as Record<string, unknown>)
      )
        return fail("invalid");
      const terms: CoachingTermsValues = {
        priceCents: input.priceCents,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        renewsOn: input.renewsOn,
        reviewMinutes: input.reviewMinutes,
        coachingSessions: input.coachingSessions,
        aiRequests: input.aiRequests,
      };
      const digest = invoiceDigest({
        ownerId: input.ownerId,
        expectedVersion: input.expectedVersion,
        terms,
      });
      return run(token, true, async (tx, actor) => {
        await student(tx, input.ownerId);
        const earlier = (
          await tx.query<{ digest: string; version: number }>(
            "SELECT digest,version FROM coaching_terms WHERE actor_id=$1 AND operation_id=$2",
            [actor, input.operationId],
          )
        ).rows[0];
        if (earlier)
          return earlier.digest === digest
            ? { kind: "ready", value: { version: earlier.version } }
            : fail("conflict");
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtext('coaching_terms:' || $1))",
          [input.ownerId],
        );
        const version = (await current(tx, input.ownerId))?.version ?? 0;
        if (version !== input.expectedVersion) return fail("conflict");
        const termsId = randomUUID();
        await tx.query(
          "INSERT INTO coaching_terms(id,owner_id,version,price_cents,starts_on,ends_on,renews_on,review_minutes,coaching_sessions,ai_requests,actor_id,operation_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            termsId,
            input.ownerId,
            version + 1,
            terms.priceCents,
            terms.startsOn,
            terms.endsOn,
            terms.renewsOn,
            terms.reviewMinutes,
            terms.coachingSessions,
            terms.aiRequests,
            actor,
            input.operationId,
            digest,
          ],
        );
        await matchAllowances(tx, input.ownerId, termsId, terms);
        return { kind: "ready", value: { version: version + 1 } };
      });
    },
  };
}
export type CoachingTermsStore = ReturnType<typeof coachingTermsStore>;

const money = (cents: number) =>
  `CAD ${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const readable = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-CA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
export const NO_CANCELLATION = `There are no cancellation or refund rules. To ask about changes, contact <a href="mailto:${SERVICE_CONTACT}">${SERVICE_CONTACT}</a>.`;

const NO_AUTOMATIC_RENEWAL = "Nothing renews or charges automatically.";
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
function renewalState(n: number) {
  return n < 0
    ? `${days(-n)} overdue`
    : n === 0
      ? "due today"
      : `due in ${days(n)}`;
}
/** RENEW317-01/03: administrators' list of renewals that have passed or are near. */
export function renewalsSection(rows: RenewalDue[], path: string) {
  return `<section class="portal-card" aria-labelledby="renewals-due"><h2 id="renewals-due">Renewals due</h2><p>Students whose renewal date has passed or is within ${RENEWAL_WINDOW_DAYS} days. ${NO_AUTOMATIC_RENEWAL} To renew, open the student and save new terms.</p><ul class="portal-list">${rows.map((r) => `<li><a href="${path}/${escape(r.ownerId)}">${escape(r.displayName ?? "Name needed")}</a> · renewal date ${readable(r.renewsOn)} · ${renewalState(r.days)}</li>`).join("") || `<li>No renewal dates have passed or fall within the next ${RENEWAL_WINDOW_DAYS} days.</li>`}</ul>${rows.length >= 200 ? "<p>Showing the first 200 students.</p>" : ""}</section>`;
}
function termsList(t: CoachingTerms) {
  return `<dl class="coaching-terms"><dt>Price</dt><dd>${money(t.priceCents)}</dd><dt>Coaching period</dt><dd>${readable(t.startsOn)} to ${readable(t.endsOn)}</dd><dt>Renewal date</dt><dd>${readable(t.renewsOn)}</dd><dt>Expert review time</dt><dd>${t.reviewMinutes} minutes</dd><dt>Coaching sessions</dt><dd>${t.coachingSessions}</dd><dt>AI requests</dt><dd>${t.aiRequests}</dd></dl>`;
}
/** ALLOW27-07: the period's units, for the student and the administrator. */
function balanceList(t: CoachingTerms, admin: boolean) {
  if (!t.balances) return "";
  const line = (
    label: string,
    b: AllowanceBalance,
    total: number,
    unit: string,
  ) =>
    `<dt>${label}</dt><dd>${b.left} of ${total}${unit} left, ${b.held} held, ${b.used} used</dd>`;
  return `<h3>Allowances left this period</h3><dl class="coaching-allowances">${line("Expert review time", t.balances.reviewMinutes, t.reviewMinutes, " minutes")}${line("AI requests", t.balances.aiRequests, t.aiRequests, "")}</dl><p>${admin ? "Coaching sessions aren't counted as units; the student arranges them with their coach." : "Coaching sessions are arranged with your coach and aren't counted here."}</p>`;
}
/** TERMS316-06: what the student sees, read-only. */
export function memberTermsSection(t: CoachingTerms | null) {
  return `<section class="portal-card" aria-labelledby="coaching-terms"><h2 id="coaching-terms">Your coaching terms</h2>${t ? `${termsList(t)}${balanceList(t, false)}<p>Your administrator set these terms. Your coaching price covers these allowances.</p><p>${NO_AUTOMATIC_RENEWAL} To renew, contact <a href="mailto:${SERVICE_CONTACT}">${SERVICE_CONTACT}</a>.</p>` : "<p>Your administrator hasn't set your coaching terms yet.</p>"}<p>${NO_CANCELLATION}</p></section>`;
}
/** COURSETERMS557-01/02: the student's coaching terms in brief, on My courses. */
export function courseTermsSection(t: CoachingTerms | null | "unavailable") {
  const body =
    t === "unavailable"
      ? "<p>Your coaching terms can't be shown right now.</p>"
      : t
        ? `<p>Coaching period ${readable(t.startsOn)} to ${readable(t.endsOn)} · Renewal date ${readable(t.renewsOn)} · Price ${money(t.priceCents)}</p><p>Your administrator set these terms. ${NO_AUTOMATIC_RENEWAL} To renew or ask about changes, contact <a href="mailto:${SERVICE_CONTACT}">${SERVICE_CONTACT}</a>.</p>`
        : "<p>Your administrator hasn't set your coaching terms. Your learning and enrollment don't depend on them.</p>";
  return `<section aria-labelledby="course-coaching"><h2 id="course-coaching">Your coaching</h2><p>Enrolling in a program is free. Coaching is arranged separately and invoiced.</p>${body}<p><a href="/account/coaching">Coaching terms, allowances and hours</a></p></section>`;
}
/** TERMS316-01: current terms and the form an administrator saves a new version with. */
export function adminTermsSection(
  t: CoachingTerms | null,
  action: string,
  hiddenFields: string,
) {
  const value = (key: keyof CoachingTermsValues) =>
    t
      ? escape(
          key === "priceCents"
            ? (t.priceCents / 100).toFixed(2)
            : String(t[key]),
        )
      : "";
  const field = (
    name: (typeof TERMS_FIELDS)[number],
    label: string,
    attributes: string,
    key: keyof CoachingTermsValues,
  ) =>
    `<label>${label}<input name="${name}" ${attributes} value="${value(key)}" required></label>`;
  return `<section class="portal-card" aria-labelledby="coaching-terms"><h2 id="coaching-terms">Coaching terms</h2>${t ? `<p>Current terms, version ${t.version}:</p>${termsList(t)}${balanceList(t, true)}<p>${NO_AUTOMATIC_RENEWAL} To renew, save new terms with the next renewal date.</p>` : "<p>No coaching terms are set for this student.</p>"}<p>The student's coaching price covers these allowances. ${NO_CANCELLATION}</p><h3>Set coaching terms</h3><p>Saving creates a new version. Earlier versions are kept.</p><form method="post" action="${action}">${hiddenFields}${field("price", "Price (CAD)", 'inputmode="decimal"', "priceCents")}${field("startsOn", "Start date", 'type="date"', "startsOn")}${field("endsOn", "End date", 'type="date"', "endsOn")}${field("renewsOn", "Renewal date", 'type="date"', "renewsOn")}${field("reviewMinutes", "Expert review minutes", 'type="number" min="0" max="100000" step="1"', "reviewMinutes")}${field("coachingSessions", "Coaching sessions", 'type="number" min="0" max="1000" step="1"', "coachingSessions")}${field("aiRequests", "AI requests", 'type="number" min="0" max="1000000" step="1"', "aiRequests")}<button>Save coaching terms</button></form></section>`;
}

/**
 * TERMSINV318-01/03: issue one invoice for the current terms version, to the
 * student's saved billing recipient. Configured invoices compute HST; sample
 * mode asks for an invented tax. Payment is recorded on the invoice later.
 */
export function adminTermsInvoiceSection(
  v: CoachingTermsInvoiceView,
  action: string,
  hiddenFields: string,
  tax: InvoiceTax | undefined,
  sample: boolean,
) {
  const head = `<section class="portal-card" aria-labelledby="terms-invoice"><h2 id="terms-invoice">Invoice these coaching terms</h2>`;
  if (!v.terms)
    return `${head}<p>Set coaching terms first. An invoice is issued for one terms version.</p></section>`;
  if (v.invoiceId)
    return `${head}<p>Terms version ${v.terms.version} is invoiced. <a href="/operator/invoices/${escape(v.invoiceId)}">View invoice</a>. Record the offline payment on the invoice when it arrives. To issue it again, void that invoice first.</p></section>`;
  if (!v.recipient)
    return `${head}<p role="status">This student hasn't saved a billing recipient yet. Ask them to save one on their Billing recipient page before you issue an invoice for these terms.</p></section>`;
  const to = `${escape(v.recipient.name)}${v.recipient.company ? ` · ${escape(v.recipient.company)}` : ""} · ${escape(v.recipient.email)}`;
  const amount = tax
    ? `${money(v.terms.priceCents)} plus ${escape(tax.label)} (${taxRate(tax)}) ${money(salesTaxCents(v.terms.priceCents, tax))}, total ${money(v.terms.priceCents + salesTaxCents(v.terms.priceCents, tax))}`
    : `${money(v.terms.priceCents)} plus the ${sample ? "invented sample" : "explicit"} tax below`;
  // TERMSINV318-08: a corrected version must not look unbilled.
  const earlier = v.earlier
    .map(
      (e) =>
        `<p role="status">Terms version ${e.version} covers an overlapping coaching period (${readable(e.startsOn)} to ${readable(e.endsOn)}) and is already invoiced: <a href="/operator/invoices/${escape(e.invoiceId)}">view that invoice</a>. Issue another invoice only if the student owes both. To replace the earlier invoice, void it first.</p>`,
    )
    .join("");
  return `${head}${earlier}<p>Issue an invoice for terms version ${v.terms.version}: ${amount}, to ${to}.</p><p>${sample ? "SAMPLE · NOT PAYABLE. All sample amounts and tax are invented." : "Issuing doesn't take payment. The student pays offline, and you record the payment on the invoice."}</p><form method="post" action="${action}">${hiddenFields}${tax ? "" : `<label>${sample ? "Invented sample tax (CAD)" : "Explicit tax amount (CAD)"}<input name="tax" inputmode="decimal" ${sample ? 'value="0.00"' : ""} required></label>`}<label class="check"><input type="checkbox" name="confirm" value="terms-invoice" required><span>I checked this terms version, amount and recipient.</span></label><button>Issue invoice for these terms</button></form></section>`;
}
