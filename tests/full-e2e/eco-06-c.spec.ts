import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import {
  aiMember,
  aiOrigin,
  grantStudyRequests,
  memberJobs,
  permitSample,
  savedForm,
  signIn,
  studyBalance,
} from "../support/local-ai-journey.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

// Content IDs are short and permanent, and both browser projects share a database.
async function publishLesson(id: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expires);
  await auth.provisionStaff(reviewer, "reviewer", expires);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented budget study lesson",
    body: "An invented sample about checking a study note against its source.",
    owner: "Synthetic test editor",
    sources: "Original invented study example",
    rights: "Owned local sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
  return id;
}

test("[F-ECO-06-C] pausing simulation or spending the last study request stops work and explains what is left", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60_000);
  const member = await aiMember(pool);
  const adminToken = randomBytes(32).toString("hex");
  const adminId = await authorizationStore(pool).provisionStaff(
    adminToken,
    "platform_admin",
    new Date(Date.now() + 86_400_000),
  );
  const admin = await browser.newContext({ baseURL: aiOrigin });
  try {
    const lessonId =
      info.project.name === "mobile-chromium" ? "ECC-602" : "ECC-601";
    await publishLesson(lessonId);
    await signIn(page, member.token);
    const adminPage = await admin.newPage();
    await signIn(adminPage, adminToken);

    await requiredCheck(1, async () => {
      // One job is queued before the pause, and one sample has only a saved form.
      const queued = await permitSample(pool, page);
      await queued.item
        .getByRole("button", { name: "Queue local simulation" })
        .click();
      await expect(
        queued.item.getByRole("button", { name: "Run local simulation" }),
      ).toBeVisible();
      const [pending] = await memberJobs(pool, member.id);
      expect(pending).toMatchObject({ status: "pending", mode: "test" });
      const idle = await permitSample(pool, page);
      const savedQueue = await savedForm(idle.item, "/queue");

      await adminPage.goto("/operator/local-ai");
      await adminPage
        .getByLabel("Confirm pause for local simulation only")
        .check();
      await adminPage
        .getByRole("button", { name: "Pause local simulation" })
        .click();
      await expect(
        adminPage.getByText("Local simulation is paused"),
      ).toBeVisible();

      await page.goto("/evidence/local-ai");
      await expect(page.getByRole("status").first()).toContainText(
        "Local simulations are paused. You can still withdraw permission.",
      );
      for (const name of [
        "Queue local simulation",
        "Run local simulation",
        "Use one local test request",
      ])
        await expect(page.getByRole("button", { name })).toHaveCount(0);

      const replayQueue = await page.request.post(savedQueue.action, {
        headers: { Origin: aiOrigin },
        form: savedQueue.fields,
        maxRedirects: 0,
      });
      expect(replayQueue.status()).toBe(403);
      expect(await replayQueue.text()).toContain("No new local job was queued");
      const replayRun = await page.request.post(
        `/evidence/local-ai/${pending!.id}/run`,
        {
          headers: { Origin: aiOrigin },
          form: savedQueue.fields,
          maxRedirects: 0,
        },
      );
      expect(replayRun.status()).toBe(403);
      expect(await replayRun.text()).toContain("will not retry automatically");
      expect(await memberJobs(pool, member.id)).toEqual([pending]);

      // Study reflection stays usable, says no provider is connected, and
      // creates no job.
      await page.goto(`/library/${lessonId}/study`);
      await expect(page.locator("body")).toContainText(
        "No live AI provider, paid allowance or formal reviewer is connected.",
      );
      await page
        .getByLabel("Your short reflection (sample information only)")
        .fill("An invented reflection");
      await page.locator('input[name="synthetic"]').check();
      await page.getByRole("button", { name: "Compare with source" }).click();
      await expect(
        page.getByRole("heading", {
          name: "Compare your reflection with the source",
        }),
      ).toBeVisible();
      expect(await memberJobs(pool, member.id)).toEqual([pending]);

      await adminPage
        .getByLabel("Confirm resume for local simulation only")
        .check();
      await adminPage
        .getByRole("button", { name: "Resume local simulation" })
        .click();
      await expect(
        adminPage.getByText("Local simulation is available"),
      ).toBeVisible();
    });

    await requiredCheck(2, async () => {
      const grantId = await grantStudyRequests(pool, member.id, 1);
      const spent = await permitSample(pool, page);
      await spent.item
        .getByLabel("Hold one existing local test request")
        .check();
      await spent.item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await spent.item
        .getByRole("button", { name: "Run local test request" })
        .click();
      await expect(
        spent.item.getByText("One local test request: consumed."),
      ).toBeVisible();
      expect(await studyBalance(pool, grantId)).toEqual({
        available: 0,
        reserved: 0,
        consumed: 1,
      });
      const jobsAfterSpend = await memberJobs(pool, member.id);

      const refused = await permitSample(pool, page);
      await refused.item
        .getByLabel("Hold one existing local test request")
        .check();
      await refused.item
        .getByRole("button", { name: "Use one local test request" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Local test request unavailable" }),
      ).toBeVisible();
      await expect(page.locator("body")).toContainText(
        "No allowance was granted and no live provider was contacted.",
      );
      expect(await studyBalance(pool, grantId)).toEqual({
        available: 0,
        reserved: 0,
        consumed: 1,
      });
      expect(await memberJobs(pool, member.id)).toEqual(jobsAfterSpend);

      // The recovery that page points to is real: the balance reads as spent,
      // and the no-allowance simulation still works.
      await page.goto("/member/test-units");
      const units = page.locator('[data-test-unit-category="study_requests"]');
      await expect(units.locator('[data-field="usable"]')).toHaveText("0");
      await expect(units.locator('[data-field="consumed"]')).toHaveText("1");
      await page.goto("/evidence/local-ai");
      const plain = await permitSample(pool, page);
      await plain.item
        .getByRole("button", { name: "Queue local simulation" })
        .click();
      await plain.item
        .getByRole("button", { name: "Run local simulation" })
        .click();
      await expect(plain.item).toContainText("Simulated locally.");
      expect(await studyBalance(pool, grantId)).toEqual({
        available: 0,
        reserved: 0,
        consumed: 1,
      });
    });
  } finally {
    await pool.query("UPDATE local_ai_control SET paused=false");
    await admin.close();
    await pool.query("DELETE FROM principals WHERE id=$1", [member.id]);
    await pool.query("DELETE FROM principals WHERE id=$1", [adminId]);
  }
});
