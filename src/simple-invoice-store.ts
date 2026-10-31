import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  invoiceCents,
  invoiceDate,
  invoiceDigest,
  invoicePeriod,
  invoiceText,
  invoiceTotal,
  invoiceUuid,
  validInvoiceTerms,
  type InvoiceTerms,
} from "./simple-invoice-values.ts";
import { normalizedEmail } from "./member-email-access.ts";
import type { SimpleInvoiceDocument } from "./simple-invoice-views.ts";

export type InvoiceFailure = {
  kind: "denied" | "invalid" | "conflict" | "unavailable" | "not-found";
};
export type InvoiceResult<T> = { kind: "ready"; value: T } | InvoiceFailure;
export interface InvoicePlan {
  id: string;
  ownerId: string;
  terms: InvoiceTerms;
  state: "offered" | "active" | "cancelled";
  revision: number;
  nextCycle: number;
}
export interface StoredInvoice {
  id: string;
  document: SimpleInvoiceDocument;
  totalCents: number;
  paidCents: number;
  revision: number;
  voidReason: string | null;
  delivery: "not_sent" | "sending" | "sent" | "unconfirmed";
}
export interface InvoiceOverview {
  plans: InvoicePlan[];
  invoices: StoredInvoice[];
}
export interface InvoiceSettings {
  sample: boolean;
  issuer: string;
  instructions: string;
}
const fail = (kind: InvoiceFailure["kind"]): InvoiceFailure => ({ kind });
const planColumns =
  'id,owner_id AS "ownerId",terms,state,revision,next_cycle AS "nextCycle"';
const invoiceColumns =
  'id,document,total_cents AS "totalCents",paid_cents AS "paidCents",revision,delivery,void_reason AS "voidReason"';
const decodeInvoice = (row: StoredInvoice): StoredInvoice => ({
  ...row,
  totalCents: Number(row.totalCents),
  paidCents: Number(row.paidCents),
  document: {
    ...row.document,
    paidCents: Number(row.paidCents),
    ...(row.voidReason ? { voidReason: row.voidReason } : {}),
  },
});
export function simpleInvoiceStore(pool: Pool, settings: InvoiceSettings) {
  async function run<T>(
    token: string,
    admin: boolean,
    use: (
      tx: PracticeTransaction,
      actor: string,
      expiry: Date,
    ) => Promise<InvoiceResult<T>>,
  ): Promise<InvoiceResult<T>> {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return fail("denied");
    try {
      return await practiceTransaction(pool, async (tx) => {
        const actor = (
          await tx.query<{ id: string; kind: string; expires: Date }>(
            "SELECT id,kind,expires_at AS expires FROM principals WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
            [hash(token)],
          )
        ).rows[0];
        if (!actor || actor.kind !== (admin ? "staff" : "member"))
          throw new PracticeLifetimeFailure("denied");
        await tx.observe([actor.expires]);
        if (admin) {
          const role = (
            await tx.query<{ role: string }>(
              "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
              [actor.id],
            )
          ).rows[0];
          if (role?.role !== "platform_admin")
            throw new PracticeLifetimeFailure("denied");
        }
        const result = await use(tx, actor.id, actor.expires);
        await tx.observe([actor.expires]);
        return result;
      });
    } catch (error) {
      return fail(
        error instanceof PracticeLifetimeFailure && error.kind === "denied"
          ? "denied"
          : "unavailable",
      );
    }
  }
  async function owner(tx: PracticeTransaction, id: string, durable = false) {
    const row = (
      await tx.query<{ expires: Date }>(
        "SELECT p.expires_at AS expires FROM principals p JOIN learners l ON l.id=p.id WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL AND ($2::boolean OR p.expires_at>clock_timestamp()) FOR SHARE OF p",
        [id, durable],
      )
    ).rows[0];
    if (!row) throw new PracticeLifetimeFailure("denied");
    if (!durable) await tx.observe([row.expires]);
    const w = await tx.query(
      "SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE",
      [id],
    );
    if (!w.rowCount) throw new PracticeLifetimeFailure("denied");
  }
  async function replay<T>(
    tx: PracticeTransaction,
    actor: string,
    key: string,
    digest: string,
  ): Promise<InvoiceResult<T> | null> {
    const previous = (
      await tx.query<{ digest: string; result: T }>(
        "SELECT digest,result FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2",
        [actor, key],
      )
    ).rows[0];
    return previous
      ? previous.digest === digest
        ? { kind: "ready", value: previous.result }
        : fail("conflict")
      : null;
  }
  async function remember<T>(
    tx: PracticeTransaction,
    actor: string,
    key: string,
    digest: string,
    value: T,
  ): Promise<InvoiceResult<T>> {
    await tx.query(
      "INSERT INTO simple_invoice_operations(actor_id,operation_id,digest,result) VALUES($1,$2,$3,$4)",
      [actor, key, digest, JSON.stringify(value)],
    );
    return { kind: "ready", value };
  }
  async function coursesEligible(
    tx: PracticeTransaction,
    ownerId: string,
    terms: InvoiceTerms,
    current = true,
  ) {
    for (const course of terms.courses) {
      const row = (
        await tx.query<{ title: string }>(
          `SELECT title FROM content_versions c WHERE id=$1 AND version=$2 AND state='published' AND kind='lesson' AND NOT requires_qualified_signoff AND (NOT $4::boolean OR version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published')) AND member_content_eligible($3,id,version) FOR SHARE`,
          [course.id, course.version, ownerId, current],
        )
      ).rows[0];
      if (!row || row.title !== course.description) return false;
    }
    return true;
  }
  async function issue(
    tx: PracticeTransaction,
    plan: InvoicePlan,
    name: string,
    email: string,
    cycle: number,
  ) {
    const id = randomUUID(),
      period = invoicePeriod(plan.terms.startsOn, cycle);
    const document: SimpleInvoiceDocument & { recipientEmail: string } = {
      number: `DN-${id}`,
      issuedOn: (
        await tx.query<{ today: string }>(
          "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
        )
      ).rows[0]!.today,
      issuer: plan.terms.issuer,
      billedTo: name,
      recipientEmail: email,
      lines: plan.terms.courses.map((c) => ({
        description: `${c.description} · ${c.id} version ${c.version}`,
        amountCents: c.amountCents,
      })),
      billing:
        plan.terms.cadence === "one_time"
          ? { kind: "one_time" }
          : {
              kind: "recurring",
              periodStart: period.start,
              periodEnd: period.end,
            },
      currency: "CAD",
      taxCents: plan.terms.taxCents,
      paidCents: 0,
      instructions: plan.terms.instructions,
      sample: plan.terms.sample,
    };
    await tx.query(
      "INSERT INTO simple_invoices(id,plan_id,owner_id,cycle,document,sample,total_cents) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        plan.id,
        plan.ownerId,
        cycle,
        JSON.stringify(document),
        plan.terms.sample,
        invoiceTotal(plan.terms),
      ],
    );
    await tx.query(
      "UPDATE simple_invoice_plans SET next_cycle=$2,revision=revision+1 WHERE id=$1",
      [plan.id, cycle + 1],
    );
    return id;
  }
  async function due(
    tx: PracticeTransaction,
  ): Promise<InvoiceResult<{ created: number }>> {
    const candidates = (
      await tx.query<{ id: string; owner_id: string }>(
        "SELECT b.id,b.owner_id FROM simple_invoice_plans b JOIN principals p ON p.id=b.owner_id JOIN workspaces w ON w.id=b.workspace_id WHERE b.state='active' AND b.accepted_at IS NOT NULL AND b.recipient_name IS NOT NULL AND b.recipient_email IS NOT NULL AND b.terms->>'cadence'='monthly' AND b.next_cycle<=1200 AND ((b.terms->>'startsOn')::date+make_interval(months=>b.next_cycle))::date<=(clock_timestamp() AT TIME ZONE 'UTC')::date AND p.revoked_at IS NULL AND w.deleting_at IS NULL ORDER BY b.owner_id,b.id LIMIT 50",
      )
    ).rows;
    let created = 0;
    for (const candidate of candidates) {
      await owner(tx, candidate.owner_id, true);
      const plan = (
        await tx.query<InvoicePlan & { name: string; email: string }>(
          `SELECT ${planColumns},recipient_name AS name,recipient_email AS email FROM simple_invoice_plans WHERE id=$1 FOR UPDATE`,
          [candidate.id],
        )
      ).rows[0];
      if (!plan || plan.state !== "active" || plan.nextCycle > 1200) continue;
      const period = invoicePeriod(plan.terms.startsOn, plan.nextCycle),
        today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
      if (
        period.start > today ||
        !(await coursesEligible(tx, plan.ownerId, plan.terms, false))
      )
        continue;
      await issue(tx, plan, plan.name, plan.email, plan.nextCycle);
      created++;
    }
    return { kind: "ready", value: { created } };
  }
  return {
    // shortcut: Lists show 100 records; add pagination before account volume exceeds this bound.
    async overview(token: string): Promise<InvoiceResult<InvoiceOverview>> {
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const plans = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [actor],
          )
        ).rows;
        const invoices = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [actor],
          )
        ).rows.map(decodeInvoice);
        return { kind: "ready", value: { plans, invoices } };
      });
    },
    async adminOverview(token: string) {
      return run(token, true, async (tx) => {
        const members = (
          await tx.query<{ id: string }>(
            "SELECT l.id FROM learners l JOIN workspaces w ON w.owner_principal_id=l.id WHERE w.deleting_at IS NULL ORDER BY l.id LIMIT 100",
          )
        ).rows;
        const courses = (
          await tx.query<{ id: string; version: number; title: string }>(
            "SELECT id,version,title FROM content_versions c WHERE state='published' AND kind='lesson' AND NOT requires_qualified_signoff AND version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published') ORDER BY id",
          )
        ).rows;
        const invoices = (
          await tx.query<{ id: string; revision: number; delivery: string }>(
            "SELECT id,revision,delivery FROM simple_invoices ORDER BY created_at DESC LIMIT 100",
          )
        ).rows;
        return { kind: "ready", value: { members, courses, invoices } };
      });
    },
    async propose(
      token: string,
      input: {
        ownerId: string;
        operationId: string;
        courses: Array<{ id: string; version: number; amountCents: number }>;
        cadence: "one_time" | "monthly";
        startsOn: string;
        taxCents: number;
      },
    ): Promise<InvoiceResult<{ planId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.ownerId) ||
        !invoiceUuid(input.operationId) ||
        !Array.isArray(input.courses) ||
        input.courses.length < 1 ||
        input.courses.length > 20 ||
        !input.courses.every(
          (c) =>
            c &&
            typeof c === "object" &&
            invoiceText(c.id, 80) &&
            Number.isSafeInteger(c.version) &&
            c.version > 0 &&
            invoiceCents(c.amountCents),
        )
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        await owner(tx, input.ownerId);
        const digest = invoiceDigest({ action: "propose", input });
        const previous = await replay<{ planId: string }>(
          tx,
          actor,
          input.operationId,
          digest,
        );
        if (previous) return previous;
        const courses = [];
        for (const selected of input.courses) {
          const row = (
            await tx.query<{ title: string }>(
              "SELECT title FROM content_versions WHERE id=$1 AND version=$2 FOR SHARE",
              [selected.id, selected.version],
            )
          ).rows[0];
          if (!row) return fail("invalid");
          courses.push({ ...selected, description: row.title });
        }
        const terms: InvoiceTerms = {
          courses,
          cadence: input.cadence,
          startsOn: input.startsOn,
          taxCents: input.taxCents,
          ...settings,
        };
        if (!validInvoiceTerms(terms)) return fail("invalid");
        const today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
        if (
          terms.startsOn < today ||
          !(await coursesEligible(tx, input.ownerId, terms))
        )
          return fail("conflict");
        const planId = randomUUID();
        await tx.query(
          "INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,created_by) VALUES($1,$2,$2,$3,$4)",
          [planId, input.ownerId, JSON.stringify(terms), actor],
        );
        return remember(tx, actor, input.operationId, digest, { planId });
      });
    },
    async accept(
      token: string,
      input: {
        planId: string;
        expectedRevision: number;
        operationId: string;
        name: string;
        email: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.planId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceText(input.name, 200) ||
        typeof input.email !== "string" ||
        !normalizedEmail(input.email)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "accept", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const plan = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
            [input.planId, actor],
          )
        ).rows[0];
        if (!plan) return fail("not-found");
        if (
          plan.state !== "offered" ||
          plan.revision !== input.expectedRevision ||
          !(await coursesEligible(tx, actor, plan.terms))
        )
          return fail("conflict");
        if (
          plan.terms.cadence === "monthly" &&
          (
            await tx.query(
              "SELECT 1 FROM simple_invoice_plans WHERE owner_id=$1 AND state='active' AND terms->>'cadence'='monthly'",
              [actor],
            )
          ).rowCount
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoice_plans SET state='active',accepted_at=clock_timestamp(),recipient_name=$2,recipient_email=$3 WHERE id=$1",
          [plan.id, input.name, normalizedEmail(input.email)],
        );
        const invoiceId = await issue(
          tx,
          plan,
          input.name,
          normalizedEmail(input.email)!,
          0,
        );
        return remember(tx, actor, input.operationId, digest, { invoiceId });
      });
    },
    async cancel(
      token: string,
      input: { planId: string; expectedRevision: number; operationId: string },
    ): Promise<InvoiceResult<{ cancelled: boolean }>> {
      if (
        !input ||
        !invoiceUuid(input.planId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision)
      )
        return fail("invalid");
      return run(token, false, async (tx, actor) => {
        await owner(tx, actor);
        const digest = invoiceDigest({ action: "cancel", input }),
          previous = await replay<{ cancelled: boolean }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const plan = (
          await tx.query<InvoicePlan>(
            `SELECT ${planColumns} FROM simple_invoice_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
            [input.planId, actor],
          )
        ).rows[0];
        if (!plan) return fail("not-found");
        if (
          plan.state === "cancelled" ||
          plan.revision !== input.expectedRevision
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoice_plans SET state='cancelled',revision=revision+1 WHERE id=$1",
          [plan.id],
        );
        return remember(tx, actor, input.operationId, digest, {
          cancelled: true,
        });
      });
    },
    async invoice(
      token: string,
      id: string,
      admin = false,
    ): Promise<InvoiceResult<StoredInvoice>> {
      if (!invoiceUuid(id)) return fail("invalid");
      return run(token, admin, async (tx, actor) => {
        if (!admin) await owner(tx, actor);
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 AND ($2::boolean OR owner_id=$3) FOR SHARE`,
            [id, admin, actor],
          )
        ).rows[0];
        return row
          ? { kind: "ready", value: decodeInvoice(row) }
          : fail("not-found");
      });
    },
    async pay(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
        amountCents: number;
        receivedOn: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceCents(input.amountCents) ||
        input.amountCents === 0 ||
        !invoiceDate(input.receivedOn)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const digest = invoiceDigest({ action: "pay", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
            [input.invoiceId],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        const invoice = decodeInvoice(row);
        const today = (
          await tx.query<{ today: string }>(
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
          )
        ).rows[0]!.today;
        if (
          invoice.voidReason !== null ||
          invoice.revision !== input.expectedRevision ||
          input.amountCents > invoice.totalCents - invoice.paidCents ||
          input.receivedOn > today
        )
          return fail("conflict");
        await tx.query(
          "INSERT INTO simple_invoice_payments(id,invoice_id,actor_id,amount_cents,received_on) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            invoice.id,
            actor,
            input.amountCents,
            input.receivedOn,
          ],
        );
        await tx.query(
          "UPDATE simple_invoices SET paid_cents=paid_cents+$2,revision=revision+1 WHERE id=$1",
          [invoice.id, input.amountCents],
        );
        return remember(tx, actor, input.operationId, digest, {
          invoiceId: invoice.id,
        });
      });
    },
    async voidInvoice(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
        reason: string;
      },
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision) ||
        !invoiceText(input.reason, 500)
      )
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const digest = invoiceDigest({ action: "void", input }),
          previous = await replay<{ invoiceId: string }>(
            tx,
            actor,
            input.operationId,
            digest,
          );
        if (previous) return previous;
        const row = (
          await tx.query<StoredInvoice>(
            `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
            [input.invoiceId],
          )
        ).rows[0];
        if (!row) return fail("not-found");
        if (
          row.revision !== input.expectedRevision ||
          row.voidReason !== null ||
          Number(row.paidCents) !== 0 ||
          row.delivery === "sending" ||
          row.delivery === "unconfirmed"
        )
          return fail("conflict");
        await tx.query(
          "UPDATE simple_invoices SET void_reason=$2,voided_at=clock_timestamp(),voided_by=$3,revision=revision+1 WHERE id=$1",
          [row.id, input.reason, actor],
        );
        return remember(tx, actor, input.operationId, digest, {
          invoiceId: row.id,
        });
      });
    },
    async inspect(
      token: string,
      key: string,
      admin = false,
    ): Promise<InvoiceResult<{ result: unknown }>> {
      if (!invoiceUuid(key)) return fail("invalid");
      return run(token, admin, async (tx, actor) => {
        if (!admin) await owner(tx, actor);
        const row = (
          await tx.query<{ result: unknown }>(
            "SELECT result FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2",
            [actor, key],
          )
        ).rows[0];
        return row ? { kind: "ready", value: row } : fail("not-found");
      });
    },
    async claimEmail(
      token: string,
      input: {
        invoiceId: string;
        expectedRevision: number;
        operationId: string;
      },
    ): Promise<InvoiceResult<{ send: boolean; invoice: StoredInvoice }>> {
      if (
        !input ||
        !invoiceUuid(input.invoiceId) ||
        !invoiceUuid(input.operationId) ||
        !invoiceCents(input.expectedRevision)
      )
        return fail("invalid");
      return run<{ send: boolean; invoice: StoredInvoice }>(
        token,
        true,
        async (tx, actor) => {
          const digest = invoiceDigest({ action: "email", input }),
            previous = await replay<{ invoiceId: string }>(
              tx,
              actor,
              input.operationId,
              digest,
            );
          if (previous && previous.kind !== "ready") return previous;
          const row = (
            await tx.query<StoredInvoice>(
              `SELECT ${invoiceColumns} FROM simple_invoices WHERE id=$1 FOR UPDATE`,
              [input.invoiceId],
            )
          ).rows[0];
          if (!row) return fail("not-found");
          if (previous)
            return {
              kind: "ready",
              value: { send: false, invoice: decodeInvoice(row) },
            };
          if (
            row.voidReason !== null ||
            row.revision !== input.expectedRevision ||
            row.delivery !== "not_sent"
          )
            return fail("conflict");
          await tx.query(
            "UPDATE simple_invoices SET delivery='sending',delivery_operation=$2,revision=revision+1 WHERE id=$1",
            [row.id, input.operationId],
          );
          await remember(tx, actor, input.operationId, digest, {
            invoiceId: row.id,
          });
          return {
            kind: "ready",
            value: { send: true, invoice: decodeInvoice(row) },
          };
        },
      );
    },
    async finishEmail(
      token: string,
      invoiceId: string,
      operationId: string,
      sent: boolean,
    ): Promise<InvoiceResult<{ invoiceId: string }>> {
      if (!invoiceUuid(invoiceId) || !invoiceUuid(operationId))
        return fail("invalid");
      return run(token, true, async (tx, actor) => {
        const receipt = (
          await tx.query(
            "SELECT 1 FROM simple_invoice_operations WHERE actor_id=$1 AND operation_id=$2 AND result->>'invoiceId'=$3",
            [actor, operationId, invoiceId],
          )
        ).rowCount;
        if (!receipt) return fail("denied");
        const updated = await tx.query(
          "UPDATE simple_invoices SET delivery=$3,revision=revision+1 WHERE id=$1 AND delivery_operation=$2 AND delivery='sending' RETURNING id",
          [invoiceId, operationId, sent ? "sent" : "unconfirmed"],
        );
        return updated.rowCount
          ? { kind: "ready", value: { invoiceId } }
          : fail("conflict");
      });
    },
    async generateDue(
      token: string,
    ): Promise<InvoiceResult<{ created: number }>> {
      return run(token, true, due);
    },
    async generateScheduled(): Promise<InvoiceResult<{ created: number }>> {
      try {
        return await practiceTransaction(pool, async (tx) => {
          // Accepted agreements authorize this bounded worker; browser expiry is not cancellation.
          const lease = (
            await tx.query<{ expires: Date }>(
              "SELECT clock_timestamp()+interval '10 seconds' AS expires",
            )
          ).rows[0]!;
          await tx.observe([lease.expires]);
          return due(tx);
        });
      } catch {
        return fail("unavailable");
      }
    },
  };
}
export type SimpleInvoiceStore = ReturnType<typeof simpleInvoiceStore>;
