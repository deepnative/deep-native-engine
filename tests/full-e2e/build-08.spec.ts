import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
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
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

test("[F-BUILD-08-B] member revocation stops current reviewer links while retaining private evidence", async ({
  page,
  context,
  browser,
}) => {
  await onboard(page);
  const ownerId = await memberId(context);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const bytes = Buffer.from(
    "Invented evidence retained after consent revocation.",
  );
  const uploaded = await page.request.post("/api/evidence", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "text/plain",
      "X-Evidence-Name": "invented-revocable.txt",
      "X-Evidence-Rights": "confirmed",
      "X-Evidence-Scopes": "private-review,community-publication",
    },
    data: bytes,
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
  const submitted = await page.request.post(`/api/evidence/${id}/review`, {
    headers: { Origin: origin, "X-CSRF-Token": csrf },
  });
  expect(submitted.status()).toBe(204);
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [id],
  );
  expect(submission.rowCount).toBe(1);

  const auth = authorizationStore(pool);
  const adminToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 86_400_000);
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expires,
  );
  const reviewerId = await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    expires,
  );
  const assignmentId = await auth.grantAssignment(
    adminId,
    reviewerId,
    ownerId,
    "reviewer",
    "synthetic revocation journey",
    expires,
  );
  await auth.grantEvidenceReview(
    adminId,
    reviewerId,
    assignmentId,
    submission.rows[0]!.id,
    "synthetic exact object",
    expires,
  );

  const reviewer = await browser.newContext({ baseURL: origin });
  try {
    await reviewer.addCookies([
      {
        name: "dne_preview",
        value: reviewerToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const reviewerPage = await reviewer.newPage();
    await reviewerPage.goto("/");
    const reviewerCsrf = await reviewerPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const issued = await reviewerPage.request.post(
      `/api/evidence/${id}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf } },
    );
    expect(issued.status()).toBe(200);
    const { href } = (await issued.json()) as { href: string };
    expect(await (await reviewerPage.request.get(href)).body()).toEqual(bytes);

    await requiredCheck(1, async () => {
      const wrongOwner = await reviewerPage.request.post(
        `/api/evidence/${id}/revoke-private-review`,
        { headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf } },
      );
      expect(wrongOwner.status()).toBe(403);
      expect((await reviewerPage.request.get(href)).status()).toBe(200);
      const revoked = await page.request.post(
        `/api/evidence/${id}/revoke-private-review`,
        { headers: { Origin: origin, "X-CSRF-Token": csrf } },
      );
      expect(revoked.status()).toBe(204);
      const row = await pool.query<{
        private_review_allowed: boolean;
        private_review_revoked_at: Date;
        community_publication_allowed: boolean;
        status: string;
      }>(
        `SELECT e.private_review_allowed,e.private_review_revoked_at,
                e.community_publication_allowed,s.status
         FROM evidence_objects e JOIN evidence_review_submissions s
           ON s.evidence_id=e.id WHERE e.id=$1`,
        [id],
      );
      expect(row.rows[0]).toMatchObject({
        private_review_allowed: false,
        community_publication_allowed: true,
        status: "withdrawn",
      });
      expect(row.rows[0]!.private_review_revoked_at).toBeInstanceOf(Date);
      const oldLink = await reviewerPage.request.get(href);
      expect(oldLink.status()).toBe(403);
      expect(await oldLink.json()).toEqual({ error: "forbidden" });
      const newLink = await reviewerPage.request.post(
        `/api/evidence/${id}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf } },
      );
      expect(newLink.status()).toBe(403);
      expect(await newLink.json()).toEqual({ error: "forbidden" });
      const ownerLink = await page.request.post(
        `/api/evidence/${id}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": csrf } },
      );
      expect(ownerLink.status()).toBe(200);
      const own = await page.request.get(
        ((await ownerLink.json()) as { href: string }).href,
      );
      expect(await own.body()).toEqual(bytes);
    });
  } finally {
    await reviewer.close();
  }
});

test("[F-BUILD-08-C] owner deletion removes configured synthetic source and derivative", async ({
  page,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const otherPage = await outsider.newPage();
  const source = Buffer.from("Invented source material for deletion proof.");
  const derivative = Buffer.from(
    "Synthetic text extraction of invented material.",
  );
  try {
    await onboard(page);
    await onboard(otherPage);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const otherCsrf = await otherPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const uploaded = await page.request.post("/api/evidence", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "text/plain",
        "X-Evidence-Name": `invented-delete-${randomBytes(4).toString("hex")}.txt`,
        "X-Evidence-Rights": "confirmed",
        "X-Evidence-Scopes": "private-review",
      },
      data: source,
    });
    expect(uploaded.status()).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    const evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "test-only-scanner-secret",
    );
    expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
    const derivativeId = await evidence.addDerivative(
      id,
      "text-extract",
      derivative,
    );
    const sourceRow = (
      await pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM evidence_objects WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    const derivativeRow = (
      await pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM evidence_derivatives WHERE id=$1",
        [derivativeId],
      )
    ).rows[0]!;
    const path = (key: string) =>
      join(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!, key);
    expect(await readFile(path(sourceRow.storage_key))).toEqual(source);
    expect(await readFile(path(derivativeRow.storage_key))).toEqual(derivative);
    const issued = await page.request.post(
      `/api/evidence/${id}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": csrf } },
    );
    expect(issued.status()).toBe(200);
    const { href } = (await issued.json()) as { href: string };
    expect(await (await page.request.get(href)).body()).toEqual(source);
    expect(
      (
        await otherPage.request.delete(`/api/evidence/${id}`, {
          headers: { Origin: origin, "X-CSRF-Token": otherCsrf },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.delete(`/api/evidence/${id}`, {
          headers: { Origin: origin, "X-CSRF-Token": "forged" },
        })
      ).status(),
    ).toBe(403);
    expect(await readFile(path(sourceRow.storage_key))).toEqual(source);
    expect(await readFile(path(derivativeRow.storage_key))).toEqual(derivative);

    await requiredCheck(1, async () => {
      const deleted = await page.request.delete(`/api/evidence/${id}`, {
        headers: { Origin: origin, "X-CSRF-Token": csrf },
      });
      expect(deleted.status()).toBe(204);
      expect(
        (await pool.query("SELECT id FROM evidence_objects WHERE id=$1", [id]))
          .rows,
      ).toEqual([]);
      await expect(readFile(path(sourceRow.storage_key))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      const replay = await page.request.get(href);
      expect(replay.status()).toBe(403);
      expect((await replay.text()).includes(source.toString())).toBe(false);
    });
    await requiredCheck(2, async () => {
      expect(
        (
          await pool.query("SELECT id FROM evidence_derivatives WHERE id=$1", [
            derivativeId,
          ])
        ).rows,
      ).toEqual([]);
      await expect(
        readFile(path(derivativeRow.storage_key)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  } finally {
    await outsider.close();
  }
});
