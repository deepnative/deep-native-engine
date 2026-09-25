import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function onboard(page: Page, background: "explorer" | "professional") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page
    .getByLabel("What would you like to do?")
    .selectOption(background === "explorer" ? "everyday" : "work");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const member = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(member.rowCount).toBe(1);
  return member.rows[0]!.id;
}

test("[F-ROADMAP-02-A] guessed workspace, evidence and staff APIs reveal no other member's private data", async ({
  page,
  context,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const privateDraft =
    "Invented private event plan: only member A may read these sample steps.";
  const privateBytes = Buffer.from(
    "Invented private evidence: member A's sample, not a shared resource.",
  );
  try {
    await onboard(page, "explorer");
    const ownerId = await memberId(context);
    await page.getByRole("link", { name: "Open lesson" }).click();
    await page.getByLabel("Your instruction to AI").fill(privateDraft);
    await page.getByRole("button", { name: "Save draft" }).click();
    const ownerWorkspace = await page.request.get(
      `/api/workspaces/${ownerId}/private`,
    );
    expect(ownerWorkspace.status()).toBe(200);
    expect((await ownerWorkspace.json()).records[0].instruction).toBe(
      privateDraft,
    );

    const otherPage = await outsider.newPage();
    await onboard(otherPage, "professional");
    const outsiderId = await memberId(outsider);
    expect(outsiderId).not.toBe(ownerId);
    await requiredCheck(1, async () => {
      const denied = await otherPage.request.get(
        `/api/workspaces/${ownerId}/private?workspace_id=${ownerId}`,
      );
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
      expect((await denied.text()).includes(privateDraft)).toBe(false);
      await otherPage.goto(`/learn?learner_id=${ownerId}`);
      await expect(otherPage.getByText(privateDraft)).toHaveCount(0);
    });

    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const uploaded = await page.request.post("/api/evidence", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "text/plain",
        "X-Evidence-Name": "invented-private.txt",
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
    const issued = await page.request.post(
      `/api/evidence/${evidenceId}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": csrf } },
    );
    expect(issued.status()).toBe(200);
    const { href } = (await issued.json()) as { href: string };
    const ownerDownload = await page.request.get(href);
    expect(ownerDownload.status()).toBe(200);
    expect(await ownerDownload.body()).toEqual(privateBytes);

    await requiredCheck(2, async () => {
      const outsiderCsrf = await otherPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const noLink = await otherPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": outsiderCsrf } },
      );
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      const stolenLink = await otherPage.request.get(href);
      expect(stolenLink.status()).toBe(403);
      expect(await stolenLink.json()).toEqual({ error: "forbidden" });
      expect((await stolenLink.text()).includes(privateBytes.toString())).toBe(
        false,
      );
    });

    await requiredCheck(3, async () => {
      const metrics = await otherPage.request.get("/operator/metrics");
      expect(metrics.status()).toBe(403);
      expect(await metrics.json()).toEqual({ error: "forbidden" });
      const roster = await otherPage.request.get("/operator/experts");
      expect(roster.status()).toBe(403);
      expect((await roster.text()).includes(privateDraft)).toBe(false);
      const staff = await pool.query(
        `SELECT p.kind,s.role FROM principals p LEFT JOIN staff_profiles s
         ON s.principal_id=p.id WHERE p.id=$1`,
        [outsiderId],
      );
      expect(staff.rows).toEqual([{ kind: "member", role: null }]);
    });
  } finally {
    await outsider.close();
  }
});
