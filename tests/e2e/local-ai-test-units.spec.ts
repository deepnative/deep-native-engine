import { test, expect, type Page } from "@playwright/test";
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
const origin = "http://127.0.0.1:4317";
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
