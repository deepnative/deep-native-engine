import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => {
  await pool.end();
});

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

test("[L59] a member manages invented private evidence with honest safety and consent state", async ({
  page,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const otherPage = await outsider.newPage();
  const name = `invented-${randomBytes(8).toString("hex")}.txt`;
  try {
    await onboard(page);
    await onboard(otherPage);
    await page.getByRole("link", { name: "Manage private evidence" }).click();
    await expect(page.getByText("No sample evidence saved yet")).toBeVisible();
    await page.getByLabel("Sample title").fill(name);
    await page
      .getByLabel("Invented text sample")
      .fill("Invented private response");
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const invalid = await page.request.post("/evidence", {
      headers: { Origin: origin },
      form: { csrf, name, sample: "Invented private response" },
    });
    expect(invalid.status()).toBe(422);
    expect(await invalid.text()).toContain(
      "confirm your rights and private-review consent",
    );
    await expect(page.getByLabel("Invented text sample")).toHaveValue(
      "Invented private response",
    );
    await page.getByLabel("I created this invented sample").check();
    await page.getByLabel("I explicitly allow this sample").check();
    await page
      .getByRole("button", { name: "Save private text sample" })
      .click();
    await expect(
      page.getByText("Pending safety check; no live scanner is connected"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Download ${name}` }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Download my evidence JSON" }),
    ).toBeVisible();
    const row = (
      await pool.query<{ id: string }>(
        "SELECT id FROM evidence_objects WHERE original_name=$1",
        [name],
      )
    ).rows[0];
    expect(row).toBeDefined();
    const id = row!.id;
    const pendingExport = await page.request.get("/api/evidence/export");
    expect(pendingExport.status()).toBe(200);
    expect(pendingExport.headers()["cache-control"]).toBe("no-store");
    expect(pendingExport.headers()["content-disposition"]).toContain(
      "deep-native-evidence.json",
    );
    expect(await pendingExport.json()).toMatchObject({
      version: "local-evidence-v1",
      items: [{ id, quarantineState: "pending", sourceBase64: null }],
    });
    await otherPage.goto("/evidence");
    await expect(otherPage.getByText(name)).toHaveCount(0);
    expect(
      await (await otherPage.request.get("/api/evidence/export")).json(),
    ).toMatchObject({
      items: [],
    });
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const outsiderDelete = await otherPage.request.post(
      `/evidence/${id}/delete`,
      {
        headers: { Origin: origin },
        form: { csrf: otherCsrf, confirm: "yes" },
      },
    );
    expect(outsiderDelete.status()).toBe(403);
    const forged = await page.request.post(`/evidence/${id}/delete`, {
      headers: { Origin: origin },
      form: { csrf: "wrong", confirm: "yes" },
    });
    expect(forged.status()).toBe(403);
    const evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "browser-secret",
    );
    expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
    await page.reload();
    await expect(
      page.getByText("Safety check passed in this local preview"),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${name}` }).click();
    expect((await download).suggestedFilename()).toBe(name);
    await page.getByLabel(`Stop private-review access to ${name}`).check();
    await page.getByRole("button", { name: "Revoke review consent" }).click();
    await expect(
      page.getByText("Private-review consent revoked"),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "SELECT private_review_allowed FROM evidence_objects WHERE id=$1",
          [id],
        )
      ).rows[0]?.private_review_allowed,
    ).toBe(false);
    const exported = await (
      await page.request.get("/api/evidence/export")
    ).json();
    expect(exported.items).toMatchObject([
      {
        id,
        privateReviewAllowed: false,
        quarantineState: "clean",
        sourceBase64: Buffer.from("Invented private response").toString(
          "base64",
        ),
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("storageKey");
    expect(
      JSON.stringify(
        await (await otherPage.request.get("/api/evidence/export")).json(),
      ),
    ).not.toContain(name);
    await page
      .getByLabel(`Delete ${name} and its configured active derivatives`)
      .check();
    await page.getByRole("button", { name: "Delete sample" }).click();
    await expect(page.getByText("No sample evidence saved yet")).toBeVisible();
    expect(
      (await pool.query("SELECT id FROM evidence_objects WHERE id=$1", [id]))
        .rows,
    ).toEqual([]);
    expect(
      await (await page.request.get("/api/evidence/export")).json(),
    ).toMatchObject({ items: [] });
  } finally {
    await outsider.close();
  }
});

test("[L60] only a clean consented owner sample enters the local review queue once", async ({
  page,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const otherPage = await outsider.newPage();
  const name = `review-intent-${randomBytes(8).toString("hex")}.txt`;
  try {
    await onboard(page);
    await onboard(otherPage);
    await page.goto("/evidence");
    await page.getByLabel("Sample title").fill(name);
    await page
      .getByLabel("Invented text sample")
      .fill("Invented private sample for local preview");
    await page.getByLabel("I created this invented sample").check();
    await page.getByLabel("I explicitly allow this sample").check();
    await page
      .getByRole("button", { name: "Save private text sample" })
      .click();
    const id = (
      await pool.query<{ id: string }>(
        "SELECT id FROM evidence_objects WHERE original_name=$1",
        [name],
      )
    ).rows[0]!.id;
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    await expect(
      page.getByRole("button", {
        name: "Queue for local review consideration",
      }),
    ).toHaveCount(0);
    const post = (token: string) =>
      page.request.post(`/evidence/${id}/queue`, {
        headers: { Origin: origin },
        form: { csrf: token, acknowledge: "yes" },
      });
    expect((await post(csrf)).status()).toBe(409);
    expect((await post("forged")).status()).toBe(403);
    const evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "browser-secret",
    );
    expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
    await page.reload();
    await expect(
      page.getByText("No qualified reviewer is assigned", { exact: false }),
    ).toBeVisible();
    await otherPage.goto("/evidence");
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const otherAttempt = await otherPage.request.post(`/evidence/${id}/queue`, {
      headers: { Origin: origin },
      form: { csrf: otherCsrf, acknowledge: "yes" },
    });
    expect(otherAttempt.status()).toBe(409);
    await page
      .getByLabel("No qualified reviewer is assigned", { exact: false })
      .check();
    await page
      .getByRole("button", { name: "Queue for local review consideration" })
      .click();
    await expect(
      page.getByText("Submitted locally; no qualified review is connected"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Queue for local review consideration",
      }),
    ).toHaveCount(0);
    expect(
      (
        await pool.query(
          "SELECT status FROM evidence_review_submissions WHERE evidence_id=$1",
          [id],
        )
      ).rows,
    ).toMatchObject([{ status: "queued" }]);
    expect((await post(csrf)).status()).toBe(409);
    await page.getByLabel(`Stop private-review access to ${name}`).check();
    await page.getByRole("button", { name: "Revoke review consent" }).click();
    await expect(
      page.getByText("Review submission withdrawn", { exact: false }),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "SELECT status FROM evidence_review_submissions WHERE evidence_id=$1",
          [id],
        )
      ).rows,
    ).toMatchObject([{ status: "withdrawn" }]);
    expect((await post(csrf)).status()).toBe(409);
  } finally {
    await outsider.close();
  }
});
