import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// This test re-runs a one-time migration, so it owns a private database:
// a shared one would let migration 090 rename other files' accounts.
const control = testPool();
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
url.pathname = `/${name}`;
// Opt in: outside the hosted database the backfill is otherwise skipped.
const pool = new Pool({
  connectionString: url.href,
  options: "-c dne.backfill_test_names=on",
});
const members = store(pool);
// Creating and fully migrating a fresh database can take well over the
// default hook time while the other integration lanes run.
beforeAll(async () => {
  await control.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
}, 120_000);
afterAll(async () => {
  await pool.end();
  await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.end();
}, 60_000);

async function member(displayName?: string) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  if (displayName)
    await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
      session.learner.id,
      displayName,
    ]);
  return session.learner.id;
}
const named = (id: string) =>
  pool
    .query<{
      display_name: string | null;
    }>("SELECT display_name FROM learners WHERE id=$1", [id])
    .then((r) => r.rows[0]!.display_name);
const rates = (id: string) =>
  pool
    .query<{
      cents: number;
    }>("SELECT cents FROM coaching_rates WHERE owner_id=$1", [id])
    .then((r) => r.rows.map((row) => row.cents));

it("TESTNAME-01/02/03 names existing unnamed test accounts once, with CAD 30-50 rates, and never the owner", async () => {
  // Accounts that existed before the one-time release step.
  await pool.query("DELETE FROM schema_migrations WHERE version=90");
  const unnamed = [await member(), await member(), await member()];
  const alreadyNamed = await member("Chosen name");
  const owner = await member();
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
    [createHash("sha256").update("tom@deepnative.io").digest("hex"), owner],
  );
  const ratedId = unnamed[2]!;
  await pool.query(
    "INSERT INTO coaching_rates(id,owner_id,effective_month,cents,version) VALUES(gen_random_uuid(),$1,'2026-01',9900,1)",
    [ratedId],
  );

  await migrate(pool);

  const names = await Promise.all(unnamed.map(named));
  for (const name of names)
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \(test\)$/);
  expect(new Set(names).size).toBe(names.length);
  expect(await named(alreadyNamed)).toBe("Chosen name");
  expect(await named(owner)).toBeNull();
  for (const id of unnamed.slice(0, 2)) {
    const [cents, ...rest] = await rates(id);
    expect(rest).toEqual([]);
    expect(cents! % 100).toBe(0);
    expect(cents).toBeGreaterThanOrEqual(3000);
    expect(cents).toBeLessThanOrEqual(5000);
  }
  expect(await rates(ratedId)).toEqual([9900]);
  expect(await rates(alreadyNamed)).toEqual([]);
  expect(await rates(owner)).toEqual([]);

  // Every later startup, and every later registration, is untouched.
  const later = await member();
  await migrate(pool);
  expect(await named(later)).toBeNull();
  expect(await rates(later)).toEqual([]);
  expect(await Promise.all(unnamed.map(named))).toEqual(names);
});

it("TESTNAME-04 leaves local, preview and test databases' accounts unnamed", async () => {
  const plain = new Pool({ connectionString: url.href });
  try {
    await plain.query("DELETE FROM schema_migrations WHERE version=90");
    const id = await member();
    await migrate(plain);
    expect(await named(id)).toBeNull();
    expect(await rates(id)).toEqual([]);
  } finally {
    await plain.end();
  }
});
