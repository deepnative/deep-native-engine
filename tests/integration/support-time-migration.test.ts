import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
afterAll(async () => pool.end());
it("upgrades populated legacy support requests and note grants twice without backfilling time privileges or effort", async () => {
  const schema = `legacy_support_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter(
        (name) =>
          /^\d{3}-.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 53,
      )
      .sort())
      await client.query(await readFile(new URL(name, directory), "utf8"));
    const scoped = {
      query: client.query.bind(client),
      async connect() {
        return { query: client.query.bind(client), release() {} };
      },
    } as unknown as Pool;
    const members = store(scoped),
      support = supportRequestStore(scoped),
      auth = authorizationStore(scoped);
    const token = randomBytes(32).toString("hex"),
      admin = randomBytes(32).toString("hex"),
      operator = randomBytes(32).toString("hex");
    await members.create(token, { background: "professional", goal: "work" });
    const member = await members.session(token);
    if (member.kind !== "active") throw Error("Missing legacy member");
    const expiresAt = new Date(Date.now() + 3600000),
      startsAt = new Date(Date.now() - 60000);
    await auth.provisionStaff(admin, "platform_admin", expiresAt);
    const staffId = await auth.provisionStaff(operator, "operator", expiresAt);
    const budgetId = await syntheticLedger(scoped).grant(
      member.learner.id,
      "support_minutes",
      20,
      randomUUID(),
      { startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() },
    );
    const created = await support.create(token, {
      idempotencyKey: randomUUID(),
      subject: "Legacy invented request",
      body: "Retained private sample",
    });
    if (!("receipt" in created)) throw Error("Missing legacy request");
    const requestId = created.receipt.requestId;
    const granted = await support.grant(admin, {
      requestId,
      staffId,
      role: "operator",
      idempotencyKey: randomUUID(),
      startsAt,
      expiresAt,
    });
    if (!("grantId" in granted)) throw Error("Missing legacy note grant");
    const scope = { requestId, grantId: granted.grantId };
    expect(
      (
        await support.note(
          operator,
          scope,
          randomUUID(),
          "Legacy internal sample",
        )
      ).kind,
    ).toBe("applied");
    const before = (
      await client.query("SELECT * FROM support_request_grants WHERE id=$1", [
        granted.grantId,
      ])
    ).rows;
    const migration = await readFile(
      new URL("054-support-test-time.sql", directory),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    expect(
      (
        await client.query("SELECT * FROM support_request_grants WHERE id=$1", [
          granted.grantId,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          "SELECT subject,body FROM support_requests WHERE id=$1",
          [requestId],
        )
      ).rows,
    ).toEqual([
      { subject: "Legacy invented request", body: "Retained private sample" },
    ]);
    expect(
      (
        await client.query(
          "SELECT body FROM support_request_notes WHERE request_id=$1",
          [requestId],
        )
      ).rows,
    ).toEqual([{ body: "Legacy internal sample" }]);
    for (const table of [
      "support_time_grants",
      "support_time_allocations",
      "support_time_entries",
      "support_time_units",
      "support_time_events",
    ])
      expect(
        (await client.query(`SELECT count(*)::integer n FROM ${table}`)).rows,
      ).toEqual([{ n: 0 }]);
    expect(
      (
        await support.note(
          operator,
          scope,
          randomUUID(),
          "Post-upgrade unmetered note",
        )
      ).kind,
    ).toBe("applied");
    expect(
      (
        await client.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [budgetId],
        )
      ).rows,
    ).toEqual([{ available: 20, reserved: 0, consumed: 0 }]);
    expect(await support.time!.operatorWorklist(operator)).toMatchObject({
      kind: "ready",
      value: { items: [] },
    });
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
