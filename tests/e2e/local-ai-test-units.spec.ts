import { browserOrigin } from "../support/browser-origin.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  ledger = syntheticLedger(pool);
const evidence = evidenceStore(
  pool,
  fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
  "browser-secret",
);
const origin = browserOrigin;
test.afterAll(async () => pool.end());
async function signIn(page: Page, token: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function source(page: Page, token: string, title: string) {
  await signIn(page, token);
  await page.goto("/evidence");
  await page.getByLabel("Sample title").fill(title);
  await page
    .getByLabel("Invented text sample")
    .fill("Invented private source for local test requests");
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
  const id = (
    await pool.query("SELECT id FROM evidence_objects WHERE original_name=$1", [
      title,
    ])
  ).rows[0].id;
  await evidence.transitionQuarantine(id, "clean");
  await page.goto("/evidence/local-ai");
  const item = page
    .locator("li")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await item.getByLabel("I permit this exact invented sample version").check();
  await item
    .getByRole("button", { name: "Grant local simulation permission" })
    .click();
  return {
    id,
    item: page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) }),
  };
}
// Explicit durable started-attempt fixture, not evidence of provider execution.
async function startedRequest(page: Page, memberId: string) {
  await pool.query(
    "UPDATE adapter_jobs SET status='running',attempt_count=1,attempt_token=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE member_id=$1 AND status='pending'",
    [memberId, randomUUID()],
  );
  await page.reload();
}
test("[L302] started requests stay held with an unknown outcome after withdrawal or a new version", async ({
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  const memberId = session.learner.id;
  const expectHeld = async (item: Locator) => {
    await expect(
      item.getByText("its outcome is unknown and it stays held"),
    ).toBeVisible();
    await expect(
      item.getByText("confirm that anything was erased"),
    ).toBeVisible();
    await expect(
      item.getByRole("button", { name: "Run local simulation" }),
    ).toHaveCount(0);
  };
  const withdrawnTitle = `Invented withdrawn ${randomUUID()}`;
  const withdrawn = await source(page, token, withdrawnTitle);
  await withdrawn.item
    .getByRole("button", { name: "Queue local simulation" })
    .click();
  // Let the queued page finish loading: a reload mid-navigation detaches the
  // page ("Not attached to an active page"), and the job must exist first.
  await expect(
    withdrawn.item.getByRole("button", { name: "Run local simulation" }),
  ).toBeVisible();
  await startedRequest(page, memberId);
  await withdrawn.item
    .getByLabel(`Withdraw local AI permission for ${withdrawnTitle}`)
    .check();
  await withdrawn.item
    .getByRole("button", { name: "Withdraw permission" })
    .click();
  await expectHeld(withdrawn.item);
  await withdrawn.item
    .getByLabel("I permit this exact invented sample version")
    .check();
  await withdrawn.item
    .getByRole("button", { name: "Grant local simulation permission" })
    .click();
  await expect(
    withdrawn.item.getByText("permission granted for this exact version"),
  ).toBeVisible();
  await expectHeld(withdrawn.item);

  const revisedTitle = `Invented revised ${randomUUID()}`;
  const revised = await source(page, token, revisedTitle);
  await revised.item
    .getByRole("button", { name: "Queue local simulation" })
    .click();
  // Let the queued page finish loading: a reload mid-navigation detaches the
  // page ("Not attached to an active page"), and the job must exist first.
  await expect(
    revised.item.getByRole("button", { name: "Run local simulation" }),
  ).toBeVisible();
  await startedRequest(page, memberId);
  await evidence.submitForReview(token, revised.id);
  const next = await evidence.upload(token, {
    name: `Invented newer ${randomUUID()}`,
    mediaType: "text/plain",
    data: Buffer.from("Invented newer private source"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
    revisesId: revised.id,
  });
  expect(next.kind).toBe("created");
  await page.reload();
  await expect(
    revised.item.getByText("so it cannot be used again"),
  ).toBeVisible();
  await expectHeld(revised.item);
  await expect(
    revised.item.getByRole("button", {
      name: "Grant local simulation permission",
    }),
  ).toHaveCount(0);
  await expect(
    revised.item.getByRole("button", { name: "Withdraw permission" }),
  ).toHaveCount(0);
});
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${120 + index}] ${background} explicitly holds, completes and cancels private local test requests`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background, goal });
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Synthetic member unavailable");
    const id = session.learner.id;
    try {
      await ledger.grant(id, "study_requests", 2, randomUUID(), {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const first = await source(page, token, `Invented-${randomUUID()}.txt`);
      const form = first.item.locator('form[action$="/queue-metered"]');
      const action = await form.getAttribute("action");
      const key = await form.locator('[name="key"]').inputValue();
      const csrf = await form.locator('[name="csrf"]').inputValue();
      // AIUSE-01: a labelled estimate is visible before the member commits.
      const estimate = first.item.getByText(
        "Estimate only: about 268 tokens and 158 simulated cost points (model simulated-model-v1, test rates simulated-rates-v1).",
      );
      await expect(estimate).toHaveCount(1);
      await first.item
        .getByLabel("Hold one existing local test request")
        .check();
      await first.item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await expect(
        first.item
          .getByRole("status")
          .filter({ hasText: "One local test request" }),
      ).toHaveText("One local test request: held.");
      expect(
        (
          await page.request.post(action!, {
            form: { csrf, key, confirm: "yes" },
            headers: { Origin: origin },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(303);
      await first.item
        .getByRole("button", { name: "Run local test request" })
        .click();
      await expect(
        first.item
          .getByRole("status")
          .filter({ hasText: "One local test request" }),
      ).toHaveText("One local test request: consumed.");
      // AIUSE-02: reloading shows actual simulated use beside the estimate.
      await page.reload();
      await expect(estimate).toHaveCount(2);
      await expect(
        first.item.getByText(
          "Actual simulated use: 76 tokens and 42 cost points. Within the estimate.",
        ),
      ).toBeVisible();
      await expect(
        first.item.getByRole("button", { name: "Run local test request" }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        first.item.getByText("One local test request: consumed."),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("metered-receipt.png"),
        fullPage: true,
      });
      const second = await source(
        page,
        token,
        `Invented-cancel-${randomUUID()}.txt`,
      );
      await second.item
        .getByLabel("Hold one existing local test request")
        .check();
      await second.item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await second.item.getByLabel("Withdraw local AI permission").check();
      await second.item
        .getByRole("button", { name: "Withdraw permission" })
        .click();
      await expect(
        second.item.getByText(
          "One local test request: released subject to expiry.",
        ),
      ).toBeVisible();
      // AICANCEL-01: the member cancelled it; nothing failed.
      await expect(
        second.item.getByText(
          "Cancelled when you withdrew permission. It never started.",
        ),
      ).toBeVisible();
      await expect(second.item.getByText(/unavailable or failed/)).toHaveCount(
        0,
      );
      await page
        .getByRole("link", { name: "See your local test units" })
        .click();
      const row = page.locator('[data-test-unit-category="study_requests"]');
      await expect(row.locator('[data-field="usable"]')).toHaveText("1");
      await expect(row.locator('[data-field="held"]')).toHaveText("0");
      await expect(row.locator('[data-field="consumed"]')).toHaveText("1");
      const response = await page.request.get("/member/test-units/download");
      expect(response.headers()["cache-control"]).toContain("no-store");
      const report = await response.json();
      expect(
        report.categories.find(
          (r: { category: string }) => r.category === "study_requests",
        ),
      ).toMatchObject({ usable: 1, held: 0, consumed: 1 });
      expect(JSON.stringify(report)).not.toContain(id);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("metered-summary.png"),
        fullPage: true,
      });
    } finally {
      await evidence.removeWorkspace(token);
      await members.remove(id);
    }
  });
}
test("[L123] absent units, pause and a seeded uncertain claim never create an automatic allowance or redispatch", async ({
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  const id = session.learner.id;
  try {
    const own = await source(
      page,
      token,
      `Invented-uncertain-${randomUUID()}.txt`,
    );
    await own.item.getByLabel("Hold one existing local test request").check();
    await own.item
      .getByRole("button", { name: "Use one local test request" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Local test request unavailable" }),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM adapter_jobs WHERE member_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    await ledger.grant(id, "study_requests", 1, randomUUID(), {
      startsAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    await pool.query("UPDATE local_ai_control SET paused=true");
    await page.goto("/evidence/local-ai");
    await expect(
      page.getByText("Local simulations are paused.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Use one local test request" }),
    ).toHaveCount(0);
    await pool.query("UPDATE local_ai_control SET paused=false");
    await page.reload();
    await own.item.getByLabel("Hold one existing local test request").check();
    await own.item
      .getByRole("button", { name: "Use one local test request" })
      .click();
    const job = (
      await pool.query("SELECT id FROM adapter_jobs WHERE member_id=$1", [id])
    ).rows[0].id;
    // This fixture is explicitly a durable uncertain claim, not evidence of a
    // live provider call. Integration tests inject actual dispatch/COMMIT faults.
    await pool.query(
      "UPDATE adapter_jobs SET status='running',attempt_count=1,attempt_token=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",
      [job, randomUUID()],
    );
    await pool.query(
      "UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown' WHERE id=$1",
      [job],
    );
    await page.reload();
    await expect(
      own.item.getByText("One local test request: held."),
    ).toBeVisible();
    await expect(
      own.item.getByRole("button", { name: "Run local test request" }),
    ).toHaveCount(0);
    const csrf = await page.locator('[name="csrf"]').first().inputValue();
    const response = await page.request.post(`/evidence/local-ai/${job}/run`, {
      form: { csrf },
      headers: { Origin: origin },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(409);
    expect(response.headers()["cache-control"]).toContain("no-store");
    await own.item.getByLabel("Withdraw local AI permission").check();
    await own.item.getByRole("button", { name: "Withdraw permission" }).click();
    await page.goto("/member/test-units");
    const row = page.locator('[data-test-unit-category="study_requests"]');
    await expect(row.locator('[data-field="held"]')).toHaveText("1");
    await expect(row.locator('[data-field="usable"]')).toHaveText("0");
    await expect(row.locator('[data-field="consumed"]')).toHaveText("0");
    expect(
      (
        await pool.query("SELECT attempt_count FROM adapter_jobs WHERE id=$1", [
          job,
        ])
      ).rows[0].attempt_count,
    ).toBe(1);
  } finally {
    await pool.query("UPDATE local_ai_control SET paused=false");
    await evidence.removeWorkspace(token);
    await members.remove(id);
  }
});

test("[L321] AILIMIT-06 a member at the unfinished-request limit is told why and nothing new is queued", async ({
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  const memberId = session.learner.id;
  const items: Locator[] = [];
  for (let n = 0; n < 4; n++)
    items.push(
      (await source(page, token, `Invented limit ${n} ${randomUUID()}`)).item,
    );
  await expect(
    page.getByText(
      "You can have up to 3 unfinished requests at a time, across all your samples; a held request counts until it is checked.",
    ),
  ).toBeVisible();
  for (const item of items.slice(0, 3)) {
    await item.getByRole("button", { name: "Queue local simulation" }).click();
    await expect(
      item.getByRole("button", { name: "Run local simulation" }),
    ).toBeVisible();
  }
  await items[3]!
    .getByRole("button", { name: "Queue local simulation" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Too many unfinished requests" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "You already have 3 AI requests that are not finished. Run one, wait for a held one to be checked, or withdraw permission for one that has not started, then try again. Nothing new was queued or held, and no provider was contacted.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const jobs = await pool.query(
    "SELECT status FROM adapter_jobs WHERE member_id=$1",
    [memberId],
  );
  expect(jobs.rows.map((r) => r.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);
  // Running one frees its place.
  await page.goto("/evidence/local-ai");
  await items[0]!.getByRole("button", { name: "Run local simulation" }).click();
  await items[3]!
    .getByRole("button", { name: "Queue local simulation" })
    .click();
  await expect(
    items[3]!.getByRole("button", { name: "Run local simulation" }),
  ).toBeVisible();
});
