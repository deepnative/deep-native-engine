import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { ApplicationMode } from "../../src/adapters.ts";
import {
  disabledInvoiceReconciliationStore,
  reconcileInvoices,
  type InvoiceFact,
  type InvoiceReconciliationStore,
} from "../../src/invoice-reconciliation.ts";
import type { Store } from "../../src/store.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import { COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";

const token = "a".repeat(64),
  secret = "invented-route-test",
  origin = "http://127.0.0.1:3000",
  path = "/operator/invoice-reconciliation",
  fact: InvoiceFact = {
    id: "00000000-0000-4000-8000-000000000001",
    sample: true,
    linked: true,
    voided: false,
    totalCents: 3000,
    paidCents: 1000,
    refundedCents: 0,
    documentTotalCents: 3000,
    documentSample: true,
    issuedOn: "2026-11-01",
    receipts: 1,
    receiptCents: 1000,
    refunds: 0,
    refundCents: 0,
    simulatedReceiptCents: 0,
    simulatedRefundCents: 0,
    firstReceipt: "2026-11-02",
    firstRefund: null,
    lateEvents: 0,
    lateCents: 0,
  },
  value = reconcileInvoices(
    [fact],
    {
      comparedMembers: 1,
      mismatchedMembers: 0,
      mismatchCents: 0,
      notComparableInvoices: 0,
    },
    new Date("2026-11-06T12:00:00Z"),
  );
const members = {
  session: vi.fn(async () => ({ kind: "none" })),
} as unknown as Store;
function application(
  store: InvoiceReconciliationStore,
  mode: ApplicationMode = "test",
) {
  return app(members, {
    origin,
    secret,
    mode,
    tracks: disabledTrackStore(),
    invoiceReconciliation: store,
  });
}
const read = (a: ReturnType<typeof app>, url = path) =>
  withLoopback(a, (s) =>
    request(s)
      .get(url)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );

it("RECON-02 shows invoiced amounts and collected cash from the snapshot", async () => {
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const r = await read(application({ snapshot }));
  expect(r.status).toBe(200);
  expect(snapshot).toHaveBeenCalledWith(token);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.text).toContain("Invoice and cash reconciliation");
  expect(r.text).toMatch(/data-field="invoiced">CAD 30\.00/);
  expect(r.text).toMatch(/data-field="net">CAD 10\.00/);
});

it("RECON-04 live mode refuses before reading anything", async () => {
  const snapshot = vi.fn(async () => ({ kind: "ready" as const, value }));
  const r = await read(application({ snapshot }, "live"));
  expect(r.status).toBe(404);
  expect(r.text).toContain("no live figures");
  expect(r.text).not.toContain("CAD");
  expect(snapshot).not.toHaveBeenCalled();
});

it("RECON-10 denial and query fields show no amounts", async () => {
  const snapshot = vi.fn(async () => ({ kind: "denied" as const }));
  const denied = await read(application({ snapshot }));
  expect(denied.status).toBe(403);
  expect(denied.text).not.toContain("CAD");
  snapshot.mockClear();
  const query = await read(application({ snapshot }), `${path}?group=sample`);
  expect(query.status).toBe(400);
  expect(snapshot).not.toHaveBeenCalled();
});

it("RECON-12 an unconfirmed snapshot shows no figures", async () => {
  const r = await read(application(disabledInvoiceReconciliationStore()));
  expect(r.status).toBe(503);
  expect(r.text).toContain("could not be confirmed");
  expect(r.text).not.toContain("CAD");
});
