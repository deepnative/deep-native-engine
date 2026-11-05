import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { start } from "../../src/runtime.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  access = authorizationStore(pool);
test.afterAll(async () => pool.end());

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("[L298] STAFFSEE-01, 02, 05 a member sees when staff were given access and opened their work", async ({
  page,
}) => {
  const storage = await mkdtemp(join(tmpdir(), "dne-staff-access-"));
  const purpose = "Invented confidential coaching purpose";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  let owner: string | undefined;
  try {
    running = await start({
      ...process.env,
      DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
      DNE_APP_MODE: "test",
      DNE_PORT: "0",
      DNE_PRIVATE_STORAGE_ROOT: storage,
    });
    const origin = running.origin;
    await page.goto(origin);
    await page.getByLabel("Display name").fill("Invented learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    await page.getByRole("button", { name: "Start my learning path" }).click();
    const token = (await page.context().cookies()).find(
      (c) => c.name === COOKIE,
    )!.value;
    const session = await members.session(token);
    if (session.kind !== "active") throw Error("Invented member unavailable");
    owner = session.learner.id;

    // STAFFSEE-01: reached from Who can see my work, nothing recorded.
    await page.goto(`${origin}/account/sharing`);
    const staff = page.getByRole("region", {
      name: "Coaches and administrators",
    });
    await expect(staff).toContainText(
      "No staff access to your private work is active right now",
    );
    await staff
      .getByRole("link", { name: "When staff opened my work" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "When staff opened my work",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "No staff access to your private work is recorded.",
    );
    expect(await noSidewaysScroll(page)).toBe(true);

    // STAFFSEE-02: given, then opened, newest first.
    const expires = new Date(Date.now() + 86_400_000);
    const adminToken = randomBytes(32).toString("hex"),
      coachToken = randomBytes(32).toString("hex");
    const adminId = await access.provisionStaff(
      adminToken,
      "platform_admin",
      expires,
    );
    const coachId = await access.provisionStaff(coachToken, "coach", expires);
    const grant = await access.grantAssignment(
      adminId,
      coachId,
      owner,
      "coach",
      purpose,
      expires,
    );
    expect(await access.readWorkspace(coachToken, owner)).toMatchObject({
      kind: "allowed",
    });
    await page.reload();
    const rows = page.locator("main li");
    await expect(rows.nth(0)).toContainText(
      "Assigned staff opened your learning workspace.",
    );
    await expect(rows.nth(1)).toContainText(
      "Assigned staff were given access to your learning workspace.",
    );
    await expect(page.locator("body")).not.toContainText(purpose);
    await expect(page.locator("body")).not.toContainText(coachId);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.goto(`${origin}/account/sharing`);
    await expect(staff).toContainText("1 staff member has access");

    // STAFFSEE-05: ending the access shows at once on both pages.
    expect(await access.revokeAssignment(adminId, grant)).toBe(true);
    await page.reload();
    await expect(staff).toContainText(
      "No staff access to your private work is active right now",
    );
    await staff
      .getByRole("link", { name: "When staff opened my work" })
      .click();
    await expect(rows.nth(0)).toContainText(
      "Access to your learning workspace was taken away from assigned staff.",
    );
  } finally {
    await page.context().close();
    try {
      if (running) await running.close();
    } finally {
      if (owner) await members.remove(owner);
      await rm(storage, { recursive: true, force: true });
    }
  }
});
