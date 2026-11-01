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
  test(`[L${251 + index}] RPTN-01..06 ${background} inspects a private report decision through hide restore source loss and erasure`, async ({
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
      const ownerNoticeUrl = page.url();
      expect(ownerNoticeUrl).toContain("moderation-notice");
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
      await peer
        .getByRole("link", { name: "Open your durable sample receipt" })
        .click();
      await peer
        .getByRole("link", {
          name: "Inspect the latest decision available for this report",
        })
        .click();
      const noticeUrl = peer.url();
      await expect(
        peer.getByText(
          "No later recorded decision is currently available for this report.",
        ),
      ).toBeVisible();
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
      const contribution = moderator.getByRole("article").filter({
        has: moderator.getByText(body, { exact: true }),
      });
      await expect(contribution).toHaveCount(1);
      await contribution
        .getByLabel("Synthetic decision reason")
        .selectOption("privacy");
      await contribution
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await expect(moderator).toHaveURL(queue);
      await expect(
        contribution.getByRole("button", {
          name: "Restore invented contribution",
        }),
      ).toBeVisible();

      await peer.goto(noticeUrl);
      await expect(
        peer.getByRole("heading", {
          name: "Your private report decision notice",
          exact: true,
        }),
      ).toBeVisible();
      await expect(peer.getByRole("status")).toContainText("Hidden");
      await expect(
        peer.getByText("Decision time", { exact: true }),
      ).toBeVisible();
      for (const secret of [body, owner.id, other.id, modId])
        await expect(peer.locator("main")).not.toContainText(secret);
      expect(
        await peer.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await peer.screenshot({
        path: info.outputPath("reporter-hidden-notice.png"),
        fullPage: true,
      });
      async function download(name: string) {
        const event = peer.waitForEvent("download");
        await peer
          .getByRole("link", { name: "Download this report decision snapshot" })
          .click();
        const d = await event;
        expect(d.suggestedFilename()).toBe(
          "circle-report-decision-notice.json",
        );
        const path = info.outputPath(name + ".json");
        await d.saveAs(path);
        const value = JSON.parse(await readFile(path, "utf8"));
        expect(value.reportNoticeVersion).toBe(1);
        expect(Object.keys(value).sort()).toEqual(
          [
            "reportNoticeVersion",
            "circleId",
            "reportId",
            "category",
            "reportedAt",
            "targetStatus",
            "decision",
          ].sort(),
        );
        for (const secret of [body, owner.id, other.id, modId])
          expect(JSON.stringify(value)).not.toContain(secret);
        return value;
      }
      const hidden = await download("reporter-hidden-snapshot");
      expect(hidden).toMatchObject({
        circleId: circle,
        category: "privacy",
        targetStatus: "hidden",
        decision: {
          action: "hidden",
          reason: "privacy",
          oldRevision: 1,
          newRevision: 2,
        },
      });
      expect((await page.goto(noticeUrl))?.status()).toBe(403);
      const denied = await page.request.get(noticeUrl + "/download");
      expect(denied.status()).toBe(403);
      expect(denied.headers()["content-disposition"]).toBeUndefined();
      await moderator.goto(queue);
      await expect(contribution).toHaveCount(1);
      await contribution
        .getByLabel("Synthetic decision reason")
        .selectOption("test_correction");
      await contribution
        .getByRole("button", { name: "Restore invented contribution" })
        .click();
      await peer.reload();
      await expect(peer.getByRole("status")).toContainText("Visible");
      await expect(peer.getByText("restored", { exact: true })).toBeVisible();
      await expect(peer.locator("main")).toContainText(
        "not a resolution of your individual report",
      );
      expect(
        (await download("reporter-restored-snapshot")).decision,
      ).toMatchObject({
        action: "restored",
        reason: "test_correction",
        oldRevision: 2,
        newRevision: 3,
      });
      await peer.screenshot({
        path: info.outputPath("reporter-restored-notice.png"),
        fullPage: true,
      });
      await page.goto(base + "/owned");
      await page
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await page
        .getByRole("button", { name: "Withdraw contribution", exact: true })
        .click();
      await peer.reload();
      await expect(peer.getByRole("status")).toContainText(
        "Target unavailable",
      );
      expect(
        (await download("reporter-unavailable-snapshot")).decision,
      ).toBeNull();
      await page.goto(origin + "/learn");
      await page.getByLabel("Delete my local preview").check();
      await page
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      await peer.goto(origin + "/circles");
      await peer
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      await peer.goto(noticeUrl);
      await expect(peer.getByRole("status")).toContainText(
        "Target unavailable",
      );
      await expect(
        peer.getByText(
          "No later recorded decision is currently available for this report.",
        ),
      ).toBeVisible();
      await peer.screenshot({
        path: info.outputPath("reporter-private-unavailable-after-leave.png"),
        fullPage: true,
      });
      await peer.goto(origin + "/learn");
      await peer.getByLabel("Delete my local preview").check();
      await peer
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      await expect(
        peer.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      const erased = await peer.request.get(noticeUrl + "/download", {
        maxRedirects: 0,
      });
      expect(erased.status()).toBe(303);
      expect(erased.headers()["content-disposition"]).toBeUndefined();
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_reports WHERE member_id=$1",
            [other.id],
          )
        ).rowCount,
      ).toBe(0);
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
