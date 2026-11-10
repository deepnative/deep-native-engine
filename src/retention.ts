// #12 D08 owner decisions, 9 and 10 November 2026, for the demo only and not
// legally reviewed. One place for the periods the account page, the response
// to a deletion and /terms all name, so they can't say different things.
// See assets/docs/MEMBER-DELETION-RETENTION.md.

/** Database backups, set on 9 November 2026. */
export const BACKUP_RETENTION_DAYS = 30;
/** Issued invoices and their payment records, set on 10 November 2026. */
export const BILLING_RETENTION_YEARS = 6;

/** RETAIN-01: the billing exception and its expiry, in plain words. */
export const BILLING_RETENTION = `Issued invoices and the payments and refunds recorded against them are kept for ${BILLING_RETENTION_YEARS} years after the account is deleted, following Canada Revenue Agency record-keeping rules (records are kept ${BILLING_RETENTION_YEARS} years from the end of the last tax year they relate to).`;
/** RETAIN-01: what such a kept invoice holds, and nothing more. */
export const BILLING_RETAINED_FIELDS =
  "They hold only what the invoice needs: its number and date, the issuer, the billing name, company and email, the items, amounts and tax, whether it was voided, and the payments and refunds recorded. Sample invoices are deleted with the account.";
/** RETAIN-02: the backup expiry. */
export const BACKUP_RETENTION = `Copies in service backups are kept for up to ${BACKUP_RETENTION_DAYS} days, then they expire.`;
