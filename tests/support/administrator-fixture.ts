import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { authorizationStore as realAuthorizationStore } from "../../src/authorization.ts";
import { hash } from "../../src/store.ts";

/** Synthetic authority setup only; never accepts an arbitrary/hosted database. */
export function authorizationStore(pool: Pool) {
  const store = realAuthorizationStore(pool);
  return {
    ...store,
    async provisionStaff(...args: Parameters<typeof store.provisionStaff>) {
      const database = (
        await pool.query<{ name: string }>("SELECT current_database() AS name")
      ).rows[0]!.name;
      if (!/^dne_test_[a-f0-9]{32}$/.test(database))
        throw Error("Synthetic staff requires a generated test database");
      const id = await store.provisionStaff(...args);
      if (args[1] !== "platform_admin") return id;
      await bindSyntheticAdministrator(pool, id, args[2]);
      return id;
    },
  };
}
/** A longer verified-member window isolates existing staff-expiry tests. */
export async function bindSyntheticAdministrator(
  pool: Pool,
  staffId: string,
  staffExpiry: Date,
) {
  const bindingExpiry = new Date(+staffExpiry + 3600000);
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const database = (
      await tx.query<{ name: string }>("SELECT current_database() AS name")
    ).rows[0]!.name;
    if (!/^dne_test_[a-f0-9]{32}$/.test(database))
      throw Error("Synthetic administrator requires a generated test database");
    await tx.query("SELECT pg_advisory_xact_lock(565)");
    // A local synthetic identity row models completed email verification.
    // No sender/network/owner account is used; entry tests exercise real consume.
    const digest = hash("shi@deepnative.io");
    let member = (
      await tx.query<{ id: string; token_hash: string }>(
        "SELECT p.id,p.token_hash FROM member_email_identities e JOIN principals p ON p.id=e.principal_id WHERE e.email_hash=$1",
        [digest],
      )
    ).rows[0];
    if (!member) {
      member = {
        id: randomUUID(),
        token_hash: hash(randomBytes(32).toString("hex")),
      };
      await tx.query(
        "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'member',$3)",
        [member.id, member.token_hash, bindingExpiry],
      );
      await tx.query(
        "INSERT INTO workspaces(id,owner_principal_id) VALUES($1,$1)",
        [member.id],
      );
      await tx.query(
        "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
        [digest, member.id],
      );
    }
    await tx.query(
      "INSERT INTO workspaces(id,owner_principal_id) VALUES($1,$1) ON CONFLICT DO NOTHING",
      [member.id],
    );
    await tx.query(
      "UPDATE principals SET expires_at=GREATEST(expires_at,$2) WHERE id=$1",
      [member.id, bindingExpiry],
    );
    await tx.query(
      "INSERT INTO administrator_sessions(staff_id,member_id,member_token_hash,expires_at,revoked_at) VALUES($1,$2,$3,$4,NULL)",
      [staffId, member.id, member.token_hash, bindingExpiry],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export { STAFF_ROLES } from "../../src/authorization.ts";
export type { StaffRole, AuthorizationStore } from "../../src/authorization.ts";
