import { formToken } from "../support/form-token.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { start } from "../../src/runtime.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  fillCriterion,
  onboardProfessional,
  queuedSample,
  sha256,
} from "../support/sample-feedback-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// The provisional server leaves review-minute writes off, so this case runs on its
// own listener with the two settings the hosted site turns on (infra/app.tf).
// Staff credentials stay out of traces.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
const pool = testPool();
let running: Awaited<ReturnType<typeof start>>;
test.beforeAll(async () => {
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: process.env.DNE_TEST_PRIVATE_STORAGE_ROOT,
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_REVIEW_TIME_WRITES: "enabled",
    DNE_REVIEW_TIME_GRANT_ADMINISTRATION: "enabled",
  });
});
test.afterAll(async () => {
  await running?.close();
  await pool.end();
});

async function actor(browser: Browser, page: Page) {
  const context = await browser.newContext({
    baseURL: running.origin,
    viewport: page.viewportSize(),
  });
  return context.newPage();
}
async function staffSignIn(page: Page, token: string) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(token);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
const feedbackCount = async (submissionId: string) =>
  (
    await pool.query(
      "SELECT id FROM private_sample_feedback WHERE submission_id=$1",
      [submissionId],
    )
  ).rowCount;

test("[F-ROADMAP-01-C] an assigned reviewer publishes criterion feedback on pinned private evidence and settles 30 reserved minutes once", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const run = randomBytes(6).toString("hex");
  const sampleText = `An invented team checks each factual claim ${run}.`;
  const comment = `Name who checks each invented claim and when ${run}.`;
  const expiry = new Date(Date.now() + 3_600_000);
  const auth = authorizationStore(pool);
  const adminToken = randomBytes(32).toString("hex"),
    reviewerToken = randomBytes(32).toString("hex"),
    otherReviewerToken = randomBytes(32).toString("hex");
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expiry,
  );
  const reviewerId = await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    expiry,
  );
  const otherReviewerId = await auth.provisionStaff(
    otherReviewerToken,
    "reviewer",
    expiry,
  );
  const member = await actor(browser, page),
    outsider = await actor(browser, page),
    administrator = await actor(browser, page),
    reviewer = await actor(browser, page),
    unassigned = await actor(browser, page);
  try {
    await onboardProfessional(member);
    await onboardProfessional(outsider);
    const sample = await queuedSample(
      member,
      pool,
      `pinned-${run}.txt`,
      sampleText,
    );
    await staffSignIn(administrator, adminToken);
    await staffSignIn(reviewer, reviewerToken);
    await staffSignIn(unassigned, otherReviewerToken);
    let original: Record<string, string> = {};
    const ownerPath = `/evidence/${sample.id}/feedback`,
      staffPath = `/review/evidence/${sample.id}/feedback`;

    await requiredCheck(1, async () => {
      const assignment = await auth.grantAssignment(
        adminId,
        reviewerId,
        sample.owner,
        "reviewer",
        "Invented provisional review",
        expiry,
      );
      // A workspace assignment alone does not open the submission.
      expect((await reviewer.goto(staffPath))!.status()).toBe(403);
      await expect(reviewer.locator("body")).not.toContainText(sampleText);
      await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignment,
        sample.submissionId,
        "private_sample_feedback_v1",
        expiry,
      );
      expect((await reviewer.goto(staffPath))!.status()).toBe(200);
      await expect(reviewer.locator("details pre")).toHaveText(sampleText);

      expect((await member.goto(ownerPath))!.status()).toBe(200);
      await expect(member.locator("details pre")).toHaveText(sampleText);
      const linkPath = `/api/evidence/${sample.id}/download-link`;
      const csrf = (page: Page) => formToken(page);
      await member.goto("/evidence");
      const link = await member.request.post(linkPath, {
        headers: { Origin: running.origin, "X-CSRF-Token": await csrf(member) },
      });
      expect(link.status()).toBe(200);
      const { href } = (await link.json()) as { href: string };
      const download = await member.request.get(href);
      expect(download.status()).toBe(200);
      expect(await download.text()).toBe(sampleText);

      // Another member and a reviewer with no assignment are refused the same
      // object, a new link to it and a replay of the owner's link.
      for (const [denied, own, formPage] of [
        [outsider, ownerPath, "/evidence"],
        [unassigned, staffPath, "/"],
      ] as const) {
        for (const path of [own, href]) {
          const response = await denied.request.get(path, { maxRedirects: 0 });
          expect([403, 404]).toContain(response.status());
          expect(await response.text()).not.toContain(sampleText);
        }
        await denied.goto(formPage);
        const refused = await denied.request.post(linkPath, {
          headers: {
            Origin: running.origin,
            "X-CSRF-Token": await csrf(denied),
          },
        });
        expect(refused.status()).toBe(403);
        expect(await refused.text()).not.toContain(sampleText);
      }
    });

    await requiredCheck(2, async () => {
      await syntheticLedger(pool).grant(
        sample.owner,
        "review_minutes",
        30,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      await member.goto(`/evidence/${sample.id}/review-allocation`);
      await member.getByLabel("Maximum minutes").fill("30");
      await member
        .getByRole("button", { name: "Reserve test minutes" })
        .click();
      await expect(
        member.getByRole("heading", { name: "Your review-minute receipt" }),
      ).toBeVisible();
      const receiptPath = new URL(member.url()).pathname;
      const allocationId = receiptPath.split("/").at(-1)!;

      // The administrator grants this reviewer time on this exact allocation.
      await administrator.goto("/operator/review-time-grants");
      await administrator
        .getByLabel("Allocation reference", { exact: true })
        .fill(allocationId);
      await administrator
        .getByLabel("Reviewer reference", { exact: true })
        .fill(reviewerId);
      await administrator
        .getByRole("button", { name: "Check exact references", exact: true })
        .click();
      await expect(administrator.locator("body")).not.toContainText(sampleText);
      await administrator
        .getByLabel("Starts at (UTC)", { exact: true })
        .fill(new Date(Date.now() - 60_000).toISOString());
      await administrator
        .getByLabel("Expires at (UTC)", { exact: true })
        .fill(new Date(+expiry - 1000).toISOString());
      await administrator
        .getByLabel("I confirm this exact finite permission", { exact: true })
        .check();
      await administrator
        .getByRole("button", {
          name: "Grant review-minute permission",
          exact: true,
        })
        .click();
      await expect(
        administrator.getByRole("heading", {
          name: "Review-minute permission receipt",
          exact: true,
        }),
      ).toBeVisible();

      await reviewer.goto(staffPath);
      await reviewer
        .getByRole("button", { name: "Begin reserved review" })
        .click();
      await expect(
        reviewer.getByText("State: begun.", { exact: false }),
      ).toBeVisible();
      await fillCriterion(
        reviewer,
        "Claim checks",
        comment,
        "An invented team",
      );
      // Twenty review minutes and ten preparation minutes, ending before now.
      const end = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
      for (const [label, at] of [
        ["review Start (UTC)", end - 20 * 60_000],
        ["review End (UTC)", end],
        ["preparation Start (UTC)", end - 30 * 60_000],
        ["preparation End (UTC)", end - 20 * 60_000],
      ] as const)
        await reviewer
          .getByLabel(label, { exact: true })
          .fill(new Date(at).toISOString());
      await reviewer
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      const publish = reviewer.locator(`form[action="${staffPath}/publish"]`);
      original = (await publish.evaluate((form) =>
        Object.fromEntries(new FormData(form as HTMLFormElement).entries()),
      )) as Record<string, string>;
      await reviewer
        .getByRole("button", { name: "Publish saved feedback" })
        .click();
      await expect(
        reviewer.getByRole("heading", { name: "Published sample feedback" }),
      ).toBeVisible();
      // Replaying the same publication settles nothing further.
      const replay = await reviewer.request.post(staffPath + "/publish", {
        form: original,
        headers: { Origin: running.origin },
        maxRedirects: 0,
      });
      expect(replay.status()).toBe(303);

      expect(
        (
          await pool.query(
            `SELECT f.submission_id,f.reviewer_id,f.source_sha256,f.source_revision,
                    f.criteria->0->>'quote' AS quote,e.review_minutes,e.preparation_minutes
             FROM private_sample_feedback f JOIN review_time_entries e ON e.feedback_id=f.id
             WHERE f.submission_id=$1 AND f.published_at IS NOT NULL`,
            [sample.submissionId],
          )
        ).rows,
      ).toEqual([
        {
          submission_id: sample.submissionId,
          reviewer_id: reviewerId,
          source_sha256: sha256(sampleText),
          source_revision: 1,
          quote: "An invented team",
          review_minutes: 20,
          preparation_minutes: 10,
        },
      ]);

      await member.goto("/member/test-units");
      const balance = member.locator(
        '[data-test-unit-category="review_minutes"]',
      );
      await expect(balance.locator('[data-field="usable"]')).toHaveText("0");
      await expect(balance.locator('[data-field="held"]')).toHaveText("0");
      await expect(balance.locator('[data-field="consumed"]')).toHaveText("30");
      await member.goto(receiptPath);
      await expect(member.locator("dl")).toContainText("Consumed30Returned0");

      await member.goto(ownerPath);
      const article = member.locator("article").filter({
        has: member.getByRole("heading", { name: "Published sample feedback" }),
      });
      await expect(article).toContainText("source version 1");
      await expect(article.locator("blockquote")).toHaveText(
        "An invented team",
      );
      await expect(article).toContainText(comment);
    });

    await requiredCheck(3, async () => {
      const before = await feedbackCount(sample.submissionId);
      // Each attempt carries the actor's own valid form token, so a refusal is
      // about who they are, not a malformed request.
      for (const [denied, formPage] of [
        [unassigned, "/"],
        [outsider, "/evidence"],
      ] as const) {
        await denied.goto(formPage);
        const csrf = await formToken(denied);
        const view = await denied.request.get(staffPath, { maxRedirects: 0 });
        expect(view.status()).toBe(403);
        const viewText = await view.text();
        expect(viewText).not.toContain(sampleText);
        expect(viewText).not.toContain(comment);
        const attempts = {
          draft: {
            csrf,
            operationId: randomUUID(),
            revision: "1",
            label0: "Outside assessment",
            comment0: `An unassigned assessment attempt ${run}.`,
            quote0: "An invented team",
            occurrence0: "1",
          },
          publish: { ...original, csrf, operationId: randomUUID() },
        };
        for (const [action, form] of Object.entries(attempts)) {
          const attempt = await denied.request.post(`${staffPath}/${action}`, {
            form,
            headers: { Origin: running.origin },
            maxRedirects: 0,
          });
          expect(attempt.status(), `${action} by ${formPage}`).toBe(403);
          const text = await attempt.text();
          expect(text).not.toContain(sampleText);
          expect(text).not.toContain(comment);
        }
      }
      await unassigned.goto(staffPath);
      await expect(unassigned.locator("body")).not.toContainText(sampleText);
      expect(await feedbackCount(sample.submissionId)).toBe(before);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS n FROM private_sample_feedback WHERE submission_id=$1 AND reviewer_id<>$2",
            [sample.submissionId, reviewerId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });
  } finally {
    for (const open of [member, outsider, administrator, reviewer, unassigned])
      await open.context().close();
    for (const id of [reviewerId, otherReviewerId, adminId])
      await pool.query("DELETE FROM principals WHERE id=$1", [id]);
  }
});
