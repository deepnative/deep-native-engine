import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";

const selected = ["shi@deepnative.io", "tom@deepnative.io"].map((address) =>
  createHash("sha256").update(address).digest("hex"),
);
export type AdministratorResult =
  | { kind: "ready"; credential?: string; expires?: Date }
  | { kind: "denied" | "unavailable" };
export interface AdministratorEntry {
  status(memberToken: string): Promise<AdministratorResult>;
  enter(memberToken: string): Promise<AdministratorResult>;
  end(memberToken: string): Promise<AdministratorResult>;
}
export function administratorEntry(pool: Pool): AdministratorEntry {
  async function run(
    memberToken: string,
    action: "status" | "enter" | "end",
  ): Promise<AdministratorResult> {
    if (!/^[a-f0-9]{64}$/.test(memberToken)) return { kind: "denied" };
    try {
      return await practiceTransaction(pool, async (tx) => {
        const owner = (
          await tx.query<{ id: string; expires: Date; session_expires: Date }>(
            `SELECT p.id,p.expires_at AS expires,
             LEAST(p.expires_at,clock_timestamp()+INTERVAL '8 hours') AS session_expires FROM principals p
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR UPDATE`,
            [hash(memberToken)],
          )
        ).rows[0];
        if (!owner) throw new PracticeLifetimeFailure("denied");
        await tx.observe([owner.expires]);
        const workspace = await tx.query(
          "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
          [owner.id],
        );
        const identity = await tx.query(
          "SELECT 1 FROM member_email_identities WHERE principal_id=$1 AND email_hash=ANY($2::text[]) FOR SHARE",
          [owner.id, selected],
        );
        if (!workspace.rowCount || !identity.rowCount)
          throw new PracticeLifetimeFailure("denied");
        if (action === "status") return { kind: "ready" };
        if (action === "end") {
          await tx.query(
            `UPDATE administrator_sessions SET revoked_at=clock_timestamp()
             WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL RETURNING staff_id`,
            [owner.id, hash(memberToken)],
          );
          return { kind: "ready" };
        }
        // Expired sessions require deliberate ending, never silent replacement.
        const previous = await tx.query(
          "SELECT 1 FROM administrator_sessions WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL",
          [owner.id, hash(memberToken)],
        );
        if (previous.rowCount) throw new PracticeLifetimeFailure("denied");
        const expires = owner.session_expires;
        const credential = randomBytes(32).toString("hex"),
          id = randomUUID();
        await tx.query(
          "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'staff',$3)",
          [id, hash(credential), expires],
        );
        await tx.query(
          "INSERT INTO staff_profiles(principal_id,role) VALUES($1,'platform_admin')",
          [id],
        );
        await tx.query(
          "INSERT INTO administrator_sessions(staff_id,member_id,member_token_hash,expires_at) VALUES($1,$2,$3,$4)",
          [id, owner.id, hash(memberToken), expires],
        );
        await tx.observe([expires]);
        return { kind: "ready", credential, expires };
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
    status: (token) => run(token, "status"),
    enter: (token) => run(token, "enter"),
    end: (token) => run(token, "end"),
  };
}
