import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContextOptions,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { start } from "../../src/runtime.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
import { startPublicationRecoveryServer } from "../support/proposal-publication-recovery-server.ts";
const control = testPool(),
  database = `dne_test_${randomBytes(16).toString("hex")}`;
let created = false,
  pool: Pool,
  running: Awaited<ReturnType<typeof start>>,
  storage: string;
test.use({ trace: "off" });
test.beforeAll(async () => {
  await control.query(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  url.pathname = database;
  pool = new Pool({ connectionString: url.href });
  storage = await mkdtemp(join(tmpdir(), "dne97-browser-"));
  running = await start({
    DNE_DATABASE_URL: url.href,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_LOCAL_STAFF_ENTRY: "enabled",
    DNE_MEMBER_CONTRIBUTIONS: "enabled",
    DNE_PRIVATE_STORAGE_ROOT: storage,
  });
  console.log(
    JSON.stringify({
      fixture: "proposal-publication",
      database,
      origin: running.origin,
      created: true,
    }),
  );
});
test.beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
test.afterAll(async () => {
  try {
    await running?.close();
    await pool?.end();
    if (created) {
      await control.query(`DROP DATABASE "${database}"`);
      expect(
        (
          await control.query(
            "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) present",
            [database],
          )
        ).rows[0].present,
      ).toBe(false);
      console.log(
        JSON.stringify({
          fixture: "proposal-publication",
          database,
          cleanupConfirmed: true,
        }),
      );
    }
    if (storage) await rm(storage, { recursive: true, force: true });
  } finally {
    await control.end();
  }
});
async function onboard(
  page: Page,
  origin: string,
  background = "explorer",
  goal = "everyday",
) {
  await page.goto(origin + "/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page
    .getByRole("button", { name: "Start my learning path", exact: true })
    .click();
  await expect(page).toHaveURL(/\/learn$/);
}
async function staff(page: Page, origin: string) {
  const credential = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    credential,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  await page.goto(origin + "/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Private proposal moderation", exact: true })
    .click();
  return id;
}
async function draft(page: Page, origin: string, title: string) {
  await page.goto(origin + "/contribute");
  await expect(
    page.getByRole("heading", { name: "Your private proposals", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("I used only invented or sample information"),
  ).toHaveCount(0);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Original contribution", { exact: true })
    .fill(
      "An invented club compares three activities. Check every detail against the original notes.",
    );
  await page
    .getByLabel("Sources and rights notes", { exact: true })
    .fill("Original invented example; platform display only.");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await page
    .getByLabel("I created this contribution or have the rights")
    .check();
  await page
    .getByRole("button", { name: "Submit to private moderation", exact: true })
    .click();
  return id;
}
async function accept(page: Page, origin: string, id: string) {
  await page.goto(origin + "/moderate/proposals");
  const item = page.locator(`[data-proposal-id="${id}"]`);
  await item.getByLabel("I reviewed this exact revision").check();
  await item
    .getByRole("button", {
      name: "Accept this revision privately",
      exact: true,
    })
    .click();
  await expect(
    page.locator('[data-publication-state="accepted"]'),
  ).toBeVisible();
}
async function share(page: Page, origin: string, id: string) {
  await page.goto(origin + `/contribute/${id}/publication`);
  await expect(
    page.getByText(
      "Accepted privately. Nothing is shared with other members.",
      { exact: true },
    ),
  ).toBeVisible();
  const consent = page.getByLabel(
    "I permit this platform to display this exact accepted revision",
  );
  await expect(consent).not.toBeChecked();
  await page
    .getByLabel("Display attribution", { exact: true })
    .fill("Invented club contributor");
  await page
    .getByLabel("Sharing audience", { exact: true })
    .selectOption("members");
  await consent.check();
  await page
    .getByRole("button", { name: "Share this accepted revision", exact: true })
    .click();
}
async function actors(
  browser: Browser,
  origin: string,
  background = "explorer",
  goal = "everyday",
  contextOptions: BrowserContextOptions = {},
) {
  const ownerContext = await browser.newContext(contextOptions),
    staffContext = await browser.newContext(contextOptions),
    peerContext = await browser.newContext(contextOptions);
  const owner = await ownerContext.newPage(),
    moderator = await staffContext.newPage(),
    peer = await peerContext.newPage();
  await onboard(owner, origin, background, goal);
  await onboard(peer, origin);
  const staffId = await staff(moderator, origin);
  return {
    owner,
    moderator,
    peer,
    staffId,
    close: async () => {
      await ownerContext.close();
      await staffContext.close();
      await peerContext.close();
    },
  };
}
test("[L227] all backgrounds keep original contributions private until exact editorial acceptance and fresh member-only sharing", async ({
  browser,
  page,
}, testInfo) => {
  for (const [background, goal] of [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ]) {
    const a = await actors(
      browser,
      running.origin,
      background,
      goal,
      testInfo.project.use,
    );
    try {
      const title = `Invented ${background} contribution`,
        id = await draft(a.owner, running.origin, title);
      await a.peer.goto(running.origin + "/contributions");
      await expect(a.peer.getByText(title, { exact: true })).toHaveCount(0);
      await accept(a.moderator, running.origin, id);
      await a.peer.reload();
      await expect(a.peer.getByText(title, { exact: true })).toHaveCount(0);
      await share(a.owner, running.origin, id);
      await expect(
        a.owner.locator('[data-publication-state="published"]'),
      ).toBeVisible();
      await a.peer.reload();
      await a.peer.getByRole("link", { name: title, exact: true }).click();
      const sharedUrl = a.peer.url();
      await expect(a.peer.locator("[data-contribution-body]")).toContainText(
        "An invented club",
      );
      await expect(
        a.peer.getByText(
          "Member contribution · editorially reviewed · revision 1",
          { exact: true },
        ),
      ).toBeVisible();
      await a.owner.goto(running.origin + `/contribute/${id}`);
      await expect(
        a.owner.getByText("This is not published", { exact: false }),
      ).toHaveCount(0);
      await expect(
        a.owner.getByText("No public or external reuse license is granted", {
          exact: false,
        }),
      ).toBeVisible();
      await a.owner
        .getByRole("link", {
          name: "Inspect editorial acceptance and sharing",
          exact: true,
        })
        .click();
      await expect(
        a.owner.locator('[data-publication-state="published"]'),
      ).toBeVisible();
      await a.owner.goto(running.origin + "/member/export");
      const [download] = await Promise.all([
        a.owner.waitForEvent("download"),
        a.owner
          .getByRole("button", {
            name: "Download page 1",
            exact: true,
          })
          .click(),
      ]);
      const exported = JSON.parse(
        await readFile((await download.path())!, "utf8"),
      );
      expect(exported.records.proposalPublications).toEqual([
        expect.objectContaining({
          proposalId: id,
          state: "published",
          attribution: "Invented club contributor",
          revision: 1,
        }),
      ]);
      expect(JSON.stringify(exported)).not.toContain(a.staffId);
      await a.owner.goto(running.origin + `/contribute/${id}/publication`);
      await a.owner
        .getByLabel("Withdraw display permission for this revision")
        .check();
      await a.owner
        .getByRole("button", { name: "Withdraw sharing", exact: true })
        .click();
      await expect(
        a.owner.locator('[data-publication-state="withdrawn"]'),
      ).toBeVisible();
      expect((await a.peer.goto(sharedUrl))?.status()).toBe(403);
      await a.owner.goto(running.origin + `/contribute/${id}`);
      await expect(a.owner.locator("[data-proposal-body]")).toContainText(
        "An invented club",
      );
      await a.owner
        .getByLabel("Remove the proposal text and stop moderation.")
        .check();
      await a.owner
        .getByRole("button", { name: "Withdraw and redact", exact: true })
        .click();
      await expect(
        a.owner.getByText("The proposal text has been removed.", {
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await a.close();
    }
  }
  await onboard(page, running.origin);
  await page.goto(running.origin + "/contributions");
  await page.screenshot({
    path: testInfo.outputPath("member-contributions-withdrawn.png"),
    fullPage: true,
  });
});
test("[L228] quarantine, account erasure and current staff authority prevent future contribution disclosure", async ({
  browser,
}, testInfo) => {
  const a = await actors(
    browser,
    running.origin,
    "explorer",
    "everyday",
    testInfo.project.use,
  );
  try {
    const id = await draft(
      a.owner,
      running.origin,
      "Invented controlled contribution",
    );
    await accept(a.moderator, running.origin, id);
    await share(a.owner, running.origin, id);
    await a.owner
      .getByRole("link", { name: "Open the shared contribution", exact: true })
      .click();
    const sharedUrl = a.owner.url();
    expect(
      (
        await a.peer.goto(running.origin + `/contribute/${id}/publication`)
      )?.status(),
    ).toBe(403);
    await a.moderator.goto(running.origin + "/moderate/proposals");
    await a.moderator
      .locator(`[data-proposal-id="${id}"]`)
      .getByRole("button", { name: "Quarantine for review", exact: true })
      .click();
    expect((await a.peer.goto(sharedUrl))?.status()).toBe(403);
    await a.owner.goto(running.origin + `/contribute/${id}/publication`);
    await expect(
      a.owner.locator('[data-publication-state="withdrawn"]'),
    ).toBeVisible();
    await expect(
      a.owner.getByRole("button", {
        name: "Share this accepted revision",
        exact: true,
      }),
    ).toHaveCount(0);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [a.staffId],
    );
    expect(
      (
        await a.moderator.goto(running.origin + "/moderate/proposals")
      )?.status(),
    ).toBe(403);
    await a.owner.goto(running.origin + "/learn");
    await a.owner
      .getByLabel("Delete my local preview and all its saved work.")
      .check();
    await a.owner
      .getByRole("button", { name: "Delete this preview", exact: true })
      .click();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM proposal_publications WHERE proposal_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await a.peer.goto(sharedUrl))?.status()).toBe(403);
  } finally {
    await a.close();
  }
});
test("[L229] a lost committed publication remains inspectable after a fresh-secret feature-off restart and source deletion cannot resurrect it", async ({
  browser,
}, testInfo) => {
  const recovery = await startPublicationRecoveryServer(pool),
    a = await actors(
      browser,
      recovery.origin,
      "explorer",
      "everyday",
      testInfo.project.use,
    );
  try {
    const id = await draft(
      a.owner,
      recovery.origin,
      "Invented recovery contribution",
    );
    await accept(a.moderator, recovery.origin, id);
    await share(a.owner, recovery.origin, id);
    await expect(
      a.owner.getByRole("heading", {
        name: "Contribution needs attention",
        exact: true,
      }),
    ).toBeVisible();
    const reference = (
      await a.owner.locator("[data-publication-request-reference]").innerText()
    ).trim();
    expect(recovery.observed).toEqual({
      commits: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    recovery.restart(false);
    const response = a.owner.context().waitForEvent("response", {
      predicate: (r) =>
        new URL(r.url()).pathname === "/contribution-requests/inspect" &&
        r.request().method() === "POST",
    });
    const [stale] = await Promise.all([
      a.owner.waitForEvent("popup"),
      a.owner
        .getByRole("button", {
          name: "Inspect this publication request",
          exact: true,
        })
        .click(),
    ]);
    expect((await response).status()).toBe(403);
    await stale.close();
    await a.owner
      .getByRole("link", {
        name: "Inspect an earlier publication request",
        exact: true,
      })
      .click();
    await a.owner
      .getByLabel("Original publication request reference", { exact: true })
      .fill(reference);
    await a.owner
      .getByRole("button", { name: "Inspect publication request", exact: true })
      .click();
    await expect(
      a.owner.locator('[data-publication-state="published"]'),
    ).toBeVisible();
    await a.owner
      .getByRole("link", {
        name: "Inspect my current contribution",
        exact: true,
      })
      .click();
    await expect(
      a.owner.getByText(
        "New contribution intake, acceptance and sharing are paused.",
        { exact: false },
      ),
    ).toBeVisible();
    await a.owner
      .getByLabel("Withdraw display permission for this revision")
      .check();
    await a.owner
      .getByRole("button", { name: "Withdraw sharing", exact: true })
      .click();
    await expect(
      a.owner.locator('[data-publication-state="withdrawn"]'),
    ).toBeVisible();
    await a.owner.goto(recovery.origin + `/contribute/${id}`);
    await a.owner
      .getByLabel("Remove the proposal text and stop moderation.")
      .check();
    await a.owner
      .getByRole("button", { name: "Withdraw and redact", exact: true })
      .click();
    await a.owner.goto(recovery.origin + "/contribution-requests/inspect");
    await a.owner
      .getByLabel("Original publication request reference", { exact: true })
      .fill(reference);
    await a.owner
      .getByRole("button", { name: "Inspect publication request", exact: true })
      .click();
    await expect(
      a.owner.locator('[data-publication-state="withdrawn"]'),
    ).toBeVisible();
    await expect(
      a.owner.getByText("Invented club contributor", { exact: false }),
    ).toHaveCount(0);
    expect(recovery.observed.commits).toBe(1);
  } finally {
    await a.close();
    await recovery.close();
  }
});
