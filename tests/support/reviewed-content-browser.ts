import {
  expect,
  devices,
  type Browser,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/runtime.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { dropAttendanceBrowserDatabase } from "./attendance-browser-database.ts";

export async function reviewedContentFixture(browser: Browser, info: TestInfo) {
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Missing generated browser database");
  const name = `dne_test_${randomBytes(16).toString("hex")}`,
    admin = new URL(original),
    own = new URL(original);
  admin.pathname = "/postgres";
  own.pathname = `/${name}`;
  const control = new Pool({ connectionString: admin.href }),
    pool = new Pool({ connectionString: own.href });
  const storage = await mkdtemp(join(tmpdir(), "dne-reviewed-content-")),
    contexts: BrowserContext[] = [];
  let running: Awaited<ReturnType<typeof start>> | undefined,
    created = false;
  async function close() {
    const closed = await Promise.allSettled(
      contexts.map((context) => context.close()),
    );
    const closeFailure = closed.find(
      (result) =>
        result.status === "rejected" &&
        !String(result.reason).includes(
          "Target page, context or browser has been closed",
        ),
    );

    await running?.close();

    await pool.end();
    try {
      if (created) {
        await dropAttendanceBrowserDatabase(control, name);
        expect(
          (
            await control.query("SELECT 1 FROM pg_database WHERE datname=$1", [
              name,
            ])
          ).rowCount,
        ).toBe(0);
      }
    } finally {
      await control.end();
    }
    await rm(storage, { recursive: true });
    if (closeFailure?.status === "rejected") throw closeFailure.reason;
  }
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    running = await start({
      DNE_DATABASE_URL: own.href,
      DNE_PORT: "0",
      DNE_APP_MODE: "test",
      DNE_PRIVATE_STORAGE_ROOT: storage,
      DNE_LOCAL_STAFF_ENTRY: "enabled",
    });
    const origin = running.origin;
    await info.attach("reviewed-content-fixture", {
      body: JSON.stringify({ database: name, origin }),
      contentType: "application/json",
    });
    async function page() {
      const context = await browser.newContext(
        info.project.name === "mobile-chromium"
          ? devices["Pixel 7"]
          : devices["Desktop Chrome"],
      );
      contexts.push(context);
      return context.newPage();
    }
    async function staff(role: StaffRole) {
      const token = randomBytes(32).toString("hex"),
        id = await authorizationStore(pool).provisionStaff(
          token,
          role,
          new Date(Date.now() + 3600000),
        );
      const actor = await page();
      await actor.goto(origin + "/staff/sign-in");
      await actor.getByLabel("Trusted local staff credential").fill(token);

      await actor
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();

      return { page: actor, token, id };
    }
    async function member(background = "explorer", goal = "everyday") {
      const actor = await page();
      await actor.goto(origin);

      await actor.getByLabel("Your starting point").selectOption(background);
      await actor.getByLabel("What would you like to do?").selectOption(goal);
      await actor
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await expect(actor).toHaveURL(origin + "/learn");

      return actor;
    }
    async function publishFixture() {
      const editor = await staff("editor"),
        reviewer = await staff("reviewer"),
        catalog = catalogStore(pool);

      expect(await foundationImportStore(pool).import(editor.token)).toBe(
        "imported",
      );
      for (const item of await reviewedFoundation()) {
        expect(await catalog.submit(editor.token, item.id, 2)).toBe(true);
        expect(await catalog.approve(reviewer.token, item.id, 2, true)).toBe(
          true,
        );
        expect(await catalog.publish(editor.token, item.id, 2)).toBe(true);
      }
      return { editor, reviewer, catalog };
    }
    return { origin, pool, page, staff, member, publishFixture, close };
  } catch (error) {
    await close();
    throw error;
  }
}
