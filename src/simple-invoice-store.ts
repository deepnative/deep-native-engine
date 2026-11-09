import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  invoiceCents,
  invoiceDate,
  invoiceEvidence,
  invoiceDigest,
  invoicePeriod,
  invoiceText,
  invoiceTotal,
  invoiceUuid,
  validInvoiceTerms,
  type InvoiceTerms,
} from "./simple-invoice-values.ts";
import { normalizedEmail } from "./member-email-access.ts";
import type { SimpleInvoiceDocument } from "./simple-invoice-views.ts";

import {
  coachingMonth,
  coachingMinutes,
  coachingSubtotal,
  type CoachingRate,
  type CoachingMonth,
  type CoachingSnapshot,
} from "./coaching-values.ts";

export type InvoiceFailure = {
  kind: "denied" | "invalid" | "conflict" | "unavailable" | "not-found";
};
export type InvoiceResult<T> = { kind: "ready"; value: T } | InvoiceFailure;
export interface InvoicePlan {
  id: string;
  ownerId: string;
  terms: InvoiceTerms;
  state: "offered" | "active" | "cancelled";
  revision: number;
  nextCycle: number;
}
type BillingChangeAction =
  | "plan_offered"
  | "rate_set"
  | "hours_returned"
  | "coaching_invoice_issued"
  | "monthly_invoice_issued"
  | "payment_recorded"
  | "payment_refunded"
  | "invoice_voided";
export interface StoredInvoice {
  id: string;
  document: SimpleInvoiceDocument;
  totalCents: number;
  paidCents: number;
  refundedCents?: number;
  revision: number;
  voidReason: string | null;
  delivery: "not_sent" | "sending" | "sent" | "unconfirmed";
  payments?: InvoicePaymentEvent[];
  /** SVC: present only on a sample invoice that signed test events reached. */
  service?: SampleService;
}
export type SampleService =
  | { state: "awaiting_payment" }
  | { state: "ready" | "withdrawn"; since: string };
/** Staff-entered or a signed test event. Never a payment-provider confirmation. */
export interface InvoicePaymentEvent {
  kind: "receipt" | "refund" | "failure" | "held";
  amountCents: number;
  on: string;
  evidence: string | null;
  verification: "manual_unverified" | "signed_test_event";
  recordedBy?: string;
}
export interface InvoiceOverview {
  plans: InvoicePlan[];
  invoices: StoredInvoice[];
  /** UTC date on the database clock; an offer closes once its start passes. */
  today: string;
}
export interface InvoiceSettings {
  sample: boolean;
  issuer: string;
  instructions: string;
}
const fail = (kind: InvoiceFailure["kind"]): InvoiceFailure => ({ kind });
async function utcToday(tx: PracticeTransaction) {
  return (
    await tx.query<{ today: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
    )
  ).rows[0]!.today;
}
const planColumns =
  'id,owner_id AS "ownerId",terms,state,revision,next_cycle AS "nextCycle"';
const invoiceColumns =
  'id,document,total_cents AS "totalCents",paid_cents AS "paidCents",refunded_cents AS "refundedCents",revision,delivery,void_reason AS "voidReason"';
const decodeInvoice = (row: StoredInvoice): StoredInvoice => ({
  ...row,
  totalCents: Number(row.totalCents),
  paidCents: Number(row.paidCents),
  refundedCents: Number(row.refundedCents ?? 0),
  document: {
    ...row.document,
    paidCents: Number(row.paidCents),
    ...(Number(row.refundedCents ?? 0)
      ? { refundedCents: Number(row.refundedCents) }
      : {}),
    ...(row.voidReason ? { voidReason: row.voidReason } : {}),
  },
});
export type CoachingStatus =
  "not_started" | "draft" | "returned" | "submitted" | "invoiced" | "voided";
/** Calendar arithmetic on YYYY-MM strings. */
/** A saved coaching month as listed in the Saved months table. */
export interface SavedCoachingMonth {
  month: string;
  state: string;
  minutes: number;
  returned?: boolean;
  submittedCents?: number | string | null;
  invoiceId?: string | null;
  totalCents?: string | null;
  paidCents?: string | null;
  refundedCents?: string | null;
  voided?: boolean;
}

export function shiftMonth(month: string, by: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}
export function simpleInvoiceStore(pool: Pool, settings: InvoiceSettings) {
  async function run<T>(
    token: string,
    admin: boolean,
    use: (
      tx: PracticeTransaction,
      actor: string,
      expiry: Date,
    ) => Promise<InvoiceResult<T>>,
  ): Promise<InvoiceResult<T>> {
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
        const result = await use(tx, actor.id, actor.expires);
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
  async function owner(tx: PracticeTransaction, id: string, durable = false) {
    const row = (
      await tx.query<{ expires: Date }>(
        "SELECT p.expires_at AS expires FROM principals p JOIN learners l ON l.id=p.id WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL AND ($2::boolean OR p.expires_at>clock_timestamp()) FOR SHARE OF p",
        [id, durable],
      )
    ).rows[0];
    if (!row) throw new PracticeLifetimeFailure("denied");
    if (!durable) await tx.observe([row.expires]);
    const w = await tx.query(
      "SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE",
      [id],
    );
    if (!w.rowCount) throw new PracticeLifetimeFailure("denied");
  }
  async function replay<T>(
    tx: PracticeTransaction,
    actor: string,
    key: string,
    digest: string,
  ): Promise<InvoiceResult<T> | null> {
    const previous = (
      await tx.query<{ digest: string; result: T }>(
        "SELECT digest,result FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2",
        [actor, key],
      )
    ).rows[0];
    return previous
      ? previous.digest === digest
        ? { kind: "ready", value: previous.result }
        : fail("conflict")
      : null;
  }
  async function remember<T>(
    tx: PracticeTransaction,
    actor: string,
    key: string,
    digest: string,
    value: T,
  ): Promise<InvoiceResult<T>> {
    await tx.query(
      "INSERT INTO simple_invoice_operations(actor_id,operation_id,digest,result) VALUES($1,$2,$3,$4)",
      [actor, key, digest, JSON.stringify(value)],
    );
    return { kind: "ready", value };
  }
  /** #40 CHANGELOG-04: inside the change's transaction, so neither happens alone. */
  const logChange = (
    tx: PracticeTransaction,
    actor: string,
    action: BillingChangeAction,
    change: { memberId: string; month?: string; amountCents?: number },
  ) =>
    tx.query(
      "INSERT INTO billing_change_events(actor_id,action,member_id,month,amount_cents) VALUES($1,$2,$3,$4,$5)",
      [
        actor,
        action,
        change.memberId,
        change.month ?? null,
        change.amountCents ?? null,
      ],
    );
  const logInvoiceChange = (
    tx: PracticeTransaction,
    actor: string,
    action: BillingChangeAction,
    invoiceId: string,
    amountCents: number,
  ) =>
    tx.query(
      "INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents) SELECT $1,$2,owner_id,$3 FROM simple_invoices WHERE id=$4",
      [actor, action, amountCents, invoiceId],
    );
  async function coursesEligible(
    tx: PracticeTransaction,
    ownerId: string,
    terms: InvoiceTerms,
    current = true,
  ) {
    for (const course of terms.courses) {
      const row = (
        await tx.query<{ title: string }>(
          `SELECT title FROM content_versions c WHERE id=$1 AND version=$2 AND state='published' AND kind='lesson' AND NOT requires_qualified_signoff AND (NOT $4::boolean OR version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published')) AND member_content_eligible($3,id,version) FOR SHARE`,
          [course.id, course.version, ownerId, current],
        )
      ).rows[0];
      if (!row || row.title !== course.description) return false;
    }
    return true;
  }
  async function issue(
    tx: PracticeTransaction,
    plan: InvoicePlan,
    name: string,
    email: string,
    cycle: number,
  ) {
    const id = randomUUID(),
      period = invoicePeriod(plan.terms.startsOn, cycle);
    const document: SimpleInvoiceDocument & { recipientEmail: string } = {
      number: `DN-${id}`,
      issuedOn: (
        await tx.query<{ today: string }>(
          "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
        )
      ).rows[0]!.today,
      issuer: plan.terms.issuer,
      billedTo: name,
      recipientEmail: email,
      lines: plan.terms.courses.map((c) => ({
        description: `${c.description} · ${c.id} version ${c.version}`,
        amountCents: c.amountCents,
      })),
      billing:
        plan.terms.cadence === "one_time"
          ? { kind: "one_time" }
          : {
              kind: "recurring",
              periodStart: period.start,
              periodEnd: period.end,
            },
      currency: "CAD",
      taxCents: plan.terms.taxCents,
      paidCents: 0,
      instructions: plan.terms.instructions,
      sample: plan.terms.sample,
    };
    await tx.query(
      "INSERT INTO simple_invoices(id,plan_id,owner_id,cycle,document,sample,total_cents) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        plan.id,
        plan.ownerId,
        cycle,
        JSON.stringify(document),
        plan.terms.sample,
        invoiceTotal(plan.terms),
      ],
    );
    await tx.query(
      "UPDATE simple_invoice_plans SET next_cycle=$2,revision=revision+1 WHERE id=$1",
      [plan.id, cycle + 1],
    );
    return id;
  }
  // A signed-in administrator's run is logged; the scheduled worker has no actor.
  async function due(
    tx: PracticeTransaction,
    actor?: string,
  ): Promise<InvoiceResult<{ created: number }>> {
    const candidates = (
      await tx.query<{ id: string; owner_id: string }>(
        "SELECT b.id,b.owner_id FROM simple_invoice_plans b JOIN principals p ON p.id=b.owner_id JOIN workspaces w ON w.id=b.workspace_id WHERE b.state='active' AND b.accepted_at IS NOT NULL AND b.recipient_name IS NOT NULL AND b.recipient_email IS NOT NULL AND b.terms->>'cadence'='monthly' AND b.next_cycle<=1200 AND ((b.terms->>'startsOn')::date+make_interval(months=>b.next_cycle))::date<=(clock_timestamp() AT TIME ZONE 'UTC')::date AND p.revoked_at IS NULL AND w.deleting_at IS NULL ORDER BY b.owner_id,b.id LIMIT 50",
      )
    ).rows;
    let created = 0;
    for (const candidate of candidates) {
      await owner(tx, candidate.owner_id, true);
      const plan = (
        await tx.query<InvoicePlan & { name: string; email: string }>(
          `SELECT ${planColumns},recipient_name AS name,recipient_email AS email FROM simple_invoice_plans WHERE id=$1 FOR UPDATE`,
          [candidate.id],
        )
      ).rows[0];
      if (!plan || plan.state !== "active" || plan.nextCycle > 1200) continue;
      const period = invoicePeriod(plan.terms.startsOn, plan.nextCycle),
        today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
      if (
        period.start > today ||
        !(await coursesEligible(tx, plan.ownerId, plan.terms, false))
      )
        continue;
      await issue(tx, plan, plan.name, plan.email, plan.nextCycle);
      if (actor)
        await logChange(tx, actor, "monthly_invoice_issued", {
          memberId: plan.ownerId,
          amountCents: invoiceTotal(plan.terms),
        });
      created++;
    }
    return { kind: "ready", value: { created } };
  }
  const rateColumns = 'id,effective_month AS "effectiveMonth",cents,version';
  async function coachingToday(tx: PracticeTransaction) {
    return (
      await tx.query<{ month: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
      )
    ).rows[0]!.month;
  }
  async function coachingEntry(
    tx: PracticeTransaction,
    memberId: string,
    month: string,
  ): Promise<CoachingMonth | null> {
    const row = (
      await tx.query<CoachingMonth>(
        `SELECT month,minutes,name,email,state,revision,submitted_revision AS "submittedRevision",invoice_id AS "invoiceId",previous_invoice_id AS "previousInvoiceId",return_reason AS "returnReason" FROM coaching_months WHERE owner_id=$1 AND month=$2 FOR UPDATE`,
        [memberId, month],
      )
    ).rows[0];
    if (!row) return null;
    const snapshot =
      row.submittedRevision === null
        ? null
        : ((
            await tx.query<{ snapshot: CoachingSnapshot }>(
              "SELECT snapshot FROM coaching_submissions WHERE owner_id=$1 AND month=$2 AND revision=$3",
              [memberId, month, row.submittedRevision],
            )
          ).rows[0]?.snapshot ?? null);
    return { ...row, snapshot };
  }
  return {
    async coachingOverview(token: string, month?: string, ownerId?: string) {
      if (
        (month !== undefined && !coachingMonth(month)) ||
        (ownerId !== undefined && !invoiceUuid(ownerId))
      )
        return fail("invalid");
      return run(token, ownerId !== undefined, async (tx, actor) => {
        const memberId = ownerId ?? actor;
        await owner(tx, memberId, ownerId !== undefined);
        const today = await coachingToday(tx),
          selected = month ?? today;
        if (selected > today) return fail("invalid");
        const rates = (
          await tx.query<CoachingRate>(
            `SELECT ${rateColumns} FROM coaching_rates WHERE owner_id=$1 ORDER BY version DESC`,
            [memberId],
          )
        ).rows;
        const entry = await coachingEntry(tx, memberId, selected);
        // HOURTABLE-01: each saved month with its amount and invoice state.
        const months = (
          await tx.query<SavedCoachingMonth>(
            `SELECT m.month,m.state,m.minutes,m.return_reason IS NOT NULL AS returned,
                    (SELECT (s.snapshot->>'subtotalCents')::bigint FROM coaching_submissions s
                     WHERE s.owner_id=m.owner_id AND s.month=m.month AND s.revision=m.submitted_revision) AS "submittedCents",
                    m.invoice_id AS "invoiceId",i.total_cents::text AS "totalCents",
                    i.paid_cents::text AS "paidCents",i.refunded_cents::text AS "refundedCents",i.voided_at IS NOT NULL AS voided
             FROM coaching_months m LEFT JOIN simple_invoices i ON i.id=m.invoice_id
             WHERE m.owner_id=$1 ORDER BY m.month DESC LIMIT 100`,
            [memberId],
          )
        ).rows;
        const displayName =
          (
            await tx.query<{ displayName: string | null }>(
              'SELECT display_name AS "displayName" FROM learners WHERE id=$1',
              [memberId],
            )
          ).rows[0]?.displayName ?? null;
        const rate =
          rates
            .filter((r) => r.effectiveMonth <= selected)
            .sort(
              (a, b) =>
                b.effectiveMonth.localeCompare(a.effectiveMonth) ||
                b.version - a.version,
            )[0] ?? null;
        return {
          kind: "ready",
          value: {
            ownerId: memberId,
            displayName,
            month: selected,
            today,
            rates,
            rate,
            rateVersion: rates[0]?.version ?? 0,
            entry,
            months,
            sample: settings.sample,
          },
        };
      });
    },
    async setCoachingRate(
      token: string,
      input: {
        ownerId: string;
        effectiveMonth: string;
        cents: number;
        expectedVersion: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ rateId: string; version: number }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !invoiceUuid(input.operationId) ||
        !coachingMonth(input.effectiveMonth) ||
        !invoiceCents(input.cents) ||
        input.cents === 0 ||
        !invoiceCents(input.expectedVersion)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        await owner(tx, input.ownerId, true);
        const digest = invoiceDigest({ action: "coaching-rate", input }),
          previous = await replay<{ rateId: string; version: number }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const current =
          (
            await tx.query<{ version: number }>(
              "SELECT version FROM coaching_rates WHERE owner_id=$1 ORDER BY version DESC LIMIT 1",
              [input.ownerId],
            )
          ).rows[0]?.version ?? 0;
        if (current !== input.expectedVersion) return fail("conflict");
        const rateId = randomUUID(),
          version = current + 1;
        await tx.query(
          "INSERT INTO coaching_rates(id,owner_id,effective_month,cents,version) VALUES($1,$2,$3,$4,$5)",
          [rateId, input.ownerId, input.effectiveMonth, input.cents, version],
        );
        await logChange(tx, actor, "rate_set", {
          memberId: input.ownerId,
          month: input.effectiveMonth,
          amountCents: input.cents,
        });
        return remember(tx, actor, input.operationId, digest, {
          rateId,
          version,
        });
      });
    },
    async saveCoaching(
      token: string,
      input: {
        month: string;
        minutes: number;
        name: string;
        email: string;
        expectedRevision: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ month: string; revision: number }>> {
      if (
        !input ||
        !invoiceUuid(input.operationId) ||
        !coachingMinutes(input.month, input.minutes) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceText(input.name, 200) ||
        typeof input.email !== "string" ||
        !normalizedEmail(input.email)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "coaching-save", input }),
          previous = await replay<{ month: string; revision: number }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        if (input.month > (await coachingToday(tx))) return fail("invalid");
        const entry = await coachingEntry(tx, actor, input.month);
        if (
          (entry?.revision ?? 0) !== input.expectedRevision ||
          (entry && entry.state !== "draft")
        )
          return fail("conflict");
        const revision = input.expectedRevision + 1;
        await tx.query(
          "INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision) VALUES($1,$2,$3,$4,$5,'draft',$6) ON CONFLICT(owner_id,month) DO UPDATE SET minutes=EXCLUDED.minutes,name=EXCLUDED.name,email=EXCLUDED.email,revision=EXCLUDED.revision",
          [
            actor,
            input.month,
            input.minutes,
            input.name,
            normalizedEmail(input.email),
            revision,
          ],
        );
        return remember(tx, actor, input.operationId, digest, {
          month: input.month,
          revision,
        });
      });
    },
    async submitCoaching(
      token: string,
      input: {
        month: string;
        rateId: string;
        sample: boolean;
        expectedRevision: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ month: string; revision: number }>> {
      if (
        !input ||
        !coachingMonth(input.month) ||
        !invoiceUuid(input.rateId) ||
        typeof input.sample !== "boolean" ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceUuid(input.operationId)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "coaching-submit", input }),
          previous = await replay<{ month: string; revision: number }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        if (input.month > (await coachingToday(tx))) return fail("invalid");
        const entry = await coachingEntry(tx, actor, input.month),
          rate = (
            await tx.query<CoachingRate>(
              `SELECT ${rateColumns} FROM coaching_rates WHERE owner_id=$1 AND effective_month<=$2 ORDER BY effective_month DESC,version DESC LIMIT 1`,
              [actor, input.month],
            )
          ).rows[0];
        if (!entry) return fail("not-found");
        if (!rate) return fail("unavailable");
        if (
          entry.state !== "draft" ||
          entry.revision !== input.expectedRevision ||
          rate.id !== input.rateId ||
          input.sample !== settings.sample
        )
          return fail("conflict");
        const subtotalCents = coachingSubtotal(entry.minutes, rate.cents);
        if (subtotalCents === null) return fail("invalid");
        const revision = entry.revision + 1,
          snapshot: CoachingSnapshot = {
            month: input.month,
            minutes: entry.minutes,
            rate,
            subtotalCents,
            name: entry.name,
            email: entry.email,
            sample: settings.sample,
          };
        await tx.query(
          "INSERT INTO coaching_submissions(owner_id,month,revision,snapshot) VALUES($1,$2,$3,$4)",
          [actor, input.month, revision, JSON.stringify(snapshot)],
        );
        await tx.query(
          "UPDATE coaching_months SET state='submitted',revision=$3,submitted_revision=$3,return_reason=NULL WHERE owner_id=$1 AND month=$2",
          [actor, input.month, revision],
        );
        return remember(tx, actor, input.operationId, digest, {
          month: input.month,
          revision,
        });
      });
    },
    async returnCoaching(
      token: string,
      input: {
        ownerId: string;
        month: string;
        expectedRevision: number;
        operationId: string;
        reason: string;
      },
    ): Promise<InvoiceResult<{ month: string; revision: number }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !coachingMonth(input.month) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceUuid(input.operationId) ||
        !invoiceText(input.reason, 500)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        await owner(tx, input.ownerId, true);
        const digest = invoiceDigest({ action: "coaching-return", input }),
          previous = await replay<{ month: string; revision: number }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const entry = await coachingEntry(tx, input.ownerId, input.month);
        if (!entry) return fail("not-found");
        if (
          entry.state === "draft" ||
          entry.revision !== input.expectedRevision
        )
          return fail("conflict");
        if (entry.state === "invoiced") {
          const invoice = (
            await tx.query<StoredInvoice>(
              `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
              [entry.invoiceId, input.ownerId],
            )
          ).rows[0];
          if (
            !invoice ||
            !invoice.voidReason ||
            Number(invoice.paidCents) !== 0 ||
            invoice.delivery === "sending" ||
            invoice.delivery === "unconfirmed"
          )
            return fail("conflict");
        }
        const revision = entry.revision + 1;
        await tx.query(
          "UPDATE coaching_months SET state='draft',revision=$3,return_reason=$4,previous_invoice_id=COALESCE(invoice_id,previous_invoice_id),invoice_id=NULL WHERE owner_id=$1 AND month=$2",
          [input.ownerId, input.month, revision, input.reason],
        );
        await logChange(tx, actor, "hours_returned", {
          memberId: input.ownerId,
          month: input.month,
        });
        return remember(tx, actor, input.operationId, digest, {
          month: input.month,
          revision,
        });
      });
    },
    async issueCoaching(
      token: string,
      input: {
        ownerId: string;
        month: string;
        expectedRevision: number;
        taxCents: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !coachingMonth(input.month) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceCents(input.taxCents) ||
        !invoiceUuid(input.operationId)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        await owner(tx, input.ownerId, true);
        const digest = invoiceDigest({ action: "coaching-issue", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const entry = await coachingEntry(tx, input.ownerId, input.month);
        if (!entry) return fail("not-found");
        if (
          entry.state !== "submitted" ||
          entry.revision !== input.expectedRevision ||
          !entry.snapshot ||
          entry.snapshot.sample !== settings.sample
        )
          return fail("conflict");
        const snapshot = entry.snapshot,
          total = snapshot.subtotalCents + input.taxCents;
        if (
          snapshot.subtotalCents <= 0 ||
          !invoiceCents(total) ||
          !invoiceText(settings.issuer, 500) ||
          !invoiceText(settings.instructions, 2000)
        )
          return fail("invalid");
        if (
          (
            await tx.query(
              "SELECT id FROM simple_invoices WHERE owner_id=$1 AND coaching_month=$2 AND void_reason IS NULL FOR UPDATE",
              [input.ownerId, input.month],
            )
          ).rowCount
        )
          return fail("conflict");
        const invoiceId = randomUUID();
        const document: SimpleInvoiceDocument & { recipientEmail: string } = {
          number: `DN-${invoiceId}`,
          issuedOn: (
            await tx.query<{ today: string }>(
              "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
            )
          ).rows[0]!.today,
          issuer: settings.issuer,
          billedTo: snapshot.name,
          recipientEmail: snapshot.email,
          lines: [
            {
              description: `Coaching · ${snapshot.month}`,
              amountCents: snapshot.subtotalCents,
            },
          ],
          billing: { kind: "one_time" },
          currency: "CAD",
          taxCents: input.taxCents,
          paidCents: 0,
          instructions: settings.instructions,
          sample: snapshot.sample,
          coaching: {
            month: snapshot.month,
            minutes: snapshot.minutes,
            rateCents: snapshot.rate.cents,
            rateVersion: snapshot.rate.version,
            rateId: snapshot.rate.id,
            submissionRevision: entry.submittedRevision!,
            replacesInvoiceId: entry.previousInvoiceId,
          },
        };
        await tx.query(
          "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,coaching_month) VALUES($1,$2,0,$3,$4,$5,$6)",
          [
            invoiceId,
            input.ownerId,
            JSON.stringify(document),
            snapshot.sample,
            total,
            input.month,
          ],
        );
        await tx.query(
          "UPDATE coaching_months SET state='invoiced',revision=revision+1,invoice_id=$3 WHERE owner_id=$1 AND month=$2",
          [input.ownerId, input.month, invoiceId],
        );
        await logChange(tx, actor, "coaching_invoice_issued", {
          memberId: input.ownerId,
          month: input.month,
          amountCents: total,
        });
        return remember(tx, actor, input.operationId, digest, { invoiceId });
      });
    },
    // shortcut: Lists show 100 records; add pagination before account volume exceeds this bound.
    async overview(token: string): Promise<InvoiceResult<InvoiceOverview>> {
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const plans = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [actor],
          )
        ).rows;
        const invoices = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [actor],
          )
        ).rows.map(decodeInvoice);
        return {
          kind: "ready",
          value: { plans, invoices, today: await utcToday(tx) },
        };
      });
    },
    async adminOverview(token: string, ownerId?: string) {
      if (ownerId !== undefined && !invoiceUuid(ownerId))
        return fail("invalid");
      return run(token, true, async (tx) => {
        if (ownerId) await owner(tx, ownerId);
        const members = (
          await tx.query<{ id: string; displayName: string | null }>(
            'SELECT l.id,l.display_name AS "displayName" FROM learners l JOIN workspaces w ON w.owner_principal_id=l.id WHERE w.deleting_at IS NULL AND ($1::uuid IS NULL OR l.id=$1) ORDER BY l.id LIMIT 100',
            [ownerId ?? null],
          )
        ).rows;
        const courses = (
          await tx.query<{ id: string; version: number; title: string }>(
            "SELECT id,version,title FROM content_versions c WHERE state='published' AND kind='lesson' AND NOT requires_qualified_signoff AND version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published') ORDER BY id",
          )
        ).rows;
        const invoices = (
          await tx.query<{ id: string; revision: number; delivery: string }>(
            "SELECT id,revision,delivery FROM simple_invoices WHERE ($1::uuid IS NULL OR owner_id=$1) ORDER BY created_at DESC LIMIT 100",
            [ownerId ?? null],
          )
        ).rows;
        const coachingPending = (
          await tx.query<{
            ownerId: string;
            month: string;
            displayName: string | null;
          }>(
            'SELECT owner_id AS "ownerId",month,l.display_name AS "displayName" FROM coaching_months JOIN learners l ON l.id=owner_id WHERE state=\'submitted\' AND ($1::uuid IS NULL OR owner_id=$1) ORDER BY month,owner_id LIMIT 100',
            [ownerId ?? null],
          )
        ).rows;
        return {
          kind: "ready",
          value: { members, courses, invoices, coachingPending },
        };
      });
    },
    /** Manager view of one month's contractor hours and coaching invoices. */
    async coachingDashboard(token: string, month?: string) {
      if (month !== undefined && !coachingMonth(month)) return fail("invalid");
      return run(token, true, async (tx) => {
        const today = await coachingToday(tx);
        const selected = month ?? shiftMonth(today, -1);
        if (selected > today) return fail("invalid");
        const previous = shiftMonth(selected, -1),
          yearStart = `${selected.slice(0, 4)}-01`;
        // Hours count once submitted; drafts and returned months do not.
        const summary = (
          await tx.query<{
            submittedMinutes: number;
            contractorsSubmitted: number;
            invoicedCents: string;
            invoicesNotSent: number;
            outstandingCents: string;
            awaitingReview: number;
            oldestWaitingDays: number | null;
          }>(
            `SELECT
              (SELECT COALESCE(sum(minutes),0)::integer FROM coaching_months WHERE month=$1 AND state IN ('submitted','invoiced')) AS "submittedMinutes",
              (SELECT count(*)::integer FROM coaching_months WHERE month=$1 AND state IN ('submitted','invoiced')) AS "contractorsSubmitted",
              COALESCE(sum(i.total_cents),0)::text AS "invoicedCents",
              count(i.id) FILTER (WHERE i.delivery<>'sent')::integer AS "invoicesNotSent",
              COALESCE(sum(i.total_cents-i.paid_cents),0)::text AS "outstandingCents",
              (SELECT count(*)::integer FROM coaching_months WHERE state='submitted') AS "awaitingReview",
              (SELECT floor(extract(epoch FROM clock_timestamp()-min(s.submitted_at))/86400)::integer FROM coaching_months c JOIN coaching_submissions s ON s.owner_id=c.owner_id AND s.month=c.month AND s.revision=c.submitted_revision WHERE c.state='submitted') AS "oldestWaitingDays"
            FROM coaching_months m JOIN simple_invoices i ON i.id=m.invoice_id AND i.voided_at IS NULL
            WHERE m.month=$1`,
            [selected],
          )
        ).rows[0]!;
        // Contractors: a rate in effect for the month, or hours this year.
        const rows = (
          await tx.query<{
            id: string;
            displayName: string | null;
            rateCents: number | null;
            minutes: number | null;
            previousMinutes: number | null;
            yearMinutes: number;
            state: string | null;
            returned: boolean;
            invoiceId: string | null;
            delivery: string | null;
            balanceCents: string | null;
          }>(
            `SELECT l.id,l.display_name AS "displayName",
              (SELECT r.cents FROM coaching_rates r WHERE r.owner_id=l.id AND r.effective_month<=$1 ORDER BY r.effective_month DESC,r.version DESC LIMIT 1) AS "rateCents",
              (SELECT x.minutes FROM coaching_months x WHERE x.owner_id=l.id AND x.month=$1 AND x.state IN ('submitted','invoiced')) AS minutes,
              (SELECT x.minutes FROM coaching_months x WHERE x.owner_id=l.id AND x.month=$2 AND x.state IN ('submitted','invoiced')) AS "previousMinutes",
              (SELECT COALESCE(sum(x.minutes),0)::integer FROM coaching_months x WHERE x.owner_id=l.id AND x.month BETWEEN $3 AND $1 AND x.state IN ('submitted','invoiced')) AS "yearMinutes",
              m.state,m.return_reason IS NOT NULL AS returned,m.invoice_id AS "invoiceId",
              i.delivery,(i.total_cents-i.paid_cents)::text AS "balanceCents"
            FROM learners l JOIN workspaces w ON w.owner_principal_id=l.id AND w.deleting_at IS NULL
            LEFT JOIN coaching_months m ON m.owner_id=l.id AND m.month=$1
            LEFT JOIN simple_invoices i ON i.id=m.invoice_id AND i.voided_at IS NULL
            WHERE EXISTS (SELECT 1 FROM coaching_rates r WHERE r.owner_id=l.id AND r.effective_month<=$1)
              OR EXISTS (SELECT 1 FROM coaching_months x WHERE x.owner_id=l.id AND x.month BETWEEN $3 AND $1)
            ORDER BY l.display_name NULLS LAST,l.id LIMIT 100`,
            [selected, previous, yearStart],
          )
        ).rows;
        const contractors = rows.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          rateCents: r.rateCents,
          minutes: r.minutes,
          previousMinutes: r.previousMinutes,
          yearMinutes: r.yearMinutes,
          status: (!r.state
            ? "not_started"
            : r.state === "draft"
              ? r.returned
                ? "returned"
                : "draft"
              : r.state === "invoiced" && r.delivery === null
                ? "voided"
                : r.state) as CoachingStatus,
          sent: r.delivery === null ? null : r.delivery === "sent",
          balanceCents: r.balanceCents === null ? null : Number(r.balanceCents),
        }));
        return {
          kind: "ready",
          value: {
            month: selected,
            today,
            summary: {
              submittedMinutes: summary.submittedMinutes,
              contractorsSubmitted: summary.contractorsSubmitted,
              invoicedCents: Number(summary.invoicedCents),
              invoicesNotSent: summary.invoicesNotSent,
              outstandingCents: Number(summary.outstandingCents),
              awaitingReview: summary.awaitingReview,
              oldestWaitingDays: summary.oldestWaitingDays,
            },
            contractors,
          },
        };
      });
    },
    async propose(
      token: string,
      input: {
        ownerId: string;
        operationId: string;
        courses: Array<{ id: string; version: number; amountCents: number }>;
        cadence: "one_time" | "monthly";
        startsOn: string;
        taxCents: number;
      },
    ): Promise<InvoiceResult<{ planId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !invoiceUuid(input.operationId) ||
        !Array.isArray(input.courses) ||
        input.courses.length < 1 ||
        input.courses.length > 20 ||
        !input.courses.every(
          (c) =>
            c &&
            typeof c === "object" &&
            invoiceText(c.id, 80) &&
            Number.isSafeInteger(c.version) &&
            c.version > 0 &&
            invoiceCents(c.amountCents),
        )
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        await owner(tx, input.ownerId);
        const digest = invoiceDigest({ action: "propose", input });
        const previous = await replay<{ planId: string }>(
          tx,
          actor,
          input.operationId,
          digest,
        );
        if (previous) return previous;
        const courses = [];
        for (const selected of input.courses) {
          const row = (
            await tx.query<{ title: string }>(
              "SELECT title FROM content_versions WHERE id=$1 AND version=$2 FOR SHARE",
              [selected.id, selected.version],
            )
          ).rows[0];
          if (!row) return fail("invalid");
          courses.push({ ...selected, description: row.title });
        }
        const terms: InvoiceTerms = {
          courses,
          cadence: input.cadence,
          startsOn: input.startsOn,
          taxCents: input.taxCents,
          ...settings,
        };
        if (!validInvoiceTerms(terms)) return fail("invalid");
        const today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
        if (
          terms.startsOn < today ||
          !(await coursesEligible(tx, input.ownerId, terms))
        )
          return fail("conflict");
        const planId = randomUUID();
        await tx.query(
          "INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,created_by) VALUES($1,$2,$2,$3,$4)",
          [planId, input.ownerId, JSON.stringify(terms), actor],
        );
        await logChange(tx, actor, "plan_offered", {
          memberId: input.ownerId,
          amountCents: invoiceTotal(terms),
        });
        return remember(tx, actor, input.operationId, digest, { planId });
      });
    },
    async accept(
      token: string,
      input: {
        planId: string;
        expectedRevision: number;
        operationId: string;
        name: string;
        email: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.planId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceText(input.name, 200) ||
        typeof input.email !== "string" ||
        !normalizedEmail(input.email)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "accept", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const plan = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
            [input.planId, actor],
          )
        ).rows[0];
        if (!plan) return fail("not-found");
        // An offer can be accepted only until its start date. Accepting later
        // would issue the first invoice for a past period and let the monthly
        // run bill every missed month (BUILD-04-C); a new proposal is needed.
        if (
          plan.state !== "offered" ||
          plan.revision !== input.expectedRevision ||
          plan.terms.startsOn < (await utcToday(tx)) ||
          !(await coursesEligible(tx, actor, plan.terms))
        )
          return fail("conflict");
        if (
          plan.terms.cadence === "monthly" &&
          (
            await tx.query(
              "SELECT 1 FROM simple_invoice_plans WHERE owner_id=$1 AND state='active' AND terms->>'cadence'='monthly'",
              [actor],
            )
          ).rowCount
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoice_plans SET state='active',accepted_at=clock_timestamp(),recipient_name=$2,recipient_email=$3 WHERE id=$1",
          [plan.id, input.name, normalizedEmail(input.email)],
        );
        const invoiceId = await issue(
          tx,
          plan,
          input.name,
          normalizedEmail(input.email)!,
          0,
        );
        return remember(tx, actor, input.operationId, digest, { invoiceId });
      });
    },
    async cancel(
      token: string,
      input: { planId: string; expectedRevision: number; operationId: string },
    ): Promise<InvoiceResult<{ cancelled: boolean }>> {
      if (
        !input ||
        !invoiceUuid(input.planId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "cancel", input }),
          previous = await replay<{ cancelled: boolean }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const plan = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
            [input.planId, actor],
          )
        ).rows[0];
        if (!plan) return fail("not-found");
        if (
          plan.state === "cancelled" ||
          plan.revision !== input.expectedRevision
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoice_plans SET state='cancelled',revision=revision+1 WHERE id=$1",
          [plan.id],
        );
        return remember(tx, actor, input.operationId, digest, {
          cancelled: true,
        });
      });
    },
    async invoice(
      token: string,
      id: string,
      admin = false,
    ): Promise<InvoiceResult<StoredInvoice>> {
      if (!invoiceUuid(id)) return fail("invalid");
      return run(token, admin, async (tx, actor) => {
        if (!admin) await owner(tx, actor);
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 AND ($2::boolean OR owner_id=$3) FOR SHARE`,
            [id, admin, actor],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        const payments = (
          await tx.query<InvoicePaymentEvent>(
            `SELECT p.kind,p.amount_cents AS "amountCents",to_char(p.received_on,'YYYY-MM-DD') AS "on",
                    p.evidence_reference AS evidence,p.verification,
                    CASE WHEN NOT $2::boolean THEN NULL
                         WHEN p.verification='signed_test_event' THEN 'Signed test event'
                         WHEN p.actor_id IS NULL THEN 'Removed staff account'
                         ELSE 'Staff account '||left(p.actor_id::text,8) END AS "recordedBy"
             FROM simple_invoice_payments p WHERE p.invoice_id=$1
               AND NOT (p.kind='held' AND EXISTS(SELECT 1 FROM simple_invoice_payments a
                 WHERE a.provider_event_id=p.provider_event_id AND a.kind='refund'))
             ORDER BY p.received_on,p.recorded_at,p.id`,
            [id, admin],
          )
        ).rows.map(({ recordedBy, ...event }) => ({
          ...event,
          amountCents: Number(event.amountCents),
          ...(recordedBy ? { recordedBy } : {}),
        }));
        // SVC-07: the latest simulated service state, once a signed test event arrived.
        const service = payments.some(
          (p) => p.verification === "signed_test_event",
        )
          ? ((
              await tx.query<SampleService>(
                `SELECT state,to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS since
                 FROM sample_service_states WHERE invoice_id=$1 ORDER BY state='withdrawn' DESC LIMIT 1`,
                [id],
              )
            ).rows[0] ?? { state: "awaiting_payment" })
          : undefined;
        return {
          kind: "ready",
          value: {
            ...decodeInvoice(row),
            payments,
            ...(service ? { service } : {}),
          },
        };
      });
    },
    async pay(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
        amountCents: number;
        receivedOn: string;
        evidence: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceCents(input.amountCents) ||
        input.amountCents === 0 ||
        !invoiceDate(input.receivedOn) ||
        !invoiceEvidence(input.evidence)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const digest = invoiceDigest({ action: "pay", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
            [input.invoiceId],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        const invoice = decodeInvoice(row);
        const today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
        if (
          invoice.voidReason !== null ||
          invoice.revision !== input.expectedRevision ||
          input.amountCents > invoice.totalCents - invoice.paidCents ||
          input.receivedOn > today
        )
          return fail("conflict");
        await tx.query(
          "INSERT INTO simple_invoice_payments(id,invoice_id,actor_id,amount_cents,received_on,kind,evidence_reference) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            invoice.id,
            actor,
            input.amountCents,
            input.receivedOn,
            "receipt",
            input.evidence,
          ],
        );
        await tx.query(
          "UPDATE simple_invoices SET paid_cents=paid_cents+$2,revision=revision+1 WHERE id=$1",
          [invoice.id, input.amountCents],
        );
        await logInvoiceChange(
          tx,
          actor,
          "payment_recorded",
          invoice.id,
          input.amountCents,
        );
        return remember(tx, actor, input.operationId, digest, {
          invoiceId: invoice.id,
        });
      });
    },
    /** MANPAY-04/05: records a refund already made; no money moves here. */
    async refund(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
        amountCents: number;
        refundedOn: string;
        evidence: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceCents(input.amountCents) ||
        input.amountCents === 0 ||
        !invoiceDate(input.refundedOn) ||
        !invoiceEvidence(input.evidence)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const digest = invoiceDigest({ action: "refund", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
            [input.invoiceId],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        const invoice = decodeInvoice(row);
        const { today, first } = (
          await tx.query<{ today: string; first: string | null }>(
            `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today,
                    (SELECT to_char(min(received_on),'YYYY-MM-DD') FROM simple_invoice_payments
                     WHERE invoice_id=$1 AND kind='receipt') AS first`,
            [invoice.id],
          )
        ).rows[0]!;
        if (
          invoice.revision !== input.expectedRevision ||
          input.amountCents > invoice.paidCents - invoice.refundedCents! ||
          input.refundedOn > today ||
          input.refundedOn < String(first)
        )
          return fail("conflict");
        await tx.query(
          "INSERT INTO simple_invoice_payments(id,invoice_id,actor_id,amount_cents,received_on,kind,evidence_reference) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            invoice.id,
            actor,
            input.amountCents,
            input.refundedOn,
            "refund",
            input.evidence,
          ],
        );
        await tx.query(
          "UPDATE simple_invoices SET refunded_cents=refunded_cents+$2,revision=revision+1 WHERE id=$1",
          [invoice.id, input.amountCents],
        );
        await logInvoiceChange(
          tx,
          actor,
          "payment_refunded",
          invoice.id,
          input.amountCents,
        );
        return remember(tx, actor, input.operationId, digest, {
          invoiceId: invoice.id,
        });
      });
    },
    async voidInvoice(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
        reason: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceText(input.reason, 500)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const digest = invoiceDigest({ action: "void", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
            [input.invoiceId],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        if (
          row.revision !== input.expectedRevision ||
          row.voidReason !== null ||
          Number(row.paidCents) !== 0 ||
          row.delivery === "sending" ||
          row.delivery === "unconfirmed"
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoices SET void_reason=$2,voided_at=clock_timestamp(),voided_by=$3,revision=revision+1 WHERE id=$1",
          [row.id, input.reason, actor],
        );
        await logInvoiceChange(
          tx,
          actor,
          "invoice_voided",
          row.id,
          Number(row.totalCents),
        );
        return remember(tx, actor, input.operationId, digest, {
          invoiceId: row.id,
        });
      });
    },
    async inspect(
      token: string,
      key: string,
      admin = false,
    ): Promise<InvoiceResult<{ result: unknown }>> {
      if (!invoiceUuid(key)) return fail("invalid");
      return run(token, admin, async (tx, actor) => {
        if (!admin) await owner(tx, actor);
        const row = (
          await tx.query<{ result: unknown }>(
            "SELECT result FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2",
            [actor, key],
          )
        ).rows[0];
        return row ? { kind: "ready", value: row } : fail("not-found");
      });
    },
    async claimEmail(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ send: boolean; invoice: StoredInvoice }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision)
      )
        return fail("invalid");
      return run<{ send: boolean; invoice: StoredInvoice }>(
        token,
        true,
        async (tx, actor) => {
          const digest = invoiceDigest({ action: "email", input }),
            previous = await replay<{ invoiceId: string }>(
              tx,
              actor,
              input.operationId,
              digest,
            );
          if (previous && previous.kind !== "ready") return previous;
          const row = (
            await tx.query<StoredInvoice>(
              `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
              [input.invoiceId],
            )
          ).rows[0];
          if (!row) return fail("not-found");
          if (previous)
            return {
              kind: "ready",
              value: { send: false, invoice: decodeInvoice(row) },
            };
          if (
            row.voidReason !== null ||
            row.revision !== input.expectedRevision ||
            row.delivery !== "not_sent"
          )
            return fail("conflict");
          await tx.query(
            "UPDATE simple_invoices SET delivery='sending',delivery_operation=$2,revision=revision+1 WHERE id=$1",
            [row.id, input.operationId],
          );
          await remember(tx, actor, input.operationId, digest, {
            invoiceId: row.id,
          });
          return {
            kind: "ready",
            value: { send: true, invoice: decodeInvoice(row) },
          };
        },
      );
    },
    async finishEmail(
      token: string,
      invoiceId: string,
      operationId: string,
      sent: boolean,
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (!invoiceUuid(invoiceId) || !invoiceUuid(operationId))
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const receipt = (
          await tx.query(
            "SELECT 1 FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2 AND result->>'invoiceId'=$3",
            [actor, operationId, invoiceId],
          )
        ).rowCount;
        if (!receipt) return fail("denied");
        const updated = await tx.query(
          "UPDATE simple_invoices SET delivery=$3,revision=revision+1 WHERE id=$1 AND delivery_operation=$2 AND delivery='sending' RETURNING id",
          [invoiceId, operationId, sent ? "sent" : "unconfirmed"],
        );
        return updated.rowCount
          ? { kind: "ready", value: { invoiceId } }
          : fail("conflict");
      });
    },
    async generateDue(
      token: string,
    ): Promise<InvoiceResult<{ created: number }>> {
      return run(token, true, (tx, actor) => due(tx, actor));
    },
    async generateScheduled(): Promise<InvoiceResult<{ created: number }>> {
      try {
        return await practiceTransaction(pool, async (tx) => {
          // Accepted agreements authorize this bounded worker; browser expiry is not cancellation.
          const lease = (
            await tx.query<{ expires: Date }>(
              "SELECT clock_timestamp()+interval '10 seconds' AS expires",
            )
          ).rows[0]!;
          await tx.observe([lease.expires]);
          return due(tx);
        });
      } catch {
        return fail("unavailable");
      }
    },
  };
}
export type SimpleInvoiceStore = ReturnType<typeof simpleInvoiceStore>;
