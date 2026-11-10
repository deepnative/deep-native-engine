import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { invoiceRetention } from "../../src/invoice-retention.ts";
import { testPool } from "../support/database.ts";

// #12 D08, owner decisions of 10 Nov 2026: Deep Native Inc.'s tax year ends on
// 31 December. After the account is deleted, an issued invoice and its payment
// records are kept until 31 December six years after the invoice's tax year,
// then removed automatically. Invented people, numbers and amounts only.
const pool = testPool(),
  members = store(pool),
  retention = invoiceRetention(pool);
let year: number;
beforeAll(async () => {
  await migrate(pool);
  year = (
    await pool.query<{ y: number }>(
      "SELECT extract(year FROM toronto_today())::integer AS y",
    )
  ).rows[0]!.y;
});
afterAll(() => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error("Expected an active member");
  return s.learner.id;
}
async function invoice(ownerId: string, issuedYear: number, sample = false) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents) VALUES($1,$2,0,$3,$4,11300)",
    [
      id,
      ownerId,
      {
        number: `INV-RETEXP-${id.slice(0, 8)}`,
        issuedOn: `${issuedYear}-03-15`,
        issuer: "Deep Native Inc.",
        billedTo: "Invented retention student",
        recipientEmail: "invented-retention@example.invalid",
      },
      sample,
    ],
  );
  await pool.query(
    "INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,evidence_reference) VALUES($1,$2,4000,$3,'receipt','Invented e-Transfer reference')",
    [randomUUID(), id, `${issuedYear}-04-01`],
  );
  return id;
}
const exists = async (id: string) =>
  (await pool.query("SELECT 1 FROM simple_invoices WHERE id=$1", [id]))
    .rowCount === 1;
const payments = async (id: string) =>
  (
    await pool.query(
      "SELECT 1 FROM simple_invoice_payments WHERE invoice_id=$1",
      [id],
    )
  ).rowCount;

it("RETEXP-01/03 removes a deleted account's invoices once 31 December six years after their tax year has passed, and logs only dates and counts", async () => {
  const gone = await member(),
    living = await member();
  const due = await invoice(gone, year - 7),
    kept = await invoice(gone, year - 6),
    sample = await invoice(gone, year - 7, true),
    stillOwned = await invoice(living, year - 10);
  const before = new Date();
  await members.remove(gone);
  const unlinked = (
    await pool.query<{ id: string; owner_deleted_at: Date | null }>(
      "SELECT id,owner_deleted_at FROM simple_invoices WHERE id=ANY($1) ORDER BY id",
      [[due, kept]],
    )
  ).rows;
  expect(unlinked).toHaveLength(2);
  for (const row of unlinked)
    expect(row.owner_deleted_at!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  expect(await exists(sample)).toBe(false);

  expect(await retention.removeExpired(500)).toBeGreaterThanOrEqual(1);
  expect(await exists(due)).toBe(false);
  expect(await payments(due)).toBe(0);
  expect(await exists(kept)).toBe(true);
  expect(await payments(kept)).toBe(1);
  expect(await exists(stillOwned)).toBe(true);
  expect(await payments(stillOwned)).toBe(1);

  const log = (
    await pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(r) AS row FROM simple_invoice_retention_removals r WHERE invoice_id=$1",
      [due],
    )
  ).rows;
  expect(log).toHaveLength(1);
  expect(log[0]!.row).toMatchObject({
    tax_year: year - 7,
    retained_until: `${year - 1}-12-31`,
    payment_records: 1,
  });
  expect(log[0]!.row.owner_deleted_at).not.toBeNull();
  const logged = JSON.stringify(log[0]!.row);
  for (const fact of ["Invented", "invented-retention", "INV-RETEXP", "11300"])
    expect(logged).not.toContain(fact);

  // A second sweep finds nothing new for these invoices.
  await retention.removeExpired(500);
  expect(await exists(kept)).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM simple_invoice_retention_removals WHERE invoice_id=ANY($1)",
        [[kept, stillOwned]],
      )
    ).rowCount,
  ).toBe(0);
});

it("RETEXP-03 the database refuses early removal, a changed deletion date and changes to the removal log", async () => {
  const gone = await member(),
    living = await member();
  const kept = await invoice(gone, year - 6),
    due = await invoice(gone, year - 8),
    owned = await invoice(living, year - 10);
  await members.remove(gone);
  for (const id of [kept, owned])
    await expect(
      pool.query("DELETE FROM simple_invoices WHERE id=$1", [id]),
    ).rejects.toThrow("Issued invoice is retained");
  await expect(
    pool.query(
      "UPDATE simple_invoices SET owner_deleted_at=clock_timestamp() WHERE id=$1",
      [kept],
    ),
  ).rejects.toThrow("Invoice deletion date is immutable");
  await expect(
    pool.query(
      "UPDATE simple_invoices SET owner_deleted_at=clock_timestamp() WHERE id=$1",
      [owned],
    ),
  ).rejects.toThrow("Invoice deletion date is immutable");
  await retention.removeExpired(500);
  expect(await exists(due)).toBe(false);
  for (const sql of [
    "UPDATE simple_invoice_retention_removals SET payment_records=9 WHERE invoice_id=$1",
    "DELETE FROM simple_invoice_retention_removals WHERE invoice_id=$1",
  ])
    await expect(pool.query(sql, [due])).rejects.toThrow(
      "Invoice removal records are immutable",
    );
  // Re-running every migration keeps the rule, the dates and the log.
  await migrate(pool);
  await expect(
    pool.query("DELETE FROM simple_invoices WHERE id=$1", [kept]),
  ).rejects.toThrow("Issued invoice is retained");
  expect(
    (
      await pool.query(
        "SELECT 1 FROM simple_invoice_retention_removals WHERE invoice_id=$1",
        [due],
      )
    ).rowCount,
  ).toBe(1);
});

it("RETEXP-02 an account's kept-invoice date is 31 December six years after its latest issued invoice; sample invoices don't count", async () => {
  const owner = await member(),
    onlySample = await member(),
    none = await member();
  await invoice(owner, 2025);
  await invoice(owner, 2026);
  await invoice(onlySample, 2026, true);
  expect(await retention.retainedUntil(owner)).toBe("2032-12-31");
  expect(await retention.retainedUntil(onlySample)).toBeNull();
  expect(await retention.retainedUntil(none)).toBeNull();
  expect(
    (
      await pool.query<{ d: string }>(
        `SELECT to_char(simple_invoice_retained_until('{"issuedOn":"2026-01-01"}'::jsonb),'YYYY-MM-DD') AS d`,
      )
    ).rows[0]!.d,
  ).toBe("2032-12-31");
});
