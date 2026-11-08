import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// OPKEY-05 (#42): a member's operation key is unique only within that member,
// so another member's key can neither be discovered nor block your own write.
const pool = testPool();
beforeAll(async () => migrate(pool));
afterAll(async () => pool.end());

const tables = [
  "provided_evidence_operations",
  "assignment_evidence_operations",
  "proposal_publications",
];

async function uniqueKeys(table: string) {
  return (
    await pool.query<{ columns: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=$1::regclass AND i.indisunique
        GROUP BY i.indexrelid
       HAVING bool_or(a.attname='operation_id')`,
      [table],
    )
  ).rows.map((row) => row.columns);
}

it("OPKEY-05 re-running every migration keeps operation keys unique per member only", async () => {
  await migrate(pool);
  for (const table of tables)
    expect(await uniqueKeys(table), table).toEqual([
      ["member_id", "operation_id"],
    ]);
});
