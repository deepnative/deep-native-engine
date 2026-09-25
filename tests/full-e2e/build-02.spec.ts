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
