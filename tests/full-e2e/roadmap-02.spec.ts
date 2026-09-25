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

test("[F-ROADMAP-02-D] editor publication role cannot read private member work", async ({
  page,
  context,
  browser,
}) => {
  const privateDraft =
    "Invented member-only draft; an editor has no permission to inspect it.";
  const privateBytes = Buffer.from(
    "Invented member-only evidence for the editor isolation check.",
  );
  await onboard(page, "explorer");
  const ownerId = await memberId(context);
  await page.getByRole("link", { name: "Open lesson" }).click();
  await page.getByLabel("Your instruction to AI").fill(privateDraft);
  await page.getByRole("button", { name: "Save draft" }).click();
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const uploaded = await page.request.post("/api/evidence", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "text/plain",
      "X-Evidence-Name": "invented-editor-private.txt",
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
  const ownerLink = await page.request.post(
    `/api/evidence/${evidenceId}/download-link`,
    { headers: { Origin: origin, "X-CSRF-Token": csrf } },
  );
  expect(ownerLink.status()).toBe(200);
  const { href } = (await ownerLink.json()) as { href: string };
  expect((await page.request.get(href)).status()).toBe(200);

  const editorToken = randomBytes(32).toString("hex");
  const editorId = await authorizationStore(pool).provisionStaff(
    editorToken,
    "editor",
    new Date(Date.now() + 86_400_000),
  );
  const editor = await browser.newContext({ baseURL: origin });
  try {
    await editor.addCookies([
      {
        name: "dne_preview",
        value: editorToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const editorPage = await editor.newPage();
    await editorPage.goto("/");
    await requiredCheck(1, async () => {
      const role = await pool.query<{ role: string }>(
        "SELECT role FROM staff_profiles WHERE principal_id=$1",
        [editorId],
      );
      expect(role.rows).toEqual([{ role: "editor" }]);
      const workspace = await editorPage.request.get(
        `/api/workspaces/${ownerId}/private`,
      );
      expect(workspace.status()).toBe(403);
      expect(await workspace.json()).toEqual({ error: "forbidden" });
      expect((await workspace.text()).includes(privateDraft)).toBe(false);

      const editorCsrf = await editorPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const noLink = await editorPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": editorCsrf } },
      );
      expect(noLink.status()).toBe(403);
      expect(await noLink.json()).toEqual({ error: "forbidden" });
      const stolenLink = await editorPage.request.get(href);
      expect(stolenLink.status()).toBe(403);
      expect(await stolenLink.json()).toEqual({ error: "forbidden" });
      expect((await stolenLink.text()).includes(privateBytes.toString())).toBe(
        false,
      );
      expect((await page.request.get(href)).status()).toBe(200);
      const saved = await page.request.get(
        `/api/workspaces/${ownerId}/private`,
      );
      expect(saved.status()).toBe(200);
      expect((await saved.json()).records[0].instruction).toBe(privateDraft);
    });
  } finally {
    await editor.close();
  }
});

test("[F-ROADMAP-02-B] assigned reviewer reads only one exact submitted evidence object", async ({
  page,
  context,
  browser,
}) => {
  await onboard(page, "professional");
  const ownerId = await memberId(context);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
    "test-only-scanner-secret",
  );
  async function upload(name: string, data: Buffer, submit: boolean) {
    const response = await page.request.post("/api/evidence", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "text/plain",
        "X-Evidence-Name": name,
        "X-Evidence-Rights": "confirmed",
        "X-Evidence-Scopes": "private-review",
      },
      data,
    });
    expect(response.status()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
    if (submit) {
      const submitted = await page.request.post(`/api/evidence/${id}/review`, {
        headers: { Origin: origin, "X-CSRF-Token": csrf },
      });
      expect(submitted.status()).toBe(204);
    }
    return id;
  }

  const allowedBytes = Buffer.from("Invented submitted version A for review.");
  const otherBytes = Buffer.from("Invented submitted version B; no grant.");
  const draftBytes = Buffer.from("Invented clean draft; never submitted.");
  const allowedId = await upload("invented-version-a.txt", allowedBytes, true);
  const otherId = await upload("invented-version-b.txt", otherBytes, true);
  const draftId = await upload("invented-draft.txt", draftBytes, false);
  const submission = await pool.query<{ id: string }>(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
    [allowedId],
  );
  expect(submission.rowCount).toBe(1);

  const auth = authorizationStore(pool);
  const adminToken = randomBytes(32).toString("hex");
  const reviewerToken = randomBytes(32).toString("hex");
  const otherReviewerToken = randomBytes(32).toString("hex");
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
  await auth.provisionStaff(otherReviewerToken, "reviewer", expires);
  const assignmentId = await auth.grantAssignment(
    adminId,
    reviewerId,
    ownerId,
    "reviewer",
    "exact synthetic browser submission",
    expires,
  );

  const reviewer = await browser.newContext({ baseURL: origin });
  const otherReviewer = await browser.newContext({ baseURL: origin });
  try {
    for (const [staffContext, token] of [
      [reviewer, reviewerToken],
      [otherReviewer, otherReviewerToken],
    ] as const) {
      await staffContext.addCookies([
        {
          name: "dne_preview",
          value: token,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
    }
    const reviewerPage = await reviewer.newPage();
    const unrelatedPage = await otherReviewer.newPage();
    await reviewerPage.goto("/");
    await unrelatedPage.goto("/");
    const reviewerCsrf = await reviewerPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const unrelatedCsrf = await unrelatedPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const linkFor = (staffPage: Page, id: string, staffCsrf: string) =>
      staffPage.request.post(`/api/evidence/${id}/download-link`, {
        headers: { Origin: origin, "X-CSRF-Token": staffCsrf },
      });

    await requiredCheck(1, async () => {
      expect(
        (await linkFor(reviewerPage, allowedId, reviewerCsrf)).status(),
      ).toBe(403);
      const exactGrant = await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignmentId,
        submission.rows[0]!.id,
        "exact synthetic browser submission",
        expires,
      );
      expect(exactGrant).toBeTruthy();
      const allowedLink = await linkFor(reviewerPage, allowedId, reviewerCsrf);
      expect(allowedLink.status()).toBe(200);
      const { href } = (await allowedLink.json()) as { href: string };
      const downloaded = await reviewerPage.request.get(href);
      expect(downloaded.status()).toBe(200);
      expect(await downloaded.body()).toEqual(allowedBytes);

      for (const deniedId of [otherId, draftId]) {
        const denied = await linkFor(reviewerPage, deniedId, reviewerCsrf);
        expect(denied.status()).toBe(403);
        expect(await denied.json()).toEqual({ error: "forbidden" });
      }
      const unrelated = await linkFor(unrelatedPage, allowedId, unrelatedCsrf);
      expect(unrelated.status()).toBe(403);
      expect(await unrelated.json()).toEqual({ error: "forbidden" });
      const stolen = await unrelatedPage.request.get(href);
      expect(stolen.status()).toBe(403);
      expect(await stolen.json()).toEqual({ error: "forbidden" });
      expect((await stolen.text()).includes(allowedBytes.toString())).toBe(
        false,
      );
      const rawDraft = await reviewerPage.request.get(
        `/api/workspaces/${ownerId}/private`,
      );
      expect(rawDraft.status()).toBe(403);
      expect((await rawDraft.text()).includes(draftBytes.toString())).toBe(
        false,
      );
      const ownerLink = await linkFor(page, otherId, csrf);
      expect(ownerLink.status()).toBe(200);
      const ownerDownload = await page.request.get(
        ((await ownerLink.json()) as { href: string }).href,
      );
      expect(await ownerDownload.body()).toEqual(otherBytes);
    });
  } finally {
    await reviewer.close();
    await otherReviewer.close();
  }
});

test("[F-ROADMAP-02-C] revoked reviewer grant and expired signed link deny private bytes", async ({
  page,
  context,
  browser,
}) => {
  const clockFile = join(
    process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!,
    ".test-evidence-clock",
  );
  const now = Date.now();
  const privateBytes = Buffer.from(
    "Invented private submission for reviewer revocation and expiry.",
  );
  const reviewer = await browser.newContext({ baseURL: origin });
  try {
    await onboard(page, "professional");
    const ownerId = await memberId(context);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const uploaded = await page.request.post("/api/evidence", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "text/plain",
        "X-Evidence-Name": "invented-revocation.txt",
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

    const auth = authorizationStore(pool);
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
      "exact synthetic browser submission",
      expires,
    );
    const grant = await auth.grantEvidenceReview(
      adminId,
      reviewerId,
      assignmentId,
      submission.rows[0]!.id,
      "exact synthetic browser submission",
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
    expect(await (await reviewerPage.request.get(href)).body()).toEqual(
      privateBytes,
    );

    await requiredCheck(1, async () => {
      expect(await auth.revokeEvidenceReview(adminId, grant)).toBe(true);
      const denied = await linkFor();
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
      expect((await denied.text()).includes(privateBytes.toString())).toBe(
        false,
      );
    });
    await requiredCheck(2, async () => {
      const old = await reviewerPage.request.get(href);
      expect(old.status()).toBe(403);
      expect(await old.json()).toEqual({ error: "forbidden" });
      expect((await old.text()).includes(privateBytes.toString())).toBe(false);
    });

    await auth.grantEvidenceReview(
      adminId,
      reviewerId,
      assignmentId,
      submission.rows[0]!.id,
      "exact synthetic browser submission after revocation",
      expires,
    );
    writeFileSync(clockFile, String(now + 300_000 - 1));
    const beforeExpiry = await reviewerPage.request.get(href);
    expect(beforeExpiry.status()).toBe(200);
    expect(await beforeExpiry.body()).toEqual(privateBytes);
    await requiredCheck(3, async () => {
      writeFileSync(clockFile, String(now + 300_000 + 1));
      const expired = await reviewerPage.request.get(href);
      expect(expired.status()).toBe(403);
      expect(await expired.json()).toEqual({ error: "forbidden" });
      expect((await expired.text()).includes(privateBytes.toString())).toBe(
        false,
      );
    });
  } finally {
    rmSync(clockFile, { force: true });
    await reviewer.close();
  }
});
