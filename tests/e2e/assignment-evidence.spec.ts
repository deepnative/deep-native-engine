import {
  test,
  expect,
  type Page,
  type Browser,
  type TestInfo,
} from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { ASSIGNMENT_ORIGIN_LABEL } from "../../src/assignment-evidence-values.ts";
import { testPool } from "../support/database.ts";
import { startAssignmentEvidenceRecoveryServer } from "../support/assignment-evidence-recovery-server.ts";

const pool = testPool();
let running: Awaited<ReturnType<typeof start>>, root: string;
// Trusted synthetic staff credentials are entered only in password fields.
test.use({ trace: "off" });
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne545-browser-"));
  running = await start({
    DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_ASSIGNMENT_HANDOFF: "enabled",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION: "enabled",
  });
});
test.afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
const consentName = "Create a private feedback copy of this submitted version.";
const sampleName = "Assignment submission 1.txt";
async function context(
  browser: Browser,
  page: Page,
  info: TestInfo,
  origin: string,
) {
  return browser.newContext({
    baseURL: origin,
    viewport: page.viewportSize(),
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
    deviceScaleFactor: info.project.use.deviceScaleFactor,
    userAgent: info.project.use.userAgent,
  });
}
async function publishAssignment(background: string, goal: string) {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 3600000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  // Unique released fixtures remain in the disposable database: published
  // content cannot be deleted or have its editor/reviewer identity erased.
  const prefix = Array.from(randomBytes(3), (byte) =>
    String.fromCharCode(65 + (byte % 26)),
  ).join("");
  const id = `AH${prefix}-${randomBytes(2).readUInt16BE() % 1000}`.replace(
    /-(\d+)$/,
    (_, n: string) => `-${n.padStart(3, "0")}`,
  );
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: `Invented ${background} feedback project ${id}`,
    body: "Compare three invented choices and check one assumption.",
    owner: "Synthetic curriculum editor",
    sources: "Original invented brief",
    rights: "Owned synthetic example",
    goals: [goal],
    backgrounds: [background],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric:
      "Explain the options, identify missing information, and describe one source check.",
    rubricVersion: 4,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
  return draft;
}
async function onboard(
  page: Page,
  origin: string,
  background: string,
  goal: string,
) {
  await page.goto(origin + "/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page
    .getByRole("button", { name: "Start my learning path", exact: true })
    .click();
  const token = (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
  const member = await store(pool).session(token);
  if (member.kind !== "active") throw Error("Invented browser member missing");
  return member.learner.id;
}
async function submitAssignment(page: Page, title: string, response: string) {
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
    exact: true,
  });
  await choices
    .getByRole("button", { name: `Choose ${title}`, exact: true })
    .click();
  await choices
    .getByRole("button", {
      name: "Start or return to this private attempt",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  await saveDraft(page, response);
  const confirmation = page.getByLabel("Save this exact submitted version.", {
    exact: false,
  });
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await page
    .getByRole("button", { name: "Submit saved version", exact: true })
    .click();
  await expect(page.locator("#submission-1 pre").first()).toHaveText(response, {
    useInnerText: false,
  });
  const exported = await page.request.get(
    new URL("/api/member/export", page.url()).toString(),
  );
  expect(exported.status()).toBe(200);
  expect((await exported.json()).records.assignmentSubmissions).toMatchObject([
    { attemptId: id, sequence: 1, response: response.replace(/\n/g, "\r\n") },
  ]);
  return id;
}
async function saveDraft(page: Page, text: string) {
  await page.getByLabel("Your private response", { exact: true }).fill(text);
  await page
    .getByLabel("This response is mine to use for private learning", {
      exact: false,
    })
    .check();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByLabel("Your private response", { exact: true }),
  ).toHaveValue(text);
}
async function prepareCopy(
  page: Page,
  origin: string,
  attemptId: string,
  response: string,
  draft: DraftContent,
) {
  await page.goto(origin + `/assignments/attempts/${attemptId}`);
  await page
    .locator("#submission-1")
    .getByRole("link", {
      name: "Prepare feedback for submission 1",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Prepare assignment feedback",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("pre").first()).toHaveText(response, {
    useInnerText: false,
  });
  expect(await page.locator("pre").first().textContent()).toBe(response);
  await expect(
    page.getByRole("heading", {
      name: "Original rubric · version 4",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("pre").nth(1)).toHaveText(draft.rubric!);
  const confirmation = page.getByLabel(consentName, { exact: false });
  await expect(confirmation).not.toBeChecked();
  return confirmation;
}
async function createCopy(
  page: Page,
  origin: string,
  attemptId: string,
  response: string,
  draft: DraftContent,
) {
  await (await prepareCopy(page, origin, attemptId, response, draft)).check();
  await page
    .getByRole("button", { name: "Create private feedback copy", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Your assignment feedback copy",
      exact: true,
    }),
  ).toBeVisible();
  const id = await page
    .locator("[data-assignment-evidence]")
    .getAttribute("data-assignment-evidence");
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  await page
    .getByRole("link", {
      name: "Manage private copies and request feedback",
      exact: true,
    })
    .click();
  return id!;
}
function evidenceItem(page: Page, id: string) {
  return page
    .locator("li")
    .filter({ has: page.locator(`form[action="/evidence/${id}/delete"]`) });
}
async function staffSignIn(page: Page, origin: string, credential: string) {
  await page.goto(origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function assignReviewer(
  admin: Page,
  origin: string,
  evidenceId: string,
  reviewerId: string,
  expires: Date,
  response: string,
) {
  await admin.goto(origin + "/staff");
  await admin
    .getByRole("link", { name: "Private sample assignments", exact: true })
    .click();
  await admin.getByLabel("Exact sample ID", { exact: true }).fill(evidenceId);
  await admin.getByLabel("Exact source version", { exact: true }).fill("1");
  await admin
    .getByLabel("Reviewer reference", { exact: true })
    .fill(reviewerId);
  await admin
    .getByRole("button", { name: "Check exact sample references", exact: true })
    .click();
  await expect(
    admin.getByRole("heading", {
      name: "Confirm private sample assignment",
      exact: true,
    }),
  ).toBeVisible();
  await expect(admin.locator("body")).not.toContainText(response.trim());
  await admin
    .getByLabel("Starts at (UTC)", { exact: true })
    .fill(new Date(Date.now() - 60000).toISOString());
  await admin
    .getByLabel("Expires at (UTC)", { exact: true })
    .fill(new Date(+expires - 1000).toISOString());
  const confirmation = admin.getByLabel(
    "I confirm this exact sample, reviewer and finite UTC window.",
    { exact: true },
  );
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
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
}
async function exportedCopy(
  page: Page,
  origin: string,
  evidenceId: string,
  attemptId: string,
  contentId: string,
  response: string,
) {
  await page.goto(origin + "/evidence/export");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download page 1", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("deep-native-evidence-page-1.json");
  const body = JSON.parse(await readFile((await download.path())!, "utf8"));
  const item = body.items.find((row: { id: string }) => row.id === evidenceId);
  expect(item.assignmentOrigin).toMatchObject({
    kind: "member-assignment-submission",
    attemptId,
    sequence: 1,
    contentId,
    contentVersion: 1,
    rubricVersion: 4,
    sourceSha256: createHash("sha256").update(response).digest("hex"),
  });
  expect(item.origin).toBeUndefined();
  expect(Buffer.from(item.sourceBase64, "base64").toString()).toBe(response);
  expect(JSON.stringify(body)).not.toContain("storage_key");
  return body;
}

for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${214 + index}] AHO-01-02-05-06-07-08-09 ${background} submits an exact private assignment, exchanges separately assigned feedback and controls source deletion`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(90000);
    const origin = running.origin,
      draft = await publishAssignment(background, goal);
    const adminContext = await context(browser, page, info, origin),
      reviewerContext = await context(browser, page, info, origin);
    const admin = await adminContext.newPage(),
      reviewer = await reviewerContext.newPage();
    const auth = authorizationStore(pool),
      expires = new Date(Date.now() + 3600000);
    const adminCredential = randomBytes(32).toString("hex"),
      reviewerCredential = randomBytes(32).toString("hex");
    const staffIds: string[] = [];
    let memberId: string | undefined;
    const response = `An invented ${background} group compares three activities.\nWe identify missing information and check one source — 中文 🤖.\n`;
    const submittedResponse = response.replace(/\n/g, "\r\n");
    const newer =
      "A separate newer private draft must never replace the selected submitted response.";
    const feedback =
      "Your options are clear. Check each claim against the invented brief and flag missing information.";
    try {
      staffIds.push(
        await auth.provisionStaff(adminCredential, "platform_admin", expires),
        await auth.provisionStaff(reviewerCredential, "reviewer", expires),
      );
      memberId = await onboard(page, origin, background, goal);
      const attemptId = await submitAssignment(page, draft.title, response);
      await page
        .getByLabel("Start a new private revision", { exact: false })
        .check();
      await page
        .getByRole("button", { name: "Revise privately", exact: true })
        .click();
      await saveDraft(page, newer);
      const copyId = await createCopy(
        page,
        origin,
        attemptId,
        submittedResponse,
        draft,
      );
      const source = evidenceItem(page, copyId);
      await expect(source).toContainText(ASSIGNMENT_ORIGIN_LABEL);
      await expect(source).toContainText(
        `assignment ${draft.id} · version 1 · submission 1 · rubric 4`,
      );
      await expect(source).toContainText("Not submitted for review");
      await expect(
        source.getByRole("link", {
          name: `Create a new private revision of ${sampleName}`,
          exact: true,
        }),
      ).toHaveCount(0);
      await staffSignIn(reviewer, origin, reviewerCredential);
      await reviewer
        .getByRole("link", { name: "My reviewer reference", exact: true })
        .click();
      const reviewerId = (
        await reviewer.locator("[data-reviewer-reference]").innerText()
      ).trim();
      const reviewerPath = origin + `/review/evidence/${copyId}/feedback`,
        ownerPath = origin + `/evidence/${copyId}/feedback`;
      expect((await reviewer.goto(reviewerPath))!.status()).toBe(403);
      await expect(reviewer.locator("body")).not.toContainText(response.trim());
      await source
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await source
        .getByRole("button", {
          name: "Queue for local review consideration",
          exact: true,
        })
        .click();
      await expect(evidenceItem(page, copyId)).toContainText(
        "Submitted locally",
      );
      expect((await reviewer.goto(reviewerPath))!.status()).toBe(403);
      await staffSignIn(admin, origin, adminCredential);
      await assignReviewer(
        admin,
        origin,
        copyId,
        reviewerId,
        expires,
        response,
      );
      await reviewer.goto(origin + "/staff");
      await reviewer
        .getByRole("link", {
          name: "Your sample feedback worklist",
          exact: true,
        })
        .click();
      await reviewer
        .getByRole("link", { name: sampleName, exact: true })
        .click();
      await expect(reviewer.locator("details pre")).toHaveText(response, {
        useInnerText: false,
      });
      expect(await reviewer.locator("details pre").textContent()).toBe(
        submittedResponse,
      );
      await expect(reviewer.locator("body")).toContainText(
        ASSIGNMENT_ORIGIN_LABEL,
      );
      await expect(reviewer.locator("body")).not.toContainText(newer);
      // Staff sign-in does not create a member session for the private original.
      // Observe the actual refusal before the browser follows its landing redirect.
      const originalDenied = await reviewer.request.get(
        origin + `/assignments/attempts/${attemptId}/handoff?sequence=1`,
        { maxRedirects: 0 },
      );
      expect(originalDenied.status()).toBe(303);
      expect(originalDenied.headers().location).toBe("/");
      expect(await originalDenied.text()).not.toContain(response.trim());
      await reviewer
        .getByLabel("Criterion 1 label", { exact: true })
        .fill("Source checking");
      await reviewer
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill(feedback);
      await reviewer
        .getByLabel("Criterion 1 exact source quote", { exact: true })
        .fill("An invented");
      await reviewer
        .getByRole("button", {
          name: "Save private feedback draft",
          exact: true,
        })
        .click();
      await reviewer
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      await reviewer
        .getByRole("button", { name: "Publish saved feedback", exact: true })
        .click();
      await expect(
        reviewer.getByRole("heading", {
          name: "Published assignment feedback",
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(ownerPath);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await expect(page.locator("body")).toContainText(ASSIGNMENT_ORIGIN_LABEL);
      await page
        .getByLabel("One clarification", { exact: true })
        .fill("Which missing information should I check first?");
      await page
        .getByRole("button", { name: "Send clarification", exact: true })
        .click();
      await reviewer.reload();
      await reviewer
        .getByLabel("One reviewer answer", { exact: true })
        .fill("Start with the information explicitly identified as missing.");
      await reviewer
        .getByRole("button", { name: "Send answer", exact: true })
        .click();
      await page.reload();
      await expect(
        page.getByText(
          "Start with the information explicitly identified as missing.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Send clarification", exact: true }),
      ).toHaveCount(0);
      await exportedCopy(
        page,
        origin,
        copyId,
        attemptId,
        draft.id,
        submittedResponse,
      );
      await page.goto(origin + "/evidence");
      await evidenceItem(page, copyId)
        .getByLabel(`Stop private-review access to ${sampleName}`, {
          exact: true,
        })
        .check();
      await page
        .locator(`form[action="/evidence/${copyId}/revoke-private-review"]`)
        .getByRole("button", { name: "Revoke review consent", exact: true })
        .click();
      expect((await reviewer.goto(reviewerPath))!.status()).toBe(403);
      await expect(reviewer.locator("body")).not.toContainText(response.trim());
      await page.goto(ownerPath);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await expect(
        page.getByText("Consent withdrawn:", { exact: false }),
      ).toBeVisible();
      await info.attach(`invented-${background}-retained-feedback`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      const disposable = await createCopy(
        page,
        origin,
        attemptId,
        submittedResponse,
        draft,
      );
      await evidenceItem(page, disposable)
        .getByLabel(
          `Delete ${sampleName} and its configured active derivatives`,
          { exact: true },
        )
        .check();
      await page
        .locator(`form[action="/evidence/${disposable}/delete"]`)
        .getByRole("button", { name: "Delete sample", exact: true })
        .click();
      await expect(evidenceItem(page, disposable)).toHaveCount(0);
      await page.goto(origin + `/assignments/attempts/${attemptId}`);
      await expect(
        page.getByLabel("Your private response", { exact: true }),
      ).toHaveValue(newer);
      await expect(page.locator("#submission-1 pre").first()).toHaveText(
        response,
        { useInnerText: false },
      );
      await page.goto(ownerPath);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      const another = await createCopy(
        page,
        origin,
        attemptId,
        submittedResponse,
        draft,
      );
      expect(another).not.toBe(copyId);
      expect(another).not.toBe(disposable);
      await page.goto(origin + `/assignments/attempts/${attemptId}`);
      await page
        .getByLabel("Delete this private attempt and all its submissions", {
          exact: false,
        })
        .check();
      await page
        .getByRole("button", { name: "Delete attempt", exact: true })
        .click();
      await expect(
        page.getByText("No private assignment attempts yet", { exact: false }),
      ).toBeVisible();
      expect((await page.goto(ownerPath))!.status()).toBe(403);
      expect((await reviewer.goto(reviewerPath))!.status()).toBe(403);
      await page.goto(origin + "/evidence");
      await expect(evidenceItem(page, copyId)).toHaveCount(0);
      await expect(evidenceItem(page, another)).toHaveCount(0);
      const exported = await page.request.get(origin + "/api/member/export");
      expect(exported.status()).toBe(200);
      const records = (await exported.json()).records;
      expect(records.assignmentSubmissions).toEqual([]);
      expect(records.assignmentEvidenceOrigins).toEqual([]);
      expect(records.sampleFeedback).toEqual([]);
      expect(records.assignmentCopyReceipts).toHaveLength(3);
      expect(
        records.assignmentCopyReceipts.every(
          (row: { state: string; evidenceId: string | null }) =>
            row.state === "removed" && row.evidenceId === null,
        ),
      ).toBe(true);
    } finally {
      await adminContext.close();
      await reviewerContext.close();
      if (memberId) await store(pool).remove(memberId);
      for (const id of staffIds)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}

test("[L217] AHO-03-10 lost committed assignment copy is inspected during creation-off rollback and after original-source deletion before deliberate replay cannot recreate it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60000);
  const recovery = await startAssignmentEvidenceRecoveryServer(pool, root);
  const recoveryContext = await context(browser, page, info, recovery.origin);
  const original = await recoveryContext.newPage();
  let memberId: string | undefined;
  const response =
    "An invented recovery example checks three options and records what is unknown.\n";
  const submittedResponse = response.replace(/\n/g, "\r\n");
  try {
    const draft = await publishAssignment("explorer", "everyday");
    memberId = await onboard(original, recovery.origin, "explorer", "everyday");
    const attemptId = await submitAssignment(original, draft.title, response);
    const confirmation = await prepareCopy(
      original,
      recovery.origin,
      attemptId,
      submittedResponse,
      draft,
    );
    const operationId = await original
      .locator('input[name="operationId"]')
      .inputValue();
    await confirmation.check();
    const lost = original.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname.endsWith("/handoff") &&
        reply.request().method() === "POST",
    );
    await original
      .getByRole("button", {
        name: "Create private feedback copy",
        exact: true,
      })
      .click();
    expect((await lost).status()).toBe(503);
    await expect(
      original.getByRole("heading", {
        name: "Assignment copy needs attention",
        exact: true,
      }),
    ).toBeVisible();
    await expect(original.getByRole("alert")).toContainText(
      "The saved result cannot be confirmed",
    );
    const repeat = original.locator(
      `form[action="/assignments/attempts/${attemptId}/handoff"]`,
    );
    await expect(repeat.locator('input[name="operationId"]')).toHaveValue(
      operationId,
    );
    await expect(
      repeat.getByLabel(consentName, { exact: false }),
    ).not.toBeChecked();
    expect(recovery.observed).toEqual({
      commits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    recovery.setCreationEnabled(false);
    const inspection = recoveryContext.waitForEvent("page");
    await original
      .getByRole("button", { name: "Inspect this copy request", exact: true })
      .click();
    const inspected = await inspection;
    await expect(
      inspected.getByRole("heading", {
        name: "Your assignment feedback copy",
        exact: true,
      }),
    ).toBeVisible();
    const evidenceId = await inspected
      .locator("[data-assignment-evidence]")
      .getAttribute("data-assignment-evidence");
    expect(evidenceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await inspected.evaluate(() => window.opener === null)).toBe(true);
    expect(new URL(inspected.url()).search).toBe("");
    await info.attach("invented-assignment-recovered-original", {
      body: await inspected.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const denied = await inspected.goto(
      recovery.origin + `/assignments/attempts/${attemptId}/handoff?sequence=1`,
    );
    expect(denied!.status()).toBe(404);
    await expect(inspected.getByRole("alert")).toContainText(
      "currently unavailable",
    );
    await exportedCopy(
      inspected,
      recovery.origin,
      evidenceId!,
      attemptId,
      draft.id,
      submittedResponse,
    );
    await expect(repeat.locator('input[name="operationId"]')).toHaveValue(
      operationId,
    );
    await expect(
      repeat.getByLabel(consentName, { exact: false }),
    ).not.toBeChecked();
    recovery.setCreationEnabled(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM evidence_objects WHERE owner_principal_id=$1",
          [memberId],
        )
      ).rows[0].n,
    ).toBe(1);
    const exported = await original.request.get(
      recovery.origin + "/api/member/export",
    );
    expect(exported.status()).toBe(200);
    expect(await exported.text()).not.toContain(operationId);
    const receipt = (await exported.json()).records.assignmentCopyReceipts[0];
    expect(receipt).toMatchObject({ evidenceId, state: "available" });
    await inspected.goto(
      recovery.origin + `/assignments/attempts/${attemptId}`,
    );
    await inspected
      .getByLabel("Delete this private attempt and all its submissions", {
        exact: false,
      })
      .check();
    await inspected
      .getByRole("button", { name: "Delete attempt", exact: true })
      .click();
    await expect(
      inspected.getByText("No private assignment attempts yet", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(repeat.locator('input[name="operationId"]')).toHaveValue(
      operationId,
    );
    const removedInspection = recoveryContext.waitForEvent("page");
    await original
      .getByRole("button", { name: "Inspect this copy request", exact: true })
      .click();
    const removed = await removedInspection;
    await expect(removed.getByText(/^Receipt /)).toContainText(
      receipt.receiptId,
    );
    await expect(removed.getByText(/^Receipt /)).toContainText("· removed");
    await expect(removed.locator("[data-assignment-evidence]")).toHaveCount(0);
    await expect(removed.locator("body")).toContainText(
      "Repeating the original request cannot recreate it",
    );
    await expect(
      repeat.getByLabel(consentName, { exact: false }),
    ).not.toBeChecked();
    await repeat.getByLabel(consentName, { exact: false }).check();
    await repeat
      .getByRole("button", {
        name: "Repeat this original copy request",
        exact: true,
      })
      .click();
    await expect(original.getByText(/^Receipt /)).toContainText(
      receipt.receiptId,
    );
    await expect(original.getByText(/^Receipt /)).toContainText("· removed");
    await expect(original.locator("[data-assignment-evidence]")).toHaveCount(0);
    await expect(original.getByRole("status")).toContainText(
      "No new copy or permission was created",
    );
    expect(recovery.observed).toEqual({
      commits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    await inspected.goto(recovery.origin + "/evidence");
    await expect(evidenceItem(inspected, evidenceId!)).toHaveCount(0);
    const afterDeletion = await inspected.request.get(
      recovery.origin + "/api/member/export",
    );
    expect(afterDeletion.status()).toBe(200);
    const records = (await afterDeletion.json()).records;
    expect(records.assignmentAttempts).toEqual([]);
    expect(records.assignmentSubmissions).toEqual([]);
    expect(records.assignmentEvidenceOrigins).toEqual([]);
    expect(records.assignmentCopyReceipts).toEqual([
      { ...receipt, evidenceId: null, state: "removed" },
    ]);
    expect(
      (
        await pool.query(
          `SELECT
            (SELECT count(*)::int FROM evidence_objects WHERE owner_principal_id=$1) AS copies,
            (SELECT count(*)::int FROM evidence_review_submissions WHERE submitted_by=$1) AS requests,
            (SELECT count(*)::int FROM assignment_grants g JOIN workspaces w ON w.id=g.workspace_id
              WHERE w.owner_principal_id=$1) AS grants`,
          [memberId],
        )
      ).rows[0],
    ).toEqual({ copies: 0, requests: 0, grants: 0 });
    await info.attach("invented-assignment-removed-original-receipt", {
      body: await original.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await recoveryContext.close();
    await recovery.close();
    if (memberId) await store(pool).remove(memberId);
  }
});

test("[L218] AHO-10 a fresh inspection page recovers the original assignment receipt after a creation-off restart invalidates the old form, including after source deletion", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60000);
  const recovery = await startAssignmentEvidenceRecoveryServer(pool, root);
  const recoveryContext = await context(browser, page, info, recovery.origin);
  const original = await recoveryContext.newPage();
  let memberId: string | undefined;
  const response =
    "An invented restart example compares three activities and records an unchecked assumption.\n";
  const submittedResponse = response.replace(/\n/g, "\r\n");
  try {
    const draft = await publishAssignment("explorer", "everyday");
    memberId = await onboard(original, recovery.origin, "explorer", "everyday");
    const attemptId = await submitAssignment(original, draft.title, response);
    await (
      await prepareCopy(
        original,
        recovery.origin,
        attemptId,
        submittedResponse,
        draft,
      )
    ).check();
    const lost = original.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname.endsWith("/handoff") &&
        reply.request().method() === "POST",
    );
    await original
      .getByRole("button", {
        name: "Create private feedback copy",
        exact: true,
      })
      .click();
    expect((await lost).status()).toBe(503);
    await expect(original.getByRole("alert")).toContainText(
      "The saved result cannot be confirmed",
    );
    const reference = original.locator("[data-assignment-request-reference]");
    await expect(reference).toBeVisible();
    const operationId = (await reference.innerText()).trim();
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
    const beforeRestart = await original.request.get(
      recovery.origin + "/api/member/export",
    );
    expect(beforeRestart.status()).toBe(200);
    const receipts = (await beforeRestart.json()).records
      .assignmentCopyReceipts;
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt.state).toBe("available");
    expect(receipt.evidenceId).toMatch(/^[a-f0-9-]{36}$/);
    recovery.restartWithFreshSecret(false);
    const rejectedPage = recoveryContext.waitForEvent("page");
    const rejectedResponse = recoveryContext.waitForEvent("response", {
      predicate: (reply) =>
        new URL(reply.url()).pathname === "/assignment-feedback/inspect" &&
        reply.request().method() === "POST",
    });
    await original
      .getByRole("button", { name: "Inspect this copy request", exact: true })
      .click();
    const other = await rejectedPage;
    expect((await rejectedResponse).status()).toBe(403);
    expect(await other.evaluate(() => window.opener === null)).toBe(true);
    await expect(other.locator("body")).not.toContainText(response.trim());
    await original
      .getByRole("link", {
        name: "Inspect an earlier copy request",
        exact: true,
      })
      .click();
    expect(new URL(original.url()).pathname).toBe(
      "/assignment-feedback/inspect",
    );
    expect(new URL(original.url()).search).toBe("");
    const inspectorUrl = original.url();
    await original
      .getByLabel("Original copy request reference", { exact: true })
      .fill(operationId);
    await original
      .getByRole("button", { name: "Inspect copy request", exact: true })
      .click();
    await expect(
      original.getByRole("heading", {
        name: "Your assignment feedback copy",
        exact: true,
      }),
    ).toBeVisible();
    await expect(original.getByText(/^Receipt /)).toContainText(
      receipt.receiptId,
    );
    await expect(original.getByText(/^Receipt /)).toContainText("· available");
    await expect(
      original.locator("[data-assignment-evidence]"),
    ).toHaveAttribute("data-assignment-evidence", receipt.evidenceId);
    expect(new URL(original.url()).search).toBe("");
    await info.attach("invented-assignment-recovered-after-restart", {
      body: await original.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const denied = await other.goto(
      recovery.origin + `/assignments/attempts/${attemptId}/handoff?sequence=1`,
    );
    expect(denied!.status()).toBe(404);
    await expect(other.getByRole("alert")).toContainText(
      "currently unavailable",
    );
    await exportedCopy(
      other,
      recovery.origin,
      receipt.evidenceId,
      attemptId,
      draft.id,
      submittedResponse,
    );
    await other.goto(recovery.origin + `/assignments/attempts/${attemptId}`);
    await other
      .getByLabel("Delete this private attempt and all its submissions", {
        exact: false,
      })
      .check();
    await other
      .getByRole("button", { name: "Delete attempt", exact: true })
      .click();
    await expect(
      other.getByText("No private assignment attempts yet", { exact: false }),
    ).toBeVisible();
    // Return to the current read-only form for a fresh nonce. The old page's
    // instruction is never reconstructed or submitted after the secret change.
    await original.goto(inspectorUrl);
    await original
      .getByLabel("Original copy request reference", { exact: true })
      .fill(operationId);
    await original
      .getByRole("button", { name: "Inspect copy request", exact: true })
      .click();
    await expect(original.getByText(/^Receipt /)).toContainText(
      receipt.receiptId,
    );
    await expect(original.getByText(/^Receipt /)).toContainText("· removed");
    await expect(original.locator("[data-assignment-evidence]")).toHaveCount(0);
    await expect(original.locator("body")).toContainText(
      "Repeating the original request cannot recreate it",
    );
    expect(new URL(original.url()).search).toBe("");
    expect(recovery.observed).toEqual({
      commits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    const afterDeletion = await original.request.get(
      recovery.origin + "/api/member/export",
    );
    expect(afterDeletion.status()).toBe(200);
    expect(await afterDeletion.text()).not.toContain(operationId);
    const records = (await afterDeletion.json()).records;
    expect(records.assignmentAttempts).toEqual([]);
    expect(records.assignmentSubmissions).toEqual([]);
    expect(records.assignmentEvidenceOrigins).toEqual([]);
    expect(records.assignmentCopyReceipts).toEqual([
      { ...receipt, evidenceId: null, state: "removed" },
    ]);
    expect(
      (
        await pool.query(
          `SELECT
            (SELECT count(*)::int FROM evidence_objects WHERE owner_principal_id=$1) AS copies,
            (SELECT count(*)::int FROM evidence_review_submissions WHERE submitted_by=$1) AS requests,
            (SELECT count(*)::int FROM assignment_grants g JOIN workspaces w ON w.id=g.workspace_id
              WHERE w.owner_principal_id=$1) AS grants`,
          [memberId],
        )
      ).rows[0],
    ).toEqual({ copies: 0, requests: 0, grants: 0 });
    await info.attach("invented-assignment-restart-removed-receipt", {
      body: await original.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await recoveryContext.close();
    await recovery.close();
    if (memberId) await store(pool).remove(memberId);
  }
});
