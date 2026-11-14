import { formToken } from "../support/form-token.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import { browserOrigin as origin } from "../support/browser-origin.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("professional");
  await chooseLearningGoal(page, "work");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(cookie: string) {
  const tokenHash = createHash("sha256").update(cookie).digest("hex");
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.id;
}

test("[F-BUILD-10-D] queued private review remains truthful after a fresh local browser context", async ({
  page,
  context,
  browser,
}, info) => {
  const title = `invented-reload-${randomBytes(5).toString("hex")}.txt`;
  const bytes = `Invented private example ${randomBytes(8).toString("hex")}.`;
  let returned: BrowserContext | undefined;
  let reviewer: BrowserContext | undefined;
  let returnedPage: Page | undefined;
  let evidenceId = "";
  let submissionId = "";
  try {
    await requiredCheck(1, async () => {
      await onboard(page);
      const cookie = (await context.cookies()).find(
        (item) => item.name === "dne_preview",
      );
      expect(cookie).toBeDefined();
      const ownerId = await memberId(cookie!.value);
      await page.goto("/evidence");
      await page.getByLabel("Sample title").fill(title);
      await page.getByLabel("Invented text sample").fill(bytes);
      await page
        .getByLabel(
          "I created this invented sample and have the right to store it.",
        )
        .check();
      await page
        .getByLabel(
          "I explicitly allow this sample to be considered for private review",
          {
            exact: false,
          },
        )
        .check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const evidenceRow = await pool.query<{ id: string }>(
        "SELECT id FROM evidence_objects WHERE owner_principal_id=$1 AND original_name=$2",
        [ownerId, title],
      );
      expect(evidenceRow.rowCount).toBe(1);
      evidenceId = evidenceRow.rows[0]!.id;
      const evidence = evidenceStore(
        pool,
        fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
        "test-only-scanner-secret",
      );
      expect(await evidence.transitionQuarantine(evidenceId, "clean")).toBe(
        true,
      );
      await page.reload();
      const item = page.getByRole("listitem").filter({ hasText: title });
      await item
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await item
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      await expect(item).toContainText(
        "Submitted locally; no qualified review is connected",
      );
      const submitted = await pool.query<{ id: string; status: string }>(
        "SELECT id,status FROM evidence_review_submissions WHERE evidence_id=$1",
        [evidenceId],
      );
      expect(submitted.rows).toHaveLength(1);
      expect(submitted.rows[0]!.status).toBe("queued");
      submissionId = submitted.rows[0]!.id;

      const viewport = page.viewportSize();
      await context.close();
      returned = await browser.newContext({
        baseURL: origin,
        viewport: viewport ?? undefined,
        isMobile: info.project.name === "mobile-chromium",
        hasTouch: info.project.name === "mobile-chromium",
      });
      await returned.addCookies([
        {
          name: "dne_preview",
          value: cookie!.value,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      returnedPage = await returned.newPage();
      await returnedPage.goto("/evidence");
      await expect(
        returnedPage.getByRole("heading", { name: "Your private evidence" }),
      ).toBeVisible();
      expect(await memberId(cookie!.value)).toBe(ownerId);
      await expect(
        returnedPage.getByRole("listitem").filter({ hasText: title }),
      ).toContainText("Submitted locally; no qualified review is connected");
      const after = await pool.query<{ id: string; status: string }>(
        "SELECT id,status FROM evidence_review_submissions WHERE evidence_id=$1",
        [evidenceId],
      );
      expect(after.rows).toEqual([{ id: submissionId, status: "queued" }]);

      const ownerCsrf = await formToken(returnedPage);
      const ownerLink = await returnedPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": ownerCsrf } },
      );
      expect(ownerLink.status()).toBe(200);
      const { href } = (await ownerLink.json()) as { href: string };
      expect(await (await returnedPage.request.get(href)).body()).toEqual(
        Buffer.from(bytes),
      );

      const reviewerToken = randomBytes(32).toString("hex");
      const reviewerId = await authorizationStore(pool).provisionStaff(
        reviewerToken,
        "reviewer",
        new Date(Date.now() + 86_400_000),
      );
      const grants = await pool.query(
        "SELECT id FROM assignment_grants WHERE staff_id=$1 AND workspace_id=$2",
        [reviewerId, ownerId],
      );
      expect(grants.rowCount).toBe(0);
      reviewer = await browser.newContext({ baseURL: origin });
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
      const reviewerCsrf = await formToken(reviewerPage);
      const denied = await reviewerPage.request.post(
        `/api/evidence/${evidenceId}/download-link`,
        { headers: { Origin: origin, "X-CSRF-Token": reviewerCsrf } },
      );
      expect(denied.status()).toBe(403);
      expect((await denied.text()).includes(bytes)).toBe(false);
      expect((await reviewerPage.request.get(href)).status()).toBe(403);
    });

    await requiredCheck(2, async () => {
      const item = returnedPage!
        .getByRole("listitem")
        .filter({ hasText: title });
      await expect(item).toContainText(
        "Submitted locally; no qualified review is connected",
      );
      await expect(
        item.getByRole("button", {
          name: "Queue for local review consideration",
        }),
      ).toHaveCount(0);
      await expect(
        item.getByText("Synthetic review state recorded"),
      ).toHaveCount(0);
      await expect(
        returnedPage!.getByRole("button", { name: /approve|book|pay/i }),
      ).toHaveCount(0);
      // Every control on the returned sample is an expected one, so an extra
      // or dead control fails here. Each button is enabled and posts its own
      // form to this sample's route with the session's form token.
      const path = `/evidence/${evidenceId}`;
      const buttons = [
        [`Download ${title}`, "download"],
        ["Revoke review consent", "revoke-private-review"],
        ["Delete sample", "delete"],
      ] as const;
      await expect(item.getByRole("button")).toHaveText(
        buttons.map(([name]) => name),
      );
      for (const [name, action] of buttons) {
        const button = item.getByRole("button", { name, exact: true });
        await expect(button).toBeEnabled();
        expect(
          await button.evaluate((element) => {
            const form = (element as HTMLButtonElement).form;
            return form
              ? {
                  method: form.method,
                  action: new URL(form.action).pathname,
                  token: form.querySelector('input[name="csrf"]') !== null,
                }
              : null;
          }),
        ).toEqual({ method: "post", action: `${path}/${action}`, token: true });
      }
      // The whole page offers only those and the form that saves a new sample.
      await expect(
        returnedPage!.locator("section.private-evidence").getByRole("button"),
      ).toHaveText([
        ...buttons.map(([name]) => name),
        "Save private text sample",
      ]);
      // The download button really returns the saved sample.
      const downloading = returnedPage!.waitForEvent("download");
      await item
        .getByRole("button", { name: `Download ${title}`, exact: true })
        .click();
      const downloaded = await downloading;
      expect(downloaded.suggestedFilename()).toBe(title);
      expect(await readFile((await downloaded.path())!, "utf8")).toBe(bytes);
      // Each link on the sample leads to a page that answers.
      const links = [
        [`Read private feedback for ${title}`, `${path}/feedback`],
        [`Create a new private revision of ${title}`, `${path}/revise`],
      ] as const;
      await expect(item.getByRole("link")).toHaveText(
        links.map(([name]) => name),
      );
      for (const [name, href] of links) {
        await expect(
          item.getByRole("link", { name, exact: true }),
        ).toHaveAttribute("href", href);
        expect((await returnedPage!.request.get(href)).status()).toBe(200);
      }
      await item
        .getByRole("link", {
          name: `Create a new private revision of ${title}`,
        })
        .click();
      await expect(
        returnedPage!.getByRole("heading", {
          name: "New private evidence revision",
        }),
      ).toBeVisible();
      await expect(
        returnedPage!.getByText("not submitted or assessed automatically"),
      ).toBeVisible();
      const unchanged = await pool.query<{ id: string; status: string }>(
        "SELECT id,status FROM evidence_review_submissions WHERE evidence_id=$1",
        [evidenceId],
      );
      expect(unchanged.rows).toEqual([{ id: submissionId, status: "queued" }]);
      const evidenceRows = await pool.query(
        "SELECT id FROM evidence_objects WHERE owner_principal_id=(SELECT owner_principal_id FROM evidence_objects WHERE id=$1)",
        [evidenceId],
      );
      expect(evidenceRows.rowCount).toBe(1);
    });
  } finally {
    await reviewer?.close();
    await returned?.close();
  }
});
