import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
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
  "invented-disposition-browser-fixture",
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
  await page.getByLabel("Display name").fill("Sample learner");
  await page.getByLabel("Your starting point").selectOption(background);
  await chooseLearningGoal(page, goal);
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(origin + "/learn");
  const token = (await page.context().cookies()).find(
    (c) => c.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Missing invented member");
  return { token, id: session.learner.id };
}
// #196 RPTD-09: a reporter sees what a granted moderator did with their one
// report, through escalation and closure against a recorded decision, foreign
// denial, leaving and account erasure.
for (const [index, [background, goal, circle, title]] of audiences.entries()) {
  test(`[L${333 + index}] RPTD-09 ${background} follows a report from escalation to closure, then leaves and erases`, async ({
    page,
    browser,
  }, info) => {
    const storage = await mkdtemp(join(tmpdir(), "dne196-disposition-"));
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
      const body = `Invented ${background} circle question for a report outcome; never copy this body.`;
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
      await peer.goto(base);
      await peer
        .getByRole("link", { name: "Open question and replies" })
        .click();
      await peer
        .getByLabel("Report this exact invented contribution")
        .selectOption("conduct");
      await peer
        .getByRole("button", { name: "Save private sample report" })
        .click();
      await peer
        .getByRole("link", { name: "Open your durable sample receipt" })
        .click();
      await peer
        .getByRole("link", { name: "Inspect what happened to this report" })
        .click();
      const outcomeUrl = peer.url();
      await expect(peer.getByRole("status")).toContainText(
        "Report disposition: Open · revision 1",
      );
      await expect(
        peer.getByText("No action has been recorded on this report yet."),
      ).toBeVisible();
      // RPTD-04: the contribution owner can't open the reporter's record.
      const foreign = await page.goto(outcomeUrl);
      expect(foreign!.status()).toBe(403);

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
      const article = moderator.getByRole("article").filter({
        has: moderator.getByText(body, { exact: true }),
      });
      await expect(article).toHaveCount(1);
      // RPTD-02: a local second look, deliberately confirmed.
      await article
        .getByLabel("Why it needs a second look", { exact: true })
        .selectOption("policy_unclear");
      await article
        .getByLabel(
          "Record that this report needs a local second look. Nobody is assigned or notified, and no response is promised.",
        )
        .check();
      await article
        .getByRole("button", { name: "Ask for a local second look" })
        .click();
      await expect(moderator).toHaveURL(queue);
      await expect(article.getByRole("status")).toContainText(
        "Waiting for a local second look · revision 2",
      );
      await expect(
        article.getByRole("button", { name: "Ask for a local second look" }),
      ).toHaveCount(0);
      await peer.reload();
      await expect(peer.getByRole("status")).toContainText(
        "Waiting for a local second look · revision 2",
      );
      await expect(peer.locator("body")).toContainText("Policy unclear");

      // RPTD-03: hide, then close against that exact recorded decision.
      await article
        .getByLabel("Synthetic decision reason")
        .selectOption("conduct");
      await article
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await article
        .getByLabel(
          "Close this report after inspecting the recorded decision at revision 2. This does not claim the report caused it.",
        )
        .check();
      await article
        .getByRole("button", { name: "Close against decision revision 2" })
        .click();
      await expect(article.getByRole("status")).toContainText(
        "Closed after a recorded decision · revision 3",
      );
      await expect(
        article.getByRole("button", { name: "Reject this report" }),
      ).toHaveCount(0);
      await peer.reload();
      await expect(peer.getByRole("status")).toContainText(
        "Closed after a recorded decision · revision 3",
      );
      await peer.screenshot({
        path: info.outputPath("reporter-report-outcome-closed.png"),
        fullPage: true,
      });
      const download = await peer.request.get(outcomeUrl + "/download");
      expect(download.status()).toBe(200);
      expect(download.headers()["content-disposition"]).toContain(
        "circle-report-disposition.json",
      );
      const text = await download.text();
      expect(JSON.parse(text)).toMatchObject({
        reportDispositionVersion: 1,
        category: "conduct",
        disposition: "closed",
        revision: 3,
        history: [
          { action: "escalated", reason: "policy_unclear" },
          { action: "closed", reason: "recorded_target_decision" },
        ],
      });
      for (const secret of [body, modId, owner.id])
        expect(text).not.toContain(secret);

      // RPTD-05: after leaving, the reporter still sees their own record.
      await peer.goto(origin + "/circles");
      await peer
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      await peer.goto(outcomeUrl);
      await expect(peer.getByRole("status")).toContainText(
        "Closed after a recorded decision · revision 3",
      );
      // RPTD-08: account erasure removes it; a stale download has no attachment.
      await peer.goto(origin + "/learn");
      await peer.getByLabel("Delete my local preview").check();
      await peer
        .getByRole("button", { name: "Delete this preview", exact: true })
        .click();
      await expect(
        peer.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      const erased = await peer.request.get(outcomeUrl + "/download", {
        maxRedirects: 0,
      });
      expect(erased.status()).toBe(303);
      expect(erased.headers()["content-disposition"]).toBeUndefined();
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_report_dispositions d JOIN preview_circle_reports r ON r.id=d.report_id WHERE r.member_id=$1",
            [other.id],
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
          for (const id of ownerIds) await members.remove(id).catch(() => {});
          for (const id of staffIds)
            await pool.query("DELETE FROM principals WHERE id=$1", [id]);
          await rm(storage, { recursive: true, force: true });
        }
      }
    }
  });
}
