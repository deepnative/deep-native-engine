import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
const members = store(pool);
const auth = authorizationStore(pool);
const discussion = circleDiscussionStore(pool, "invented-browser-grant-secret");
test.afterAll(async () => pool.end());

const circle = "everyday-ai";
const title = "Everyday AI practice";
const otherCircle = "professional-work";

type Harness = {
  origin: string;
  base: string;
  contexts: BrowserContext[];
  newPage(): Promise<Page>;
  ownerIds: string[];
  staffIds: string[];
};

// Discussion is default-off, so each journey runs its own explicitly enabled
// listener against the same disposable database. All clients close before the
// listener shuts down, because an unparsed preconnection can hold server.close().
async function withDiscussion(
  browser: Browser,
  info: TestInfo,
  journey: (harness: Harness) => Promise<void>,
) {
  const storage = await mkdtemp(join(tmpdir(), "dne94-e2e-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const contexts: BrowserContext[] = [];
  const ownerIds: string[] = [];
  const staffIds: string[] = [];
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_CIRCLE_DISCUSSION: "enabled",
    });
    const origin = running.origin;
    const device =
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]!
        : devices["Desktop Chrome"]!;
    await journey({
      origin,
      base: `${origin}/circles/${circle}/discussion`,
      contexts,
      ownerIds,
      staffIds,
      async newPage() {
        const context = await browser.newContext(device);
        contexts.push(context);
        return context.newPage();
      },
    });
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } finally {
      try {
        if (running) await running.close();
      } finally {
        for (const id of ownerIds) await members.remove(id);
        for (const id of staffIds)
          await pool.query("DELETE FROM principals WHERE id=$1", [id]);
        await rm(storage, { recursive: true, force: true });
      }
    }
  }
}

async function onboard(page: Page, harness: Harness) {
  await page.goto(harness.origin);
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await chooseLearningGoal(page, "everyday");
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  const token = (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  harness.ownerIds.push(session.learner.id);
  return { token, id: session.learner.id };
}

async function joinAndShare(page: Page, harness: Harness) {
  await page.goto(`${harness.origin}/circles`);
  await page
    .getByRole("button", { name: `Join ${title}`, exact: true })
    .click();
  await page.goto(`${harness.base}/choice`);
  await page
    .getByLabel(
      "I choose invented local discussion sharing under this exact circle policy.",
    )
    .check();
  await page
    .getByRole("button", { name: "Enable invented circle sharing" })
    .click();
  await page.goto(harness.base);
}

async function askQuestion(page: Page, harness: Harness, question: string) {
  await page.goto(harness.base);
  await page
    .getByLabel("Your invented question (up to 2,000 characters)")
    .fill(question);
  await page
    .getByLabel(
      "I used only invented information and choose to share it with this circle.",
    )
    .check();
  await page
    .getByRole("button", { name: "Share question", exact: true })
    .click();
  await expect(page.locator("pre.content-text")).toHaveText(question);
}

async function replyInThread(page: Page, harness: Harness, reply: string) {
  await page.goto(harness.base);
  await page.getByRole("link", { name: "Open question and replies" }).click();
  const thread = page.url();
  await page
    .getByLabel("Your invented reply (up to 2,000 characters)")
    .fill(reply);
  await page
    .getByLabel(
      "I used only invented information and choose to share it with this circle.",
    )
    .check();
  await page.getByRole("button", { name: "Share reply", exact: true }).click();
  return thread;
}

async function postRow(body: string) {
  const rows = await pool.query<{
    id: string;
    state: string;
    revision: number;
  }>("SELECT id,state,revision FROM preview_circle_posts WHERE body=$1", [
    body,
  ]);
  expect(rows.rowCount).toBe(1);
  return rows.rows[0]!;
}

async function audit(postId: string) {
  return (
    await pool.query(
      `SELECT actor_id,action,reason,circle_id FROM preview_circle_moderation_audit
       WHERE post_id=$1 ORDER BY new_revision`,
      [postId],
    )
  ).rows;
}

const csrfOf = (page: Page) =>
  page.locator('input[name="csrf"]').first().inputValue();

async function publishAssignment(id: string, assignmentTitle: string) {
  const expiry = new Date(Date.now() + 3_600_000);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: assignmentTitle,
    body: "Use invented details and check the outcome against this brief.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: "Compare the answer with the source.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
  return () => catalog.retire(editor, id);
}

test("[F-ECO-04-B] circle participation, reporting and accountable scoped moderation deny everyone else", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  let retire: (() => Promise<boolean>) | undefined;
  await withDiscussion(browser, info, async (harness) => {
    const { origin, base } = harness;
    const run = randomBytes(6).toString("hex");
    const question = `Invented question needing moderation ${run}`;
    const reply = `Invented peer reply ${run}`;
    const privateText = `Invented private starter text ${run}`;
    const privateAnswer = `Invented private assignment answer ${run}`;
    const assignmentTitle = `Invented moderation boundary assignment ${run}`;
    const assignmentId =
      info.project.name === "mobile-chromium" ? "ECB-402" : "ECB-401";
    retire = await publishAssignment(assignmentId, assignmentTitle);

    const author = await harness.newPage();
    const peer = await harness.newPage();
    const outsider = await harness.newPage();
    const moderator = await harness.newPage();
    const authorIdentity = await onboard(author, harness);
    const peerIdentity = await onboard(peer, harness);
    const outsiderIdentity = await onboard(outsider, harness);

    // Unrelated private work the author owns and never shared.
    expect(
      await members.save(authorIdentity.token, {
        revision: 0,
        instruction: privateText,
        verification: "Private invented check",
        complete: false,
        goal: "everyday",
      }),
    ).toBe("saved");
    await author.goto(`${origin}/learn`);
    const choices = author.getByRole("region", {
      name: "Choose a practice assignment",
    });
    await choices
      .getByRole("button", { name: `Choose ${assignmentTitle}` })
      .click();
    await choices
      .getByRole("button", { name: "Start or return to this private attempt" })
      .click();
    const attemptPath = new URL(author.url()).pathname;
    await author.getByLabel("Private sample response").fill(privateAnswer);
    await author
      .getByLabel("I used only invented or sample information")
      .check();
    await author.getByRole("button", { name: "Save private draft" }).click();
    await expect(author.getByLabel("Private sample response")).toHaveValue(
      privateAnswer,
    );

    const adminToken = randomBytes(32).toString("hex");
    const moderatorToken = randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 3_600_000);
    const adminId = await auth.provisionStaff(
      adminToken,
      "platform_admin",
      expiry,
    );
    const moderatorId = await auth.provisionStaff(
      moderatorToken,
      "moderator",
      expiry,
    );
    harness.staffIds.push(adminId, moderatorId);
    await moderator.context().addCookies([
      {
        name: COOKIE,
        value: moderatorToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const queue = `${origin}/moderate/circles/${circle}/reports`;
    let questionId = "";
    let thread = "";
    let grantId = "";

    await requiredCheck(1, async () => {
      // A member who has not joined and chosen sharing can neither read nor post.
      expect((await outsider.goto(base))?.status()).toBe(403);
      await outsider.goto(`${origin}/circles`);
      const denied = await outsider.request.post(`${base}/posts`, {
        headers: { Origin: origin },
        form: {
          csrf: await csrfOf(outsider),
          idempotencyKey: randomUUID(),
          body: `Invented outsider post ${run}`,
          confirm: "yes",
        },
      });
      expect(denied.status()).toBe(403);
      expect(
        (
          await pool.query(
            "SELECT id FROM preview_circle_posts WHERE member_id=$1",
            [outsiderIdentity.id],
          )
        ).rowCount,
      ).toBe(0);

      await joinAndShare(author, harness);
      await joinAndShare(peer, harness);
      await askQuestion(author, harness, question);
      thread = await replyInThread(peer, harness, reply);
      await peer.goto(thread);
      await expect(peer.locator("pre.content-text")).toHaveText([
        question,
        reply,
      ]);
      // Private work is never drawn into the circle.
      for (const secret of [privateText, privateAnswer])
        await expect(peer.locator("body")).not.toContainText(secret);
      questionId = (await postRow(question)).id;
      expect((await postRow(reply)).state).toBe("visible");
    });

    await requiredCheck(2, async () => {
      const article = peer.locator("article").filter({ hasText: question });
      await article
        .getByLabel("Report this exact invented contribution")
        .selectOption("privacy");
      await article
        .getByRole("button", { name: "Save private sample report" })
        .click();
      await expect(
        peer.getByRole("link", { name: "Open your durable sample receipt" }),
      ).toBeVisible();

      // A moderator role alone sees nothing until an exact circle grant exists.
      expect((await moderator.goto(queue))?.status()).toBe(403);
      const granted = await discussion.grantModerator(
        adminToken,
        moderatorId,
        circle,
        randomUUID(),
        new Date(Date.now() + 600_000),
      );
      if (granted.kind !== "ready") throw Error("Missing moderator grant");
      grantId = granted.value.id;

      await moderator.goto(queue);
      await expect(moderator.locator("pre.content-text")).toHaveText(question);
      const body = moderator.locator("body");
      for (const secret of [
        privateText,
        privateAnswer,
        peerIdentity.id,
        authorIdentity.id,
      ])
        await expect(body).not.toContainText(secret);
    });

    await requiredCheck(3, async () => {
      // The grant does not reach another circle or unrelated private work.
      expect(
        (
          await moderator.goto(
            `${origin}/moderate/circles/${otherCircle}/reports`,
          )
        )?.status(),
      ).toBe(403);
      const attempt = await moderator.request.get(`${origin}${attemptPath}`, {
        maxRedirects: 0,
      });
      expect(attempt.status()).toBe(303);
      expect(attempt.headers().location).toBe("/learn#assignment-options");
      expect(await attempt.text()).not.toContain(privateAnswer);
      await moderator.goto(`${origin}${attemptPath}`);
      expect(new URL(moderator.url()).pathname).not.toBe(attemptPath);
      for (const secret of [privateAnswer, assignmentTitle])
        await expect(moderator.locator("body")).not.toContainText(secret);
      const list = await moderator.goto(`${origin}/assignments/attempts`);
      await expect(moderator.locator("body")).not.toContainText(privateAnswer);
      expect(list?.status()).not.toBe(500);

      await moderator.goto(queue);
      await moderator
        .getByLabel("Synthetic decision reason")
        .selectOption("privacy");
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await peer.goto(base);
      await expect(peer.locator("body")).not.toContainText(question);
      expect((await postRow(question)).state).toBe("hidden");
      expect(await audit(questionId)).toEqual([
        {
          actor_id: moderatorId,
          action: "hidden",
          reason: "privacy",
          circle_id: circle,
        },
      ]);
      // Only the reported question moved; the peer's reply did not.
      expect((await postRow(reply)).state).toBe("visible");

      await moderator.goto(queue);
      await moderator
        .getByLabel("Synthetic decision reason")
        .selectOption("test_correction");
      await moderator
        .getByRole("button", { name: "Restore invented contribution" })
        .click();
      expect((await postRow(question)).state).toBe("visible");
      expect(await audit(questionId)).toHaveLength(2);
    });

    // Each denied attempt tries to hide the visible question with valid fields.
    const attemptHide = async (actor: Page, csrfPath: string) => {
      const before = await postRow(question);
      const auditBefore = await audit(questionId);
      await actor.goto(`${origin}${csrfPath}`);
      const response = await actor.request.post(
        `${origin}/moderate/circles/${circle}/posts/${questionId}`,
        {
          headers: { Origin: origin },
          form: {
            csrf: await csrfOf(actor),
            idempotencyKey: randomUUID(),
            expectedRevision: String(before.revision),
            action: "hide",
            reason: "conduct",
          },
          maxRedirects: 0,
        },
      );
      expect(response.status()).toBe(403);
      const text = await response.text();
      expect(text).not.toContain(privateAnswer);
      expect(text).not.toContain(privateText);
      expect(await postRow(question)).toEqual(before);
      expect(await audit(questionId)).toEqual(auditBefore);
      expect((await actor.goto(queue))?.status()).toBe(403);
    };

    await requiredCheck(4, async () => {
      await attemptHide(outsider, "/circles");
    });

    await requiredCheck(5, async () => {
      await attemptHide(peer, "/circles");
    });

    await requiredCheck(6, async () => {
      // Taken before revocation, so the form is one the moderator really held.
      await moderator.goto(queue);
      const csrf = await csrfOf(moderator);
      const before = await postRow(question);
      const auditBefore = await audit(questionId);
      expect(
        (await discussion.revokeModerator(adminToken, circle, grantId)).kind,
      ).toBe("ready");
      const response = await moderator.request.post(
        `${origin}/moderate/circles/${circle}/posts/${questionId}`,
        {
          headers: { Origin: origin },
          form: {
            csrf,
            idempotencyKey: randomUUID(),
            expectedRevision: String(before.revision),
            action: "hide",
            reason: "conduct",
          },
          maxRedirects: 0,
        },
      );
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain(question);
      expect(await postRow(question)).toEqual(before);
      expect(await audit(questionId)).toEqual(auditBefore);
      expect((await moderator.goto(queue))?.status()).toBe(403);
      await expect(moderator.locator("body")).not.toContainText(question);
    });
  }).finally(async () => {
    // Later journeys count the assignments offered to this audience.
    await retire?.();
  });
});

test("[F-ECO-04-C] leaving a circle revokes membership and replaying its content is denied", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  await withDiscussion(browser, info, async (harness) => {
    const { origin, base } = harness;
    const run = randomBytes(6).toString("hex");
    const question = `Invented question from the remaining member ${run}`;
    const reply = `Invented reply from the leaving member ${run}`;
    const stay = await harness.newPage();
    const leaver = await harness.newPage();
    await onboard(stay, harness);
    const leaverIdentity = await onboard(leaver, harness);
    await joinAndShare(stay, harness);
    await joinAndShare(leaver, harness);
    await askQuestion(stay, harness, question);
    const thread = await replyInThread(leaver, harness, reply);
    await leaver.goto(thread);
    await expect(leaver.locator("pre.content-text")).toHaveText([
      question,
      reply,
    ]);
    const form = {
      csrf: await csrfOf(leaver),
      rootId: (await postRow(question)).id,
    };

    await requiredCheck(1, async () => {
      await leaver.goto(`${origin}/circles`);
      await leaver
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      await expect(
        leaver.getByRole("button", { name: `Join ${title}`, exact: true }),
      ).toBeVisible();
      const membership = await pool.query<{ left_at: Date | null }>(
        "SELECT left_at FROM preview_circle_memberships WHERE member_id=$1 AND circle_id=$2",
        [leaverIdentity.id, circle],
      );
      expect(membership.rowCount).toBe(1);
      expect(membership.rows[0]!.left_at).not.toBeNull();
    });

    await requiredCheck(2, async () => {
      // Every saved address is refused and shows no group content.
      for (const path of [base, thread]) {
        expect((await leaver.goto(path))?.status()).toBe(403);
        const body = leaver.locator("body");
        await expect(body).not.toContainText(question);
      }
      // Replaying the old reply form creates nothing.
      const posts = async () =>
        (
          await pool.query(
            "SELECT id FROM preview_circle_posts WHERE member_id=$1",
            [leaverIdentity.id],
          )
        ).rowCount;
      const before = await posts();
      await leaver.goto(`${origin}/circles`);
      const replay = await leaver.request.post(`${base}/posts`, {
        headers: { Origin: origin },
        form: {
          csrf: form.csrf,
          rootId: form.rootId,
          idempotencyKey: randomUUID(),
          body: `Invented replay after leaving ${run}`,
          confirm: "yes",
        },
        maxRedirects: 0,
      });
      expect(replay.status()).toBe(403);
      expect(await posts()).toBe(before);

      // The documented retained scope is the member's own contribution only.
      await leaver.goto(`${base}/owned`);
      await expect(leaver.locator("pre.content-text")).toHaveText(reply);
      await expect(leaver.locator("body")).not.toContainText(question);

      // Rejoining does not silently restore the earlier sharing choice.
      await leaver.goto(`${origin}/circles`);
      await leaver
        .getByRole("button", { name: `Join ${title}`, exact: true })
        .click();
      expect((await leaver.goto(thread))?.status()).toBe(403);
      await expect(leaver.locator("body")).not.toContainText(question);

      // The remaining member keeps access to the circle.
      await stay.goto(base);
      await expect(stay.locator("body")).toContainText(question);
    });
  });
});
