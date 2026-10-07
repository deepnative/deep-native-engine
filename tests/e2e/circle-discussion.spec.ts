import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const discussion = circleDiscussionStore(pool, "invented-browser-grant-secret");
test.afterAll(async () => pool.end());
const audiences = [
  ["explorer", "everyday", "everyday-ai", "Everyday AI practice"],
  ["professional", "work", "professional-work", "Clearer professional work"],
  ["technical", "build", "technical-practice", "Technical AI practice"],
] as const;
async function onboard(
  page: Page,
  origin: string,
  background: string,
  goal: string,
) {
  await page.goto(origin);
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await page.context().cookies()).find(
    (c) => c.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Invented browser member unavailable");
  return { token, id: session.learner.id };
}
async function sharing(page: Page, origin: string, circle: string) {
  await page.goto(`${origin}/circles/${circle}/discussion/choice`);
  await page
    .getByLabel(
      "I choose invented local discussion sharing under this exact circle policy.",
    )
    .check();
  await page
    .getByRole("button", { name: "Enable invented circle sharing" })
    .click();
}
async function erase(page: Page, origin: string) {
  await page.goto(`${origin}/learn`);
  await page.getByLabel("Delete my local preview").check();
  await page.getByRole("button", { name: "Delete this preview" }).click();
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
}
for (const [index, [background, goal, circle, title]] of audiences.entries()) {
  test(`[L${127 + index}] ${background} deliberately shares invented discussion, reports and observes scoped moderation while preserving owned withdrawal/export/erasure`, async ({
    page,
    browser,
  }, testInfo) => {
    const storage = await mkdtemp(join(tmpdir(), "dne443-e2e-"));
    let running: Awaited<ReturnType<typeof start>> | undefined;
    const contexts: BrowserContext[] = [];
    const ownerIds: string[] = [],
      staffIds: string[] = [];
    try {
      // An explicitly enabled isolated local listener preserves the default-off
      // existing preview and its already approved circle membership journeys.
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_PRIVATE_STORAGE_ROOT: storage,
        DNE_CIRCLE_DISCUSSION: "enabled",
      });
      const origin = running.origin,
        base = `${origin}/circles/${circle}/discussion`;
      const device =
        testInfo.project.name === "mobile-chromium"
          ? devices["Pixel 7"]!
          : devices["Desktop Chrome"]!;
      const peerContext = await browser.newContext(device);
      const moderatorContext = await browser.newContext(device);
      contexts.push(peerContext, moderatorContext);
      const peer = await peerContext.newPage(),
        moderator = await moderatorContext.newPage();
      const a = await onboard(page, origin, background, goal);
      ownerIds.push(a.id);
      const b = await onboard(peer, origin, background, goal);
      ownerIds.push(b.id);
      const privateText =
        "Invented private starter text must never appear in a discussion";
      expect(
        await members.save(a.id, {
          instruction: privateText,
          verification: "Private invented check",
          complete: false,
          goal,
        }),
      ).toBe("saved");
      for (const participant of [page, peer]) {
        await participant.goto(`${origin}/circles`);
        await participant
          .getByRole("button", { name: `Join ${title}`, exact: true })
          .click();
        expect((await participant.goto(base))?.status()).toBe(403);
        await sharing(participant, origin, circle);
        await participant.goto(base);
        expect(
          await participant.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(participant.locator("body")).not.toContainText(
          privateText,
        );
      }
      const question = `Invented ${background} question <script>window.circleLeak=true</script>`;
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
      expect(
        await page.evaluate(() => Object.hasOwn(window, "circleLeak")),
      ).toBe(false);
      await peer.goto(base);
      await peer
        .getByRole("link", { name: "Open question and replies" })
        .click();
      const thread = peer.url();
      const reply = `Invented ${background} peer reply`;
      await peer
        .getByLabel("Your invented reply (up to 2,000 characters)")
        .fill(reply);
      await peer
        .getByLabel(
          "I used only invented information and choose to share it with this circle.",
        )
        .check();
      const replyButton = peer.getByRole("button", {
        name: "Share reply",
        exact: true,
      });
      await expect(peer.locator("body")).not.toContainText(privateText);
      expect(
        await peer.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await replyButton.scrollIntoViewIfNeeded();
      await replyButton.click();
      await peer.goto(thread);
      await expect(peer.locator("pre.content-text")).toHaveText([
        question,
        reply,
      ]);
      const rootArticle = peer.locator("article").filter({ hasText: question });
      await rootArticle
        .getByLabel("Report this exact invented contribution")
        .selectOption("privacy");
      await rootArticle
        .getByRole("button", { name: "Save private sample report" })
        .click();
      await peer
        .getByRole("link", { name: "Open your durable sample receipt" })
        .click();
      const receipt = peer.url();
      await expect(peer.getByRole("status")).toContainText(
        "Sample report retained",
      );
      await page.goto(`${base}/reports`);
      await expect(page.locator("body")).toContainText("No own sample reports");
      expect(
        (
          await page.goto(`${origin}/moderate/circles/${circle}/reports`)
        )?.status(),
      ).toBe(403);
      const adminToken = randomBytes(32).toString("hex"),
        modToken = randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 3600000);
      const adminId = await auth.provisionStaff(
        adminToken,
        "platform_admin",
        expiry,
      );
      const modId = await auth.provisionStaff(modToken, "moderator", expiry);
      staffIds.push(adminId, modId);
      await moderatorContext.addCookies([
        {
          name: COOKIE,
          value: modToken,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const queue = `${origin}/moderate/circles/${circle}/reports`;
      expect((await moderator.goto(queue))?.status()).toBe(403);
      const granted = await discussion.grantModerator(
        adminToken,
        modId,
        circle,
        randomUUID(),
        new Date(Date.now() + 600000),
      );
      expect(granted.kind).toBe("ready");
      await moderator.goto(queue);
      expect(
        await moderator.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(moderator.locator("pre.content-text")).toHaveText(question);
      await expect(moderator.locator("body")).not.toContainText(b.id);
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await peer.goto(base);
      await expect(peer.locator("pre.content-text")).toHaveCount(0);
      await peer.goto(receipt);
      await expect(peer.getByRole("status")).toContainText(
        "Sample target hidden",
      );
      await moderator.goto(queue);
      await moderator
        .getByRole("button", { name: "Restore invented contribution" })
        .click();
      await peer.goto(thread);
      await expect(peer.locator("pre.content-text")).toHaveText([
        question,
        reply,
      ]);
      await page.goto(`${base}/owned`);
      await page
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await page.getByRole("button", { name: "Withdraw contribution" }).click();
      expect((await peer.goto(thread))?.status()).toBe(403);
      await peer.goto(`${base}/owned`);
      await expect(peer.locator("pre.content-text")).toHaveText(reply);
      await expect(peer.locator("body")).not.toContainText(question);
      await moderator.goto(queue);
      await expect(moderator.locator("body")).toContainText(
        "Target unavailable",
      );
      await expect(
        moderator.getByRole("button", {
          name: "Restore invented contribution",
        }),
      ).toHaveCount(0);
      await peer.goto(`${origin}/circles`);
      await peer
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      await peer.goto(`${base}/owned`);
      await expect(peer.locator("pre.content-text")).toHaveText(reply);
      await peer.goto(`${origin}/circles`);
      await peer
        .getByRole("button", { name: `Join ${title}`, exact: true })
        .click();
      await sharing(peer, origin, circle);
      await peer.goto(base);
      await expect(peer.locator("pre.content-text")).toHaveCount(0);
      const exported = await (
        await peer.request.get(`${origin}/api/member/export`)
      ).json();
      expect(exported.version).toBe("local-member-records-v24");
      expect(
        exported.records.circlePosts.map((row: { body: string }) => row.body),
      ).toEqual([reply]);
      expect(JSON.stringify(exported.records.circlePosts)).not.toContain(
        question,
      );
      await peer.goto(`${base}/owned`);
      await peer
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await peer.getByRole("button", { name: "Withdraw contribution" }).click();
      await expect(peer.locator("pre.content-text")).toHaveCount(0);
      await expect(peer.locator("body")).toContainText("Text withdrawn");
      await erase(page, origin);
      expect(
        (
          await pool.query(
            "SELECT id FROM preview_circle_posts WHERE member_id=$1",
            [a.id],
          )
        ).rowCount,
      ).toBe(0);
      await peer.goto(receipt);
      await expect(peer.getByRole("status")).toContainText(
        "Target unavailable",
      );
      const after = await (
        await peer.request.get(`${origin}/api/member/export`)
      ).json();
      expect(after.records.circlePosts).toHaveLength(1);
      expect(after.records.circlePosts[0].body).toBeNull();
      await erase(peer, origin);
      expect(
        (
          await pool.query(
            "SELECT id FROM preview_circle_reports WHERE member_id=$1",
            [b.id],
          )
        ).rowCount,
      ).toBe(0);
      if (granted.kind !== "ready") throw Error("Missing scope receipt");
      expect(
        (await discussion.revokeModerator(adminToken, circle, granted.value.id))
          .kind,
      ).toBe("ready");
      expect((await moderator.goto(queue))?.status()).toBe(403);
      expect(
        await moderator.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      try {
        // The primary fixture context also owns speculative connections. Close
        // every browser client before awaiting graceful listener shutdown; on
        // Node24 an unparsed preconnection can otherwise retain server.close().
        await Promise.all([
          page.context().close(),
          ...contexts.map((context) => context.close()),
        ]);
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
  });
}
