import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.use({ trace: "on" });
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

test("[L71] member keeps exact-version workflow feedback private and can correct, withdraw and delete it", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("/workflows/WF-001");
  await expect(
    page.getByRole("link", { name: "Save private feedback about this draft" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Save private feedback about this draft" })
    .click();
  await expect(page).toHaveURL(origin + "/");
  await onboard(page, "explorer");
  await page.goto("/workflows/WF-001");
  await page
    .getByRole("link", { name: "Save private feedback about this draft" })
    .click();
  await expect(
    page.getByText("Only you can read this invented-text note"),
  ).toBeVisible();
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const session = await store(pool).session(cookie!.value);
  expect(session.kind).toBe("active");
  const ownerId = session.kind === "active" ? session.learner.id : "";
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const note = "Invented private feedback about clearer setup steps.";
  await page.getByLabel("Your private feedback on version 1").fill(note);
  await page
    .getByLabel("I am saving private feedback using only invented text")
    .check();
  await page.getByRole("button", { name: "Save private feedback" }).click();
  await expect(page.getByRole("status")).toContainText("saved privately");
  await page.reload();
  await expect(
    page.getByLabel("Your private feedback on version 1"),
  ).toHaveValue(note);
  await page
    .getByLabel("Your private feedback on version 1")
    .fill("Invented correction for a second reading.");
  await page
    .getByLabel("I am saving private feedback using only invented text")
    .check();
  await page.getByRole("button", { name: "Save private feedback" }).click();
  const stale = await context.request.post("/workflow-feedback/WF-001/save", {
    headers: { origin },
    form: {
      csrf,
      workflow_version: "1",
      revision: "1",
      note: "Stale replay",
      confirm: "yes",
    },
  });
  expect(stale.status()).toBe(409);
  const forged = await context.request.post("/workflow-feedback/WF-001/save", {
    headers: { origin },
    form: {
      csrf: "forged",
      workflow_version: "1",
      revision: "2",
      note: "Forged CSRF",
      confirm: "yes",
    },
  });
  expect(forged.status()).toBe(403);
  const exportBefore = await context.request.get("/api/member/export");
  expect(exportBefore.status()).toBe(200);
  expect((await exportBefore.json()).records.workflowFeedback).toMatchObject([
    { workflowId: "WF-001", workflowVersion: 1, revision: 2 },
  ]);
  const outsider = await browser.newContext({ baseURL: origin });
  const reviewer = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await outsider.newPage();
    await onboard(otherPage, "professional");
    await otherPage.goto(`/workflow-feedback/WF-001?member_id=${ownerId}`);
    await expect(
      otherPage.getByLabel("Your private feedback on version 1"),
    ).toHaveValue("");
    await expect(
      otherPage.getByText("Invented correction for a second reading."),
    ).toHaveCount(0);
    const reviewerToken = randomBytes(32).toString("hex");
    await authorizationStore(pool).provisionStaff(
      reviewerToken,
      "reviewer",
      new Date(Date.now() + 86_400_000),
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
    const reviewerResponse = await reviewer.request.get(
      "/workflow-feedback/WF-001",
      { maxRedirects: 0 },
    );
    expect(reviewerResponse.status()).toBe(303);
    const publicWorkflow = await outsider.request.get("/workflows/WF-001");
    expect(publicWorkflow.status()).toBe(200);
    expect(await publicWorkflow.text()).not.toContain(
      "Invented correction for a second reading.",
    );
  } finally {
    await outsider.close();
    await reviewer.close();
  }
  await page.getByLabel("Remove my private note for version 1").check();
  await page
    .getByRole("button", { name: "Withdraw version 1 feedback" })
    .click();
  await expect(page.getByRole("status")).toHaveCount(0);
  const exportAfter = await context.request.get("/api/member/export");
  expect((await exportAfter.json()).records.workflowFeedback).toEqual([]);
  await page.getByLabel("Your private feedback on version 1").fill(note);
  await page
    .getByLabel("I am saving private feedback using only invented text")
    .check();
  await page.getByRole("button", { name: "Save private feedback" }).click();
  await page.goto("/learn");
  await page.getByLabel("Delete my local preview").check();
  await page.getByRole("button", { name: "Delete this preview" }).click();
  expect(
    (
      await pool.query("SELECT 1 FROM workflow_feedback WHERE member_id=$1", [
        ownerId,
      ])
    ).rowCount,
  ).toBe(0);
});

test("[L99] feedback save waiting past session expiry leaves the private note unchanged", async ({
  page,
  context,
}) => {
  await onboard(page, "explorer");
  await page.goto("/workflow-feedback/WF-001");
  await page
    .getByLabel("Your private feedback on version 1")
    .fill("Original invented private workflow note.");
  await page
    .getByLabel("I am saving private feedback using only invented text")
    .check();
  await page.getByRole("button", { name: "Save private feedback" }).click();
  await expect(page.getByRole("status")).toContainText("saved privately");
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "dne_preview",
  )!;
  const tokenHash = createHash("sha256").update(cookie.value).digest("hex");
  const original = (
    await pool.query(
      `SELECT f.note,f.revision FROM workflow_feedback f
       JOIN principals p ON p.id=f.member_id
       WHERE p.token_hash=$1 AND f.workflow_id='WF-001'`,
      [tokenHash],
    )
  ).rows;
  expect(original).toMatchObject([
    { note: "Original invented private workflow note.", revision: 1 },
  ]);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1",
    [tokenHash],
  );
  const holder = await pool.connect();
  let saving: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM principals WHERE token_hash=$1 FOR UPDATE",
      [tokenHash],
    );
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await page
      .getByLabel("Your private feedback on version 1")
      .fill("Late invented replacement that must not save.");
    await page
      .getByLabel("I am saving private feedback using only invented text")
      .check();
    saving = Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/workflow-feedback/WF-001/save") &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Save private feedback" }).click(),
    ]).then(([response]) => {
      expect(response.status()).toBe(409);
    });
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity waiter CROSS JOIN principals p
               WHERE p.token_hash=$2 AND waiter.state='active'
                 AND waiter.wait_event_type='Lock'
                 AND $1::integer=ANY(pg_blocking_pids(waiter.pid))
                 AND waiter.xact_start<p.expires_at
                 AND p.expires_at<=clock_timestamp()`,
              [holderPid, tokenHash],
            )
          ).rowCount,
        { timeout: 7_000, intervals: [10, 20, 50] },
      )
      .toBe(1);
    await holder.query("COMMIT");
    await saving;
    await expect(
      page.getByRole("heading", { name: "Feedback unchanged" }),
    ).toBeVisible();
    const retained = (
      await pool.query(
        `SELECT f.note,f.revision FROM workflow_feedback f
         JOIN principals p ON p.id=f.member_id
         WHERE p.token_hash=$1 AND f.workflow_id='WF-001'`,
        [tokenHash],
      )
    ).rows;
    expect(retained).toEqual(original);
  } finally {
    await holder.query("ROLLBACK");
    await Promise.allSettled(saving ? [saving] : []);
    holder.release();
  }
  await page.goto("/workflow-feedback/WF-001");
  await expect(page).toHaveURL(origin + "/");
});
