import { afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testPool } from "../support/database.ts";

const pool = testPool();
afterAll(async () => pool.end());

it("migrates legacy synthetic availability to an audited expired balance once", async () => {
  const schema = `legacy_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  const member = randomUUID();
  const grant = randomUUID();
  const reservation = randomUUID();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (let version = 1; version <= 16; version++) {
      const name = [
        "learning",
        "adapter-jobs",
        "workspace-authorization",
        "private-evidence",
        "learner-profile",
        "content-lifecycle",
        "expert-readiness",
        "member-proposals",
        "learning-plan",
        "assignment-choice",
        "learning-milestones",
        "private-career-planning",
        "lesson-activity",
        "preview-circles",
        "assignment-attempts",
        "synthetic-entitlement-ledger",
      ][version - 1]!;
      const sql = await readFile(
        new URL(
          `../../migrations/${String(version).padStart(3, "0")}-${name}.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql);
    }
    const tokenHash = createHash("sha256")
      .update(`legacy-${member}`)
      .digest("hex");
    await client.query(
      "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'member',CURRENT_TIMESTAMP+interval '1 day')",
      [member, tokenHash],
    );
    await client.query(
      "INSERT INTO learners(id,token_hash,background,goal) VALUES($1,$2,'explorer','everyday')",
      [member, tokenHash],
    );
    await client.query(
      "INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,reserved) VALUES($1,$2,'coach_minutes',2,1,1)",
      [grant, member],
    );
    await client.query(
      "INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state) VALUES($1,$2,1,'reserved')",
      [reservation, grant],
    );
    const migration = await readFile(
      new URL(
        "../../migrations/017-synthetic-entitlement-expiry.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    const balance = (
      await client.query(
        "SELECT available,reserved,consumed,expired,expired_at FROM synthetic_entitlement_grants WHERE id=$1",
        [grant],
      )
    ).rows[0];
    expect(balance).toMatchObject({
      available: 0,
      reserved: 1,
      consumed: 0,
      expired: 1,
    });
    expect(balance.expired_at).toBeInstanceOf(Date);
    const events = (
      await client.query(
        "SELECT operation,quantity,request_fingerprint,result_id FROM synthetic_entitlement_events WHERE grant_id=$1",
        [grant],
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      operation: "expire",
      quantity: 1,
      result_id: grant,
      request_fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            operation: "expire",
            memberId: member,
            grantId: grant,
          }),
        )
        .digest("hex"),
    });
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
