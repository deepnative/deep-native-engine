import type { Pool } from "pg";
import { hash } from "./store.ts";
import { normalizedEmail } from "./member-email-access.ts";
import { invoiceText, invoiceCents } from "./simple-invoice-values.ts";
import type { InvoiceResult } from "./simple-invoice-store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";
export interface BillingProfile {
  name: string;
  email: string;
  revision: number;
}
export function billingProfileStore(pool: Pool) {
  async function use(
    token: string,
    input?: BillingProfile | null,
  ): Promise<InvoiceResult<BillingProfile | null>> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return { kind: "denied" };
    if (
      input !== undefined &&
      (!input ||
        !invoiceText(input.name, 200) ||
        typeof input.email !== "string" ||
        !normalizedEmail(input.email) ||
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
              "SELECT name,email,revision FROM billing_profiles WHERE owner_id=$1",
              [member.id],
            )
          ).rows[0] ?? null;
        if (input) {
          if ((current?.revision ?? 0) !== input.revision)
            return { kind: "conflict" as const };
          const saved = {
            name: input.name,
            email: normalizedEmail(input.email)!,
            revision: input.revision + 1,
          };
          await tx.query(
            "INSERT INTO billing_profiles(owner_id,name,email,revision) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,revision=EXCLUDED.revision",
            [member.id, saved.name, saved.email, saved.revision],
          );
          await tx.observe([member.expires]);
          return { kind: "ready" as const, value: saved };
        }
        await tx.observe([member.expires]);
        return { kind: "ready" as const, value: current };
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
    save: (token: string, input: BillingProfile) => use(token, input ?? null),
  };
}
export type BillingProfileStore = ReturnType<typeof billingProfileStore>;
