import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { catalogStore } from "../../src/catalog.ts";
import { learningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";
import { PROGRAM_PATH } from "../../src/program-values.ts";
import { reviewedContentFixture as fixture } from "../support/reviewed-content-browser.ts";

// The fixture's invented staff credentials must not appear in a browser trace.
test.use({ trace: "off" });

const contentId = "LRN-001";
const version = 1;
const editorialUrl = (origin: string) =>
  `${origin}/editor/library/${contentId}/${version}`;

async function publishThroughEditorialUi(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const editor = await f.staff("editor");
  const reviewer = await f.staff("reviewer");
  await editor.page.goto(f.origin + "/editor/library/learning-workspace");
  await editor.page
    .getByRole("button", { name: "Import teaching draft" })
    .click();
  await editor.page.goto(editorialUrl(f.origin));
  await editor.page.getByRole("button", { name: "Submit for review" }).click();
  await reviewer.page.goto(editorialUrl(f.origin));
  await reviewer.page
    .getByLabel(
      "I checked the sources and rights for this ordinary educational lesson.",
    )
    .check();
  await reviewer.page
    .getByRole("button", { name: "Approve editorial review" })
    .click();
  await editor.page.goto(editorialUrl(f.origin));
  await editor.page
    .getByRole("button", { name: "Publish reviewed lesson" })
    .click();
  return { editor, reviewer };
}

async function publishForMemberJourney(f: Awaited<ReturnType<typeof fixture>>) {
  const editor = await f.staff("editor");
  const reviewer = await f.staff("reviewer");
  expect(
    (await learningWorkspacePublicationStore(f.pool).import(editor.token)).kind,
  ).toBe("imported");
  const catalog = catalogStore(f.pool);
  expect(await catalog.submit(editor.token, contentId, version)).toBe(true);
  expect(await catalog.approve(reviewer.token, contentId, version, true)).toBe(
    true,
  );
  expect(await catalog.publish(editor.token, contentId, version)).toBe(true);
  return { editor, reviewer };
}

async function saveAccountNotebook(page: Page) {
  await page.locator("#save").click();
  await expect(page.locator("#save-status")).toContainText(
    "Saved to your private account notebook.",
  );
}

async function downloadEnrollment(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("link", { name: "Download private enrollment JSON" })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe("program-enrollment.json");
  const path = await download.path();
  if (!path) throw Error("Owned enrollment download missing");
  return JSON.parse(await readFile(path, "utf8"));
}

async function openLesson(page: Page, number: number, step: number) {
  if (
    !(await page
      .locator("#course-menu")
      .evaluate((menu) => (menu as HTMLDetailsElement).open))
  )
    await page.locator("#course-menu > summary").click();
  await page.locator(`#course-path [data-lesson="${number - 1}"]`).click();
  await page.locator(`[data-step="${step}"]`).click();
}

async function openFinal(page: Page, step: number) {
  if (
    !(await page
      .locator("#course-menu")
      .evaluate((menu) => (menu as HTMLDetailsElement).open))
  )
    await page.locator("#course-menu > summary").click();
  await page.locator('#course-path [data-lesson="6"]').click();
  await page.locator(`[data-final-step="${step}"]`).click();
}

test("[L257] LWORK-05 editor imports the full teaching bundle as an unpublished draft; a distinct reviewer checks rights before publication", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const editor = await f.staff("editor");
    const reviewer = await f.staff("reviewer");
    const member = await f.member();
    await editor.page.goto(f.origin + "/editor/library/learning-workspace");
    await expect(
      editor.page.getByRole("heading", {
        name: "Review the learning workspace",
      }),
    ).toBeVisible();
    const bundleLink = editor.page.getByRole("link", {
      name: "Inspect the complete teaching bundle (JSON)",
    });
    const bundle = await editor.page.request.get(
      f.origin + (await bundleLink.getAttribute("href")),
    );
    expect(bundle.ok()).toBe(true);
    const content = await bundle.json();
    expect(content.course.lessons).toHaveLength(6);
    expect(Object.keys(content.course.feedbackCases).sort()).toEqual([
      "everyday",
      "technical",
      "work",
    ]);
    await reviewer.page.goto(f.origin + "/editor/library/learning-workspace");
    await reviewer.page
      .getByRole("button", { name: "Import teaching draft" })
      .click();
    expect(
      (
        await f.pool.query("SELECT 1 FROM content_versions WHERE id=$1", [
          contentId,
        ])
      ).rowCount,
    ).toBe(0);
    await editor.page.goto(f.origin + "/editor/library/learning-workspace");
    await editor.page
      .getByRole("button", { name: "Import teaching draft" })
      .click();
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM content_versions WHERE id=$1 AND version=$2 AND state='draft'",
          [contentId, version],
        )
      ).rowCount,
    ).toBe(1);
    await member.reload();
    await expect(member.locator("[data-workspace-module-base]")).toHaveCount(0);
    await editor.page.goto(editorialUrl(f.origin));
    await editor.page
      .getByRole("button", { name: "Publish reviewed lesson" })
      .click();
    await expect(
      editor.page.getByRole("heading", { name: "Content state unchanged" }),
    ).toBeVisible();
    await editor.page.goto(editorialUrl(f.origin));
    await editor.page
      .getByRole("button", { name: "Submit for review" })
      .click();
    await reviewer.page.goto(editorialUrl(f.origin));
    const csrf = await reviewer.page
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    expect(
      (
        await reviewer.page.request.post(editorialUrl(f.origin) + "/approve", {
          headers: { origin: f.origin },
          form: { csrf },
        })
      ).status(),
    ).toBe(409);
    await reviewer.page.reload();
    await reviewer.page
      .getByLabel(
        "I checked the sources and rights for this ordinary educational lesson.",
      )
      .check();
    await reviewer.page
      .getByRole("button", { name: "Approve editorial review" })
      .click();
    await editor.page.goto(editorialUrl(f.origin));
    await editor.page
      .getByRole("button", { name: "Publish reviewed lesson" })
      .click();
    await expect(editor.page.getByText("PUBLISHED · VERSION 1")).toBeVisible();
    await member.goto(f.origin + "/learn");
    await expect(
      member.getByRole("heading", { name: "Your learning path" }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

for (const [background, goal, route, sourceFact, freshFact, correction] of [
  [
    "explorer",
    "everyday",
    "Everyday",
    "Twelve volunteers",
    "A room has not been chosen",
    "The reading group has nine people and meets for forty-five minutes on Wednesday. The room is undecided.",
  ],
  [
    "professional",
    "work",
    "Work",
    "Sam",
    "No agenda deadline is recorded",
    "Noor is the agenda owner; Lee invites participants. The agenda deadline is not recorded.",
  ],
  [
    "technical",
    "build",
    "Technical",
    "No tests have been run",
    "Its behavior for JPEG is unspecified",
    "PNG up to 4 MB is required; no tests have run. JPEG behavior is unspecified.",
  ],
] as const) {
  const scenario =
    route === "Everyday" ? "L258" : route === "Work" ? "L259" : "L260";
  test(`[${scenario}] LWORK-01/02/03/08/INTEGRATION-01 ${route} member moves between courses and private account notebook`, async ({
    browser,
  }, info) => {
    const f = await fixture(browser, info);
    try {
      await f.publishFixture();
      await publishForMemberJourney(f);
      const admin = await f.staff("platform_admin");
      await admin.page.goto(f.origin + "/operator/programs");
      await admin.page
        .getByLabel("Open this exact local inventory only.")
        .check();
      await admin.page
        .getByRole("button", { name: "Open local term", exact: true })
        .click();
      const member = await f.member(background, goal);
      await expect(
        member.getByRole("heading", { name: "Your learning path" }),
      ).toBeVisible();
      await expect(member.locator("#course-path [data-lesson]")).toHaveCount(7);
      await expect(
        member.getByRole("navigation", { name: "Main navigation" }),
      ).toContainText("Learn");
      await expect(
        member.getByRole("navigation", { name: "Main navigation" }),
      ).toContainText("Practice");
      await expect(
        member.getByRole("navigation", { name: "Main navigation" }),
      ).toContainText("My work");
      await expect(
        member.getByRole("link", { name: "Learning records" }),
      ).toHaveAttribute("href", "/learn/records");
      await member.getByRole("link", { name: "My courses" }).click();
      await expect(
        member.getByText("No local enrollment is recorded for this account."),
      ).toBeVisible();
      await member
        .getByRole("link", { name: "Explore local foundation program" })
        .click();
      await expect(member).toHaveURL(f.origin + PROGRAM_PATH);
      await member
        .getByLabel(/Choose this exact local program and term/)
        .check();
      await member
        .getByRole("button", { name: "Choose local program", exact: true })
        .click();
      await member
        .getByLabel(/Enroll this current account in the local simulation/)
        .check();
      await member
        .getByRole("button", { name: "Confirm local enrollment", exact: true })
        .click();
      await expect(
        member.getByRole("heading", { name: "My courses", exact: true }),
      ).toBeVisible();
      await expect(
        member.getByText("No self-assessed activity recorded", {
          exact: false,
        }),
      ).toHaveCount(6);
      const initialEnrollment = await downloadEnrollment(member);
      expect(initialEnrollment.enrollment.manifest.lessons).toHaveLength(6);
      for (const [
        index,
        lesson,
      ] of initialEnrollment.enrollment.manifest.lessons.entries())
        expect(lesson).toMatchObject({ id: `FND-00${index + 1}`, version: 2 });
      expect(initialEnrollment.enrollment.activity).toEqual([]);
      await member.getByRole("link", { name: "Continue learning" }).click();
      await expect(
        member.getByRole("heading", { name: "Your learning path" }),
      ).toBeVisible();
      await member.locator('[data-view="practice"]').first().click();
      await expect(
        member.getByRole("heading", { name: "Make it stick" }),
      ).toBeVisible();
      await member.locator('[data-view="work"]').first().click();
      await expect(
        member.getByRole("heading", { name: "Your work, kept together" }),
      ).toBeVisible();
      await openLesson(member, 3, 1);
      await expect(member.locator("#source-text")).toContainText(sourceFact);
      const questions = member.locator("#practice-form fieldset");
      await expect(questions).toHaveCount(3);
      await questions.nth(0).locator('input[value="Contradicted"]').check();
      await questions.nth(1).locator('input[value="Contradicted"]').check();
      await questions.nth(2).locator('input[value="Not given"]').check();
      await member.getByRole("button", { name: "Check answers" }).click();
      await expect(
        member.locator("#practice-form .answer-feedback").first(),
      ).toContainText("Try another choice after comparing with the source.");
      await questions.nth(0).locator('input[value="Supported"]').check();
      await member.getByRole("button", { name: "Check answers" }).click();
      for (const explanation of await member
        .locator("#practice-form .answer-feedback")
        .all())
        await expect(explanation).toContainText(
          "This response matches the source.",
        );
      await member.locator('[data-step="2"]').click();
      await expect(member.locator("#source-text")).toContainText(freshFact);
      await member.getByLabel("Your fresh-case attempt").fill(correction);
      await member.locator('[data-step="3"]').click();
      await member
        .getByLabel("Your lesson work")
        .fill(
          `I revised this ${route.toLowerCase()} example against its source and left unsupported details open.`,
        );
      await member
        .getByLabel("I compared this work with the criteria above")
        .check();
      await openFinal(member, 1);
      await member
        .getByLabel("3. Claim check and repair")
        .fill(
          `First draft for ${route}: compare each claim with the invented source.`,
        );
      await member.locator('[data-final-step="3"]').click();
      await member
        .getByLabel("6. Feedback and revision")
        .fill(
          `Revised ${route} draft: preserve supported facts and label missing evidence.`,
        );
      await openLesson(member, 6, 2);
      await member.getByLabel("My decision").selectOption("revise");
      await member
        .getByLabel("Revised text")
        .fill(`Revised ${route} feedback text grounded in the supplied case.`);
      await member
        .getByLabel("My reason")
        .fill(
          "The source supports this change; the unresolved detail stays open.",
        );
      await member
        .getByLabel("Clarification to keep (optional)")
        .fill("Which source would settle the missing detail?");
      await member
        .getByRole("button", { name: "Add decision to my notebook" })
        .click();
      await expect(member.locator("#feedback-decisions")).toContainText(
        "Decision 1",
      );
      await saveAccountNotebook(member);
      await member.reload();
      await expect(member.locator("#feedback-decisions")).toContainText(
        "Decision 1",
      );
      await member.getByRole("link", { name: "My courses" }).click();
      await expect(
        member.getByText("No self-assessed activity recorded", {
          exact: false,
        }),
      ).toHaveCount(6);
      expect(await downloadEnrollment(member)).toEqual(initialEnrollment);
      const firstFoundation = member.locator(
        'a[href="/library/FND-001?version=2"]',
      );
      await expect(firstFoundation).toBeVisible();
      await firstFoundation.click();
      await member.getByRole("button", { name: "Start this lesson" }).click();
      await member
        .getByLabel(
          "I have finished reading this lesson; this is my own report.",
        )
        .check();
      await member
        .getByRole("button", { name: "Mark self-assessed complete" })
        .click();
      await member.goto(f.origin + "/my-courses");
      await expect(
        member.getByText("No self-assessed activity recorded", {
          exact: false,
        }),
      ).toHaveCount(5);
      const finalEnrollment = await downloadEnrollment(member);
      expect(finalEnrollment.enrollment.activity).toEqual([
        { id: "FND-001", version: 2, started: true, selfAssessed: true },
      ]);
      await member.getByRole("link", { name: "Continue learning" }).click();
      await expect(member.locator("#feedback-decisions")).toContainText(
        "Decision 1",
      );
      await expect(
        member.getByLabel("Clarification to keep (optional)"),
      ).toHaveValue("");
      const secondBrowser = await f.page();
      await secondBrowser
        .context()
        .addCookies(await member.context().cookies());
      await secondBrowser.goto(f.origin + "/learn");
      await openLesson(secondBrowser, 3, 2);
      await expect(
        secondBrowser.getByLabel("Your fresh-case attempt"),
      ).toHaveValue(correction);
      await openFinal(secondBrowser, 1);
      await expect(
        secondBrowser.getByLabel("3. Claim check and repair"),
      ).toHaveValue(
        `First draft for ${route}: compare each claim with the invented source.`,
      );
      await secondBrowser.locator('[data-final-step="3"]').click();
      await expect(
        secondBrowser.getByLabel("6. Feedback and revision"),
      ).toHaveValue(
        `Revised ${route} draft: preserve supported facts and label missing evidence.`,
      );
      await openLesson(secondBrowser, 6, 2);
      await expect(secondBrowser.locator("#feedback-decisions")).toContainText(
        "Decision 1",
      );
      const otherRoute = route === "Everyday" ? "Work" : "Everyday";
      await member
        .getByRole("group", { name: "Choose your example route" })
        .getByRole("button", { name: otherRoute, exact: true })
        .click();
      await expect(member.locator("#save-status")).toContainText(
        "Nothing saved yet",
      );
      await openLesson(member, 1, 3);
      await expect(member.getByLabel("Your lesson work")).toHaveValue("");
      await member
        .getByLabel("Your lesson work")
        .fill(`Separate ${otherRoute.toLowerCase()} notebook note.`);
      await saveAccountNotebook(member);
      await member
        .getByRole("group", { name: "Choose your example route" })
        .getByRole("button", { name: route, exact: true })
        .click();
      await openLesson(member, 3, 2);
      await expect(member.getByLabel("Your fresh-case attempt")).toHaveValue(
        correction,
      );
      await member.locator('[data-view="work"]').first().click();
      await expect(
        member.getByRole("heading", { name: "Your work, kept together" }),
      ).toBeVisible();
      await member.goto(f.origin + "/learn/notebooks");
      await expect(
        member.getByRole("heading", { name: "Saved notebooks" }),
      ).toBeVisible();
      const saved = member
        .locator("article.notebook")
        .filter({ hasText: `${route.toLowerCase()} notebook` })
        .locator('a[href^="/learn/notebooks/"]');
      const savedPath = await saved.getAttribute("href");
      expect(savedPath).toBeTruthy();
      await saved.click();
      await expect(member.getByText(correction, { exact: true })).toBeVisible();
      await expect(
        member.getByText(
          `Revised ${route} draft: preserve supported facts and label missing evidence.`,
          { exact: true },
        ),
      ).toBeVisible();
      await member.getByRole("link", { name: "Read feedback history" }).click();
      await expect(
        member.getByRole("heading", { name: "Saved feedback history" }),
      ).toBeVisible();
      await expect(
        member.getByText("Decision 1:", { exact: false }),
      ).toBeVisible();
      const outsider = await f.member();
      await outsider.goto(f.origin + savedPath);
      await expect(outsider.getByRole("status")).toContainText(
        "not available to your account",
      );
      for (const suffix of ["/history", "/download"]) {
        const denied = await outsider.request.get(
          f.origin + savedPath + suffix,
        );
        expect(denied.status()).toBe(404);
        const body = await denied.text();
        expect(body).not.toContain(correction);
        expect(body).not.toContain(
          `Revised ${route} draft: preserve supported facts and label missing evidence.`,
        );
      }
      await outsider.goto(f.origin + "/learn/notebooks");
      await expect(
        outsider.getByText("No saved notebooks on this page."),
      ).toBeVisible();
    } finally {
      await f.close();
    }
  });
}

test("[L261] LWORK-05 retirement rejects new writing while the member retains exact private history and download", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    const { editor } = await publishThroughEditorialUi(f);
    const member = await f.member();
    await openLesson(member, 1, 3);
    const original =
      "Invented book-swap note: compare twelve cards with the list; no venue is confirmed.";
    const decisionText =
      "Revised invented feedback: keep the twelve cards; ask the organiser to confirm the venue.";
    await member.getByLabel("Your lesson work").fill(original);
    await saveAccountNotebook(member);
    await openLesson(member, 6, 2);
    await member.getByLabel("My decision").selectOption("revise");
    await member.getByLabel("Revised text").fill(decisionText);
    await member
      .getByLabel("My reason")
      .fill("The original note supplies the count but leaves the venue open.");
    await member
      .getByRole("button", { name: "Add decision to my notebook" })
      .click();
    await saveAccountNotebook(member);
    await member.goto(f.origin + "/learn/notebooks");
    const path = await member
      .locator('a[href^="/learn/notebooks/"]')
      .first()
      .getAttribute("href");
    expect(path).toBeTruthy();
    await member.goto(f.origin + "/learn");
    await openLesson(member, 1, 3);
    const moduleBase = await member
      .locator("[data-workspace-module-base]")
      .getAttribute("data-workspace-module-base");
    expect(moduleBase).toBeTruthy();
    await editor.page.goto(editorialUrl(f.origin));
    await editor.page
      .getByRole("button", { name: "Retire published versions" })
      .click();
    await member.getByLabel("Your lesson work").fill(original + " Later edit.");
    const write = member.waitForResponse(
      (response) =>
        response.url().includes("/api/learning-workspace/notebooks/") &&
        response.url().endsWith("/draft") &&
        response.request().method() === "PUT",
    );
    await member.locator("#save").click();
    const deniedWrite = await write;
    expect(deniedWrite.status()).toBe(409);
    expect(await deniedWrite.json()).toEqual({ kind: "source-unavailable" });
    await expect(member.locator("#save-status")).toContainText(
      "Your writing remains here",
    );
    await expect(member.getByLabel("Your lesson work")).toHaveValue(
      original + " Later edit.",
    );
    const course = await member.request.get(
      f.origin + moduleBase + "/course.mjs",
    );
    expect(course.status()).toBe(409);
    expect(await course.json()).toEqual({ kind: "source-unavailable" });
    await member.goto(f.origin + "/learn");
    await expect(member.locator("[data-workspace-module-base]")).toHaveCount(0);
    await member.goto(f.origin + path);
    await expect(member.getByText(original, { exact: true })).toBeVisible();
    await expect(member.getByRole("status")).toContainText(
      "teaching source is unavailable",
    );
    await member.goto(f.origin + path + "/history");
    await expect(
      member.getByText("Decision 1:", { exact: false }),
    ).toBeVisible();
    await expect(
      member
        .getByRole("heading", { name: "Accepted artifact", exact: true })
        .locator("..")
        .locator("pre"),
    ).toHaveText(decisionText);
    const download = await member.request.get(f.origin + path + "/download");
    expect(download.ok()).toBe(true);
    const json = await download.json();
    expect(json.notebook.state.lessons[0].work).toBe(original);
    expect(json.historyPage.items).toHaveLength(1);
    expect(json.historyPage.items[0].text).toBe(decisionText);
    await member.goto(f.origin + "/learn?view=records");
    await expect(member.locator("[data-workspace-module-base]")).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test("[L262] LWORK-04 a committed draft with a lost response is confirmed by its original receipt before any retry", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    await publishForMemberJourney(f);
    const member = await f.member();
    await openLesson(member, 1, 3);
    await member
      .getByLabel("Your lesson work")
      .fill("Invented first saved note.");
    await saveAccountNotebook(member);
    await member
      .getByLabel("Your lesson work")
      .fill("Invented revised note after checking the source.");
    let putCount = 0;
    let operationId = "";
    let committedStatus = 0;
    await member.route(
      "**/api/learning-workspace/notebooks/*/draft",
      async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        putCount += 1;
        operationId = (
          route.request().postDataJSON() as { operationId: string }
        ).operationId;
        const committed = await route.fetch();
        committedStatus = committed.status();
        await route.abort("failed");
      },
    );
    await member.locator("#save").click();
    await expect(member.locator("#save-status")).toContainText(
      "Save status is uncertain",
    );
    expect(committedStatus).toBe(200);
    expect(putCount).toBe(1);
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/i);
    // The browser must inspect the original operation before any new mutation.
    const receiptResponse = member.waitForResponse(
      (response) =>
        response.url() ===
          f.origin + "/api/learning-workspace/operations/" + operationId &&
        response.request().method() === "GET",
    );
    await member.getByRole("button", { name: "Check save status" }).click();
    const receipt = await receiptResponse;
    expect(receipt.status()).toBe(200);
    expect((await receipt.json()).kind).toMatch(/saved|replayed/);
    await expect(member.locator("#save-status")).toContainText(
      "Saved to your private account notebook.",
    );
    expect(putCount).toBe(1);
    await member.reload();
    await expect(member.getByLabel("Your lesson work")).toHaveValue(
      "Invented revised note after checking the source.",
    );
  } finally {
    await f.close();
  }
});
