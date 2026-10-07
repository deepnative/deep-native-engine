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
  test(`[L${133 + index}] ${background} downloads retained test-unit history across bounded private pages`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex"),
      otherToken = randomBytes(32).toString("hex");
    await members.create(token, { background, goal });
    await members.create(otherToken, {
      background: "explorer",
      goal: "everyday",
    });
    const own = await members.session(token),
      other = await members.session(otherToken);
    if (own.kind !== "active" || other.kind !== "active")
      throw Error("Invented member unavailable");
    const id = own.learner.id;
    let erased = false;
    try {
      // Existing local fixture allowances only; the browser grants no units.
      await ledger.grant(id, "study_requests", 2, randomUUID(), {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const first = await source(
        page,
        token,
        `History-complete-${randomUUID()}.txt`,
      );
      await first.item
        .getByLabel("Hold one existing local test request")
        .check();
      await first.item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await expect(
        first.item.getByText("One local test request: held."),
      ).toBeVisible();
      await first.item
        .getByRole("button", { name: "Run local test request" })
        .click();
      await expect(
        first.item.getByText("One local test request: consumed."),
      ).toBeVisible();
      const second = await source(
        page,
        token,
        `History-cancel-${randomUUID()}.txt`,
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
      const reviewGrant = await ledger.grant(
        id,
        "review_minutes",
        2,
        randomUUID(),
        {
          startsAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z",
        },
      );
      const reviewHold = await ledger.reserve(id, reviewGrant, 1, randomUUID());
      await ledger.settleCompletion(id, reviewHold, randomUUID(), {
        reference: "synthetic:history-review-" + randomUUID(),
        category: "review_minutes",
        deliveredMinutes: 1,
        preparationMinutes: 0,
      });
      for (let i = 0; i < 55; i++)
        await ledger.grant(id, "coach_minutes", 1, randomUUID(), {
          startsAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z",
        });
      await ledger.grant(other.learner.id, "mock_sessions", 77, randomUUID(), {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const before = (
        await pool.query(
          "SELECT count(*)::int AS n FROM synthetic_entitlement_events WHERE member_id=$1",
          [id],
        )
      ).rows[0].n;
      await page.goto("/member/test-units");
      await page
        .getByRole("link", {
          name: "Download retained test-unit history",
          exact: true,
        })
        .click();
      await expect(
        page.getByText(/Available quantities are stored counters/),
      ).toBeVisible();
      const collected: Record<string, Record<string, unknown>[]> = {
        testUnitGrants: [],
        testUnitReservations: [],
        testUnitEvents: [],
        testUnitSettlements: [],
      };
      let number = 0,
        continuation: string | null = null;
      do {
        const button = page.getByRole("button", {
          name: `Download page ${++number}`,
          exact: true,
        });
        await button.focus();
        await expect(button).toBeFocused();
        const downloadPromise = page.waitForEvent("download");
        await page.keyboard.press("Enter");
        const download = await downloadPromise,
          stream = await download.createReadStream();
        if (!stream) throw Error("Private download stream unavailable");
        let text = "";
        for await (const chunk of stream) text += chunk.toString();
        expect(download.suggestedFilename()).toBe(
          `deep-native-member-records-page-${number}.json`,
        );
        const payload = JSON.parse(text);
        expect(payload.version).toBe("local-member-records-v25");
        expect(payload.page.recordCount).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
        expect(payload.testUnitHistory.availableMeaning).toBe(
          "stored-counter-not-usable-balance",
        );
        expect(
          Number.isFinite(Date.parse(payload.testUnitHistory.observedAt)),
        ).toBe(true);
        for (const name of Object.keys(collected)) {
          collected[name]!.push(...payload.records[name]);
          for (const record of payload.records[name]) {
            expect(JSON.stringify(record)).not.toMatch(
              /memberId|idempotency|fingerprint|resultId|completionRef|staffId|provider/,
            );
            expect(JSON.stringify(record)).not.toContain(other.learner.id);
            expect(record.quantity).not.toBe(77);
          }
        }
        continuation = payload.page.nextCursor;
        if (continuation) {
          const next = page.getByRole("link", {
            name: "Next page",
            exact: true,
          });
          await expect(next).toBeVisible();
          await next.click();
          await page.reload();
        }
        expect(number).toBeLessThan(6);
      } while (continuation);
      expect(number).toBeGreaterThan(1);
      expect(collected.testUnitGrants).toHaveLength(57);
      expect(
        collected.testUnitReservations!.map((row) => row.state).sort(),
      ).toEqual(["consumed", "consumed", "released"]);
      expect(collected.testUnitSettlements).toHaveLength(1);
      expect(collected.testUnitSettlements![0]).toMatchObject({
        category: "review_minutes",
        deliveredMinutes: 1,
        preparationMinutes: 0,
      });
      const studyHold = collected.testUnitReservations!.find(
        (row) => row.category === "study_requests" && row.state === "consumed",
      )!;
      expect(
        collected.testUnitSettlements!.some(
          (row) => row.reservationId === studyHold.id,
        ),
      ).toBe(false);
      expect(collected.testUnitEvents).toHaveLength(before);
      expect(new Set(collected.testUnitEvents!.map((row) => row.id)).size).toBe(
        before,
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM synthetic_entitlement_events WHERE member_id=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(before);
      const summary = await page.request.get("/member/test-units/download");
      const report = await summary.json();
      expect(report.scope).toBe("synthetic-local-preview");
      expect(
        report.categories.find(
          (row: { category: string }) => row.category === "study_requests",
        ),
      ).toMatchObject({ usable: 1, held: 0, consumed: 1 });
      expect(report.testUnitHistory).toBeUndefined();
      await expect(
        page.getByRole("heading", { name: `Page ${number}` }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("retained-history-download.png"),
        fullPage: true,
      });
      await evidence.removeWorkspace(token);
      await members.remove(id);
      erased = true;
      expect((await page.request.get("/api/member/export")).status()).toBe(403);
    } finally {
      if (!erased) {
        await evidence.removeWorkspace(token);
        await members.remove(id);
      }
      await members.remove(other.learner.id);
    }
  });
}
