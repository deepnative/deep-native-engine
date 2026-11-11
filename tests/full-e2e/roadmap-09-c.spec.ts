import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deterministicRegistry } from "../../src/adapters.ts";
import { estimateAiRequest } from "../../src/ai-budget-policy.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { COOKIE } from "../../src/session.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import {
  signTestProviderEvent,
  TEST_PROVIDER_PATH,
  TEST_PROVIDER_SIGNATURE,
} from "../../src/test-provider-events.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  invoiceMoney,
  issueTermsInvoice,
  recordOfflinePayment,
  saveRecipient,
  saveTerms,
  torontoDay,
  type TermsForm,
} from "../support/coaching-terms-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// Operator reconciliation and the delivery cost report, from existing records
// only. The main listener issues sample (demo) invoices and accepts this
// site's own signed test events; a second listener on the same database
// issues configured invoices, the only "real" ones. Nothing is payable, no
// provider is called and no money moves. AI figures are simulated points.
// Staff credentials stay out of traces; every person and amount is invented.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
const key = "invented-provisional-test-provider-key-09c";

const cash = (page: Page, group: string, name: string) =>
  page.locator(`[data-invoice-group="${group}"] [data-field="${name}"]`);
const cost = (page: Page, name: string) =>
  page.locator(`[data-field="cost.${name}"]`);
const costLabel = (page: Page, name: string) =>
  page
    .locator("dt")
    .filter({ has: page.locator(`+ dd[data-field="cost.${name}"]`) });

test("[F-ROADMAP-09-C] a payment exception is flagged on its invoice, delivery cost counts preparation once with AI labelled as an estimate, and demo activity stays out of real figures", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
    testProviderKey: key,
  });
  try {
    const admin = await f.staff("platform_admin"),
      first = await f.staff("operator"),
      second = await f.staff("operator");
    const real = await f.configuredInvoiceListener();
    const student = await f.member();
    const reference = await memberReference(student, f.origin);
    const token = (await student.context().cookies()).find(
      (cookie) => cookie.name === COOKIE,
    )!.value;
    const terms = async (from: number, price: string): Promise<TermsForm> => ({
      price,
      startsOn: await torontoDay(f.pool, from),
      endsOn: await torontoDay(f.pool, from + 29),
      renewsOn: await torontoDay(f.pool, from + 30),
      reviewMinutes: 0,
      coachingSessions: 4,
      aiRequests: 0,
    });
    // A demo invoice: sample billing, CAD 1,200.00 with a typed zero tax.
    await saveTerms(admin.page, f.origin, reference, await terms(0, "1200.00"));
    await saveRecipient(student, f.origin);
    const demo = (
      await issueTermsInvoice(admin.page, f.origin, reference, "0.00")
    ).invoiceId;

    await requiredCheck(1, async () => {
      // The deliberate exception: a refund event arrives for a payment that
      // was never reported, while staff record the money they did receive.
      const body = JSON.stringify({
        invoiceId: demo,
        id: "evt-provisional-09c-refund",
        type: "refund.succeeded",
        paymentRef: "pay-provisional-09c-missing",
        amountCents: 120000,
        occurredAt: "2026-11-03T12:00:00.000Z",
      });
      const delivered = await student.request.post(
        f.origin + TEST_PROVIDER_PATH,
        {
          headers: {
            "Content-Type": "application/json",
            [TEST_PROVIDER_SIGNATURE]: signTestProviderEvent(key, body),
          },
          data: body,
        },
      );
      expect(await delivered.json()).toEqual({ outcome: "held" });
      await recordOfflinePayment(admin.page, f.origin, demo, "1200.00");
      const money = await invoiceMoney(f.pool, demo);
      expect(money.paidCents).toBe(120000);
      expect(money.refundedCents).toBe(0);
      expect(
        money.rows.map((row) => row.split(":").slice(1).join(":")).sort(),
      ).toEqual(["held:120000", "receipt:120000"]);

      const page = admin.page;
      await page.goto(f.origin + "/operator/invoice-reconciliation");
      // The manual receipt reconciles with its invoice.
      await expect(
        page.locator(
          '[data-invoice-group="sample"] [data-reconciliation-status="consistent"]',
        ),
      ).toBeVisible();
      await expect(cash(page, "sample", "receipts")).toHaveText("CAD 1200.00");
      await expect(cash(page, "sample", "mismatched")).toHaveText("0");
      // The event that matches no payment is visible, with its amount.
      const events = page.locator("[data-test-events]");
      await expect(
        events.locator('[data-reconciliation-status="waiting"]'),
      ).toContainText("held and not applied");
      await expect(events.locator('[data-field="test.waiting"]')).toHaveText(
        "CAD 1200.00",
      );
      // It is attributed to its invoice, which the operator can open.
      const flagged = page.locator(`[data-flagged-invoice="${demo}"]`);
      await expect(flagged).toContainText(
        "Signed test event held and not applied",
      );
      await flagged.getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/operator/invoices/${demo}$`));
      const record = page.getByRole("table", {
        name: "Recorded receipts and refunds",
      });
      await expect(record).toContainText("Test event not applied");
      await expect(record).toContainText("Invented e-Transfer");
      // The entitlement ledger report still reads, and is a separate record.
      expect(
        (await page.goto(
          f.origin + "/operator/ledger-reconciliation",
        ))!.status(),
      ).toBe(200);
      await expect(page.locator("[data-ledger-category]")).toHaveCount(5);
    });

    await requiredCheck(2, async () => {
      // One support booking that two operators hold a grant on; one of them
      // records 10 support and 5 preparation minutes.
      const support = supportRequestStore(f.pool);
      const expiry = new Date(Date.now() + 3_600_000);
      await syntheticLedger(f.pool).grant(
        reference,
        "support_minutes",
        20,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      const intake = await support.create(token, {
        idempotencyKey: randomUUID(),
        subject: "Invented support request",
        body: "Invented private request text for a browser test.",
      });
      if (!("receipt" in intake)) throw Error("Missing support request");
      const requestId = intake.receipt.requestId;
      const held = await support.time!.allocate(
        token,
        requestId,
        randomUUID(),
        20,
      );
      if (!("receipt" in held)) throw Error("Missing held support minutes");
      const allocationId = held.receipt.allocationId;
      const grants: string[] = [];
      for (const operator of [first, second]) {
        const granted = await support.time!.grant(admin.token, {
          requestId,
          allocationId,
          staffId: operator.id,
          role: "operator",
          idempotencyKey: randomUUID(),
          startsAt: new Date(Date.now() - 60_000),
          expiresAt: expiry,
        });
        if (!("grantId" in granted)) throw Error("Missing support time grant");
        grants.push(granted.grantId);
      }
      const scope = { requestId, allocationId, grantId: grants[0]! };
      expect(
        (await support.time!.begin(first.token, scope, randomUUID())).kind,
      ).toBe("applied");
      const start = new Date(Date.now() - 3_600_000),
        end = new Date(+start + 600_000);
      expect(
        (
          await support.time!.record(first.token, scope, randomUUID(), {
            supportStart: start,
            supportEnd: end,
            preparationStart: end,
            preparationEnd: new Date(+end + 300_000),
          })
        ).kind,
      ).toBe("applied");

      // Two metered test AI requests on the student's own invented file; one
      // runs, so it has recorded simulated use as well as an estimate.
      const objects = fileObjectStorage(f.storageRoot),
        evidence = evidenceStore(f.pool, objects, "invented-09c-secret"),
        local = localAiConsentStore(
          f.pool,
          objects,
          deterministicRegistry({}, "test"),
        );
      await syntheticLedger(f.pool).grant(
        reference,
        "study_requests",
        2,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      const data = Buffer.from(
        "An invented team checks every claim against its sources.",
      );
      const jobs: string[] = [];
      for (const name of ["first", "second"]) {
        const uploaded = await evidence.upload(token, {
          name: `Invented-09c-${name}-${randomUUID()}`,
          mediaType: "text/plain",
          data,
          consent: {
            rightsConfirmed: true,
            privateReview: true,
            communityPublication: false,
          },
        });
        if (uploaded.kind !== "created") throw Error("Missing invented file");
        await evidence.transitionQuarantine(uploaded.id, "clean");
        const permission = await local.grant(token, uploaded.id);
        if (permission.kind !== "granted") throw Error("Missing permission");
        const queued = await local.enqueueMetered(
          token,
          permission.receiptId,
          randomUUID(),
        );
        if (queued.kind !== "queued") throw Error("Missing AI request");
        jobs.push(queued.jobId);
      }
      expect((await local.run(token, jobs[0]!)).kind).toBe("completed");
      const estimate = estimateAiRequest(data.byteLength).costPoints;
      const settled = (
        await f.pool.query<{ points: number }>(
          "SELECT cost_points AS points FROM ai_usage_settlements WHERE job_id=$1",
          [jobs[0]],
        )
      ).rows[0]!.points;
      const points = (value: number) =>
        `${value} simulated cost point${value === 1 ? "" : "s"} · estimate`;

      const page = admin.page;
      await page.goto(f.origin + "/staff");
      await page
        .getByRole("link", { name: "Delivery cost", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Delivery cost", level: 1 }),
      ).toBeVisible();
      // Preparation is counted once, though two operators held a grant.
      await expect(cost(page, "supports")).toHaveText("1");
      await expect(cost(page, "support")).toHaveText("10 min");
      await expect(costLabel(page, "supportPreparation")).toHaveText(
        "Support preparation minutes, counted once",
      );
      await expect(cost(page, "supportPreparation")).toHaveText("5 min");
      await expect(cost(page, "reviews")).toHaveText("0");
      await expect(cost(page, "reviewPreparation")).toHaveText("0 min");
      await expect(cost(page, "staffMinutes")).toHaveText("15 min");
      // Every AI figure is a labelled estimate in simulated points.
      const ai = page.locator("[data-delivery-ai]");
      await expect(ai.getByRole("heading", { level: 2 })).toHaveText(
        "AI use · Estimate",
      );
      await expect(ai).toContainText(
        "ESTIMATE · SIMULATED · NO MONEY CHARGED.",
      );
      await expect(cost(page, "aiRequests")).toHaveText("2");
      await expect(cost(page, "aiEstimated")).toHaveText(points(2 * estimate));
      await expect(cost(page, "aiSettled")).toHaveText("1");
      await expect(cost(page, "aiSettledPoints")).toHaveText(points(settled));
      await expect(cost(page, "aiSettledEstimate")).toHaveText(
        points(estimate),
      );
      for (const figure of await ai.locator("dd").allInnerTexts())
        if (/point/.test(figure)) expect(figure).toMatch(/· estimate$/);
      // No money on the page, and nobody is named.
      const text = await page.locator("main").innerText();
      expect(text).toContain("No cost in money.");
      expect(text).not.toMatch(/CAD|\$\d/);
      for (const secret of [reference, requestId, first.id, second.id])
        expect(text).not.toContain(secret);
      // A student can't read it.
      expect(
        (await student.goto(f.origin + "/operator/delivery-cost"))!.status(),
      ).toBe(403);
    });

    await requiredCheck(3, async () => {
      // A real (configured) invoice for the next period, paid offline. The
      // demo invoice, its receipt and the test event are already recorded.
      await saveTerms(admin.page, real, reference, await terms(30, "1500.00"));
      const live = (await issueTermsInvoice(admin.page, real, reference))
        .invoiceId;
      await recordOfflinePayment(admin.page, real, live, "1695.00");

      const page = admin.page;
      await page.goto(f.origin + "/operator/invoice-reconciliation");
      // Real figures count only the configured invoice and its receipt.
      await expect(cash(page, "configured", "invoiced")).toHaveText(
        "CAD 1695.00",
      );
      await expect(cash(page, "configured", "receipts")).toHaveText(
        "CAD 1695.00",
      );
      await expect(cash(page, "configured", "net")).toHaveText("CAD 1695.00");
      await expect(cash(page, "configured", "unpaid")).toHaveText("CAD 0.00");
      // Demo activity is still visible, labelled and kept apart.
      await expect(cash(page, "sample", "invoiced")).toHaveText("CAD 1200.00");
      await expect(cash(page, "sample", "receipts")).toHaveText("CAD 1200.00");
      await expect(
        page.locator('[data-test-events] [data-field="test.waiting"]'),
      ).toHaveText("CAD 1200.00");
      await expect(
        page.locator('[data-invoice-group="sample"] h2'),
      ).toContainText(/sample|test/i);
      const stored = await f.pool.query<{ sample: boolean; n: number }>(
        "SELECT sample,count(*)::integer AS n FROM simple_invoices WHERE owner_id=$1 GROUP BY 1 ORDER BY 1",
        [reference],
      );
      expect(stored.rows).toEqual([
        { sample: false, n: 1 },
        { sample: true, n: 1 },
      ]);
    });
  } finally {
    await f.close();
  }
});
