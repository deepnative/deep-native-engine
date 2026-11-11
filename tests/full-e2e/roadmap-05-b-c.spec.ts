import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { TEST_AI_FAULT_MARKERS } from "../../src/adapters.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  saveTerms,
  shown,
  torontoDay,
  unitsShown,
  type TermsForm,
} from "../support/coaching-terms-journey.ts";
import {
  aiUnits,
  holdMeteredRequest,
  meteredForm,
  meteredRequests,
  permitFixtureSample,
} from "../support/fixture-ai-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// AI allowance boundaries under the owner's 9 and 10 November 2026 decisions:
// an administrator sets each student's AI request allowance, and a request
// whose outcome is unknown stays held. The AI step is the local deterministic
// simulation: no provider, no money. Marked invented text makes it time out;
// that switch is refused on hosted sites. Staff credentials stay out of traces.
test.use({ trace: staffTrace });

const DID_NOT_FINISH =
  "This attempt did not finish normally and will not retry automatically.";

async function setUp(browser: Browser, info: TestInfo, aiRequests: number) {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    sampleInvoices: true,
    aiFaults: true,
  });
  try {
    const admin = (await f.staff("platform_admin")).page;
    const student = await f.member();
    const reference = await memberReference(student, f.origin);
    const terms: TermsForm = {
      price: "1200.00",
      startsOn: await torontoDay(f.pool, 0),
      endsOn: await torontoDay(f.pool, 29),
      renewsOn: await torontoDay(f.pool, 30),
      reviewMinutes: 0,
      coachingSessions: 4,
      aiRequests,
    };
    // The administrator sets the student's AI request allowance.
    await saveTerms(admin, f.origin, reference, terms);
    return { f, admin, student, reference, terms };
  } catch (error) {
    await f.close();
    throw error;
  }
}
type Journey = Awaited<ReturnType<typeof setUp>>;

async function post(
  page: Page,
  origin: string,
  form: { action: string; fields: Record<string, string> },
) {
  return page.request.post(origin + form.action, {
    headers: { Origin: origin },
    form: form.fields,
    maxRedirects: 0,
  });
}
/** Holds one request for a new invented sample and runs it to its result. */
async function runRequest(j: Journey, text: string) {
  const sample = await permitFixtureSample(j.f, j.student, text);
  await holdMeteredRequest(sample.item);
  await sample.item
    .getByRole("button", { name: "Run local test request" })
    .click();
  await j.student.goto(j.f.origin + "/evidence/local-ai");
  return sample;
}

test("[F-ROADMAP-05-B] the administrator-set AI allowance blocks at its end, a lowered allowance leaves only what it allows, and a practice conversation stops at its turn limit", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info, 1);
  try {
    await requiredCheck(1, async () => {
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "1", future: "0" },
      );
      const used = await runRequest(j, "Invented source for the last request");
      await expect(
        used.item.getByText("One local test request: consumed."),
      ).toBeVisible();
      expect(await aiUnits(j.f, j.reference)).toMatchObject({
        available: 0,
        reserved: 0,
        consumed: 1,
      });
      // The next request has no unit to hold and is refused.
      const next = await permitFixtureSample(
        j.f,
        j.student,
        "Invented source for one request too many",
      );
      const form = await meteredForm(next.item);
      await holdMeteredRequest(next.item);
      await expect(
        j.student.getByRole("heading", {
          name: "Local test request unavailable",
        }),
      ).toBeVisible();
      await expect(j.student.locator("main")).toContainText(
        "No allowance was granted and no live provider was contacted.",
      );
      expect((await post(j.student, j.f.origin, form)).status()).toBe(403);
      // One request ran, with one estimate and one settlement; nothing more.
      expect(await meteredRequests(j.f, j.reference)).toEqual([
        expect.objectContaining({
          status: "succeeded",
          attempt_count: 1,
          estimates: 1,
          settlements: 1,
        }),
      ]);
      expect(await aiUnits(j.f, j.reference)).toMatchObject({
        available: 0,
        reserved: 0,
        consumed: 1,
      });
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "0", future: "0" },
      );
    });

    await requiredCheck(2, async () => {
      // The administrator raises the allowance to 4 (three unused), then
      // lowers it to 2: below the three that were unused.
      await saveTerms(j.admin, j.f.origin, j.reference, {
        ...j.terms,
        aiRequests: 4,
      });
      expect(await aiUnits(j.f, j.reference)).toMatchObject({
        available: 3,
        consumed: 1,
      });
      await saveTerms(j.admin, j.f.origin, j.reference, {
        ...j.terms,
        aiRequests: 2,
      });
      expect(await aiUnits(j.f, j.reference)).toMatchObject({
        available: 1,
        reserved: 0,
        consumed: 1,
      });
      await expect(
        shown(j.admin, "coaching-allowances", "AI requests"),
      ).toHaveText("1 of 2 left, 0 held, 1 used");
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText("1 of 2 left, 0 held, 1 used");
      expect(await unitsShown(j.student, j.f.origin, "study_requests")).toEqual(
        { usable: "1", future: "0" },
      );
      // The used request is kept as it was, and nothing was charged again.
      expect(await meteredRequests(j.f, j.reference)).toEqual([
        expect.objectContaining({
          status: "succeeded",
          estimates: 1,
          settlements: 1,
        }),
      ]);
      // Exactly the lowered allowance is usable: one more request, then none.
      const last = await runRequest(
        j,
        "Invented source for the lowered allowance",
      );
      await expect(
        last.item.getByText("One local test request: consumed."),
      ).toBeVisible();
      const over = await permitFixtureSample(
        j.f,
        j.student,
        "Invented source past the lowered allowance",
      );
      expect(
        (
          await post(j.student, j.f.origin, await meteredForm(over.item))
        ).status(),
      ).toBe(403);
      expect(await aiUnits(j.f, j.reference)).toMatchObject({
        available: 0,
        reserved: 0,
        consumed: 2,
      });
      expect(await meteredRequests(j.f, j.reference)).toHaveLength(2);
    });

    await requiredCheck(3, async () => {
      // The reviewed foundation lessons are published, so there is a
      // current source to practise on.
      await j.f.publishFixture();
      const id = "FND-001";
      const before = await aiUnits(j.f, j.reference);

      const page = j.student;
      await page.goto(`${j.f.origin}/library/${id}`);
      await page
        .getByRole("link", { name: "Try a private practice session" })
        .click();
      await expect(
        page.getByText("30 visible turns", { exact: false }),
      ).toBeVisible();
      await page.getByLabel("I want to start private sample practice").check();
      await page
        .getByRole("button", { name: "Start or return to private session" })
        .click();
      const path = new URL(page.url()).pathname;
      const responses = page.locator("[data-practice-response]");
      for (let sequence = 1; sequence <= 15; sequence++) {
        await page
          .getByLabel("Your next sample response")
          .fill(`Invented response ${sequence}: check the source.`);
        await page
          .getByLabel(
            "I used only invented or sample information and want to save this response.",
          )
          .check();
        await page
          .getByRole("button", { name: "Save response and compare" })
          .click();
        await expect(responses).toHaveCount(sequence);
      }
      // Thirty visible turns: fifteen responses and fifteen comparisons.
      await page.reload();
      await expect(page.locator("[data-practice-comparison]")).toHaveCount(15);
      await expect(page.getByRole("status")).toContainText(
        "15 pairs / 30 visible turns",
      );
      await expect(
        page.getByRole("button", { name: "Save response and compare" }),
      ).toHaveCount(0);
      // A further turn sent directly is refused, and nothing is saved.
      const csrf = await page
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const further = await page.request.post(
        `${j.f.origin}${path}/responses`,
        {
          headers: { Origin: j.f.origin },
          form: {
            csrf,
            expected_sequence: "16",
            response: "Invented response 16 past the limit.",
            confirm: "yes",
          },
          maxRedirects: 0,
        },
      );
      expect(further.status()).toBeGreaterThanOrEqual(400);
      await page.goto(j.f.origin + path);
      await expect(responses).toHaveCount(15);
      // The conversation used and charged no AI request.
      expect(await aiUnits(j.f, j.reference)).toEqual(before);
      expect(await meteredRequests(j.f, j.reference)).toHaveLength(2);
    });
  } finally {
    await j.f.close();
  }
});

test("[F-ROADMAP-05-C] a timed-out metered AI request is visibly failed, its usage stays held once, and no retry or second charge is possible", async ({
  browser,
}, info) => {
  const j = await setUp(browser, info, 1);
  try {
    const sample = await permitFixtureSample(
      j.f,
      j.student,
      `Invented source that never gets an answer ${TEST_AI_FAULT_MARKERS.timeout}`,
    );
    const form = await meteredForm(sample.item);
    const held = [
      {
        status: "needs_reconciliation",
        safe_error: "provider_timeout",
        attempt_count: 1,
        commitments: "committed",
        estimates: 1,
        settlements: 0,
      },
    ];

    await requiredCheck(1, async () => {
      await holdMeteredRequest(sample.item);
      await sample.item
        .getByRole("button", { name: "Run local test request" })
        .click();
      await expect(
        j.student.getByText(DID_NOT_FINISH, { exact: false }),
      ).toBeVisible({ timeout: 15_000 });
      await j.student.goto(j.f.origin + "/evidence/local-ai");
      await expect(
        sample.item.getByText(
          "The AI step did not answer within 5 seconds, so it timed out.",
        ),
      ).toBeVisible();
      await expect(
        sample.item.getByText("One local test request: held."),
      ).toBeVisible();
      // Held exactly once: reserved, not given back and not settled.
      expect(await meteredRequests(j.f, j.reference)).toEqual(held);
      expect(await aiUnits(j.f, j.reference)).toEqual({
        available: 0,
        reserved: 1,
        consumed: 0,
        events: "grant:1,reserve:1",
      });
      await j.student.goto(j.f.origin + "/account/coaching");
      await expect(
        shown(j.student, "coaching-allowances", "AI requests"),
      ).toHaveText("0 of 1 left, 1 held, 0 used");
    });

    await requiredCheck(2, async () => {
      await j.student.goto(j.f.origin + "/evidence/local-ai");
      // No retry is offered for the held request.
      await expect(
        sample.item.getByRole("button", { name: /Run|Try|Retry/ }),
      ).toHaveCount(0);
      // The same form sent again is the same held request; a new request
      // has no unit to hold. Neither runs anything or charges again.
      const again = await post(j.student, j.f.origin, form);
      expect(again.status()).toBeLessThan(500);
      const fresh = await post(j.student, j.f.origin, {
        action: form.action,
        fields: { ...form.fields, key: randomUUID() },
      });
      expect(fresh.status()).toBeGreaterThanOrEqual(400);
      expect(await meteredRequests(j.f, j.reference)).toEqual(held);
      expect(await aiUnits(j.f, j.reference)).toEqual({
        available: 0,
        reserved: 1,
        consumed: 0,
        events: "grant:1,reserve:1",
      });
      await j.student.reload();
      await expect(
        sample.item.getByText("One local test request: held."),
      ).toBeVisible();
    });
  } finally {
    await j.f.close();
  }
});
