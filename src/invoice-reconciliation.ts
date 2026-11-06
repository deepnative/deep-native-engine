import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

/** #123 RECON: read-only comparison of invoices with their recorded money events. */
export type InvoiceGroupName = "sample" | "configured";
export type InvoiceFlag =
  | "receipts_differ"
  | "refunds_differ"
  | "document_differs"
  | "void_with_cash"
  | "refund_before_receipt"
  | "receipt_before_issue"
  | "late_recorded"
  | "partly_refunded"
  | "fully_refunded"
  | "voided";
/** One retained invoice with its events, compared before any totals exist. */
export interface InvoiceFact {
  id: string;
  sample: boolean;
  linked: boolean;
  voided: boolean;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  documentTotalCents: number;
  documentSample: boolean;
  issuedOn: string;
  receipts: number;
  receiptCents: number;
  refunds: number;
  refundCents: number;
  simulatedReceiptCents: number;
  simulatedRefundCents: number;
  firstReceipt: string | null;
  firstRefund: string | null;
  lateEvents: number;
  lateCents: number;
}
export interface InvoiceCashGroup {
  group: InvoiceGroupName;
  invoices: number;
  current: number;
  voided: number;
  unlinked: number;
  invoicedCents: number;
  voidedCents: number;
  receipts: number;
  receiptCents: number;
  refunds: number;
  refundCents: number;
  netCollectedCents: number;
  unpaidCents: number;
  simulatedReceiptCents: number;
  simulatedRefundCents: number;
  collectedShare: number | null;
  mismatchedInvoices: number;
  /** Sum of absolute gaps per invoice, so opposite gaps cannot cancel. */
  mismatchCents: number;
  lateEvents: number;
  lateCents: number;
  datedBeforeIssue: number;
  partlyRefunded: number;
  fullyRefunded: number;
  status: "empty" | "consistent" | "discrepancies";
}
export interface FlaggedInvoice {
  id: string;
  group: InvoiceGroupName;
  gapCents: number;
  flags: InvoiceFlag[];
}
export interface ManualRecordCheck {
  /** Members whose recorded money events differ from staff change history. */
  mismatchedMembers: number;
  mismatchCents: number;
  comparedMembers: number;
  notComparableInvoices: number;
}
export interface InvoiceReconciliationSnapshot {
  asOf: Date;
  groups: [InvoiceCashGroup, InvoiceCashGroup];
  flagged: FlaggedInvoice[];
  flaggedTotal: number;
  manual: ManualRecordCheck;
}
export type InvoiceReconciliationResult =
  | { kind: "ready"; value: InvoiceReconciliationSnapshot }
  | { kind: "denied" | "unavailable" };
export interface InvoiceReconciliationStore {
  snapshot(token: string): Promise<InvoiceReconciliationResult>;
}
export function disabledInvoiceReconciliationStore(): InvoiceReconciliationStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}

export const FLAGGED_LIMIT = 50;
const mismatchFlags: readonly InvoiceFlag[] = [
  "receipts_differ",
  "refunds_differ",
  "document_differs",
  "void_with_cash",
  "refund_before_receipt",
];
const severity = (flags: readonly InvoiceFlag[]) =>
  flags.some((flag) => mismatchFlags.includes(flag))
    ? 0
    : flags.includes("late_recorded") || flags.includes("receipt_before_issue")
      ? 1
      : 2;

/** The gap is per invoice, in absolute cents, and is never netted across invoices. */
export function invoiceGap(fact: InvoiceFact) {
  return (
    Math.abs(
      fact.paidCents - (fact.receiptCents + fact.simulatedReceiptCents),
    ) +
    Math.abs(
      fact.refundedCents - (fact.refundCents + fact.simulatedRefundCents),
    ) +
    Math.abs(fact.totalCents - fact.documentTotalCents)
  );
}
export function invoiceFlags(fact: InvoiceFact): InvoiceFlag[] {
  const flags: InvoiceFlag[] = [];
  const receipts = fact.receiptCents + fact.simulatedReceiptCents,
    refunds = fact.refundCents + fact.simulatedRefundCents;
  if (fact.paidCents !== receipts) flags.push("receipts_differ");
  if (fact.refundedCents !== refunds) flags.push("refunds_differ");
  if (
    fact.totalCents !== fact.documentTotalCents ||
    fact.sample !== fact.documentSample
  )
    flags.push("document_differs");
  if (fact.voided && receipts + refunds > 0) flags.push("void_with_cash");
  if (
    fact.firstRefund !== null &&
    (fact.firstReceipt === null || fact.firstRefund < fact.firstReceipt)
  )
    flags.push("refund_before_receipt");
  if (fact.firstReceipt !== null && fact.firstReceipt < fact.issuedOn)
    flags.push("receipt_before_issue");
  if (fact.lateEvents > 0) flags.push("late_recorded");
  if (fact.refundedCents > 0)
    flags.push(
      fact.refundedCents === fact.paidCents
        ? "fully_refunded"
        : "partly_refunded",
    );
  if (fact.voided) flags.push("voided");
  return flags;
}
function group(
  name: InvoiceGroupName,
  facts: readonly InvoiceFact[],
): InvoiceCashGroup {
  const rows = facts.filter((fact) => fact.sample === (name === "sample"));
  const sum = (pick: (fact: InvoiceFact) => number, from = rows) =>
    from.reduce((total, fact) => total + pick(fact), 0);
  const current = rows.filter((fact) => !fact.voided),
    flagged = rows.map((fact) => ({ fact, flags: invoiceFlags(fact) })),
    mismatched = flagged.filter(({ flags }) =>
      flags.some((flag) => mismatchFlags.includes(flag)),
    ),
    invoicedCents = sum((fact) => fact.totalCents, current),
    receiptCents = sum((fact) => fact.receiptCents),
    refundCents = sum((fact) => fact.refundCents),
    netCollectedCents = receiptCents - refundCents;
  return {
    group: name,
    invoices: rows.length,
    current: current.length,
    voided: rows.length - current.length,
    unlinked: rows.filter((fact) => !fact.linked).length,
    invoicedCents,
    voidedCents: sum((fact) => (fact.voided ? fact.totalCents : 0)),
    receipts: sum((fact) => fact.receipts),
    receiptCents,
    refunds: sum((fact) => fact.refunds),
    refundCents,
    netCollectedCents,
    unpaidCents: sum((fact) => fact.totalCents - fact.paidCents, current),
    simulatedReceiptCents: sum((fact) => fact.simulatedReceiptCents),
    simulatedRefundCents: sum((fact) => fact.simulatedRefundCents),
    // Zero denominator: nothing invoiced has no share, not a share of zero.
    collectedShare:
      invoicedCents === 0
        ? null
        : Math.floor((netCollectedCents * 100) / invoicedCents),
    mismatchedInvoices: mismatched.length,
    mismatchCents: mismatched.reduce((t, { fact }) => t + invoiceGap(fact), 0),
    lateEvents: sum((fact) => fact.lateEvents),
    lateCents: sum((fact) => fact.lateCents),
    datedBeforeIssue: flagged.filter(({ flags }) =>
      flags.includes("receipt_before_issue"),
    ).length,
    partlyRefunded: flagged.filter(({ flags }) =>
      flags.includes("partly_refunded"),
    ).length,
    fullyRefunded: flagged.filter(({ flags }) =>
      flags.includes("fully_refunded"),
    ).length,
    status: !rows.length
      ? "empty"
      : mismatched.length
        ? "discrepancies"
        : "consistent",
  };
}
export function reconcileInvoices(
  facts: readonly InvoiceFact[],
  manual: ManualRecordCheck,
  asOf: Date,
): InvoiceReconciliationSnapshot {
  const flagged = facts
    .map((fact) => ({
      id: fact.id,
      group: (fact.sample ? "sample" : "configured") as InvoiceGroupName,
      gapCents: invoiceGap(fact),
      flags: invoiceFlags(fact),
    }))
    .filter((row) => row.flags.length > 0)
    .sort(
      (a, b) =>
        severity(a.flags) - severity(b.flags) ||
        b.gapCents - a.gapCents ||
        a.id.localeCompare(b.id),
    );
  return {
    asOf,
    groups: [group("configured", facts), group("sample", facts)],
    flagged: flagged.slice(0, FLAGGED_LIMIT),
    flaggedTotal: flagged.length,
    manual,
  };
}

const digits = (expression: string) =>
  `CASE WHEN ${expression} ~ '^[0-9]{1,15}$' THEN (${expression})::bigint ELSE -1 END`;
// shortcut: Every retained invoice is read and compared here; move the totals
// into SQL before retained invoices reach the tens of thousands.
const factsSql = `SELECT i.id,i.sample,i.owner_id IS NOT NULL AS linked,i.voided_at IS NOT NULL AS voided,
   i.total_cents::text AS "totalCents",i.paid_cents::text AS "paidCents",i.refunded_cents::text AS "refundedCents",
   (d.lines+${digits("i.document->>'taxCents'")})::text AS "documentTotalCents",
   COALESCE(i.document->>'sample','')='true' AS "documentSample",
   COALESCE(i.document->>'issuedOn','') AS "issuedOn",
   e.receipts,e.receipt_cents::text AS "receiptCents",e.refunds,e.refund_cents::text AS "refundCents",
   e.simulated_receipt_cents::text AS "simulatedReceiptCents",e.simulated_refund_cents::text AS "simulatedRefundCents",
   e.first_receipt AS "firstReceipt",e.first_refund AS "firstRefund",
   e.late_events AS "lateEvents",e.late_cents::text AS "lateCents"
 FROM simple_invoices i
 CROSS JOIN LATERAL (
   SELECT COALESCE(sum(${digits("line->>'amountCents'")}),0) AS lines
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.document->'lines')='array' THEN i.document->'lines' ELSE '[]'::jsonb END) AS line
 ) d
 CROSS JOIN LATERAL (
   SELECT count(*) FILTER (WHERE p.kind='receipt' AND p.verification='manual_unverified')::integer AS receipts,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='receipt' AND p.verification='manual_unverified'),0) AS receipt_cents,
     count(*) FILTER (WHERE p.kind='refund' AND p.verification='manual_unverified')::integer AS refunds,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='refund' AND p.verification='manual_unverified'),0) AS refund_cents,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='receipt' AND p.verification<>'manual_unverified'),0) AS simulated_receipt_cents,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='refund' AND p.verification<>'manual_unverified'),0) AS simulated_refund_cents,
     to_char(min(p.received_on) FILTER (WHERE p.kind='receipt'),'YYYY-MM-DD') AS first_receipt,
     to_char(min(p.received_on) FILTER (WHERE p.kind='refund'),'YYYY-MM-DD') AS first_refund,
     count(*) FILTER (WHERE to_char(p.recorded_at AT TIME ZONE 'UTC','YYYY-MM')>to_char(p.received_on,'YYYY-MM'))::integer AS late_events,
     COALESCE(sum(p.amount_cents) FILTER (WHERE to_char(p.recorded_at AT TIME ZONE 'UTC','YYYY-MM')>to_char(p.received_on,'YYYY-MM')),0) AS late_cents
   FROM simple_invoice_payments p WHERE p.invoice_id=i.id
 ) e`;
// Staff change history names a member, not an invoice, so it compares per member.
// Signed test events have no staff actor and never belong in this comparison.
const manualSql = `WITH recorded AS (
   SELECT i.owner_id AS member_id,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='receipt'),0) AS receipts,
     COALESCE(sum(p.amount_cents) FILTER (WHERE p.kind='refund'),0) AS refunds
   FROM simple_invoices i JOIN simple_invoice_payments p ON p.invoice_id=i.id AND p.verification='manual_unverified'
   WHERE i.owner_id IS NOT NULL GROUP BY i.owner_id
 ),history AS (
   SELECT h.member_id,
     COALESCE(sum(h.amount_cents) FILTER (WHERE h.action='payment_recorded'),0) AS receipts,
     COALESCE(sum(h.amount_cents) FILTER (WHERE h.action='payment_refunded'),0) AS refunds
   FROM billing_change_events h
   WHERE h.action IN ('payment_recorded','payment_refunded')
     AND h.member_id IN (SELECT owner_id FROM simple_invoices WHERE owner_id IS NOT NULL)
   GROUP BY h.member_id
 ),compared AS (
   SELECT abs(COALESCE(r.receipts,0)-COALESCE(h.receipts,0))+abs(COALESCE(r.refunds,0)-COALESCE(h.refunds,0)) AS gap
   FROM recorded r FULL JOIN history h ON h.member_id=r.member_id
 )
 SELECT (SELECT count(*)::integer FROM compared) AS "comparedMembers",
   (SELECT count(*)::integer FROM compared WHERE gap>0) AS "mismatchedMembers",
   (SELECT COALESCE(sum(gap),0)::text FROM compared) AS "mismatchCents",
   (SELECT count(*)::integer FROM simple_invoices WHERE owner_id IS NULL) AS "notComparableInvoices"`;

const whole = (value: unknown) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error("Invoice report value is not a whole number");
  return number;
};
const decodeFact = (row: Record<string, unknown>): InvoiceFact => ({
  id: String(row.id),
  sample: row.sample === true,
  linked: row.linked === true,
  voided: row.voided === true,
  totalCents: whole(row.totalCents),
  paidCents: whole(row.paidCents),
  refundedCents: whole(row.refundedCents),
  documentTotalCents: whole(row.documentTotalCents),
  documentSample: row.documentSample === true,
  issuedOn: String(row.issuedOn),
  receipts: whole(row.receipts),
  receiptCents: whole(row.receiptCents),
  refunds: whole(row.refunds),
  refundCents: whole(row.refundCents),
  simulatedReceiptCents: whole(row.simulatedReceiptCents),
  simulatedRefundCents: whole(row.simulatedRefundCents),
  firstReceipt: (row.firstReceipt ?? null) as string | null,
  firstRefund: (row.firstRefund ?? null) as string | null,
  lateEvents: whole(row.lateEvents),
  lateCents: whole(row.lateCents),
});
/** Reads the comparison inside the caller's one read-only snapshot. */
export async function readInvoiceReconciliation(
  client: Pick<PoolClient, "query">,
): Promise<InvoiceReconciliationSnapshot> {
  const facts = await client.query<Record<string, unknown>>(factsSql),
    manual = (await client.query<Record<string, unknown>>(manualSql)).rows[0],
    asOf = (await client.query<{ asOf: Date }>('SELECT now() AS "asOf"'))
      .rows[0];
  if (!manual || !asOf) throw new Error("Invoice report row missing");
  return reconcileInvoices(
    facts.rows.map(decodeFact),
    {
      comparedMembers: whole(manual.comparedMembers),
      mismatchedMembers: whole(manual.mismatchedMembers),
      mismatchCents: whole(manual.mismatchCents),
      notComparableInvoices: whole(manual.notComparableInvoices),
    },
    asOf.asOf,
  );
}
class AccessDenied extends Error {}
export function invoiceReconciliationStore(
  pool: Pool,
): InvoiceReconciliationStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        failure: Error | undefined,
        result: InvoiceReconciliationResult;
      try {
        client = await pool.connect();
        // One snapshot across every statement, so totals and checks agree. It writes
        // nothing and always rolls back; the staff-role view locks, so not READ ONLY.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SET LOCAL statement_timeout='5s'");
        const admin = (
          await client.query(
            `SELECT 1 FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND s.role='platform_admin'`,
            [hash(token)],
          )
        ).rows[0];
        if (!admin) throw new AccessDenied();
        result = {
          kind: "ready",
          value: await readInvoiceReconciliation(client),
        };
      } catch (error) {
        result = {
          kind: error instanceof AccessDenied ? "denied" : "unavailable",
        };
      }
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          failure = new Error("Invoice report rollback failed");
          result = { kind: "unavailable" };
        }
        client.release(failure);
      }
      return result;
    },
  };
}
