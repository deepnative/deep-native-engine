import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import type { Pool, PoolClient } from "pg";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool);
const settings = {
  sample: true,
  issuer: "Invented invoice issuer",
  instructions: "Sample only; do not pay.",
};
const invoices = simpleInvoiceStore(pool, settings),
  origin = "http://127.0.0.1:3000",
  secret = "native-invoice-test";
const sent: string[] = [];
const application = app(members, {
  origin,
  secret,
  mode: "test",
  simpleInvoices: invoices,
  invoiceSender: {
    send: async (address) => {
      sent.push(address);
    },
  },
});
const ready = <T>(r: InvoiceResult<T>): T => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected invoice result");
  return r.value;
};
let admin: string, today: string;
async function staff(role: "platform_admin" | "reviewer" | "editor") {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3_600_000));
  return token;
}
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token, "account");
  if (session.kind !== "active") throw Error("Member fixture missing");
  return { token, id: session.learner.id };
}
const proposal = (
  ownerId: string,
  cadence: "one_time" | "monthly" = "one_time",
) => ({
  ownerId,
  operationId: randomUUID(),
  courses: [
    { id: "FND-001", version: 2, amountCents: 1000 },
    { id: "FND-002", version: 2, amountCents: 2000 },
  ],
  cadence,
  startsOn: today,
  taxCents: 0,
});
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (path: string, token: string, fields: Record<string, string>) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
async function accepted(
  cadence: "one_time" | "monthly" = "one_time",
  service = invoices,
) {
  const m = await member(),
    p = ready(await service.propose(admin, proposal(m.id, cadence)));
  const operationId = randomUUID();
  const result = ready(
    await service.accept(m.token, {
      planId: p.planId,
      expectedRevision: 1,
      operationId,
      name: "陳 · Invented student",
      email: "invented-student@example.invalid",
    }),
  );
  return { ...m, ...p, ...result, operationId };
}
beforeAll(async () => {
  await migrate(pool);
  await seedDraftPack(pool);
  admin = await staff("platform_admin");
  const editor = await staff("editor"),
    reviewer = await staff("reviewer");
  expect(await foundationImportStore(pool).import(editor)).toBe("imported");
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
  }
  today = (
    await pool.query<{ day: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
});
afterAll(() => pool.end());
it("OFFPUR-01/02/04/08/09 registers first, consolidates courses into one owner invoice and records only verified offline funds", async () => {
  const m = await member(),
    input = proposal(m.id),
    p = ready(await invoices.propose(admin, input));
  expect(ready(await invoices.overview(m.token)).invoices).toEqual([]);
  const page = await get("/account/purchases", m.token);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Course bundle");
  expect(page.text).toContain("FND");
  const key = randomUUID();
  const accepted = await post(
    `/account/purchases/plans/${p.planId}/accept`,
    m.token,
    {
      revision: "1",
      operationId: key,
      name: "陳 · Invented student",
      email: "invented-student@example.invalid",
      confirm: "accept",
    },
  );
  expect(accepted.status).toBe(303);
  const own = ready(await invoices.overview(m.token));
  expect(own.invoices).toHaveLength(1);
  const invoice = own.invoices[0]!;
  expect(invoice.totalCents).toBe(3000);
  expect(invoice.document.lines).toHaveLength(2);
  expect(invoice.document.billing).toEqual({ kind: "one_time" });
  const rendered = await get(accepted.headers.location as string, m.token);
  expect(rendered.status).toBe(200);
  expect(rendered.text).toContain("SAMPLE · NOT PAYABLE");
  expect(rendered.text).toContain("陳");
  expect(rendered.text).toContain("Print command");
  expect(ready(await invoices.generateDue(admin)).created).toBe(0);
  expect(
    (
      await post(`/operator/invoices/${invoice.id}/payment`, m.token, {
        revision: "1",
        operationId: randomUUID(),
        amount: "30.00",
        receivedOn: today,
        confirm: "received",
      })
    ).status,
  ).toBe(403);
  const paid = await post(`/operator/invoices/${invoice.id}/payment`, admin, {
    revision: "1",
    operationId: randomUUID(),
    amount: "10.00",
    receivedOn: today,
    confirm: "received",
  });
  expect(paid.status).toBe(303);
  expect(ready(await invoices.invoice(m.token, invoice.id)).paidCents).toBe(
    1000,
  );
  expect(
    (
      await invoices.pay(admin, {
        invoiceId: invoice.id,
        expectedRevision: 2,
        operationId: randomUUID(),
        amountCents: 2001,
        receivedOn: today,
      })
    ).kind,
  ).toBe("conflict");
  ready(
    await invoices.pay(admin, {
      invoiceId: invoice.id,
      expectedRevision: 2,
      operationId: randomUUID(),
      amountCents: 2000,
      receivedOn: today,
    }),
  );
  expect(ready(await invoices.invoice(m.token, invoice.id)).paidCents).toBe(
    3000,
  );
});
it("OFFPUR-03 duplicates acceptance and payment exactly once and denies unrelated members and ordinary staff", async () => {
  const m = await accepted(),
    other = await member(),
    reviewer = await staff("reviewer");
  const same = ready(
    await invoices.accept(m.token, {
      planId: m.planId,
      expectedRevision: 1,
      operationId: m.operationId,
      name: "陳 · Invented student",
      email: "invented-student@example.invalid",
    }),
  );
  expect(same.invoiceId).toBe(m.invoiceId);
  expect((await invoices.invoice(other.token, m.invoiceId)).kind).toBe(
    "not-found",
  );
  expect((await invoices.invoice(reviewer, m.invoiceId, true)).kind).toBe(
    "denied",
  );
  const input = {
    invoiceId: m.invoiceId,
    expectedRevision: 1,
    operationId: randomUUID(),
    amountCents: 100,
    receivedOn: today,
  };
  const results = await Promise.all([
    invoices.pay(admin, input),
    invoices.pay(admin, input),
  ]);
  expect(results.map((r) => r.kind)).toEqual(["ready", "ready"]);
  expect(ready(await invoices.invoice(m.token, m.invoiceId)).paidCents).toBe(
    100,
  );
});
it("OFFPUR-10 generates distinct due periods for a previously accepted monthly agreement and cancellation stops future invoices", async () => {
  const m = await member(),
    source = ready(await invoices.propose(admin, proposal(m.id, "monthly"))),
    row = (
      await pool.query<{ terms: Record<string, unknown> }>(
        "SELECT terms FROM simple_invoice_plans WHERE id=$1",
        [source.planId],
      )
    ).rows[0]!;
  // Historical accepted agreement is fixture data, not a claim of past browser execution.
  const anchor = (
    await pool.query<{ day: string }>(
      "SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
  const planId = randomUUID();
  await pool.query(
    "INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,state,created_by,accepted_at,recipient_name,recipient_email) VALUES($1,$2,$2,$3,'active',$4,clock_timestamp()-interval '1 month','Invented student','invented-student@example.invalid')",
    [
      planId,
      m.id,
      JSON.stringify({ ...row.terms, startsOn: anchor }),
      (
        await pool.query<{ id: string }>(
          "SELECT id FROM principals WHERE token_hash=$1",
          [(await import("../../src/store.ts")).hash(admin)],
        )
      ).rows[0]!.id,
    ],
  );
  const r = await Promise.all([
    invoices.generateDue(admin),
    invoices.generateDue(admin),
  ]);
  r.forEach(ready);
  const created = (
    await pool.query<{ cycle: number }>(
      "SELECT cycle FROM simple_invoices WHERE plan_id=$1 ORDER BY cycle",
      [planId],
    )
  ).rows;
  expect(created.map((x) => x.cycle)).toEqual([0, 1]);
  expect(ready(await invoices.generateDue(admin)).created).toBe(0);
  const plan = ready(await invoices.overview(m.token)).plans.find(
    (p) => p.id === planId,
  )!;
  ready(
    await invoices.cancel(m.token, {
      planId,
      expectedRevision: plan.revision,
      operationId: randomUUID(),
    }),
  );
  expect(ready(await invoices.generateDue(admin)).created).toBe(0);
});
it("OFFPUR-02/03 records a separate invoice-email result and never sends again on original-key replay", async () => {
  const m = await accepted();
  const operationId = randomUUID();
  const first = await post(`/operator/invoices/${m.invoiceId}/email`, admin, {
    revision: "1",
    operationId,
    confirm: "send",
  });
  expect(first.status).toBe(303);
  expect(
    sent.filter((x) => x === "invented-student@example.invalid"),
  ).toHaveLength(1);
  expect(ready(await invoices.invoice(m.token, m.invoiceId)).delivery).toBe(
    "sent",
  );
  expect(
    (
      await post(`/operator/invoices/${m.invoiceId}/email`, admin, {
        revision: "1",
        operationId,
        confirm: "send",
      })
    ).status,
  ).toBe(303);
  expect(sent).toHaveLength(1);
});
it("OFFPUR-05/07 erases sample invoices with the learning account while retaining configured issued accounting records under admin-only access", async () => {
  const sample = await accepted();
  await members.remove(sample.id);
  expect(
    (
      await pool.query("SELECT id FROM simple_invoices WHERE id=$1", [
        sample.invoiceId,
      ])
    ).rowCount,
  ).toBe(0);
  const configured = simpleInvoiceStore(pool, { ...settings, sample: false });
  const real = await accepted("one_time", configured);
  await members.remove(real.id);
  expect((await configured.invoice(real.token, real.invoiceId)).kind).toBe(
    "denied",
  );
  expect(
    ready(await configured.invoice(admin, real.invoiceId, true)).document
      .billedTo,
  ).toBe("陳 · Invented student");
});
it("OFFPUR-03 an acknowledged server commit with a lost response stays inspectable without a second invoice", async () => {
  const m = await member(),
    p = ready(await invoices.propose(admin, proposal(m.id)));
  let lost = false;
  const proxy = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, k) {
              if (k === "query")
                return async (...args: unknown[]) => {
                  const result = await (
                    c.query as (...values: unknown[]) => Promise<unknown>
                  ).apply(c, args);
                  if (args[0] === "COMMIT" && !lost) {
                    lost = true;
                    throw Error("Invented commit acknowledgement loss");
                  }
                  return result;
                };
              return typeof c[k as keyof PoolClient] === "function"
                ? (
                    c[k as keyof PoolClient] as (...args: unknown[]) => unknown
                  ).bind(c)
                : c[k as keyof PoolClient];
            },
          });
        };
      return typeof target[key as keyof Pool] === "function"
        ? (target[key as keyof Pool] as (...args: unknown[]) => unknown).bind(
            target,
          )
        : target[key as keyof Pool];
    },
  }) as Pool;
  const faulty = simpleInvoiceStore(proxy, settings),
    input = {
      planId: p.planId,
      expectedRevision: 1,
      operationId: randomUUID(),
      name: "Invented student",
      email: "invented@example.invalid",
    };
  expect((await faulty.accept(m.token, input)).kind).toBe("unavailable");
  const receipt = ready(await invoices.inspect(m.token, input.operationId));
  expect(receipt.result).toHaveProperty("invoiceId");
  expect(ready(await invoices.accept(m.token, input)).invoiceId).toBe(
    (receipt.result as { invoiceId: string }).invoiceId,
  );
  expect(ready(await invoices.overview(m.token)).invoices).toHaveLength(1);
});
it("OFFPUR-05 rejects forged origin/CSRF, malformed amounts and unknown fields without recording funds", async () => {
  const m = await accepted();
  const fields = {
    revision: "1",
    operationId: randomUUID(),
    amount: "1e2",
    receivedOn: today,
    confirm: "received",
  };
  expect(
    (await post(`/operator/invoices/${m.invoiceId}/payment`, admin, fields))
      .status,
  ).toBe(422);
  const response = await withLoopback(application, (s) =>
    request(s)
      .post(`/operator/invoices/${m.invoiceId}/payment`)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", "https://foreign.invalid")
      .set("Cookie", `${COOKIE}=${admin}`)
      .type("form")
      .send({ csrf: csrf(admin, secret), ...fields, amount: "1.00" }),
  );
  expect(response.status).toBe(403);
  expect(ready(await invoices.invoice(m.token, m.invoiceId)).paidCents).toBe(0);
});
it("OFFPUR-10 accepted recurring consent survives browser expiry and uses the accepted published version", async () => {
  const m = await member();
  const source = ready(
    await invoices.propose(admin, proposal(m.id, "monthly")),
  );
  const terms = (
    await pool.query<{ terms: Record<string, unknown> }>(
      "SELECT terms FROM simple_invoice_plans WHERE id=$1",
      [source.planId],
    )
  ).rows[0]!.terms;
  const anchor = (
    await pool.query<{ day: string }>(
      "SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month','YYYY-MM-DD') AS day",
    )
  ).rows[0]!.day;
  const planId = randomUUID();
  await pool.query(
    "INSERT INTO simple_invoice_plans(id,owner_id,workspace_id,terms,state,accepted_at,recipient_name,recipient_email,next_cycle) VALUES($1,$2,$2,$3,'active',clock_timestamp()-interval '1 month','Invented student','invented@example.invalid',1)",
    [planId, m.id, JSON.stringify({ ...terms, startsOn: anchor })],
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [m.id],
  );
  ready(await invoices.generateScheduled());
  expect(
    (
      await pool.query(
        "SELECT id FROM simple_invoices WHERE plan_id=$1 AND cycle=1",
        [planId],
      )
    ).rowCount,
  ).toBe(1);
  expect((await invoices.overview(m.token)).kind).toBe("denied");
});
it("OFFPUR-06 cancels an unpaid issued invoice without rewriting its snapshot or accepting a later payment", async () => {
  const m = await accepted();
  const before = ready(await invoices.invoice(m.token, m.invoiceId)).document;
  const response = await post(`/operator/invoices/${m.invoiceId}/void`, admin, {
    revision: "1",
    operationId: randomUUID(),
    reason: "Wrong course bundle; prepare a corrected proposal",
    confirm: "void",
  });
  expect(response.status).toBe(303);
  const after = await get(
    `/account/purchases/invoices/${m.invoiceId}`,
    m.token,
  );
  expect(after.text).toContain("VOID");
  expect(
    (
      await pool.query<{ document: unknown }>(
        "SELECT document FROM simple_invoices WHERE id=$1",
        [m.invoiceId],
      )
    ).rows[0]!.document,
  ).toEqual({ ...before, recipientEmail: "invented-student@example.invalid" });
  expect(
    (
      await invoices.pay(admin, {
        invoiceId: m.invoiceId,
        expectedRevision: 2,
        operationId: randomUUID(),
        amountCents: 100,
        receivedOn: today,
      })
    ).kind,
  ).toBe("conflict");
});
it("OFFPUR-10 a replacement course proposal cannot create two active recurring bills for one student", async () => {
  const m = await accepted("monthly");
  const replacement = ready(
    await invoices.propose(admin, proposal(m.id, "monthly")),
  );
  const input = {
    planId: replacement.planId,
    expectedRevision: 1,
    operationId: randomUUID(),
    name: "Invented student",
    email: "invented@example.invalid",
  };
  expect((await invoices.accept(m.token, input)).kind).toBe("conflict");
  const old = ready(await invoices.overview(m.token)).plans.find(
    (p) => p.id === m.planId,
  )!;
  ready(
    await invoices.cancel(m.token, {
      planId: old.id,
      expectedRevision: old.revision,
      operationId: randomUUID(),
    }),
  );
  expect((await invoices.accept(m.token, input)).kind).toBe("ready");
});
