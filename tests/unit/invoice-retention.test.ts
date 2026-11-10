import type { Request, Response } from "express";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  invoiceRetention,
  RETENTION_SWEEP_INTERVAL_MS,
} from "../../src/invoice-retention.ts";
import { takeLandingNotice } from "../../src/landing-notice.ts";
import {
  BILLING_RETENTION,
  billingRetainedUntil,
} from "../../src/retention.ts";
import { welcome } from "../../src/views.ts";

// #12 D08, owner decisions of 10 Nov 2026: Deep Native Inc.'s tax year ends on
// 31 December; a deleted account's issued invoices are kept until 31 December
// six years after the invoice's tax year, then removed automatically.
const pool = (query: ReturnType<typeof vi.fn>) =>
  ({ query }) as unknown as Pool;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();

it("RETEXP-04 the billing exception names the tax-year end, an example date and automatic removal", () => {
  expect(BILLING_RETENTION).toContain(
    "until December 31, 6 years after the tax year of the invoice (Deep Native Inc.'s tax year ends on December 31). An invoice from 2026 is kept until December 31, 2032. Then the invoice and its payment records are removed automatically.",
  );
  expect(billingRetainedUntil("2032-12-31")).toBe(
    "Your issued invoices and their payment records are kept until December 31, 2032, then removed automatically.",
  );
  expect(RETENTION_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
});

it("RETEXP-02 reads the account's last kept-invoice date, and says nothing specific when it can't", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ until: "2032-12-31" }] })
    .mockResolvedValueOnce({ rows: [{ until: null }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(Error("down"));
  const r = invoiceRetention(pool(query));
  expect(await r.retainedUntil("owner")).toBe("2032-12-31");
  expect(query.mock.calls[0]![1]).toEqual(["owner"]);
  expect(String(query.mock.calls[0]![0])).toContain("NOT sample");
  expect(await r.retainedUntil("owner")).toBeNull();
  expect(await r.retainedUntil("owner")).toBeNull();
  expect(await r.retainedUntil("owner")).toBeNull();
});

it("RETEXP-01 removes a bounded batch of unlinked, expired invoices and reports a failed sweep", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rowCount: 3 })
    .mockResolvedValueOnce({ rowCount: null })
    .mockRejectedValueOnce(Error("down"));
  const r = invoiceRetention(pool(query));
  expect(await r.removeExpired(25)).toBe(3);
  const sql = String(query.mock.calls[0]![0]);
  expect(query.mock.calls[0]![1]).toEqual([25]);
  for (const part of [
    "owner_id IS NULL AND NOT sample",
    "simple_invoice_retained_until(document) < toronto_today()",
    "FOR UPDATE SKIP LOCKED",
    "INSERT INTO simple_invoice_retention_removals",
  ])
    expect(sql).toContain(part);
  expect(await r.removeExpired()).toBe(0);
  expect(query.mock.calls[1]![1]).toEqual([100]);
  expect(await r.removeExpired()).toBeNull();
});

it("RETEXP-02 the deletion notice cookie accepts only a 31 December date and shows it", () => {
  const take = (value: unknown) =>
    takeLandingNotice(
      { cookies: { dne_landing_notice: value } } as unknown as Request,
      { clearCookie: vi.fn() } as unknown as Response,
      "https://engine.example.test",
    );
  expect(take("deleted-until-2032-12-31")).toBe("deleted-until-2032-12-31");
  for (const bad of [
    "deleted-until-2032-06-30",
    "deleted-until-1999-12-31",
    "deleted-until-<b>",
    "deleted-until-2032-12-31x",
    42,
  ])
    expect(take(bad)).toBeUndefined();
  const dated = text(
    welcome(
      "csrf",
      [],
      undefined,
      false,
      undefined,
      "deleted-until-2032-12-31",
    ),
  );
  expect(dated).toContain(
    "Not everything is erased yet. Issued invoices and the payments and refunds recorded against them are kept after the account is deleted",
  );
  expect(dated).toContain(
    "Then the invoice and its payment records are removed automatically. Your issued invoices and their payment records are kept until December 31, 2032, then removed automatically. Copies in service backups are kept for up to 30 days, then they expire.",
  );
  const plain = text(
    welcome("csrf", [], undefined, false, undefined, "deleted"),
  );
  expect(plain).not.toContain("Your issued invoices");
  expect(plain).toContain("Not everything is erased yet.");
});
