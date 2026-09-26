import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

test("[F-ECO-08-C] operator aggregates do not grant private member drill-down", async ({
  page,
  context,
  browser,
}) => {
  const privateText = `Invented member-only outcome ${randomUUID()}`;
  const privateBytes = Buffer.from(privateText);
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  const ownerId = await memberId(context);
  await pool.query(
    `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
     VALUES($1,$2,'Invented goal',$3,'Check my next step')`,
    [randomUUID(), ownerId, privateText],
  );
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const uploaded = await page.request.post("/api/evidence", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "text/plain",
      "X-Evidence-Name": "invented-member-only-outcome.txt",
      "X-Evidence-Rights": "confirmed",
      "X-Evidence-Scopes": "private-review",
    },
    data: privateBytes,
  });
  expect(uploaded.status()).toBe(201);
  const { id: evidenceId } = (await uploaded.json()) as { id: string };
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(evidenceId, "clean")).toBe(true);

  const ownerExport = await page.request.get("/api/member/export");
  expect(ownerExport.status()).toBe(200);
  expect(await ownerExport.text()).toContain(privateText);
  const ownerEvidence = await page.request.get("/api/evidence/export");
  expect(ownerEvidence.status()).toBe(200);
  expect(await ownerEvidence.text()).toContain(evidenceId);
  const ownerLink = await page.request.post(
    `/api/evidence/${evidenceId}/download-link`,
    { headers: { Origin: origin, "X-CSRF-Token": csrf } },
  );
  expect(ownerLink.status()).toBe(200);
  const { href } = (await ownerLink.json()) as { href: string };
  expect(await (await page.request.get(href)).body()).toEqual(privateBytes);

  const operatorToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    operatorToken,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const operator = await browser.newContext({ baseURL: origin });
  const outsider = await browser.newContext({ baseURL: origin });
  try {
    const outsiderPage = await outsider.newPage();
    await outsiderPage.goto("/");
    await outsiderPage
      .getByLabel("Your starting point")
      .selectOption("explorer");
    await outsiderPage
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await outsiderPage
      .getByLabel("I'll use invented or sample information")
      .check();
    await outsiderPage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    await expect(outsiderPage).toHaveURL(/\/learn$/);
    const outsiderId = await memberId(outsider);
    expect(outsiderId).not.toBe(ownerId);
    await operator.addCookies([
      {
        name: "dne_preview",
        value: operatorToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const operatorPage = await operator.newPage();
    await operatorPage.goto("/");
    const operatorCsrf = await operatorPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();

    await requiredCheck(1, async () => {
      for (const path of [
        "/operator/metrics",
        `/operator/metrics?member_id=${ownerId}&evidence_id=${evidenceId}`,
      ]) {
        const metrics = await operatorPage.request.get(path);
        expect(metrics.status()).toBe(200);
        const report = await metrics.json();
        expect(report.scope).toBe("synthetic-local-preview");
        expect(report.counts.members).toBeGreaterThanOrEqual(2);
        const serialized = JSON.stringify(report);
        for (const secret of [
          ownerId,
          evidenceId,
          privateText,
          operatorToken,
        ]) {
          expect(serialized).not.toContain(secret);
        }
      }

      for (const path of [
        `/api/member/export?member_id=${ownerId}`,
        `/api/evidence/export?member_id=${ownerId}`,
        `/api/workspaces/${ownerId}/private`,
      ]) {
        const denied = await operatorPage.request.get(path);
        expect(denied.status()).toBe(403);
        expect(await denied.json()).toEqual({ error: "forbidden" });
        expect(await denied.text()).not.toContain(privateText);
      }
      const noLink = await operatorPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": operatorCsrf } },
      );
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      const stolenLink = await operatorPage.request.get(href);
      expect(stolenLink.status()).toBe(403);
      expect(await stolenLink.json()).toEqual({ error: "forbidden" });
      expect(await stolenLink.text()).not.toContain(privateText);
      const forgedMember = await outsiderPage.request.get(
        `/api/member/export?member_id=${ownerId}`,
      );
      expect(forgedMember.status()).toBe(200);
      const forgedPayload = await forgedMember.json();
      expect(forgedPayload.profile.id).toBe(outsiderId);
      expect(JSON.stringify(forgedPayload)).not.toContain(privateText);
      const outsiderEvidence = await outsiderPage.request.get(
        `/api/evidence/export?member_id=${ownerId}`,
      );
      expect(outsiderEvidence.status()).toBe(200);
      expect(await outsiderEvidence.text()).not.toContain(evidenceId);
      const outsiderCsrf = await outsiderPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const outsiderLink = await outsiderPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": outsiderCsrf } },
      );
      expect(outsiderLink.status()).toBe(403);
      expect(await (await outsiderPage.request.get(href)).status()).toBe(403);
      expect(await (await page.request.get(href)).body()).toEqual(privateBytes);
    });
  } finally {
    await operator.close();
    await outsider.close();
  }
});
