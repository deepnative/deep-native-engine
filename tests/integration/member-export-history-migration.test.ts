import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { hash, migrate } from "../../src/store.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
afterAll(async () => pool.end());
it("exports actual migration-017 legacy expiry including its zero-quantity event without rewriting history", async () => {
  const schema = `history_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  const token = randomBytes(32).toString("hex"),
    member = randomUUID();
  const grants = [randomUUID(), randomUUID()];
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    const scripts = (await readdir(directory))
      .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
      .sort();
    for (const name of scripts.filter((name) => Number(name.slice(0, 3)) <= 16))
      await client.query(await readFile(new URL(name, directory), "utf8"));
    await client.query(
      "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'member',CURRENT_TIMESTAMP+interval '1 day')",
      [member, hash(token)],
    );
    await client.query(
      "INSERT INTO learners(id,token_hash,background,goal) VALUES($1,$2,'explorer','everyday')",
      [member, hash(token)],
    );
    await client.query(
      "INSERT INTO workspaces(id,owner_principal_id) VALUES($1,$1)",
      [member],
    );
    for (const [i, grant] of grants.entries()) {
      await client.query(
        "INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,reserved) VALUES($1,$2,'coach_minutes',$3,$4,1)",
        [grant, member, i === 0 ? 2 : 1, i === 0 ? 1 : 0],
      );
      await client.query(
        "INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state) VALUES($1,$2,1,'reserved')",
        [randomUUID(), grant],
      );
    }
    for (const name of scripts.filter((name) => Number(name.slice(0, 3)) > 16))
      await client.query(await readFile(new URL(name, directory), "utf8"));
    const connectionPool = {
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as Pool;
    // The established migration entrypoint must not add or rewrite expiry again.
    const before = (
      await client.query(
        "SELECT * FROM synthetic_entitlement_events ORDER BY id",
      )
    ).rows;
    await migrate(connectionPool);
    const exported = await memberExportStore(connectionPool).exportOwned(token);
    expect(exported.kind).toBe("ready");
    if (exported.kind !== "ready")
      throw Error("Migrated private export unavailable");
    expect(exported.payload.records.testUnitGrants).toHaveLength(2);
    expect(exported.payload.records.testUnitReservations).toHaveLength(2);
    expect(exported.payload.records.testUnitEvents).toHaveLength(2);
    expect(exported.payload.records.testUnitSettlements).toEqual([]);
    expect(
      exported.payload.records
        .testUnitEvents!.map((row) => row.quantity)
        .sort(),
    ).toEqual([0, 1]);
    for (const row of exported.payload.records.testUnitGrants!) {
      expect(row.available).toBe(0);
      expect(row.reserved).toBe(1);
      expect(row.startsAt).toEqual(row.createdAt);
      expect(row.expiresAt).toEqual(row.createdAt);
      expect(row.expiredAt).toEqual(row.createdAt);
    }
    expect(
      JSON.stringify(exported.payload.records.testUnitEvents),
    ).not.toContain("migration-017-expire");
    expect(
      (
        await client.query(
          "SELECT * FROM synthetic_entitlement_events ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
