import type { Pool } from "pg";

// #188 The database refuses an unrecorded change to the test spending
// ceiling. Test setup still needs a known ceiling and total, so it suspends
// that table's triggers inside one transaction, where the change is visible
// and undone by failure. Only the table owner can do this; application code
// changes the ceiling through a recorded administrator change.
export async function setTestCeiling(
  pool: Pool,
  values: { ceiling: number; committed?: number } | { room: number },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE ai_test_spending_ceiling DISABLE TRIGGER USER",
    );
    if ("room" in values)
      await client.query(
        "UPDATE ai_test_spending_ceiling SET ceiling_points=committed_points+$1",
        [values.room],
      );
    else
      await client.query(
        "UPDATE ai_test_spending_ceiling SET ceiling_points=$1,committed_points=COALESCE($2,committed_points)",
        [values.ceiling, values.committed ?? null],
      );
    await client.query(
      "ALTER TABLE ai_test_spending_ceiling ENABLE TRIGGER USER",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
