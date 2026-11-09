import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import {
  aiMember,
  aiOrigin,
  grantStudyRequests,
  memberJobs,
  permitSample,
  signIn,
  studyBalance,
} from "../support/local-ai-journey.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

const insufficient = "there is insufficient evidence for formal assessment";

function lessonId() {
  const letters = Array.from(randomBytes(3), (byte) =>
    String.fromCharCode(65 + (byte % 26)),
  ).join("");
  const number = String(randomBytes(2).readUInt16BE() % 1000).padStart(3, "0");
  return `PG${letters}-${number}`;
}

async function publishers() {
  const auth = authorizationStore(pool);
  const editor = randomBytes(32).toString("hex"),
    reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 3_600_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  return { editor, reviewer };
}

function lesson(body: string, goals: DraftContent["goals"] = []): DraftContent {
  const id = lessonId();
  return {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: `Invented practice source ${id}`,
    body,
    owner: "Synthetic editor",
    sources: "Original invented sample",
    rights: "Owned sample",
    goals,
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
}

async function publish(draft: DraftContent) {
  const staff = await publishers();
  const catalog = catalogStore(pool);
  expect(await catalog.createDraft(staff.editor, draft)).toBe(true);
  expect(await catalog.submit(staff.editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(staff.reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(staff.editor, draft.id, 1)).toBe(true);
  return { ...staff, retire: () => catalog.retire(staff.editor, draft.id) };
}

async function startSession(page: Page, id: string) {
  await page.goto(`/library/${id}/practice-session`);
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
}

async function respond(page: Page, response: string) {
  await page.getByLabel("Your next sample response").fill(response);
  await page
    .getByLabel(
      "I used only invented or sample information and want to save this response.",
    )
    .check();
  const saved = page.locator("[data-practice-response]");
  const expected = (await saved.count()) + 1;
  await page.getByRole("button", { name: "Save response and compare" }).click();
  await expect(saved).toHaveCount(expected);
  return page.locator("[data-practice-comparison]").last();
}

const sessions = async (memberId: string) =>
  (
    await pool.query(
      "SELECT content_id FROM private_practice_sessions WHERE member_id=$1",
      [memberId],
    )
  ).rows;

test("[F-ECO-06-B] nothing runs before opting in and the comparison cites its allowed source", async ({
  page,
}) => {
  const allowed = lesson(
    `Check every invented claim against the supplied agenda ${randomBytes(4).toString("hex")}.`,
  );
  const unrelated = lesson(
    `A separate lesson nobody selected ${randomBytes(4).toString("hex")}.`,
  );
  await publish(allowed);
  await publish(unrelated);
  const member = await aiMember(pool);
  await signIn(page, member.token);

  await requiredCheck(1, async () => {
    await page.goto(`/library/${allowed.id}/practice-session`);
    await expect(page.locator("body")).toContainText("No live AI provider");
    const form = page.locator(
      `form[action$="/practice-session/start"][data-practice-purpose="lesson"]`,
    );
    const fields: Record<string, string> = {};
    for (const name of ["csrf", "content_version", "goal", "prompt_version"])
      fields[name] = await form.locator(`[name="${name}"]`).inputValue();
    // The same form, sent without the opt-in, starts nothing.
    const refused = await page.request.post(
      `/library/${allowed.id}/practice-session/start`,
      { headers: { Origin: aiOrigin }, form: fields, maxRedirects: 0 },
    );
    expect(refused.status()).toBe(422);
    expect(await sessions(member.id)).toEqual([]);
    expect(await memberJobs(pool, member.id)).toEqual([]);

    await startSession(page, allowed.id);
    expect(await sessions(member.id)).toEqual([{ content_id: allowed.id }]);
    // Opting in reaches no provider, because none is connected.
    expect(await memberJobs(pool, member.id)).toEqual([]);
  });

  await requiredCheck(2, async () => {
    const comparison = await respond(
      page,
      "I would check one invented claim against the agenda.",
    );
    await expect(comparison).toContainText(
      `Exact source excerpt (${allowed.id} v1): “${allowed.body}”`,
    );
    await expect(comparison).toContainText("Simulation — unreviewed");
    await expect(
      page.getByRole("heading", {
        name: `Exact source excerpt · ${allowed.id} · version 1`,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(unrelated.body);
    await expect(page.locator("body")).toContainText(
      "No live AI provider, paid allowance or qualified reviewer is connected.",
    );
  });
});

test("[F-BUILD-06-A] each comparison quotes the member's own response and nothing invented", async ({
  page,
  browser,
}) => {
  const source = lesson(
    `Compare invented interview answers with the brief ${randomBytes(4).toString("hex")}.`,
  );
  await publish(source);
  const run = randomBytes(4).toString("hex");
  const first = `In the invented interview I named two risks ${run}.`;
  const second = `I then explained which invented risk I would test first ${run}.`;
  const foreign = `Another member's invented answer ${run}.`;

  // Another member's answer exists on the same source.
  const other = await aiMember(pool);
  const otherContext = await browser.newContext({ baseURL: aiOrigin });
  try {
    const otherPage = await otherContext.newPage();
    await signIn(otherPage, other.token);
    await startSession(otherPage, source.id);
    await respond(otherPage, foreign);
  } finally {
    await otherContext.close();
  }

  const member = await aiMember(pool);
  await signIn(page, member.token);
  await requiredCheck(1, async () => {
    await startSession(page, source.id);
    const pairOne = await respond(page, first);
    await expect(pairOne).toContainText(`Your paired words: “${first}”`);
    const pairTwo = await respond(page, second);
    await expect(pairTwo).toContainText(`Your paired words: “${second}”`);
    // A comparison holds its own response and the source: not the other pair.
    await expect(pairTwo).not.toContainText(first);
    await expect(
      page.locator("[data-practice-comparison]").first(),
    ).not.toContainText(second);
    await expect(page.locator("body")).not.toContainText(foreign);
    await expect(pairTwo).toContainText("does not verify accuracy");

    const stored = await pool.query<{ response: string; comparison: string }>(
      `SELECT e.response,e.comparison FROM private_practice_exchanges e
       JOIN private_practice_sessions s ON s.id=e.session_id
       WHERE s.member_id=$1 ORDER BY e.sequence`,
      [member.id],
    );
    expect(stored.rows.map((row) => row.response)).toEqual([first, second]);
    for (const row of stored.rows)
      expect(row.comparison).toContain(`“${row.response}”`);
  });
});

test("[F-BUILD-06-B] a very short response is told the evidence is insufficient", async ({
  page,
}) => {
  const source = lesson(
    `Check one invented claim ${randomBytes(4).toString("hex")}.`,
  );
  await publish(source);
  const member = await aiMember(pool);
  await signIn(page, member.token);
  await requiredCheck(1, async () => {
    await startSession(page, source.id);
    const comparison = await respond(page, "ok");
    await expect(page.locator("body")).toContainText(insufficient);
    await expect(comparison).toContainText("cannot judge competence");
    await expect(comparison).toContainText("Uncertainty remains");
    await expect(page.locator("body")).not.toContainText(
      /\b(you passed|well done|competent)\b/i,
    );
  });
});

test("[F-ROADMAP-05-D] sparse answers, disallowed sources and a spent budget all stop honestly", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const run = randomBytes(4).toString("hex");
  const allowed = lesson(`Allowed invented source ${run}.`);
  const otherGoal = lesson(`Disallowed goal source ${run}.`, ["build"]);
  const retired = lesson(`Retired invented source ${run}.`);
  const unpublished = lesson(`Unpublished invented source ${run}.`);
  await publish(allowed);
  await publish(otherGoal);
  const retiring = await publish(retired);
  const draftStaff = await publishers();
  expect(
    await catalogStore(pool).createDraft(draftStaff.editor, unpublished),
  ).toBe(true);
  const member = await aiMember(pool);
  await signIn(page, member.token);

  await requiredCheck(1, async () => {
    await startSession(page, allowed.id);
    await respond(page, "ok");
    await expect(page.locator("body")).toContainText(insufficient);
  });

  await requiredCheck(2, async () => {
    await startSession(page, retired.id);
    const sessionUrl = page.url();
    expect(await retiring.retire()).toBe(true);
    const before = await sessions(member.id);
    for (const [draft, body] of [
      [otherGoal, otherGoal.body],
      [retired, retired.body],
      [unpublished, unpublished.body],
    ] as const) {
      const opened = await page.goto(`/library/${draft.id}/practice-session`);
      expect(opened!.status()).toBe(404);
      await expect(page.locator("body")).not.toContainText(body);
    }
    expect(await sessions(member.id)).toEqual(before);

    // Practice already started on the retired source can't take a new comparison.
    await page.goto(sessionUrl);
    await expect(page.getByLabel("Your next sample response")).toHaveCount(0);

    // Output for the allowed source holds that source only.
    await startSession(page, allowed.id);
    const comparison = page.locator("[data-practice-comparison]").last();
    await expect(comparison).toContainText(allowed.body);
    await expect(page.locator("body")).not.toContainText(otherGoal.body);
    await expect(page.locator("body")).not.toContainText(unpublished.body);
  });

  await requiredCheck(3, async () => {
    const grantId = await grantStudyRequests(pool, member.id, 1);
    await page.goto("/evidence/local-ai");
    const spent = await permitSample(pool, page);
    await expect(spent.item).toContainText("Estimate only");
    await spent.item.getByLabel("Hold one existing local test request").check();
    await spent.item
      .getByRole("button", { name: "Use one local test request" })
      .click();
    await spent.item
      .getByRole("button", { name: "Run local test request" })
      .click();
    await expect(
      spent.item.getByText("One local test request: consumed."),
    ).toBeVisible();
    await expect(spent.item).toContainText("Actual simulated use");
    const spentBalance = { available: 0, reserved: 0, consumed: 1 };
    expect(await studyBalance(pool, grantId)).toEqual(spentBalance);
    const jobs = await memberJobs(pool, member.id);

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
    expect(await studyBalance(pool, grantId)).toEqual(spentBalance);
    expect(await memberJobs(pool, member.id)).toEqual(jobs);

    // The way forward the page names is real: the balance reads as spent.
    await page.goto("/member/test-units");
    const units = page.locator('[data-test-unit-category="study_requests"]');
    await expect(units.locator('[data-field="usable"]')).toHaveText("0");
    await expect(units.locator('[data-field="consumed"]')).toHaveText("1");
  });
});
