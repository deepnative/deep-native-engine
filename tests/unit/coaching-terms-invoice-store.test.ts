import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  simpleInvoiceStore,
  type InvoiceSettings,
} from "../../src/simple-invoice-store.ts";
import {
  practiceTransaction,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { invoiceDigest } from "../../src/simple-invoice-values.ts";
import { DEEP_NATIVE_INVOICE_ISSUER } from "../../src/invoice-issuer.ts";
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));

// #318 TERMSINV318: issuing an invoice for a student's coaching-terms version,
// against an invented in-memory transaction. Invented values only.
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  termsId = "33333333-3333-4333-8333-333333333333",
  token = "a".repeat(64);
const terms = {
  id: termsId,
  version: 2,
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
};
const recipient = {
  name: "Invented Student",
  email: "s@example.invalid",
  company: "Invented Studio" as string | null,
};
const configured: InvoiceSettings = {
  sample: false,
  ...DEEP_NATIVE_INVOICE_ISSUER,
};
const sample: InvoiceSettings = {
  sample: true,
  issuer: "Invented issuer",
  instructions: "Sample only",
};
function fixture(
  o: {
    terms?: typeof terms | null;
    recipient?: typeof recipient | null;
    live?: boolean;
    receipt?: { digest: string; result: unknown };
    settings?: InvoiceSettings;
  } = {},
) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes("FROM principals WHERE token_hash"))
      rows = [{ id, kind: "staff", expires: new Date("2099-01-01") }];
    else if (sql.includes("FROM authorized_staff_profiles"))
      rows = [{ role: "platform_admin" }];
    else if (sql.includes("FROM principals p JOIN learners"))
      rows = [{ expires: new Date("2099-01-01") }];
    else if (sql.includes("FROM workspaces WHERE")) rows = [{ id }];
    else if (sql.includes("FROM simple_invoice_operations"))
      rows = o.receipt ? [o.receipt] : [];
    else if (sql.includes("FROM coaching_terms"))
      rows = o.terms === null ? [] : [o.terms ?? terms];
    else if (sql.includes("FROM billing_profiles"))
      rows = o.recipient === null ? [] : [o.recipient ?? recipient];
    else if (sql.includes("FROM simple_invoices WHERE coaching_terms_id"))
      rows = o.live ? [{ id: key }] : [];
    else if (sql.includes("AS today")) rows = [{ today: "2026-11-10" }];
    return { rows, rowCount: rows.length };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe: async () => {} } as unknown as PracticeTransaction),
  );
  return {
    service: simpleInvoiceStore({} as Pool, o.settings ?? configured),
    query,
  };
}
const sql = (f: ReturnType<typeof fixture>, start: string) =>
  f.query.mock.calls.find(([text]) => text.startsWith(start));
const input = { ownerId: id, version: 2, operationId: key };
beforeEach(() => vi.clearAllMocks());

it("TERMSINV318-01 reads the current version, recipient and live invoice for the form", async () => {
  expect(
    await fixture({ live: true }).service.coachingTermsInvoice(token, id),
  ).toEqual({
    kind: "ready",
    value: { terms, recipient, invoiceId: key },
  });
  expect(
    await fixture({
      terms: null,
      recipient: null,
    }).service.coachingTermsInvoice(token, id),
  ).toEqual({
    kind: "ready",
    value: { terms: null, recipient: null, invoiceId: null },
  });
  expect(await fixture().service.coachingTermsInvoice(token, id)).toEqual({
    kind: "ready",
    value: { terms, recipient, invoiceId: null },
  });
  expect(await fixture().service.coachingTermsInvoice(token, "x")).toEqual({
    kind: "invalid",
  });
});

it("TERMSINV318-01 issues the terms price with server-computed HST to the saved recipient", async () => {
  const f = fixture();
  const r = await f.service.issueCoachingTerms(token, input);
  expect(r.kind).toBe("ready");
  const insert = sql(f, "INSERT INTO simple_invoices")!;
  const [, owner, document, isSample, total, link] = insert[1] as [
    string,
    string,
    string,
    boolean,
    number,
    string,
  ];
  expect([owner, isSample, total, link]).toEqual([id, false, 135600, termsId]);
  expect(JSON.parse(document)).toMatchObject({
    issuedOn: "2026-11-10",
    issuer: DEEP_NATIVE_INVOICE_ISSUER.issuer,
    billedTo: "Invented Student",
    billedToCompany: "Invented Studio",
    recipientEmail: "s@example.invalid",
    lines: [
      {
        description: "Coaching · 2026-12-01 to 2027-05-31 · terms version 2",
        amountCents: 120000,
      },
    ],
    taxCents: 15600,
    tax: DEEP_NATIVE_INVOICE_ISSUER.tax,
    coachingTerms: { version: 2, startsOn: "2026-12-01", endsOn: "2027-05-31" },
  });
  expect(sql(f, "INSERT INTO billing_change_events")![1]).toEqual([
    id,
    "terms_invoice_issued",
    id,
    null,
    135600,
  ]);
  expect(sql(f, "INSERT INTO simple_invoice_operations")).toBeTruthy();
});

it("TERMSINV318-06 sample mode takes the typed tax, and a recipient without a company prints none", async () => {
  const f = fixture({
    settings: sample,
    recipient: { ...recipient, company: null },
  });
  expect(
    (await f.service.issueCoachingTerms(token, { ...input, taxCents: 500 }))
      .kind,
  ).toBe("ready");
  const document = JSON.parse(
    (sql(f, "INSERT INTO simple_invoices")![1] as string[])[2]!,
  );
  expect(document).toMatchObject({ taxCents: 500, sample: true });
  expect(document.billedToCompany).toBeUndefined();
  expect(document.tax).toBeUndefined();
});

it("TERMSINV318-02/03/04 refuses wrong input, a replayed different request, missing terms or recipient, a stale version and a second live invoice", async () => {
  const f = fixture();
  for (const wrong of [
    null,
    { ...input, ownerId: "x" },
    { ...input, version: 1.5 },
    { ...input, version: 0 },
    { ...input, taxCents: 100 },
    { ...input, operationId: "x" },
  ])
    expect(
      await f.service.issueCoachingTerms(
        token,
        wrong as unknown as typeof input,
      ),
    ).toEqual({ kind: "invalid" });
  expect(
    await fixture({ settings: sample }).service.issueCoachingTerms(
      token,
      input,
    ),
  ).toEqual({ kind: "invalid" });
  const digest = invoiceDigest({ action: "terms-invoice", input });
  expect(
    await fixture({
      receipt: { digest, result: { invoiceId: key } },
    }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "ready", value: { invoiceId: key } });
  expect(
    await fixture({
      receipt: { digest: "0".repeat(64), result: {} },
    }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ terms: null }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "not-found" });
  expect(
    await fixture({ recipient: null }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture().service.issueCoachingTerms(token, { ...input, version: 1 }),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ live: true }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "conflict" });
  for (const settings of [
    { ...configured, issuer: "" },
    { ...configured, instructions: "" },
  ])
    expect(
      await fixture({ settings }).service.issueCoachingTerms(token, input),
    ).toEqual({ kind: "invalid" });
  expect(
    await fixture({
      terms: { ...terms, priceCents: 1_000_000_000 },
    }).service.issueCoachingTerms(token, input),
  ).toEqual({ kind: "invalid" });
});
