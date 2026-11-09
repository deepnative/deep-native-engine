import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";

const pool = testPool(),
  members = store(pool),
  access = authorizationStore(pool);
test.afterAll(async () => pool.end());

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L298] STAFFSEE-01, 02, 05 a member sees when staff were given access and opened their work", async ({
  page,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-staff-access-"));
  const purpose = "Invented confidential coaching purpose";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    // STAFFSEE-01: reached from Who can see my work, nothing recorded.
    await page.goto(`${origin}/account/sharing`);
    const staff = page.getByRole("region", {
      name: "Coaches and administrators",
    });
    await expect(staff).toContainText(
      "No staff access to your private work is active right now",
    );
    await staff
      .getByRole("link", { name: "When staff opened my work" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "When staff opened my work",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "No staff access to your private work is recorded.",
    );
    expect(await noSidewaysScroll(page)).toBe(true);

    // STAFFSEE-02: given, then opened, newest first.
    const expires = new Date(Date.now() + 86_400_000);
    const adminToken = randomBytes(32).toString("hex"),
      coachToken = randomBytes(32).toString("hex");
    const adminId = await access.provisionStaff(
      adminToken,
      "platform_admin",
      expires,
    );
    const coachId = await access.provisionStaff(coachToken, "coach", expires);
    const grant = await access.grantAssignment(
      adminId,
      coachId,
      owner,
      "coach",
      purpose,
      expires,
    );
    expect(await access.readWorkspace(coachToken, owner)).toMatchObject({
      kind: "allowed",
    });
    await page.reload();
    const rows = page.locator("main li");
    await expect(rows.nth(0)).toContainText(
      "Assigned staff opened your learning workspace.",
    );
    await expect(rows.nth(1)).toContainText(
      "Assigned staff were given access to your learning workspace.",
    );
    await expect(page.locator("body")).not.toContainText(purpose);
    await expect(page.locator("body")).not.toContainText(coachId);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.goto(`${origin}/account/sharing`);
    await expect(staff).toContainText("1 staff member has access");

    // STAFFSEE-05: ending the access shows at once on both pages.
    expect(await access.revokeAssignment(adminId, grant)).toBe(true);
    await page.reload();
    await expect(staff).toContainText(
      "No staff access to your private work is active right now",
    );
    await staff
      .getByRole("link", { name: "When staff opened my work" })
      .click();
    await expect(rows.nth(0)).toContainText(
      "Access to your learning workspace was taken away from assigned staff.",
    );
  } finally {
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      if (owner) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});

test("[L306] NOTEREAD-01, 08 a member sees when a moderator read a workflow note they sent for private review", async ({
  page,
  browser,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-note-read-"));
  const note = "Invented private workflow note for reading history";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  const staffIds: string[] = [];
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_LOCAL_STAFF_ENTRY: "enabled",
      DNE_WORKFLOW_REVIEW_REQUESTS: "enabled",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    await page.goto(`${origin}/workflow-feedback/WF-001`);
    await page.getByLabel("Your private feedback on version 2").fill(note);
    await page.getByLabel("I choose to save this note privately.").check();
    await page
      .getByRole("button", { name: "Save private feedback", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("saved privately");
    await page.reload();
    await page
      .getByRole("link", { name: "Request private review of this exact note" })
      .click();
    await page
      .getByLabel(
        "Allow an individually assigned local moderator to read only this exact note until the shown deadline",
      )
      .check();
    await page
      .getByRole("button", { name: "Request private review", exact: true })
      .click();
    const requestId = await page
      .locator("[data-request-id]")
      .getAttribute("data-request-id");

    // Assigned through the store: L192-194 cover the administrator's pages.
    const expires = new Date(Date.now() + 3_600_000);
    const adminToken = randomBytes(32).toString("hex"),
      moderatorToken = randomBytes(32).toString("hex");
    staffIds.push(
      await access.provisionStaff(adminToken, "platform_admin", expires),
      await access.provisionStaff(moderatorToken, "moderator", expires),
    );
    const moderatorId = staffIds[1]!;
    const assigning = workflowReviewStaffStore(
      pool,
      { enabled: true, mode: "test" },
      "invented-note-read-secret",
    );
    const checked = await assigning.check(adminToken, requestId!, moderatorId);
    if (checked.kind !== "ready") throw Error("Assignment check failed");
    const grant = await assigning.assign(
      adminToken,
      checked.checked,
      randomUUID(),
      "yes",
    );
    if (grant.kind !== "applied") throw Error("Assignment failed");

    // Being assigned isn't a reading.
    await page.goto(`${origin}/account/sharing/staff-access`);
    await expect(page.getByRole("status")).toContainText(
      "No staff access to your private work is recorded.",
    );

    const context = await browser.newContext();
    try {
      const moderator = await context.newPage();
      await moderator.goto(`${origin}/staff/sign-in`);
      await moderator
        .getByLabel("Trusted local staff credential")
        .fill(moderatorToken);
      await moderator
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      await moderator.goto(`${origin}/moderate/workflow-reviews`);
      await moderator
        .getByRole("link", {
          name: "WF-001 · version 2 · revision 1",
          exact: true,
        })
        .click();
      await expect(moderator.locator("pre")).toHaveText(note);
    } finally {
      await context.close();
    }

    await page.reload();
    await expect(page.locator("main li").nth(0)).toContainText(
      "A moderator read your workflow note for WF-001, version 2.",
    );
    const body = page.locator("body");
    await expect(body).toContainText(
      "Readings of workflow notes are listed from November 2026 on; earlier ones weren't recorded.",
    );
    await expect(body).not.toContainText(note);
    await expect(body).not.toContainText(moderatorId);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      if (owner) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});

test("[L314] STAFFEXPORT-01, 02, 05 a member finds when staff opened their work in Download my records", async ({
  page,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-staff-access-export-"));
  const purpose = "Invented confidential export purpose";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    const expires = new Date(Date.now() + 86_400_000);
    const adminToken = randomBytes(32).toString("hex"),
      coachToken = randomBytes(32).toString("hex");
    const adminId = await access.provisionStaff(
      adminToken,
      "platform_admin",
      expires,
    );
    const coachId = await access.provisionStaff(coachToken, "coach", expires);
    const grant = await access.grantAssignment(
      adminId,
      coachId,
      owner,
      "coach",
      purpose,
      expires,
    );
    expect(await access.readWorkspace(coachToken, owner)).toMatchObject({
      kind: "allowed",
    });

    // STAFFEXPORT-05: the history page points to the download.
    await page.goto(`${origin}/account/sharing/staff-access`);
    const covers = page.getByRole("region", { name: "What this covers" });
    await expect(covers).toContainText(
      "Its section there is called staffAccess.",
    );
    expect(await noSidewaysScroll(page)).toBe(true);
    await covers.getByRole("link", { name: "Download my records" }).click();
    await expect(page).toHaveURL(`${origin}/member/export`);

    // STAFFEXPORT-01, 02: the same two entries, with no staff details.
    const exported = await (
      await page.request.get(`${origin}/api/member/export`)
    ).json();
    expect(exported.version).toBe("local-member-records-v44");
    expect(
      exported.records.staffAccess
        .map(
          (row: { action: string; via: string }) => `${row.action}:${row.via}`,
        )
        .sort(),
    ).toEqual(["grant_created:assignment", "workspace_read:assignment"]);
    const text = JSON.stringify(exported.records.staffAccess);
    for (const hidden of [purpose, coachId, adminId, String(grant)])
      expect(text).not.toContain(hidden);
  } finally {
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      if (owner) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});
