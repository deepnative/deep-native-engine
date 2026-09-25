import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { proposalStore } from "../../src/proposals.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => {
  await pool.end();
});
test("[L28] consented sample stays private, quarantines and redacts after withdrawal", async ({
  browser,
  page,
}, testInfo) => {
  const title = `Invented contribution ${testInfo.project.name}`;
  const moderator = await staff("moderator");
  const reviewer = await staff("reviewer");
  const other = await browser.newContext({ baseURL: origin });
  const moderatorContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  try {
    await onboard(page);
    await page.goto("/contribute");
    await page.getByLabel("Title").fill(title);
    await page
      .getByLabel("Original sample")
      .fill("An invented plan with no private people.");
    await page
      .getByLabel("Sources and rights notes")
      .fill("Original invented sample.");
    await page.getByLabel("I used only invented or sample information").check();
    await page.getByRole("button", { name: "Save private draft" }).click();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page.getByText("This is not published or licensed"),
    ).toBeVisible();

    const otherPage = await other.newPage();
    await onboard(otherPage);
    await otherPage.goto(`/contribute/${id}`);
    await expect(
      otherPage.getByRole("heading", { name: "Proposal unavailable" }),
    ).toBeVisible();
    await useToken(reviewerContext, reviewer.token);
    const reviewerPage = await reviewerContext.newPage();
    await reviewerPage.goto("/moderate/proposals");
    await expect(
      reviewerPage.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();

    await page.getByLabel("I created this sample or have the rights").check();
    await page
      .getByRole("button", { name: "Submit to private moderation" })
      .click();
    await expect(page.getByText("PRIVATE SAMPLE · SUBMITTED")).toBeVisible();
    await useToken(moderatorContext, moderator.token);
    const moderatorPage = await moderatorContext.newPage();
    await moderatorPage.goto("/moderate/proposals");
    await expect(moderatorPage.getByText(title)).toBeVisible();
    await expect(
      moderatorPage.getByRole("button", { name: /publish|approve/i }),
    ).toHaveCount(0);
    const ownQueueItem = moderatorPage
      .locator("main li")
      .filter({ hasText: title });
    await ownQueueItem
      .getByRole("button", { name: "Quarantine for review" })
      .click();
    await expect(
      moderatorPage.locator("main li").filter({ hasText: title }),
    ).toContainText("quarantined");
    const denied = await page.request.post(`/contribute/${id}/withdraw`, {
      headers: { origin },
      form: { csrf: "wrong", confirm: "yes" },
    });
    expect(denied.status()).toBe(403);
    await page.reload();
    await page
      .getByLabel("Remove the proposal text and stop moderation")
      .check();
    await page.getByRole("button", { name: "Withdraw and redact" }).click();
    await expect(
      page.getByText("The proposal text has been removed"),
    ).toBeVisible();
    await moderatorPage.reload();
    await expect(moderatorPage.getByText(title)).toHaveCount(0);
    const record = (
      await pool.query(
        "SELECT title,body,sources,state FROM member_proposals WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(record).toEqual({
      title: null,
      body: null,
      sources: null,
      state: "withdrawn",
    });
    await page.goto(`/library?q=${encodeURIComponent(title)}`);
    await expect(page.getByText("No published content matches")).toBeVisible();
  } finally {
    await other.close();
    await moderatorContext.close();
    await reviewerContext.close();
  }
});
test("[L57] private moderation worklist orders by submission and loses revoked access", async ({
  browser,
  page,
}, testInfo) => {
  await onboard(page);
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "dne_preview",
  )!;
  const proposals = proposalStore(pool);
  const olderTitle = `Earlier submitted sample ${testInfo.project.name}`;
  const laterTitle = `Later submitted sample ${testInfo.project.name}`;
  const sample = {
    body: "Invented worklist example",
    sources: "Original invented sample",
  };
  const later = (await proposals.createDraft(
    cookie.value,
    { ...sample, title: laterTitle },
    true,
  ))!;
  const older = (await proposals.createDraft(
    cookie.value,
    { ...sample, title: olderTitle },
    true,
  ))!;
  expect(await proposals.submit(cookie.value, older, true)).toBe(true);
  expect(await proposals.submit(cookie.value, later, true)).toBe(true);
  await pool.query(
    `UPDATE member_proposals SET submitted_at=CASE WHEN id=$1 THEN CURRENT_TIMESTAMP-INTERVAL '2 hours' ELSE CURRENT_TIMESTAMP-INTERVAL '1 hour' END WHERE id IN ($1,$2)`,
    [older, later],
  );
  const moderator = await staff("moderator");
  const reviewer = await staff("reviewer");
  const moderatorContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  try {
    await page.goto("/moderate/proposals");
    await expect(
      page.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();
    await useToken(reviewerContext, reviewer.token);
    const reviewerPage = await reviewerContext.newPage();
    await reviewerPage.goto("/moderate/proposals");
    await expect(
      reviewerPage.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();

    await useToken(moderatorContext, moderator.token);
    const worklist = await moderatorContext.newPage();
    await worklist.goto("/moderate/proposals");
    await expect(worklist.getByText(olderTitle)).toBeVisible();
    await expect(worklist.getByText(laterTitle)).toBeVisible();
    const entries = await worklist.locator("main li").allTextContents();
    expect(
      entries.findIndex((entry) => entry.includes(olderTitle)),
    ).toBeLessThan(entries.findIndex((entry) => entry.includes(laterTitle)));
    for (const title of [olderTitle, laterTitle]) {
      const item = worklist.locator("main li").filter({ hasText: title });
      await expect(item.locator("time")).toHaveCount(1);
      await expect(item.getByText(/Elapsed: [0-9]+ minutes/)).toBeVisible();
    }
    await expect(worklist.getByText("no response-time promise")).toBeVisible();
    await pool.query(
      "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
      [moderator.id],
    );
    await worklist
      .locator("main li")
      .filter({ hasText: olderTitle })
      .getByRole("button", { name: "Reject and redact" })
      .click();
    await expect(
      worklist.getByRole("heading", { name: "Proposal unchanged" }),
    ).toBeVisible();
    await worklist.goto("/moderate/proposals");
    await expect(
      worklist.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();
    expect(await proposals.preview(cookie.value, older)).toMatchObject({
      state: "submitted",
    });
  } finally {
    await moderatorContext.close();
    await reviewerContext.close();
  }
});
test("[L27] general learner sees preparation while operator alone sees pending expert evidence", async ({
  browser,
  page,
}) => {
  const operator = await staff("operator");
  const reviewer = await staff("reviewer");
  const recordId = randomUUID();
  await pool.query(
    `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,
      starts_at,ends_at,loaded_cost_cents,capacity_minutes)
     VALUES($1,$2,'reviewer','education','formal-review',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '30 days',12000,120)`,
    [recordId, reviewer.id],
  );
  const operatorContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  try {
    await page.goto("/readiness/tracks");
    await expect(
      page.getByRole("heading", { name: "Learning track readiness" }),
    ).toBeVisible();
    await expect(page.getByText("in preparation")).toHaveCount(15);
    await expect(page.getByText("General learners may use")).toBeVisible();
    await expect(page.getByRole("button", { name: /book|buy/i })).toHaveCount(
      0,
    );
    await useToken(reviewerContext, reviewer.token);
    const reviewerPage = await reviewerContext.newPage();
    await reviewerPage.goto("/operator/experts");
    await expect(
      reviewerPage.getByRole("heading", { name: "Registry unavailable" }),
    ).toBeVisible();
    await useToken(operatorContext, operator.token);
    const operatorPage = await operatorContext.newPage();
    await operatorPage.goto("/operator/experts");
    await expect(
      operatorPage.getByRole("heading", { name: "Expert coverage registry" }),
    ).toBeVisible();
    await expect(operatorPage.getByText("verification pending")).toBeVisible();
    await expect(operatorPage.getByText("backup missing")).toBeVisible();
  } finally {
    await pool.query("DELETE FROM expert_registry WHERE id=$1", [recordId]);
    await operatorContext.close();
    await reviewerContext.close();
  }
});
async function staff(role: StaffRole) {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 86_400_000),
  );
  return { token, id };
}
async function useToken(context: BrowserContext, value: string) {
  await context.addCookies([
    {
      name: "dne_preview",
      value,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function onboard(page: Page, background = "explorer", goal = "everyday") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}
test("[L25] editor and member see a real gated draft, review, publish and retire lifecycle", async ({
  browser,
  page,
}, testInfo) => {
  const id =
    testInfo.project.name === "desktop-chromium" ? "SYN-901" : "SYN-902";
  const foundationId =
    testInfo.project.name === "desktop-chromium" ? "FND-001" : "FND-002";
  const title = `Synthetic content preview ${id}`;
  const editor = await staff("editor"),
    reviewer = await staff("reviewer");
  const editorContext = await browser.newContext({ baseURL: origin });
  const reviewerContext = await browser.newContext({ baseURL: origin });
  try {
    await onboard(page);
    await page.goto("/library");
    await expect(
      page.locator(`a[href="/library/${foundationId}"]`),
    ).toHaveCount(0);
    await useToken(editorContext, editor.token);
    const editorPage = await editorContext.newPage();
    await editorPage.goto("/editor/library");
    await editorPage.goto(`/editor/library/${foundationId}/1`);
    await expect(
      editorPage.getByText(
        "Qualified curriculum and domain sign-off is pending",
      ),
    ).toBeVisible();
    await editorPage.getByRole("button", { name: "Submit for review" }).click();
    await useToken(reviewerContext, reviewer.token);
    const reviewerPage = await reviewerContext.newPage();
    await reviewerPage.goto(`/editor/library/${foundationId}/1`);
    await reviewerPage
      .getByLabel(
        "I checked the source and rights statement for this synthetic item.",
      )
      .check();
    await reviewerPage
      .getByRole("button", { name: "Approve synthetic review" })
      .click();
    await expect(
      reviewerPage.getByRole("heading", { name: "Content state unchanged" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator(`a[href="/library/${foundationId}"]`),
    ).toHaveCount(0);

    await editorPage.goto("/editor/library");
    await editorPage.getByLabel("Content ID").fill(id);
    await editorPage.getByLabel("Version").fill("1");
    await editorPage.getByLabel("Title").fill(title);
    await editorPage
      .getByLabel("Body")
      .fill("A synthetic <script>unsafe</script> example.");
    await editorPage.getByLabel("Owner").fill("Test editor");
    await editorPage.getByLabel("Sources").fill("Original synthetic text");
    await editorPage.getByLabel("Rights").fill("Owned for this local test");
    await editorPage.getByRole("button", { name: "Save draft" }).click();
    await expect(editorPage).toHaveURL(new RegExp(`/editor/library/${id}/1$`));
    await editorPage.getByRole("button", { name: "Submit for review" }).click();
    await reviewerPage.goto(`/editor/library/${id}/1`);
    await reviewerPage
      .getByLabel(
        "I checked the source and rights statement for this synthetic item.",
      )
      .check();
    await reviewerPage
      .getByRole("button", { name: "Approve synthetic review" })
      .click();
    await expect(reviewerPage.getByText("APPROVED · VERSION 1")).toBeVisible();
    await editorPage.reload();
    await editorPage
      .getByRole("button", { name: "Publish to local library" })
      .click();
    await page.goto(`/library?q=${id}`);
    await page.getByRole("link", { name: title }).click();
    await expect(
      page.getByText("A synthetic <script>unsafe</script> example."),
    ).toBeVisible();
    expect(await page.locator("script").count()).toBe(0);
    await editorPage.goto(`/editor/library/${id}/1`);
    await editorPage
      .getByRole("button", { name: "Retire published versions" })
      .click();
    await page.goto(`/library?q=${id}`);
    await expect(page.getByText("No published content matches")).toBeVisible();
  } finally {
    await editorContext.close();
    await reviewerContext.close();
  }
});
test("[L26] member search selects the latest eligible version while simulated assessment stays pinned", async ({
  browser,
  page,
}, testInfo) => {
  const id =
    testInfo.project.name === "desktop-chromium" ? "SYN-903" : "SYN-904";
  const title = `Synthetic sign-up review ${id}`;
  const editor = await staff("editor"),
    reviewer = await staff("reviewer"),
    admin = await staff("platform_admin");
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title,
    body: "Version one synthetic test brief.",
    owner: "Test editor",
    sources: "Original synthetic brief",
    rights: "Owned sample",
    goals: ["build"],
    backgrounds: ["technical"],
    domains: [],
    prerequisites: "None",
    rubric: "Version one rubric",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor.token, draft)).toBe(true);
  expect(await catalog.submit(editor.token, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer.token, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor.token, id, 1)).toBe(true);
  await onboard(page, "technical", "build");
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "dne_preview",
  )!;
  const memberId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM learners WHERE token_hash=$1",
      [createHash("sha256").update(cookie.value).digest("hex")],
    )
  ).rows[0]!.id;
  await authorizationStore(pool).grantAssignment(
    admin.id,
    reviewer.id,
    memberId,
    "reviewer",
    "synthetic scoring",
    new Date(Date.now() + 86_400_000),
  );
  const assessmentId = await catalog.assess(
    reviewer.token,
    memberId,
    id,
    1,
    "Synthetic review only",
  );
  expect(assessmentId).toEqual(expect.any(String));
  const second = {
    ...draft,
    version: 2,
    body: "Version two synthetic test brief.",
    rubric: "Version two rubric",
    rubricVersion: 2,
  };
  expect(await catalog.createDraft(editor.token, second)).toBe(true);
  expect(await catalog.submit(editor.token, id, 2)).toBe(true);
  expect(await catalog.approve(reviewer.token, id, 2, true)).toBe(true);
  expect(await catalog.publish(editor.token, id, 2)).toBe(true);
  await page.goto(`/library?q=${id}&goal=build&background=technical`);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByText("VERSION 2")).toBeVisible();
  await expect(
    page.getByText("Version two synthetic test brief."),
  ).toBeVisible();
  const pinned = (
    await pool.query(
      "SELECT content_version,rubric_version,result FROM content_assessments WHERE id=$1",
      [assessmentId],
    )
  ).rows[0];
  expect(pinned).toEqual({
    content_version: 1,
    rubric_version: 1,
    result: "Synthetic review only",
  });
  await page.goto(`/library?q=${id}&goal=everyday`);
  await expect(page.getByText("No published content matches")).toBeVisible();
  const outsider = await browser.newContext({ baseURL: origin });
  try {
    await outsider.newPage().then(async (other) => {
      await other.goto(`/editor/library/${id}/2`);
      await expect(
        other.getByRole("heading", { name: "Staff preview unavailable" }),
      ).toBeVisible();
    });
  } finally {
    await outsider.close();
  }
});
