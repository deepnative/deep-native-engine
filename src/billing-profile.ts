import type { Pool } from "pg";
import { hash } from "./store.ts";
import { normalizedEmail } from "./member-email-access.ts";
import {
  invoiceCompany,
  invoiceText,
  invoiceCents,
} from "./simple-invoice-values.ts";
import type { InvoiceResult } from "./simple-invoice-store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";
export interface BillingProfile {
  name: string;
  email: string;
  /** RECIPIENT-04: optional; null or absent means none. */
  company?: string | null;
  revision: number;
}
export function billingProfileStore(pool: Pool) {
  async function use(
    token: string,
    input?: BillingProfile | null,
    suggest = false,
  ): Promise<InvoiceResult<BillingProfile | null>> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return { kind: "denied" };
    if (
      input !== undefined &&
      (!input ||
        !invoiceText(input.name, 200) ||
        typeof input.email !== "string" ||
        !normalizedEmail(input.email) ||
        invoiceCompany(input.company) === undefined ||
        !invoiceCents(input.revision))
    )
      return { kind: "invalid" };
    try {
      return await practiceTransaction(pool, async (tx) => {
        const member = (
          await tx.query<{ id: string; expires: Date }>(
            "SELECT p.id,p.expires_at AS expires FROM principals p JOIN learners l ON l.id=p.id WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() FOR UPDATE OF p",
            [hash(token)],
          )
        ).rows[0];
        if (!member) throw new PracticeLifetimeFailure("denied");
        await tx.observe([member.expires]);
        if (
          !(
            await tx.query(
              "SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE",
              [member.id],
            )
          ).rowCount
        )
          throw new PracticeLifetimeFailure("denied");
        const current =
          (
            await tx.query<BillingProfile>(
              "SELECT name,email,company,revision FROM billing_profiles WHERE owner_id=$1",
              [member.id],
            )
          ).rows[0] ?? null;
        if (input) {
          if ((current?.revision ?? 0) !== input.revision)
            return { kind: "conflict" as const };
          const saved = {
            name: input.name,
            email: normalizedEmail(input.email)!,
            company: invoiceCompany(input.company)!,
            revision: input.revision + 1,
          };
          await tx.query(
            "INSERT INTO billing_profiles(owner_id,name,email,company,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,company=EXCLUDED.company,revision=EXCLUDED.revision",
            [member.id, saved.name, saved.email, saved.company, saved.revision],
          );
          await tx.observe([member.expires]);
          return { kind: "ready" as const, value: saved };
        }
        // RECIPIENT-01/SIGNEMAIL-01: until a recipient is saved, suggest the
        // registered name and verified sign-in email. Members verified before
        // #796 have no readable address until their next email sign-in.
        const registered =
          current || !suggest
            ? null
            : (
                await tx.query<{
                  displayName: string | null;
                  address: string | null;
                }>(
                  `SELECT l.display_name AS "displayName",i.address FROM learners l
                   LEFT JOIN member_email_identities i ON i.principal_id=l.id WHERE l.id=$1`,
                  [member.id],
                )
              ).rows[0]!;
        const value = registered
          ? {
              name: registered.displayName ?? "",
              email: registered.address ?? "",
              company: null,
              revision: 0,
            }
          : current;
        await tx.observe([member.expires]);
        return { kind: "ready" as const, value };
      });
    } catch (error) {
      return {
        kind:
          error instanceof PracticeLifetimeFailure && error.kind === "denied"
            ? "denied"
            : "unavailable",
      };
    }
  }
  return {
    read: (token: string) => use(token),
    /** The saved recipient, else the member's registered name to start from. */
    suggest: (token: string) =>
      use(token, undefined, true) as Promise<InvoiceResult<BillingProfile>>,
    save: (token: string, input: BillingProfile) => use(token, input ?? null),
  };
}
export type BillingProfileStore = ReturnType<typeof billingProfileStore>;
