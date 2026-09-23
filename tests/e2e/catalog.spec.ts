import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => {
  await pool.end();
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
