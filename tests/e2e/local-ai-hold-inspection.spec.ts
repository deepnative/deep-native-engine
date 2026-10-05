import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool);
const objects = fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
  evidence = evidenceStore(pool, objects, "browser-secret"),
  local = localAiConsentStore(pool, objects, deterministicRegistry({}, "test")),
  inspection = localAiHoldInspectionStore(pool, {
    mode: "test",
    enabled: true,
  });
const origin = "http://127.0.0.1:4317";
test.afterAll(() => pool.end());
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
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${166 + index}] ${background} held local request metadata requires a current exact operator assignment`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex"),
      adminToken = randomBytes(32).toString("hex"),
      operatorToken = randomBytes(32).toString("hex"),
      outsiderToken = randomBytes(32).toString("hex");
    await members.create(token, { background, goal });
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented owner unavailable");
    const memberId = session.learner.id,
      expires = new Date(Date.now() + 3600000),
      starts = new Date(Date.now() - 60000),
      staffIds: string[] = [];
    try {
      staffIds.push(
        await auth.provisionStaff(adminToken, "platform_admin", expires),
      );
      const operatorId = await auth.provisionStaff(
        operatorToken,
        "operator",
        expires,
      );
      staffIds.push(
        operatorId,
        await auth.provisionStaff(outsiderToken, "operator", expires),
      );
      await ledger.grant(memberId, "study_requests", 1, randomUUID(), {
        startsAt: starts.toISOString(),
        expiresAt: expires.toISOString(),
      });
      const title = `Invented-private-${randomUUID()}`;
      const uploaded = await evidence.upload(token, {
        name: title,
        mediaType: "text/plain",
        data: Buffer.from(
          "Invented private source must not enter the operator snapshot",
        ),
        consent: {
          rightsConfirmed: true,
          privateReview: true,
          communityPublication: false,
        },
      });
      if (uploaded.kind !== "created")
        throw Error("Invented source unavailable");
      await evidence.transitionQuarantine(uploaded.id, "clean");
      const permission = await local.grant(token, uploaded.id);
      if (permission.kind !== "granted")
        throw Error("Invented permission unavailable");
      const queued = await local.enqueueMetered(
        token,
        permission.receiptId,
        randomUUID(),
      );
      if (queued.kind !== "queued") throw Error("Invented request unavailable");
      // Explicit durable expired-claim fixture, not evidence of provider execution.
      // Real integration cases inject ambiguous dispatch and exercise read races.
      await pool.query(
        "UPDATE adapter_jobs SET status='running',attempt_count=1,attempt_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [queued.jobId, randomUUID()],
      );
      const before = (
        await pool.query(
          "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
          [queued.jobId],
        )
      ).rows;
      await signIn(page, token);
      await page.goto("/evidence/local-ai");
      await expect(
        page.getByText("One local test request: held."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Run local test request" }),
      ).toHaveCount(0);
      await signIn(page, operatorToken);
      expect((await page.goto("/operator/local-ai-holds"))?.status()).toBe(403);
      const granted = await inspection.grant(
        adminToken,
        queued.jobId,
        operatorId,
        starts,
        expires,
        randomUUID(),
      );
      if (!("grantId" in granted)) throw Error("Exact assignment unavailable");
      expect((await page.goto("/operator/local-ai-holds"))?.status()).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Assigned local request holds",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "Expired claim: outcome unconfirmed",
        }),
      ).toBeVisible();
      await expect(
        page.locator("dd").filter({ hasText: "reserved" }),
      ).toBeVisible();
      await expect(page.locator("form")).toHaveCount(0);
      await page
        .getByRole("link", { name: "Read a fresh assigned snapshot" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Assigned local request snapshot",
          exact: true,
        }),
      ).toBeVisible();
      const markup = await page.content();
      for (const secret of [
        token,
        adminToken,
        operatorToken,
        memberId,
        uploaded.id,
        permission.receiptId,
        operatorId,
        granted.grantId,
        title,
        "Invented private source must not enter the operator snapshot",
      ])
        expect(markup).not.toContain(secret);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("assigned-hold-snapshot.png"),
        fullPage: true,
      });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
            [queued.jobId],
          )
        ).rows,
      ).toEqual(before);
      await local.withdraw(token, permission.receiptId);
      await evidence.remove(token, uploaded.id);
      const afterSourceChange = (
        await pool.query(
          "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
          [queued.jobId],
        )
      ).rows;
      expect(afterSourceChange[0]?.value).toMatchObject({
        status: "needs_reconciliation",
        local_ai_receipt_id: null,
        attempt_token: null,
        lease_until: null,
      });
      expect((await page.reload())?.status()).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Started request: outcome unconfirmed",
        }),
      ).toBeVisible();
      for (const denied of [token, outsiderToken, adminToken]) {
        await signIn(page, denied);
        expect(
          (
            await page.goto(`/operator/local-ai-holds/${queued.jobId}`)
          )?.status(),
        ).toBe(403);
        await expect(
          page.getByRole("heading", {
            name: "Local request inspection unavailable",
          }),
        ).toBeVisible();
        expect(await page.content()).not.toContain(queued.jobId);
      }
      expect((await inspection.revoke(adminToken, granted.grantId)).kind).toBe(
        "applied",
      );
      await signIn(page, operatorToken);
      expect(
        (await page.goto(`/operator/local-ai-holds/${queued.jobId}`))?.status(),
      ).toBe(403);
      // Compare inspection against each stable lifecycle state; permission
      // withdrawal itself legitimately records uncertainty and clears its lease.
      const after = (
        await pool.query(
          "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
          [queued.jobId],
        )
      ).rows;
      expect(after).toEqual(afterSourceChange);
      await signIn(page, token);
      await page.goto("/member/test-units");
      const balance = page.locator(
        '[data-test-unit-category="study_requests"]',
      );
      await expect(balance.locator('[data-field="held"]')).toHaveText("1");
      await expect(balance.locator('[data-field="consumed"]')).toHaveText("0");
      await expect(balance.locator('[data-field="usable"]')).toHaveText("0");
    } finally {
      await evidence.removeWorkspace(token);
      await members.remove(memberId);
      await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
        staffIds,
      ]);
    }
  });
}
