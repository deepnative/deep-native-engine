import { createHash, randomBytes, randomUUID } from "node:crypto";
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

test("[F-BUILD-08-A] owner export excludes another member's private records", async ({
  page,
  context,
  browser,
}) => {
  const outsider = await browser.newContext({ baseURL: origin });
  const anonymous = await browser.newContext({ baseURL: origin });
  try {
    const outsiderPage = await outsider.newPage();
    await onboard(page);
    await onboard(outsiderPage);
    const ownerId = await memberId(context);
    const outsiderId = await memberId(outsider);
    expect(outsiderId).not.toBe(ownerId);
    const ownerTitle = `Invented private owner milestone ${randomBytes(4).toString("hex")}`;
    const outsiderTitle = `Invented private outsider milestone ${randomBytes(4).toString("hex")}`;
    for (const [memberId, title] of [
      [ownerId, ownerTitle],
      [outsiderId, outsiderTitle],
    ]) {
      await pool.query(
        `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
         VALUES($1,$2,'Invented goal',$3,'Check my next step')`,
        [randomUUID(), memberId, title],
      );
    }
    const linkName = "Download my structured preview records";
    const ownerLink = page.getByRole("link", { name: linkName });

    await requiredCheck(1, async () => {
      await expect(ownerLink).toHaveAttribute("href", "/api/member/export");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        ownerLink.click(),
      ]);
      expect(download.suggestedFilename()).toBe(
        "deep-native-member-records.json",
      );
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      const payload = JSON.parse(await readFile(downloadPath!, "utf8")) as {
        version: string;
        profile: { id: string };
        records: { milestones: { milestoneTitle: string }[] };
      };
      expect(payload.version).toBe("local-member-records-v1");
      expect(payload.profile.id).toBe(ownerId);
      expect(payload.records.milestones).toMatchObject([
        { milestoneTitle: ownerTitle },
      ]);
      expect(JSON.stringify(payload)).not.toContain(outsiderTitle);
      expect(JSON.stringify(payload)).not.toContain(outsiderId);
      const response = await page.request.get("/api/member/export");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-disposition"]).toContain(
        "deep-native-member-records.json",
      );
      expect(response.headers()["cache-control"]).toBe("no-store");
    });

    await requiredCheck(2, async () => {
      const outsiderLink = outsiderPage.getByRole("link", { name: linkName });
      await expect(outsiderLink).toHaveAttribute("href", "/api/member/export");
      const [download] = await Promise.all([
        outsiderPage.waitForEvent("download"),
        outsiderLink.click(),
      ]);
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      const payload = JSON.parse(await readFile(downloadPath!, "utf8")) as {
        profile: { id: string };
        records: { milestones: { milestoneTitle: string }[] };
      };
      expect(payload.profile.id).toBe(outsiderId);
      expect(payload.records.milestones).toMatchObject([
        { milestoneTitle: outsiderTitle },
      ]);
      expect(JSON.stringify(payload)).not.toContain(ownerTitle);
      expect(JSON.stringify(payload)).not.toContain(ownerId);
      const forged = await outsiderPage.request.get(
        `/api/member/export?member_id=${ownerId}`,
      );
      expect(forged.status()).toBe(200);
      const forgedPayload = await forged.json();
      expect(forgedPayload).toMatchObject({
        profile: { id: outsiderId },
        records: { milestones: [{ milestoneTitle: outsiderTitle }] },
      });
      expect(JSON.stringify(forgedPayload)).not.toContain(ownerTitle);
      const denied = await anonymous.request.get("/api/member/export");
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
    });
  } finally {
    await outsider.close();
    await anonymous.close();
  }
});

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
      await page.goto("/evidence");
      const sample = page.getByRole("listitem").filter({
        has: page.getByRole("heading", { name: "invented-revocable.txt" }),
      });
      await expect(sample).toContainText("Private-review consent active");
      await sample
        .getByLabel("Stop private-review access to invented-revocable.txt")
        .check();
      await sample
        .getByRole("button", { name: "Revoke review consent" })
        .click();
      await expect(page).toHaveURL(/\/evidence$/);
      await expect(sample).toContainText("Private-review consent revoked");
      await expect(
        sample.getByRole("button", { name: "Revoke review consent" }),
      ).toHaveCount(0);
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
      const currentCsrf = await page
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const ownerLink = await page.request.post(
        `/api/evidence/${id}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": currentCsrf } },
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
  const sampleName = `invented-delete-${randomBytes(4).toString("hex")}.txt`;
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
        "X-Evidence-Name": sampleName,
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
      await page.goto("/evidence");
      const sample = page.getByRole("listitem").filter({
        has: page.getByRole("heading", { name: sampleName }),
      });
      await expect(sample).toContainText("Safety check passed");
      await sample
        .getByLabel(
          `Delete ${sampleName} and its configured active derivatives`,
        )
        .check();
      await sample.getByRole("button", { name: "Delete sample" }).click();
      await expect(page).toHaveURL(/\/evidence$/);
      await expect(sample).toHaveCount(0);
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
