import {
  test,
  expect,
  devices,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool);
test.afterAll(() => pool.end());
async function onboard(
  page: Page,
  origin: string,
  background: string,
  goal: string,
) {
  await page.goto(origin);
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("Time zone (optional)").fill("America/Toronto");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const token = (await page.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Missing invented event member");
  return session.learner.id;
}
for (const [index, [background, goal]] of (
  [
    ["explorer", "everyday"],
    ["professional", "work"],
    ["technical", "build"],
  ] as const
).entries()) {
  test(`[L${142 + index}] ${background} enrolls in an explicit local rehearsal, withdraws and frees the last seat without exposing another member`, async ({
    page,
    browser,
  }, testInfo) => {
    const storage = await mkdtemp(join(tmpdir(), "dne456-e2e-")),
      owners: string[] = [];
    let running: Awaited<ReturnType<typeof start>> | undefined,
      peerContext: BrowserContext | undefined;
    try {
      running = await start({
        ...process.env,
        DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
        DNE_APP_MODE: "test",
        DNE_PORT: "0",
        DNE_PRIVATE_STORAGE_ROOT: storage,
        DNE_EVENT_REGISTRATION: "enabled",
      });
      const origin = running.origin;
      peerContext = await browser.newContext(
        testInfo.project.name === "mobile-chromium"
          ? devices["Pixel 7"]
          : devices["Desktop Chrome"],
      );
      const peer = await peerContext.newPage();
      owners.push(await onboard(page, origin, background, goal));
      owners.push(await onboard(peer, origin, background, goal));
      await page.goto(`${origin}/events`);
      // This journey exercises the unchanged static event; dated rehearsals
      // intentionally share its trusted title but have distinct immutable IDs.
      const originalEvent = page.locator(
        'a[href="/events/local-registration-rehearsal/1"]',
      );
      await expect(originalEvent).toHaveText(
        "Local event registration rehearsal",
      );
      await originalEvent.click();
      await page
        .getByRole("link", { name: "Try local registration rehearsal" })
        .click();
      const rehearsal = page.url();
      await expect(page.locator("body")).toContainText(
        "not a real appointment",
      );
      await expect(page.locator("body")).toContainText("GMT-04:00");
      await expect(page.locator("body")).toContainText("GMT-05:00");
      await page
        .getByLabel(
          "I want to save an invented-data registration; this is not a real appointment.",
        )
        .check();
      const enroll = page.getByRole("button", {
        name: "Enroll in local rehearsal",
      });
      await enroll.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", {
          name: "Private registration receipt",
          exact: true,
        }),
      ).toBeVisible();
      const receipt = page.url();
      await page.reload();
      await expect(page.locator("body")).toContainText(
        "Registered for the local rehearsal.",
      );
      expect((await peer.goto(receipt))?.status()).toBe(404);
      await peer.goto(rehearsal);
      await expect(peer.locator("body")).toContainText(
        "This local rehearsal is full.",
      );
      await expect(
        peer.getByRole("button", { name: "Enroll in local rehearsal" }),
      ).toHaveCount(0);
      await page
        .getByLabel(
          "Withdraw this exact sample registration and release its seat.",
        )
        .check();
      const withdraw = page.getByRole("button", {
        name: "Withdraw registration",
      });
      await withdraw.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("body")).toContainText(
        "This attempt cannot be reactivated.",
      );
      await peer.goto(rehearsal);
      await peer
        .getByLabel(
          "I want to save an invented-data registration; this is not a real appointment.",
        )
        .check();
      await peer
        .getByRole("button", { name: "Enroll in local rehearsal" })
        .click();
      await expect(peer.locator("body")).toContainText(
        "Registered for the local rehearsal.",
      );
      const peerReceipt = peer.url();
      expect((await page.goto(peerReceipt))?.status()).toBe(404);
      for (const participant of [page, peer]) {
        await participant.goto(`${origin}/events/registrations`);
        expect(
          await participant.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const exported = await (
          await participant.request.get(`${origin}/api/member/export`)
        ).json();
        expect(exported.version).toBe("local-member-records-v25");
        expect(exported.records.eventEnrollments).toHaveLength(1);
        expect(exported.records.eventEnrollments[0].id).toBe(
          new URL(participant === page ? receipt : peerReceipt).pathname
            .split("/")
            .at(-1),
        );
      }
      await peer.goto(`${origin}/learn`);
      await peer.getByLabel("Delete my local preview").check();
      await peer.getByRole("button", { name: "Delete this preview" }).click();
      await expect(
        peer.getByRole("button", { name: "Start my learning path" }),
      ).toBeVisible();
      await page.goto(rehearsal);
      await expect(
        page.getByRole("button", { name: "Enroll in local rehearsal" }),
      ).toBeVisible();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM private_event_enrollments WHERE member_id=$1",
            [owners[1]],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await Promise.all([page.context().close(), peerContext?.close()]);
      try {
        if (running) await running.close();
      } finally {
        for (const id of owners) await members.remove(id);
        await rm(storage, { recursive: true, force: true });
      }
    }
  });
}
