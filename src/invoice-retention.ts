import type { Pool } from "pg";

// #12 D08, owner decisions of 10 November 2026 (demo only, not legal or tax
// advice). After an account is deleted, its issued invoices and their payment
// records are kept until 31 December six years after the invoice's tax year
// (Deep Native Inc.'s tax year ends on 31 December), then removed
// automatically. Migration 133 enforces the date; this module finds what is due.

/** How often the running service looks for kept invoices past their date. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long after start the first look happens. */
export const RETENTION_FIRST_SWEEP_MS = 60 * 1000;

export function invoiceRetention(pool: Pool) {
  return {
    /**
     * RETEXP-02: the last day this account's issued invoices are kept after
     * deletion (YYYY-MM-DD), or null when it has none or it can't be read.
     */
    async retainedUntil(ownerId: string): Promise<string | null> {
      try {
        const row = (
          await pool.query<{ until: string | null }>(
            "SELECT to_char(max(simple_invoice_retained_until(document)),'YYYY-MM-DD') AS until FROM simple_invoices WHERE owner_id=$1 AND NOT sample",
            [ownerId],
          )
        ).rows[0];
        return row?.until ?? null;
      } catch {
        return null;
      }
    },
    /**
     * RETEXP-01/03: removes up to `limit` issued invoices whose account is
     * gone and whose date has passed, with their payment records, leaving one
     * content-free removal record each. Returns null when the sweep failed.
     */
    async removeExpired(limit = 100): Promise<number | null> {
      try {
        const removed = await pool.query(
          `WITH due AS (
             SELECT id,document,owner_deleted_at FROM simple_invoices
             WHERE owner_id IS NULL AND NOT sample
               AND simple_invoice_retained_until(document) < toronto_today()
             ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
           ), logged AS (
             INSERT INTO simple_invoice_retention_removals(invoice_id,tax_year,retained_until,owner_deleted_at,payment_records)
             SELECT d.id,extract(year FROM (d.document->>'issuedOn')::date)::integer,
               simple_invoice_retained_until(d.document),d.owner_deleted_at,
               (SELECT count(*)::integer FROM simple_invoice_payments p WHERE p.invoice_id=d.id)
             FROM due d RETURNING invoice_id
           )
           DELETE FROM simple_invoices WHERE id IN (SELECT invoice_id FROM logged) RETURNING id`,
          [limit],
        );
        return removed.rowCount ?? 0;
      } catch {
        return null;
      }
    },
  };
}
export type InvoiceRetention = ReturnType<typeof invoiceRetention>;
