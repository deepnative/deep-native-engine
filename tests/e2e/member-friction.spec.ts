import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
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

test("[L289] FRICTION-01/02/05/06/12 READABLE-01..03 a member sees what happened after saving, leaving and deleting", async ({
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

    // READABLE-01..03: one text style in the plan, and links with room to breathe.
    await page.goto(`${origin}/learn`);
    const planText = await page
      .locator(".learning-plan > p:not(.eyebrow), .learning-plan li")
      .evaluateAll((items) =>
        items.map((item) => {
          const style = getComputedStyle(item);
          return `${style.fontSize} ${style.color}`;
        }),
      );
    expect(planText.length).toBeGreaterThan(2);
    expect([...new Set(planText)]).toEqual([planText[0]]);
    expect(planText[0]).toContain("16px");
    const links = await page.locator(".learning-links a").evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      }),
    );
    expect(links.length).toBeGreaterThanOrEqual(11);
    for (const [index, link] of links.entries()) {
      expect(link.height).toBeGreaterThanOrEqual(24);
      const below = links
        .slice(index + 1)
        .filter((other) => other.top > link.top + 1);
      if (below.length)
        expect(
          Math.min(...below.map((other) => other.top)),
        ).toBeGreaterThanOrEqual(link.bottom + 6);
    }
    await expect(
      page.locator(".learning-links").getByRole("heading"),
    ).toHaveCount(3);
    await page.screenshot({
      path: `artifacts/member-learning-links-${test.info().project.name}.png`,
      fullPage: true,
    });

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

test("[L291] READWIDTH-01..03 reading pages use the page width and forms stay comfortable", async ({
  page,
}) => {
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-reading-width-browser",
      memberEmail: memberEmailAccess(pool, { async send() {} }, origin),
    }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test listener");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background: "explorer", goal: "everyday" });
    await page
      .context()
      .addCookies([{ name: COOKIE, value: token, url: origin }]);
    const wide = page.viewportSize()!.width >= 1000;
    for (const [path, selector] of [
      ["/readiness", ".error-page p:not(.eyebrow)"],
      ["/lesson/guide", ".guidance .lead"],
      ["/lesson", ".lesson-heading .lead"],
      ["/milestones", ".milestone-page .lead"],
      ["/career", ".career-page .lead"],
    ] as const) {
      await page.goto(`${origin}${path}`);
      await page.screenshot({
        path: `artifacts/reading-width${path.replace(/\//g, "-")}-${test.info().project.name}.png`,
        fullPage: true,
      });
      // READWIDTH-03: no page scrolls sideways at any width.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
      if (!wide) continue;
      // READWIDTH-01: text boxes reach the same right edge as the page.
      const [text, main] = await Promise.all([
        page.locator(selector).first().boundingBox(),
        page.locator("main").evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            element.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)
          );
        }),
      ]);
      expect(text!.width, path).toBeGreaterThanOrEqual(main - 1);
    }
    // READWIDTH-02: a short form does not stretch across the page.
    await page.goto(`${origin}/email/attach`);
    const form = await page.locator(".error-page form").first().boundingBox();
    expect(form!.width).toBeLessThanOrEqual(620);
    await page.screenshot({
      path: `artifacts/reading-width-email-${test.info().project.name}.png`,
      fullPage: true,
    });
  } finally {
    await closeLoopback(server);
  }
});
