import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

// Finite invented staff credentials are entered only in password fields and are
// never retained in a network trace or capture.
test.use({ trace: "off" });
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
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
const base = "/operator/circle-grants";
async function signIn(page: Page, origin: string, credential: string) {
  await page.goto(origin + "/staff/sign-in");
  await expect(
    page.getByLabel("Trusted local staff credential"),
  ).toHaveAttribute("type", "password");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
async function grant(
  page: Page,
  origin: string,
  target: string,
  circle: string,
  expires: Date,
  privateText: string,
) {
  await page.goto(origin + base);
  const check = page
    .locator(`form[action="${base}/check"]`)
    .filter({ has: page.locator('input[type="text"][name="staffId"]') });
  await check.getByLabel("Exact staff reference", { exact: true }).fill(target);
  await check.getByLabel("Exact circle", { exact: true }).selectOption(circle);
  await check
    .getByRole("button", { name: "Check exact references", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm circle moderation grant",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Exact staff reference", { exact: true }),
  ).toHaveValue(target);
  await expect(page.getByLabel("Exact circle ID", { exact: true })).toHaveValue(
    circle,
  );
  await expect(
    page.getByLabel("Original submission key", { exact: true }),
  ).toHaveAttribute("readonly", "");
  const key = await page
    .getByLabel("Original submission key", { exact: true })
    .inputValue();
  const confirmation = page.getByLabel(
    "I confirm this exact staff reference, circle and finite expiry.",
    { exact: true },
  );
  await expect(confirmation).not.toBeChecked();
  await expect(page.locator("body")).toContainText("circle-discussion-test-v1");
  await expect(page.locator("body")).not.toContainText(privateText);
  await page
    .getByLabel("Expires at (UTC)", { exact: true })
    .fill(expires.toISOString());
  await confirmation.check();
  await page
    .getByRole("button", { name: "Create this circle grant", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Circle grant receipt", exact: true }),
  ).toBeVisible();
  const id = (await page.locator("[data-circle-grant]").innerText()).trim();
  await expect(page.locator("body")).toContainText(key);
  expect(new URL(page.url()).search).toBe("");
  return { id, key };
}

for (const [index, [background, goal, circle, title]] of audiences.entries()) {
  test(`[L${248 + index}] MODA-01..08 ${background} requests exact-decision reconsideration and inspects a scoped result, withdrawal and erasure`, async ({
    page,
    browser,
  }, info) => {
    const storage = await mkdtemp(join(tmpdir(), "dne196-appeal-browser-"));
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
        DNE_LOCAL_CIRCLE_ADMIN: "enabled",
      });
      const origin = running.origin,
        discussion = `${origin}/circles/${circle}/discussion`,
        queue = `${origin}/moderate/circles/${circle}/reports`,
        appeals = `${origin}/moderate/circles/${circle}/appeals`;
      const device =
        info.project.name === "mobile-chromium"
          ? devices["Pixel 7"]!
          : devices["Desktop Chrome"]!;
      const peerContext = await browser.newContext(device),
        moderatorContext = await browser.newContext(device),
        adminContext = await browser.newContext(device);
      contexts.push(peerContext, moderatorContext, adminContext);
      const peer = await peerContext.newPage(),
        moderator = await moderatorContext.newPage(),
        admin = await adminContext.newPage();
      const owner = await onboard(page, origin, background, goal),
        other = await onboard(peer, origin, background, goal);
      ownerIds.push(owner.id, other.id);
      for (const actor of [page, peer]) {
        await actor.goto(origin + "/circles");
        await actor
          .getByRole("button", { name: `Join ${title}`, exact: true })
          .click();
        await actor.goto(discussion + "/choice");
        await actor
          .getByLabel(
            "I choose invented local discussion sharing under this exact circle policy.",
          )
          .check();
        await actor
          .getByRole("button", { name: "Enable invented circle sharing" })
          .click();
      }
      const body = `Invented ${background} shared source; this text must never enter the retained appeal download.`;
      await page.goto(discussion);
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
      await expect(page).toHaveURL(discussion + "/owned");
      await page
        .getByRole("link", {
          name: "Inspect this contribution's moderation notice",
        })
        .click();
      const noticeUrl = page.url();
      await peer.goto(discussion);
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
        modToken = randomBytes(32).toString("hex"),
        expiry = new Date(Date.now() + 3600000);
      staffIds.push(
        await auth.provisionStaff(adminToken, "platform_admin", expiry),
      );
      const modId = await auth.provisionStaff(modToken, "moderator", expiry);
      staffIds.push(modId);
      await signIn(moderator, origin, modToken);
      await signIn(admin, origin, adminToken);
      await grant(
        admin,
        origin,
        modId,
        circle,
        new Date(Date.now() + 1200000),
        body,
      );
      await moderator.goto(queue);
      await moderator
        .getByLabel("Synthetic decision reason")
        .selectOption("privacy");
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await expect(
        moderator.getByRole("button", {
          name: "Restore invented contribution",
        }),
      ).toBeVisible();
      await page.goto(noticeUrl);
      await page
        .getByRole("link", {
          name: "Request or inspect reconsideration of this decision",
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Request reconsideration of this decision",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Reason for reconsideration")
        .selectOption("missing_context");
      await page
        .getByLabel(
          "Request reconsideration of this exact hidden decision; retain only this structured reason and decision reference.",
        )
        .check();
      await page
        .getByRole("button", { name: "Request reconsideration", exact: true })
        .click();
      const firstUrl = page.url();
      await expect(page.getByRole("status")).toContainText(
        "Recorded request: pending",
      );
      await expect(page.locator("main")).not.toContainText(body);
      await expect(page.locator("main")).not.toContainText(modId);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("pending-private-appeal.png"),
        fullPage: true,
      });
      expect((await peer.goto(firstUrl))?.status()).toBe(403);
      await expect(peer.locator("main")).not.toContainText("missing context");
      await moderator.goto(appeals);
      await expect(moderator.locator("main")).toContainText(body);
      await expect(moderator.locator("main")).not.toContainText(owner.id);
      const outcome = index === 0 ? "uphold" : "restore";
      await moderator
        .getByLabel("Recorded reconsideration result")
        .selectOption(outcome);
      await moderator
        .getByLabel(
          "Record this exact reconsideration result; this is not independent or qualified review.",
        )
        .check();
      await moderator
        .getByRole("button", { name: "Record reconsideration result" })
        .click();
      await expect(moderator).toHaveURL(appeals);
      await expect(
        moderator.getByText(
          "No currently available reconsideration requests on this page.",
        ),
      ).toBeVisible();
      await page.goto(firstUrl);
      await expect(page.getByRole("status")).toContainText(
        `Recorded request: ${outcome === "uphold" ? "upheld" : "restored"}`,
      );
      await expect(page.locator("main")).toContainText(
        "not independent or qualified review",
      );
      const pendingDownload = page.waitForEvent("download");
      await page
        .getByRole("link", {
          name: "Download all your retained appeals in this circle",
        })
        .click();
      const download = await pendingDownload,
        file = info.outputPath("own-appeal-history.json");
      await download.saveAs(file);
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      expect(snapshot).toMatchObject({
        appealsVersion: 1,
        circleId: circle,
        items: [
          {
            decisionRevision: 2,
            requestReason: "missing_context",
            state: outcome === "uphold" ? "upheld" : "restored",
            resolution: {
              reason:
                outcome === "uphold" ? "rule_applies" : "decision_corrected",
              postRevision: outcome === "uphold" ? 2 : 3,
            },
          },
        ],
      });
      expect(snapshot.items).toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toMatch(
        /actor|resolver|reporter|fingerprint|idempotency|body|workspace|token/,
      );
      expect(JSON.stringify(snapshot)).not.toContain(body);
      await page.screenshot({
        path: info.outputPath("recorded-private-appeal-result.png"),
        fullPage: true,
      });
      await moderator.goto(queue);
      if (outcome === "uphold") {
        await moderator
          .getByLabel("Synthetic decision reason")
          .selectOption("test_correction");
        await moderator
          .getByRole("button", { name: "Restore invented contribution" })
          .click();
        await expect(
          moderator.getByRole("button", { name: "Hide invented contribution" }),
        ).toBeVisible();
      }
      await moderator
        .getByLabel("Synthetic decision reason")
        .selectOption("privacy");
      await moderator
        .getByRole("button", { name: "Hide invented contribution" })
        .click();
      await expect(
        moderator.getByRole("button", {
          name: "Restore invented contribution",
        }),
      ).toBeVisible();
      await page.goto(noticeUrl);
      await expect(page.getByRole("status")).toContainText(
        "hidden · revision 4",
      );
      await page
        .getByRole("link", {
          name: "Request or inspect reconsideration of this decision",
        })
        .click();
      await page.getByLabel("Reason for reconsideration").selectOption("other");
      await page
        .getByLabel(
          "Request reconsideration of this exact hidden decision; retain only this structured reason and decision reference.",
        )
        .check();
      await page
        .getByRole("button", { name: "Request reconsideration", exact: true })
        .click();
      const secondUrl = page.url();
      expect(secondUrl).not.toBe(firstUrl);
      await page
        .getByLabel(
          "Withdraw this pending reconsideration request; its content-free record remains private until account deletion.",
        )
        .check();
      await page
        .getByRole("button", {
          name: "Withdraw reconsideration request",
          exact: true,
        })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Recorded request: withdrawn",
      );
      await moderator.goto(appeals);
      await expect(
        moderator.getByText(
          "No currently available reconsideration requests on this page.",
        ),
      ).toBeVisible();
      await page.goto(origin + "/circles");
      await page
        .getByRole("button", { name: `Leave ${title}`, exact: true })
        .click();
      expect((await page.goto(secondUrl))?.status()).toBe(200);
      await page.goto(discussion + "/owned");
      await page
        .getByLabel(
          "Withdraw this contribution's text; a content-free marker remains until account deletion.",
        )
        .check();
      await page.getByRole("button", { name: "Withdraw contribution" }).click();
      expect((await page.goto(firstUrl))?.status()).toBe(200);
      await expect(page.getByRole("status")).toContainText(
        "withdrawn · revision 5",
      );
      await expect(page.locator("main")).not.toContainText(body);
      await page.screenshot({
        path: info.outputPath("withdrawn-source-retained-appeal.png"),
        fullPage: true,
      });
      await page.goto(origin + "/learn");
      await page.getByLabel("Delete my local preview").check();
      await page.getByRole("button", { name: "Delete this preview" }).click();
      await expect(
        page.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      const erased = await page.request.get(discussion + "/appeals/download", {
        maxRedirects: 0,
      });
      expect(erased.status()).toBe(303);
      expect(erased.headers()["content-disposition"]).toBeUndefined();
      expect(
        (
          await pool.query(
            "SELECT 1 FROM preview_circle_appeals WHERE member_id=$1",
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
