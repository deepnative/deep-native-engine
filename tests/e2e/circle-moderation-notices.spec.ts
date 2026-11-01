import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { circleDiscussionStore } from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

// Finite invented staff credentials are entered only in password fields and are
// never retained in a network trace or capture.
test.use({ trace: "off" });
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const discussion = circleDiscussionStore(
  pool,
  "invented-notice-browser-fixture",
);
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
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(origin + "/learn");
  const token = (await page.context().cookies()).find(
    (c) => c.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Missing invented member");
  return { token, id: session.learner.id };
}
for (const [index, [background, goal, circle, title]] of audiences.entries()) {
  test(`[L${245 + index}] MODN-01..05 ${background} inspects and downloads an own moderation notice while retaining private withdrawal and erasure`, async ({
    page,
    browser,
  }, info) => {
    const storage = await mkdtemp(join(tmpdir(), "dne196-browser-"));
    let running: Awaited<ReturnType<typeof start>> | undefined;
    const contexts: BrowserContext[] = [],
      ownerIds: string[] = [],
      staffIds: string[] = [];
    try {
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_PRIVATE_STORAGE_ROOT: storage,
        DNE_CIRCLE_DISCUSSION: "enabled",
        DNE_LOCAL_STAFF_ENTRY: "enabled",
      });
      const origin = running.origin,
        base = `${origin}/circles/${circle}/discussion`;
      const device =
        info.project.name === "mobile-chromium"
          ? devices["Pixel 7"]!
          : devices["Desktop Chrome"]!;
      const peerContext = await browser.newContext(device),
        modContext = await browser.newContext(device);
      contexts.push(peerContext, modContext);
      const peer = await peerContext.newPage(),
        moderator = await modContext.newPage();
      const owner = await onboard(page, origin, background, goal),
        other = await onboard(peer, origin, background, goal);
      ownerIds.push(owner.id, other.id);
      for (const actor of [page, peer]) {
        await actor.goto(origin + "/circles");
        await actor
          .getByRole("button", { name: `Join ${title}`, exact: true })
          .click();
        await actor.goto(base + "/choice");
        await actor
          .getByLabel(
            "I choose invented local discussion sharing under this exact circle policy.",
          )
          .check();
        await actor
          .getByRole("button", { name: "Enable invented circle sharing" })
          .click();
      }
      const body = `Invented ${background} circle question: do not copy this contribution body into a decision receipt.`;
      await page.goto(base);
      await page
        .getByLabel("Your invented question (up to 2,000 characters)")
        .fill(body);
      await page
        .getByLabel(
          "I used only invented information and choose to share it with this circle.",
        )
        .check();
      await page
        .getByRole("button", { name: "Share question", exact: true })
        .click();
      await expect(page).toHaveURL(base + "/owned");
      await page
        .getByRole("link", {
          name: "Inspect this contribution's moderation notice",
        })
        .click();
      await expect(
        page.getByText(
          "No moderation decision is recorded for this contribution.",
        ),
      ).toBeVisible();
      const noticeUrl = page.url();
      await peer.goto(base);
      await peer
        .getByRole("link", { name: "Open question and replies" })
        .click();
      await peer
        .getByLabel("Report this exact invented contribution")
        .selectOption("privacy");
      await peer
        .getByRole("button", { name: "Save private sample report" })
        .click();
      const adminToken = randomBytes(32).toString("hex"),
        modToken = randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 3600000);
      staffIds.push(
        await auth.provisionStaff(adminToken, "platform_admin", expiry),
      );
      const modId = await auth.provisionStaff(modToken, "moderator", expiry);
      staffIds.push(modId);
      expect(
        (
          await discussion.grantModerator(
            adminToken,
            modId,
            circle,
            randomUUID(),
            new Date(Date.now() + 600000),
          )
        ).kind,
      ).toBe("ready");
      await moderator.goto(origin + "/staff/sign-in");
      await moderator
        .getByLabel("Trusted local staff credential")
        .fill(modToken);
      await moderator
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      const queue = `${origin}/moderate/circles/${circle}/reports`;
      await moderator.goto(queue);
      await moderator
        .getByLabel("Synthetic decision reason")
        .selectOption("privacy");
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await expect(moderator).toHaveURL(queue);
      await expect(
        moderator.getByRole("button", {
          name: "Restore invented contribution",
        }),
      ).toBeVisible();
      await page.goto(noticeUrl);
      await expect(
        page.getByRole("heading", {
          name: "Your private moderation decision notice",
        }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText(
        "hidden · revision 2",
      );
      await expect(page.getByText("privacy", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Decision time", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("main")).not.toContainText(body);
      await expect(page.locator("main")).not.toContainText(other.id);
      await expect(page.locator("main")).not.toContainText(modId);
      await page
        .getByText("Rules, privacy and review limits", { exact: true })
        .click();
      await expect(
        page.getByText(
          "A structured request is not a promise of response, independent review or qualified judgment.",
          { exact: false },
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("own-decision-notice.png"),
        fullPage: true,
      });
      const pendingDownload = page.waitForEvent("download");
      await page
        .getByRole("link", { name: "Download this latest-decision snapshot" })
        .click();
      const download = await pendingDownload,
        file = info.outputPath("own-decision-snapshot.json");
      await download.saveAs(file);
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      expect(snapshot).toEqual({
        noticeVersion: 1,
        circleId: circle,
        postId: expect.any(String),
        postState: "hidden",
        postRevision: 2,
        decision: {
          action: "hidden",
          reason: "privacy",
          oldRevision: 1,
          newRevision: 2,
          occurredAt: expect.any(String),
        },
      });
      expect(JSON.stringify(snapshot)).not.toContain(body);
      expect((await peer.goto(noticeUrl))?.status()).toBe(403);
      await expect(peer.locator("main")).not.toContainText("Decision time");
      const deniedDownload = await peer.request.get(noticeUrl + "/download");
      expect(deniedDownload.status()).toBe(403);
      expect(deniedDownload.headers()["content-disposition"]).toBeUndefined();
      await page.goto(origin + "/circles");
      await page
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      expect((await page.goto(noticeUrl))?.status()).toBe(200);
      await page
        .getByRole("link", { name: "Return to your retained contributions" })
        .click();
      await page
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await page.getByRole("button", { name: "Withdraw contribution" }).click();
      await page
        .getByRole("link", {
          name: "Inspect this contribution's moderation notice",
        })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "withdrawn · revision 3",
      );
      await expect(page.getByText("privacy", { exact: true })).toBeVisible();
      await page.screenshot({
        path: info.outputPath("withdrawn-owner-notice.png"),
        fullPage: true,
      });
      await page.goto(origin + "/learn");
      await page.getByLabel("Delete my local preview").check();
      await page.getByRole("button", { name: "Delete this preview" }).click();
      await expect(
        page.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      const erasedDownload = await page.request.get(noticeUrl + "/download", {
        maxRedirects: 0,
      });
      expect(erasedDownload.status()).toBe(303);
      expect(erasedDownload.headers()["content-disposition"]).toBeUndefined();
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_moderation_audit WHERE member_id=$1",
            [owner.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      try {
        await Promise.all([
          page.context().close(),
          ...contexts.map((c) => c.close()),
        ]);
      } finally {
        try {
          await running?.close();
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
