import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
} from "../../src/prepared-sample-values.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, root: string;
// Staff credentials are entered in password fields; retain no credential traces.
test.use({ trace: "off" });
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne38-browser-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
    DNE_PREPARED_REVIEW_SAMPLES: "enabled",
  });
});
test.afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function signIn(page: Page, credential: string) {
  await page.goto(running.origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${224 + index}] INTAKE-01-02-03-04-06 ${background} requests feedback that an administrator discovers and explicitly assigns`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60000);
    const origin = running.origin;
    const staffContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const reviewerContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const admin = await staffContext.newPage(),
      reviewer = await reviewerContext.newPage();
    const auth = authorizationStore(pool),
      expires = new Date(Date.now() + 3600000);
    const adminCredential = randomBytes(32).toString("hex"),
      reviewerCredential = randomBytes(32).toString("hex");
    const ids: string[] = [];
    const example = PREPARED_SAMPLES[index]!;
    const feedback =
      "Check the invented example against its stated information and flag unknowns.";
    try {
      // The only setup fixtures are finite staff identities. No source, clean
      // transition, review queue, grant, feedback or allowance is seeded.
      ids.push(
        await auth.provisionStaff(adminCredential, "platform_admin", expires),
      );
      ids.push(
        await auth.provisionStaff(reviewerCredential, "reviewer", expires),
      );
      await page.goto(origin + "/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const token = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!.value;
      const member = await store(pool).session(token);
      if (member.kind !== "active")
        throw Error("Invented browser member missing");
      ids.push(member.learner.id);
      await page.goto(origin + "/evidence");
      await page
        .getByRole("link", {
          name: "Use a prepared invented sample",
          exact: true,
        })
        .click();
      const chosen = page.locator(`[data-prepared-template="${example.id}"]`);
      await expect(page.locator("[data-prepared-template]")).toHaveCount(3);
      await expect(chosen.locator("pre")).toHaveText(example.text, {
        useInnerText: false,
      });
      expect(await chosen.locator("pre").textContent()).toBe(example.text);
      await expect(
        chosen.getByText("Suggested for your current direction", {
          exact: false,
        }),
      ).toBeVisible();
      const provided = chosen.getByLabel(
        "I understand this is a provided invented example",
        { exact: false },
      );
      const consent = chosen.getByLabel(
        "I separately permit private review of my copy",
        { exact: false },
      );
      await expect(provided).not.toBeChecked();
      await expect(consent).not.toBeChecked();
      await provided.check();
      await consent.check();
      await chosen
        .getByRole("button", {
          name: "Create my private provided copy",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Your provided-copy receipt",
          exact: true,
        }),
      ).toBeVisible();
      const evidenceId = await page
        .locator("[data-prepared-evidence]")
        .getAttribute("data-prepared-evidence");
      expect(evidenceId).toMatch(/^[a-f0-9-]{36}$/);
      await page
        .getByRole("link", {
          name: "Manage my private samples and separately queue for review",
          exact: true,
        })
        .click();
      const source = page.locator("li").filter({
        has: page.getByRole("heading", { name: example.name, exact: true }),
      });
      await expect(source).toContainText(PROVIDED_SAMPLE_LABEL);
      await expect(source).toContainText(example.digest);
      await expect(source).toContainText("Not submitted for review");
      await source
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await source
        .getByRole("button", {
          name: "Queue for local review consideration",
          exact: true,
        })
        .click();
      await expect(source).toContainText("Submitted locally");
      await signIn(reviewer, reviewerCredential);
      await reviewer
        .getByRole("link", { name: "My reviewer reference", exact: true })
        .click();
      const reviewerId = (
        await reviewer.locator("[data-reviewer-reference]").innerText()
      ).trim();
      await signIn(admin, adminCredential);
      await expect(
        reviewer.getByRole("link", {
          name: "Pending feedback requests",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(
        (
          await reviewer.request.get(
            origin + "/operator/sample-assignments/pending",
          )
        ).status(),
      ).toBe(403);
      expect(
        (
          await page.request.get(
            origin + "/operator/sample-assignments/pending",
          )
        ).status(),
      ).toBe(403);
      await admin
        .getByRole("link", { name: "Pending feedback requests", exact: true })
        .click();
      const pending = admin.locator(`[data-pending-evidence="${evidenceId}"]`);
      await expect(pending).toContainText("Source version 1");
      for (const privateValue of [
        example.name,
        example.text.trim(),
        member.learner.id,
        token,
        reviewerId,
      ])
        await expect(admin.locator("body")).not.toContainText(privateValue);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM reviewer_evidence_grants WHERE reviewer_id=$1",
            [reviewerId],
          )
        ).rows[0].count,
      ).toBe(0);
      await admin.screenshot({
        path: test.info().outputPath(`intake-${background}.png`),
        fullPage: true,
      });
      await pending
        .getByRole("link", { name: "Choose this request", exact: true })
        .click();
      await expect(
        admin.getByLabel("Exact sample ID", { exact: true }),
      ).toHaveValue(evidenceId!);
      await expect(
        admin.getByLabel("Exact source version", { exact: true }),
      ).toHaveValue("1");
      await admin
        .getByLabel("Reviewer reference", { exact: true })
        .fill(reviewerId);
      await admin
        .getByRole("button", {
          name: "Check exact sample references",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Confirm private sample assignment",
          exact: true,
        }),
      ).toBeVisible();
      await expect(admin.locator("body")).not.toContainText(
        example.text.trim(),
      );
      await admin
        .getByLabel("Starts at (UTC)", { exact: true })
        .fill(new Date(Date.now() - 60000).toISOString());
      await admin
        .getByLabel("Expires at (UTC)", { exact: true })
        .fill(new Date(+expires - 1000).toISOString());
      await admin
        .getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        )
        .check();
      await admin
        .getByRole("button", {
          name: "Assign private sample feedback",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Private sample assignment receipt",
          exact: true,
        }),
      ).toBeVisible();
      await reviewer.goto(origin + "/staff");
      await reviewer
        .getByRole("link", {
          name: "Your sample feedback worklist",
          exact: true,
        })
        .click();
      await reviewer
        .getByRole("link", { name: example.name, exact: true })
        .click();
      await expect(reviewer.locator("details pre")).toHaveText(example.text, {
        useInnerText: false,
      });
      await expect(reviewer.locator("body")).toContainText(
        PROVIDED_SAMPLE_LABEL,
      );
      await admin.goto(origin + "/operator/sample-assignments/pending");
      await expect(
        admin.locator(`[data-pending-evidence="${evidenceId}"]`),
      ).toHaveCount(0);
      expect(
        (
          await admin.request.get(
            origin + `/operator/sample-assignments/pending/${evidenceId}/1`,
          )
        ).status(),
      ).toBe(403);
      await page.goto(origin + "/evidence");
      await source
        .getByLabel("Stop private-review access", { exact: false })
        .check();
      await source
        .getByRole("button", { name: "Revoke review consent", exact: true })
        .click();
      await admin.reload();
      await expect(
        admin.locator(`[data-pending-evidence="${evidenceId}"]`),
      ).toHaveCount(0);
      expect(
        (
          await reviewer.request.get(
            origin + `/review/evidence/${evidenceId}/feedback`,
          )
        ).status(),
      ).toBe(403);
      const width = await admin.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(width.document).toBeLessThanOrEqual(width.viewport);
    } finally {
      await staffContext.close();
      await reviewerContext.close();
      // Remove the owned member/workspace before its staff grant creators.
      for (const id of [...ids].reverse())
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}
