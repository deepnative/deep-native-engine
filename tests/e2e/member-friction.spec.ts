import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({ connectionString: root.toString() });
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({ connectionString: scoped.toString() });
const members = store(pool);
test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
test.afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});
const inView = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });

test("[L289] FRICTION-01/02/05/06/12 a member sees what happened after saving, leaving and deleting", async ({
  page,
}) => {
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-friction-browser",
      localStaffEntry: true,
      workflowFeedback: workflowFeedbackStore(pool),
    }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test listener");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    // FRICTION-05/06: a signed-out visitor is told why, and sees no member tools.
    await page.goto(`${origin}/learn`);
    await expect(
      page.getByRole("status").filter({ hasText: "create an account" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: "create an account" }),
    ).toHaveCount(0);
    await page.goto(`${origin}/admin`);
    const navigation = page.getByRole("navigation", {
      name: "Main navigation",
    });
    await expect(
      navigation.getByRole("link", { name: "Sign out" }),
    ).toHaveCount(0);

    const token = randomBytes(32).toString("hex");
    await members.create(token, { background: "explorer", goal: "everyday" });
    await page
      .context()
      .addCookies([{ name: COOKIE, value: token, url: origin }]);

    // FRICTION-01: saving a draft lands on its confirmation, on any screen.
    await page.goto(`${origin}/lesson`);
    await page.locator("#instruction").fill("My invented draft instruction");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page).toHaveURL(/\/lesson#exercise-status$/);
    await expect(page.locator("#exercise-status")).toBeVisible();
    await expect.poll(() => inView(page, "#exercise-status")).toBe(true);

    // FRICTION-12: a plain checkbox stays large enough to use.
    await page.goto(`${origin}/workflow-feedback/WF-001`);
    const box = await page
      .locator('form input[type="checkbox"]')
      .first()
      .boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(18);

    // FRICTION-02: deletion is offered on My account and confirmed afterwards.
    await page.goto(`${origin}/account`);
    await page.getByRole("heading", { name: "Delete your account" }).waitFor();
    await page.locator('.account-delete input[name="confirm"]').check();
    await page.locator(".account-delete button").click();
    await expect(
      page.getByRole("status").filter({ hasText: "were deleted" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await closeLoopback(server);
  }
});
