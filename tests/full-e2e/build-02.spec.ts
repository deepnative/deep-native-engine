import { createHash, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
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
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
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

async function submittedEvidence(page: Page, context: BrowserContext) {
  await onboard(page);
  const ownerId = await memberId(context);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const bytes = Buffer.from(
    `Invented private BUILD-02 submission ${randomBytes(8).toString("hex")}.`,
  );
  const uploaded = await page.request.post("/api/evidence", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "text/plain",
      "X-Evidence-Name": "invented-build-02.txt",
      "X-Evidence-Rights": "confirmed",
      "X-Evidence-Scopes": "private-review",
    },
    data: bytes,
  });
  expect(uploaded.status()).toBe(201);
  const { id: evidenceId } = (await uploaded.json()) as { id: string };
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(evidenceId, "clean")).toBe(true);
  const submitted = await page.request.post(
    `/api/evidence/${evidenceId}/review`,
    { headers: { Origin: origin, "X-CSRF-Token": csrf } },
  );
  expect(submitted.status()).toBe(204);
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [evidenceId],
  );
  expect(submission.rowCount).toBe(1);
  return {
    ownerId,
    evidenceId,
    submissionId: submission.rows[0]!.id,
    bytes,
    csrf,
  };
}

test("[F-BUILD-02-A] member keeps original and revised evidence separately private", async ({
  page,
  context,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const reviewer = await browser.newContext({ baseURL: origin });
  const originalBytes = `Invented original member sample ${randomBytes(8).toString("hex")}.`;
  const revisedBytes = `Invented revised member sample ${randomBytes(8).toString("hex")}.`;
  try {
    await onboard(page);
    const ownerId = await memberId(context);
    const outsiderPage = await outsider.newPage();
    await onboard(outsiderPage);
    expect(await memberId(outsider)).not.toBe(ownerId);
    let originalId = "";
    await requiredCheck(1, async () => {
      await page.goto("/evidence");
      await page.getByLabel("Sample title").fill("original-build02.txt");
      await page.getByLabel("Invented text sample").fill(originalBytes);
      await page
        .getByLabel(
          "I created this invented sample and have the right to store it.",
        )
        .check();
      await page
        .getByLabel(
          "I explicitly allow this sample to be considered for private review",
          { exact: false },
        )
        .check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const original = await pool.query<{ id: string; storage_key: string }>(
        `SELECT id,storage_key FROM evidence_objects
         WHERE owner_principal_id=$1 AND original_name='original-build02.txt'`,
        [ownerId],
      );
      expect(original.rowCount).toBe(1);
      originalId = original.rows[0]!.id;
      const storage = fileObjectStorage(
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
      );
      expect(await storage.get(original.rows[0]!.storage_key)).toEqual(
        Buffer.from(originalBytes),
      );
      const evidence = evidenceStore(pool, storage, "test-only-scanner-secret");
      expect(await evidence.transitionQuarantine(originalId, "clean")).toBe(
        true,
      );
      await page.reload();
      await page
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await page
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      await expect(
        page.getByText("Submitted locally", { exact: false }),
      ).toBeVisible();
      const outsiderCsrf = await outsiderPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const denied = await outsiderPage.request.post(
        `/api/evidence/${originalId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": outsiderCsrf } },
      );
      expect(denied.status()).toBe(403);
      expect((await denied.text()).includes(originalBytes)).toBe(false);
    });

    await requiredCheck(2, async () => {
      await page
        .getByRole("link", {
          name: "Create a new private revision of original-build02.txt",
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "New private evidence revision" }),
      ).toBeVisible();
      await page.getByLabel("Revised sample title").fill("revised-build02.txt");
      await page
        .getByRole("textbox", { name: "New invented text", exact: true })
        .fill(revisedBytes);
      await page
        .getByLabel(
          "I created this new invented text and have the right to store it.",
        )
        .check();
      await page
        .getByLabel(
          "I separately allow this revision to be considered for private review",
          {
            exact: false,
          },
        )
        .check();
      await page
        .getByRole("button", { name: "Save new private revision" })
        .click();
      await expect(page).toHaveURL(/\/evidence$/);
      const rows = await pool.query<{
        id: string;
        revision_parent_id: string | null;
        revision_number: number;
        quarantine_state: string;
        storage_key: string;
      }>(
        `SELECT id,revision_parent_id,revision_number,quarantine_state,storage_key
         FROM evidence_objects WHERE owner_principal_id=$1 ORDER BY revision_number`,
        [ownerId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]).toMatchObject({
        id: originalId,
        revision_parent_id: null,
        revision_number: 1,
        quarantine_state: "clean",
      });
      expect(rows.rows[1]).toMatchObject({
        revision_parent_id: originalId,
        revision_number: 2,
        quarantine_state: "pending",
      });
      const revisedId = rows.rows[1]!.id;
      const storage = fileObjectStorage(
        process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
      );
      expect(await storage.get(rows.rows[0]!.storage_key)).toEqual(
        Buffer.from(originalBytes),
      );
      expect(await storage.get(rows.rows[1]!.storage_key)).toEqual(
        Buffer.from(revisedBytes),
      );
      await expect(
        page.getByText(`Private evidence version 2 · revises ${originalId}`, {
          exact: false,
        }),
      ).toBeVisible();
      const evidence = evidenceStore(pool, storage, "test-only-scanner-secret");
      expect(
        await evidence.submitForReview(
          (await context.cookies()).find(
            (cookie) => cookie.name === "dne_preview",
          )!.value,
          revisedId,
        ),
      ).toBe(false);
      const originalSubmissionRow = await pool.query<{ id: string }>(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [originalId],
      );
      expect(originalSubmissionRow.rowCount).toBe(1);
      const pendingSubmission = await pool.query(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [revisedId],
      );
      expect(pendingSubmission.rowCount).toBe(0);

      const auth = authorizationStore(pool);
      const expires = new Date(Date.now() + 86_400_000);
      const adminId = await auth.provisionStaff(
        randomBytes(32).toString("hex"),
        "platform_admin",
        expires,
      );
      const reviewerToken = randomBytes(32).toString("hex");
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
        "original synthetic submission only",
        expires,
      );
      await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignmentId,
        originalSubmissionRow.rows[0]!.id,
        "original synthetic submission only",
        expires,
      );
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
      const linkFor = (id: string) =>
        reviewerPage.request.post(`/api/evidence/${id}/download-link`, {
          headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf },
        });
      const originalLink = await linkFor(originalId);
      expect(originalLink.status()).toBe(200);
      const { href } = (await originalLink.json()) as { href: string };
      expect(await (await reviewerPage.request.get(href)).body()).toEqual(
        Buffer.from(originalBytes),
      );
      const noPendingLink = await linkFor(revisedId);
      expect(noPendingLink.status()).toBe(403);
      expect(await noPendingLink.json()).toEqual({ error: "forbidden" });
      expect((await noPendingLink.text()).includes(revisedBytes)).toBe(false);
      const guessedRevision = await reviewerPage.request.get(
        href.replace(originalId, revisedId),
      );
      expect(guessedRevision.status()).toBe(403);
      expect(await guessedRevision.json()).toEqual({ error: "forbidden" });
      expect((await guessedRevision.text()).includes(revisedBytes)).toBe(false);

      expect(await evidence.transitionQuarantine(revisedId, "clean")).toBe(
        true,
      );
      await page.reload();
      await page
        .getByRole("listitem")
        .filter({ hasText: "revised-build02.txt" })
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await page
        .getByRole("listitem")
        .filter({ hasText: "revised-build02.txt" })
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      const submissions = await pool.query<{ evidence_id: string; id: string }>(
        `SELECT evidence_id,id FROM evidence_review_submissions
         WHERE evidence_id IN ($1,$2) ORDER BY evidence_id`,
        [originalId, revisedId],
      );
      expect(submissions.rowCount).toBe(2);
      const originalSubmission = submissions.rows.find(
        (row) => row.evidence_id === originalId,
      );
      expect(originalSubmission?.id).toBe(originalSubmissionRow.rows[0]!.id);
      expect((await linkFor(originalId)).status()).toBe(200);
      const noRevisionLink = await linkFor(revisedId);
      expect(noRevisionLink.status()).toBe(403);
      expect((await noRevisionLink.text()).includes(revisedBytes)).toBe(false);
      const outsiderCsrf = await outsiderPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const outsiderRevision = await outsiderPage.request.post(
        `/api/evidence/${revisedId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": outsiderCsrf } },
      );
      expect(outsiderRevision.status()).toBe(403);
      expect((await outsiderRevision.text()).includes(revisedBytes)).toBe(
        false,
      );
    });
  } finally {
    await outsider.close();
    await reviewer.close();
  }
});

test("[F-BUILD-02-C] another member and an unassigned coach cannot read submitted evidence", async ({
  page,
  context,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const coach = await browser.newContext({ baseURL: origin });
  try {
    const { ownerId, evidenceId, bytes, csrf } = await submittedEvidence(
      page,
      context,
    );
    const ownerLink = await page.request.post(
      `/api/evidence/${evidenceId}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": csrf } },
    );
    expect(ownerLink.status()).toBe(200);
    const { href } = (await ownerLink.json()) as { href: string };
    expect(await (await page.request.get(href)).body()).toEqual(bytes);

    const outsiderPage = await outsider.newPage();
    await onboard(outsiderPage);
    expect(await memberId(outsider)).not.toBe(ownerId);
    await requiredCheck(1, async () => {
      const outsiderCsrf = await outsiderPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const noLink = await outsiderPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": outsiderCsrf } },
      );
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      const stolen = await outsiderPage.request.get(href);
      expect(stolen.status()).toBe(403);
      expect((await stolen.text()).includes(bytes.toString())).toBe(false);
    });

    const coachToken = randomBytes(32).toString("hex");
    const coachId = await authorizationStore(pool).provisionStaff(
      coachToken,
      "coach",
      new Date(Date.now() + 86_400_000),
    );
    await coach.addCookies([
      {
        name: "dne_preview",
        value: coachToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const coachPage = await coach.newPage();
    await coachPage.goto("/");
    await requiredCheck(2, async () => {
      const grants = await pool.query(
        "SELECT id FROM assignment_grants WHERE staff_id=$1 AND workspace_id=$2",
        [coachId, ownerId],
      );
      expect(grants.rowCount).toBe(0);
      const coachCsrf = await coachPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const noLink = await coachPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": coachCsrf } },
      );
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      const stolen = await coachPage.request.get(href);
      expect(stolen.status()).toBe(403);
      expect((await stolen.text()).includes(bytes.toString())).toBe(false);
      expect(await (await page.request.get(href)).body()).toEqual(bytes);
    });
  } finally {
    await outsider.close();
    await coach.close();
  }
});

test("[F-BUILD-02-D] reviewer assignment revocation and capability expiry deny submitted evidence", async ({
  page,
  context,
  browser,
}) => {
  const clockFile = join(
    process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
    ".test-evidence-clock",
  );
  const reviewer = await browser.newContext({ baseURL: origin });
  try {
    const { ownerId, evidenceId, submissionId, bytes } =
      await submittedEvidence(page, context);
    const auth = authorizationStore(pool);
    const now = Date.now();
    const expires = new Date(now + 86_400_000);
    const adminId = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      "platform_admin",
      expires,
    );
    const reviewerToken = randomBytes(32).toString("hex");
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
      "exact BUILD-02 synthetic submission",
      expires,
    );
    await auth.grantEvidenceReview(
      adminId,
      reviewerId,
      assignmentId,
      submissionId,
      "exact BUILD-02 synthetic submission",
      expires,
    );
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
    const linkFor = () =>
      reviewerPage.request.post(`/api/evidence/${evidenceId}/download-link`, {
        headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf },
      });
    writeFileSync(clockFile, String(now));
    const issued = await linkFor();
    expect(issued.status()).toBe(200);
    const { href, expiresAt } = (await issued.json()) as {
      href: string;
      expiresAt: string;
    };
    expect(expiresAt).toBe(new Date(now + 300_000).toISOString());
    expect(await (await reviewerPage.request.get(href)).body()).toEqual(bytes);

    await requiredCheck(1, async () => {
      expect(await auth.revokeAssignment(adminId, assignmentId)).toBe(true);
      const noLink = await linkFor();
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      expect((await noLink.text()).includes(bytes.toString())).toBe(false);
    });
    await requiredCheck(2, async () => {
      const old = await reviewerPage.request.get(href);
      expect(old.status()).toBe(403);
      expect(await old.json()).toEqual({ error: "forbidden" });
      expect((await old.text()).includes(bytes.toString())).toBe(false);
    });

    const restoredAssignment = await auth.grantAssignment(
      adminId,
      reviewerId,
      ownerId,
      "reviewer",
      "restored exact BUILD-02 synthetic submission",
      expires,
    );
    await auth.grantEvidenceReview(
      adminId,
      reviewerId,
      restoredAssignment,
      submissionId,
      "restored exact BUILD-02 synthetic submission",
      expires,
    );
    writeFileSync(clockFile, String(now + 300_000 - 1));
    const beforeExpiry = await reviewerPage.request.get(href);
    expect(beforeExpiry.status()).toBe(200);
    expect(await beforeExpiry.body()).toEqual(bytes);
    await requiredCheck(3, async () => {
      writeFileSync(clockFile, String(now + 300_000 + 1));
      const expired = await reviewerPage.request.get(href);
      expect(expired.status()).toBe(403);
      expect(await expired.json()).toEqual({ error: "forbidden" });
      expect((await expired.text()).includes(bytes.toString())).toBe(false);
    });
  } finally {
    rmSync(clockFile, { force: true });
    await reviewer.close();
  }
});
