import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  origin = "http://127.0.0.1:4317";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
test.afterAll(async () => pool.end());
async function onboard(
  page: Page,
  background: (typeof audiences)[number][0],
  goal: (typeof audiences)[number][1],
) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
}
async function syntheticLesson(id: string) {
  const auth = authorizationStore(pool),
    catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: `Invented practice source ${id}`,
    body: "Use only invented details. Check every suggestion against the supplied sample before acting.",
    owner: "Synthetic editor",
    sources: "Original invented sample",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number) => {
    expect(await catalog.createDraft(editor, { ...draft, version })).toBe(true);
    expect(await catalog.submit(editor, id, version)).toBe(true);
    expect(await catalog.approve(reviewer, id, version, true)).toBe(true);
    expect(await catalog.publish(editor, id, version)).toBe(true);
  };
  await publish(1);
  return { publish, retire: () => catalog.retire(editor, id) };
}
async function start(page: Page, id: string) {
  await page.goto(`/library/${id}`);
  await page
    .getByRole("link", { name: "Try a private practice session" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Start private practice session" }),
  ).toBeVisible();
  await expect(
    page.getByText("30 visible turns", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("I want to start private sample practice").check();
  await page
    .getByRole("button", { name: "Start or return to private session" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private practice session",
      exact: true,
    }),
  ).toBeVisible();
  return new URL(page.url()).pathname;
}
async function respond(page: Page, response: string) {
  await page.getByLabel("Your next sample response").fill(response);
  await page
    .getByLabel(
      "I used only invented or sample information and want to save this response.",
    )
    .check();
  const savedResponses = page.locator("[data-practice-response]");
  const expectedPairs = (await savedResponses.count()) + 1;
  await page.getByRole("button", { name: "Save response and compare" }).click();
  await expect(savedResponses).toHaveCount(expectedPairs);
  await expect(page.locator("[data-practice-comparison]")).toHaveCount(
    expectedPairs,
  );
  await expect(savedResponses.last()).toHaveText(response);
}
async function changeGoal(page: Page, goal: (typeof audiences)[number][1]) {
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByRole("button", { name: "Save my direction" }).click();
}
async function exported(page: Page) {
  const response = await page.request.get("/api/member/export");
  expect(response.status()).toBe(200);
  return response.json();
}
// Reviewed #424 addition: v71 adds L103-L105 (102 -> 105); all three
// audience variants must pass on both registered browsers. Full-MVP is unchanged.
test("[L103] all three audiences explicitly opt into ordered private pairs, reload and reach the 30-turn cap", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const id = info.project.name === "desktop-chromium" ? "PRAC-101" : "PRAC-102";
  await syntheticLesson(id);
  for (const [background, goal] of audiences) {
    await onboard(page, background, goal);
    await page.goto(`/library/${id}/practice-session`);
    await page
      .getByRole("button", { name: "Start or return to private session" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/library/${id}/practice-session$`),
    );
    await page.goto("/practice-sessions");
    await expect(
      page.getByText("No private sessions are saved yet", { exact: false }),
    ).toBeVisible();
    const path = await start(page, id);
    await expect(
      page.getByText("cannot judge competence", { exact: false }),
    ).toBeVisible();
    for (let sequence = 1; sequence <= 2; sequence++)
      await respond(
        page,
        `Invented ${goal} response ${sequence}: check the source.`,
      );
    await page.reload();
    await expect(page.locator("[data-practice-response]")).toHaveText([
      `Invented ${goal} response 1: check the source.`,
      `Invented ${goal} response 2: check the source.`,
    ]);
    await expect(page.locator("[data-practice-comparison]")).toHaveCount(2);
    await expect(
      page.getByText("2 of 15 saved pairs · 4 of 30 visible turns", {
        exact: false,
      }),
    ).toBeVisible();
    await page.goto(`/library/${id}/practice`);
    await expect(
      page.getByRole("button", { name: "Save private practice", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Try a private practice session" })
      .click();
    await page.getByLabel("I want to start private sample practice").check();
    await page
      .getByRole("button", { name: "Start or return to private session" })
      .click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    for (let sequence = 3; sequence <= 15; sequence++)
      await respond(
        page,
        `Invented ${goal} response ${sequence}: check the source.`,
      );
    await page.reload();
    await expect(page.locator("[data-practice-response]")).toHaveCount(15);
    await expect(page.locator("[data-practice-comparison]")).toHaveCount(15);
    await expect(page.getByRole("status")).toContainText(
      "15 pairs / 30 visible turns",
    );
    await expect(
      page.getByRole("button", { name: "Save response and compare" }),
    ).toHaveCount(0);
    const csrf = await page.locator('input[name="csrf"]').inputValue();
    const overCap = await page.request.post(`${path}/responses`, {
      headers: { Origin: origin },
      form: {
        csrf,
        expected_sequence: "16",
        response: "Invented extra response",
        synthetic: "yes",
      },
      maxRedirects: 0,
    });
    expect(overCap.status()).toBe(409);
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= innerWidth + 1),
    ).toBe(true);
  }
});
test("[L104] all three audiences retain owner-only exact sessions through goal and source changes", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  for (const [index, [background, goal]] of audiences.entries()) {
    const id = `PRAC-${(info.project.name === "desktop-chromium" ? 111 : 121) + index}`;
    const { publish, retire } = await syntheticLesson(id);
    await onboard(page, background, goal);
    const path = await start(page, id);
    const words = `Private invented ${background} session words`;
    await respond(page, words);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const other = await browser.newContext({ baseURL: origin });
    try {
      const otherPage = await other.newPage();
      await onboard(otherPage, background, goal);
      const otherCsrf = await otherPage
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const denied = await otherPage.goto(path);
      expect(denied!.status()).toBe(404);
      await expect(otherPage.getByText(words, { exact: true })).toHaveCount(0);
      expect(
        (
          await otherPage.request.post(`${path}/responses`, {
            headers: { Origin: origin },
            form: {
              csrf: otherCsrf,
              expected_sequence: "2",
              response: "Other invented response",
              synthetic: "yes",
            },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await page.request.post(`${path}/responses`, {
            headers: { Origin: origin },
            form: {
              csrf,
              expected_sequence: "2",
              response: "Forged owner response",
              synthetic: "yes",
              memberId: "forged",
            },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(422);
      await changeGoal(page, goal === "everyday" ? "work" : "everyday");
      await page.goto(path);
      await expect(page.getByRole("status")).toContainText(
        "Saved pairs are read-only",
      );
      await expect(page.getByText(words, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save response and compare" }),
      ).toHaveCount(0);
      await changeGoal(page, goal);
      await page.goto(path);
      await respond(page, `Restored invented ${background} goal`);
      await publish(2);
      await page.goto(path);
      await expect(page.getByRole("status")).toContainText(
        "Saved pairs are read-only",
      );
      await expect(page.locator("[data-practice-response]")).toHaveCount(2);
      expect(
        (
          await page.request.post(`${path}/responses`, {
            headers: { Origin: origin },
            form: {
              csrf,
              expected_sequence: "1",
              response: words,
              synthetic: "yes",
            },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(409);
      expect(await retire()).toBe(true);
      await page.reload();
      await expect(page.getByText(words, { exact: true })).toBeVisible();
      await page.goto("/practice-sessions");
      await page
        .getByRole("link", { name: new RegExp(`${id} · version 1`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      expect(
        await page
          .locator("body")
          .evaluate((el) => el.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    } finally {
      await other.close();
    }
  }
});
test("[L105] all three audiences export ordered session pairs and withdraw all text with keyboard confirmation", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const id = info.project.name === "desktop-chromium" ? "PRAC-131" : "PRAC-132";
  await syntheticLesson(id);
  for (const [background, goal] of audiences) {
    await onboard(page, background, goal);
    const path = await start(page, id),
      sessionId = path.split("/").at(-1)!;
    const first = `Withdraw invented ${background} first response`,
      second = `Withdraw invented ${background} second response`;
    await respond(page, first);
    await respond(page, second);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const before = await exported(page);
    expect(before.version).toBe("local-member-records-v17");
    expect(before.records.practiceSessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        contentId: id,
        contentVersion: 1,
        goalAtStart: goal,
        promptVersion: "practice-v1",
        state: "active",
      }),
    ]);
    expect(before.records.practiceExchanges).toEqual([
      expect.objectContaining({ sessionId, sequence: 1, response: first }),
      expect.objectContaining({ sessionId, sequence: 2, response: second }),
    ]);
    await page.getByRole("button", { name: "Withdraw session text" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    const confirmation = page.getByLabel(
      "Remove all response, comparison and source-excerpt text",
    );
    await confirmation.focus();
    await page.keyboard.press("Space");
    await expect(confirmation).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Withdraw session text" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Session withdrawn");
    await expect(page.getByText(first, { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-practice-comparison]")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("status")).toContainText("Session withdrawn");
    const after = await exported(page);
    expect(after.records.practiceSessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        state: "withdrawn",
        withdrawnAt: expect.any(String),
      }),
    ]);
    expect(after.records.practiceExchanges).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(first);
    expect(JSON.stringify(after)).not.toContain(second);
    expect(
      (
        await page.request.post(`${path}/responses`, {
          headers: { Origin: origin },
          form: {
            csrf,
            expected_sequence: "1",
            response: first,
            synthetic: "yes",
          },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await page.request.post(`${path}/withdraw`, {
          headers: { Origin: origin },
          form: { csrf, confirm: "yes" },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303);
    expect(
      (
        await page.request.post(`/library/${id}/practice-session/start`, {
          headers: { Origin: origin },
          form: {
            csrf,
            content_version: "1",
            goal,
            prompt_version: "practice-v1",
            synthetic: "yes",
          },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(409);
    await page.goto("/practice-sessions");
    await expect(
      page.getByText("response, comparison and excerpt text removed", {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= innerWidth + 1),
    ).toBe(true);
  }
});
