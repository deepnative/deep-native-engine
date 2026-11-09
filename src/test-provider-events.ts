import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import type { Pool } from "pg";
import {
  practiceTransaction,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import type { InvoiceResult } from "./simple-invoice-store.ts";
import {
  invoiceCents,
  invoiceDigest,
  invoiceEvidence,
  invoiceUuid,
} from "./simple-invoice-values.ts";

/** An invented local event. It is not a payment provider's contract or proof of money. */
export interface TestProviderEvent {
  id: string;
  type: "payment.succeeded" | "payment.failed" | "refund.succeeded";
  invoiceId: string;
  paymentRef: string;
  amountCents: number;
  occurredAt: string;
}
export type TestEventKind = "receipt" | "refund" | "failure" | "held";
export type TestEventOutcome = TestEventKind | "duplicate";
export interface InvoiceMoney {
  voided: boolean;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  /** Signed test rows already on this invoice. */
  events: Array<{
    kind: TestEventKind;
    paymentRef: string;
    amountCents: number;
  }>;
}

export const TEST_PROVIDER_PATH = "/test-provider/invoice-events";
export const TEST_PROVIDER_SIGNATURE = "X-DNE-Test-Signature";
const reference = /^[A-Za-z0-9_-]{1,80}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const TYPES = ["payment.succeeded", "payment.failed", "refund.succeeded"];
const FIELDS = "amountCents,id,invoiceId,occurredAt,paymentRef,type";

export function signTestProviderEvent(key: string, body: string | Buffer) {
  return "sha256=" + createHmac("sha256", key).update(body).digest("hex");
}
/** TESTPAY-03: the raw bytes are checked before anything reads them. */
export function validTestProviderSignature(
  key: string,
  header: unknown,
  body: unknown,
) {
  if (typeof header !== "string" || !Buffer.isBuffer(body)) return false;
  const expected = Buffer.from(signTestProviderEvent(key, body)),
    given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export function parseTestProviderEvent(body: Buffer): TestProviderEvent | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { id, type, invoiceId, paymentRef, amountCents, occurredAt } = value;
  if (
    Object.keys(value).sort().join() !== FIELDS ||
    typeof id !== "string" ||
    !reference.test(id) ||
    // Shares the receipt rule, so an ID can't carry a card-like digit run.
    !invoiceEvidence(`Test event ${id}`) ||
    typeof paymentRef !== "string" ||
    !reference.test(paymentRef) ||
    !TYPES.includes(String(type)) ||
    !invoiceUuid(invoiceId) ||
    !invoiceCents(amountCents) ||
    amountCents === 0 ||
    typeof occurredAt !== "string" ||
    !instant.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  )
    return null;
  return {
    id,
    type: type as TestProviderEvent["type"],
    invoiceId,
    paymentRef,
    amountCents,
    occurredAt,
  };
}
/**
 * TESTPAY-06/07: what one event does to an invoice. A failure never moves money, so a
 * stale one can't undo a payment or read as a refund. A refund waits for its payment.
 */
export function testEventEffect(
  money: InvoiceMoney,
  event: Pick<TestProviderEvent, "type" | "paymentRef" | "amountCents">,
): TestEventKind {
  if (event.type === "payment.failed") return "failure";
  const same = money.events.filter((e) => e.paymentRef === event.paymentRef),
    receipt = same.find((e) => e.kind === "receipt");
  if (event.type === "payment.succeeded")
    return money.voided ||
      receipt ||
      event.amountCents > money.totalCents - money.paidCents
      ? "held"
      : "receipt";
  const refunded = same
    .filter((e) => e.kind === "refund")
    .reduce((sum, e) => sum + e.amountCents, 0);
  return receipt &&
    refunded + event.amountCents <= receipt.amountCents &&
    event.amountCents <= money.paidCents - money.refundedCents
    ? "refund"
    : "held";
}

/** SVC: no row is awaiting payment; a row grants nothing. */
export type SampleServiceState = "awaiting_payment" | "ready" | "withdrawn";
/**
 * SVC-01/02/03: only signed test receipts and refunds move the simulated service, never a
 * staff record nobody verified. Both sums only grow, so the state only moves forward and
 * every arrival order ends in the same state.
 */
export function sampleServiceState(
  totalCents: number,
  events: InvoiceMoney["events"],
): SampleServiceState {
  const sum = (kind: TestEventKind) =>
    events
      .filter((e) => e.kind === kind)
      .reduce((total, e) => total + e.amountCents, 0);
  const received = sum("receipt");
  if (received < totalCents) return "awaiting_payment";
  return received - sum("refund") >= totalCents ? "ready" : "withdrawn";
}

type StoredEvent = {
  kind: TestEventKind;
  id: string;
  type: TestProviderEvent["type"];
  paymentRef: string;
  amountCents: string;
  digest: string;
  occurredAt: string;
};
const HISTORY = {
  receipt: "test_payment_received",
  refund: "test_refund_recorded",
  failure: "test_payment_failed",
} as const;

export function testProviderEventStore(pool: Pool) {
  async function record(
    tx: PracticeTransaction,
    invoiceId: string,
    ownerId: string,
    kind: TestEventKind,
    event: Omit<TestProviderEvent, "invoiceId">,
    digest: string,
  ) {
    await tx.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,verification,evidence_reference,
         provider_event_id,provider_payment_ref,provider_event_type,provider_event_digest,provider_occurred_at)
       VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'UTC')::date,$5,'signed_test_event',$6,$7,$8,$9,$10,$4::timestamptz)`,
      [
        randomUUID(),
        invoiceId,
        event.amountCents,
        event.occurredAt,
        kind,
        `Test event ${event.id}`,
        event.id,
        event.paymentRef,
        event.type,
        digest,
      ],
    );
    if (kind === "held") return;
    if (kind !== "failure")
      await tx.query(
        `UPDATE simple_invoices SET ${kind === "receipt" ? "paid_cents=paid_cents" : "refunded_cents=refunded_cents"}+$2,revision=revision+1 WHERE id=$1`,
        [invoiceId, event.amountCents],
      );
    await tx.query(
      "INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents) VALUES(NULL,$1,$2,$3)",
      [HISTORY[kind], ownerId, event.amountCents],
    );
  }
  async function read(tx: PracticeTransaction, invoiceId: string) {
    const invoice = (
      await tx.query<{
        ownerId: string;
        sample: boolean;
        voided: boolean;
        totalCents: string;
        paidCents: string;
        refundedCents: string;
      }>(
        `SELECT owner_id AS "ownerId",sample,void_reason IS NOT NULL AS voided,total_cents AS "totalCents",
                paid_cents AS "paidCents",refunded_cents AS "refundedCents"
         FROM simple_invoices WHERE id=$1 FOR UPDATE`,
        [invoiceId],
      )
    ).rows[0];
    if (!invoice?.sample) return null;
    const stored = (
      await tx.query<StoredEvent>(
        `SELECT kind,provider_event_id AS id,provider_event_type AS type,provider_payment_ref AS "paymentRef",
                amount_cents AS "amountCents",provider_event_digest AS digest,
                to_char(provider_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
         FROM simple_invoice_payments
         WHERE invoice_id=$1 AND verification='signed_test_event' ORDER BY provider_occurred_at,provider_event_id`,
        [invoiceId],
      )
    ).rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    const money: InvoiceMoney = {
      voided: invoice.voided,
      totalCents: Number(invoice.totalCents),
      paidCents: Number(invoice.paidCents),
      refundedCents: Number(invoice.refundedCents),
      events: stored,
    };
    return { ownerId: invoice.ownerId, money, stored };
  }
  return {
    async apply(
      event: TestProviderEvent,
    ): Promise<InvoiceResult<{ outcome: TestEventOutcome }>> {
      const digest = invoiceDigest(event);
      try {
        return await practiceTransaction(pool, async (tx) => {
          // No session limits this write, so its authority is the transaction's own deadline.
          await tx.observe([new Date(Date.now() + 10_000)]);
          // Serializes one event ID across invoices; each transaction takes only one.
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,32))",
            [event.id],
          );
          const previous = (
            await tx.query<{ digest: string }>(
              "SELECT provider_event_digest AS digest FROM simple_invoice_payments WHERE provider_event_id=$1 LIMIT 1",
              [event.id],
            )
          ).rows[0];
          if (previous)
            return previous.digest === digest
              ? { kind: "ready", value: { outcome: "duplicate" } }
              : { kind: "conflict" };
          const before = await read(tx, event.invoiceId);
          if (!before) return { kind: "not-found" };
          const kind = testEventEffect(before.money, event);
          await record(
            tx,
            event.invoiceId,
            before.ownerId,
            kind,
            event,
            digest,
          );
          if (kind === "receipt") {
            // TESTPAY-06: refunds that arrived before this payment apply now, once.
            const after = (await read(tx, event.invoiceId))!;
            const applied = new Set(
              after.stored.filter((e) => e.kind === "refund").map((e) => e.id),
            );
            for (const waiting of after.stored) {
              if (
                waiting.kind !== "held" ||
                waiting.type !== "refund.succeeded" ||
                applied.has(waiting.id) ||
                testEventEffect(after.money, waiting) !== "refund"
              )
                continue;
              await record(
                tx,
                event.invoiceId,
                after.ownerId,
                "refund",
                waiting,
                waiting.digest,
              );
              after.money.refundedCents += waiting.amountCents;
              after.money.events = [
                ...after.money.events,
                { ...waiting, kind: "refund" },
              ];
            }
          }
          if (kind === "receipt" || kind === "refund") {
            // SVC-02/03: append the state this event reached, once.
            const now = (await read(tx, event.invoiceId))!,
              state = sampleServiceState(now.money.totalCents, now.stored);
            if (state !== "awaiting_payment")
              await tx.query(
                `INSERT INTO sample_service_states(id,invoice_id,state,cause_event_id) VALUES($1,$2,$3,$4)
                 ON CONFLICT (invoice_id,state) DO NOTHING`,
                [randomUUID(), event.invoiceId, state, event.id],
              );
          }
          return { kind: "ready", value: { outcome: kind } };
        });
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
export type TestProviderEventStore = ReturnType<typeof testProviderEventStore>;
export interface TestProviderEvents {
  key: string;
  store: TestProviderEventStore;
}

/** TESTPAY-01: mounted only when configured, so it is absent by default. */
export function mountTestProviderEvents(
  app: Express,
  { key, store }: TestProviderEvents,
) {
  app.post(
    TEST_PROVIDER_PATH,
    express.raw({ type: "*/*", limit: "8kb" }),
    (req, res, next) => {
      if (
        !validTestProviderSignature(
          key,
          req.get(TEST_PROVIDER_SIGNATURE),
          req.body,
        )
      ) {
        res.status(401).json({ error: "invalid-signature" });
        return;
      }
      const event = parseTestProviderEvent(req.body as Buffer);
      if (!event || Date.parse(event.occurredAt) > Date.now()) {
        res.status(422).json({ error: "invalid-event" });
        return;
      }
      store
        .apply(event)
        .then((result) => {
          if (result.kind === "ready") {
            res.json({ outcome: result.value.outcome });
            return;
          }
          res
            .status(
              { conflict: 409, "not-found": 404, unavailable: 503 }[
                result.kind as "conflict" | "not-found" | "unavailable"
              ],
            )
            .json({ error: result.kind });
        })
        .catch(next);
    },
  );
}
