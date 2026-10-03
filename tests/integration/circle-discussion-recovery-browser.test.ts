import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { COOKIE } from "../../src/session.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool),
  secret = "invented-browser-recovery-secret";
let browser: Browser;
beforeAll(async () => {
  await migrate(pool);
  browser = await chromium.launch();
});
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => {
  try {
    if (browser) await browser.close();
  } finally {
    await pool.end();
  }
});
for (const [background, goal, circle] of [
  ["explorer", "everyday", "everyday-ai"],
  ["professional", "work", "professional-work"],
  ["technical", "build", "technical-practice"],
] as const)
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 393, height: 851 },
  ])
    it(`recovers a committed but unconfirmed ${background} contribution at ${viewport.width}px using its original key`, async () => {
      const token = randomBytes(32).toString("hex");
      await members.create(token, { background, goal });
      const session = await members.session(token);
      if (session.kind !== "active")
        throw Error("Invented browser member missing");
      expect(await circles.join(token, circle)).toBe("joined");
      const healthy = circleDiscussionStore(pool, secret);
      expect(
        (
          await healthy.choose(
            token,
            circle,
            randomUUID(),
            "1",
            CIRCLE_DISCUSSION_POLICY,
            true,
          )
        ).kind,
      ).toBe("ready");
      let commitAttempts = 0;
      const faultPool = {
        connect: async () => {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return async (sql: string, values: unknown[] = []) => {
                  const result = await target.query(sql, values);
                  if (sql === "COMMIT") {
                    commitAttempts++;
                    throw Error("Invented acknowledgement loss after commit");
                  }
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      } as unknown as Pool;
      const faulty = circleDiscussionStore(faultPool, secret);
      const options = {
        origin: "http://127.0.0.1",
        secret,
        circles,
        circleDiscussion: { ...healthy, post: faulty.post },
        circleDiscussionEnabled: true,
      };
      const server = await listenLoopback(app(members, options));
      options.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const context = await browser.newContext({ viewport });
      try {
        await context.addCookies([
          { name: COOKIE, value: token, url: options.origin },
        ]);
        const page = await context.newPage();
        await page.goto(`${options.origin}/circles/${circle}/discussion`);
        const key = await page
          .locator('form[action$="/posts"] input[name="idempotencyKey"]')
          .inputValue();
        await page
          .getByLabel("Your invented question (up to 2,000 characters)")
          .fill("Invented recovery question, never submit twice");
        await page
          .getByLabel(
            "I used only invented information and choose to share it with this circle.",
          )
          .check();
        await page
          .getByRole("button", { name: "Share question", exact: true })
          .click();
        expect(
          await page
            .getByRole("heading", { name: "Circle result unconfirmed" })
            .isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByRole("link", { name: "Check the original form key" })
            .getAttribute("href"),
        ).toContain(key);
        expect(await page.locator("body").innerText()).not.toContain(
          "Invented recovery question",
        );
        await page
          .getByRole("link", { name: "Check the original form key" })
          .click();
        expect(await page.getByRole("status").innerText()).toContain(
          "Original-key receipt: visible",
        );
        await page
          .getByRole("link", { name: "Inspect your retained contributions" })
          .click();
        expect(
          await page.locator("pre.content-text").allTextContents(),
        ).toEqual(["Invented recovery question, never submit twice"]);
        expect(commitAttempts).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT count(*)::integer n FROM preview_circle_posts WHERE member_id=$1",
              [session.learner.id],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        await page
          .getByLabel(
            "Withdraw this contribution's text; a content-free marker remains until account deletion.",
          )
          .check();
        await page
          .getByRole("button", { name: "Withdraw contribution", exact: true })
          .click();
        await page.goto(
          `${options.origin}/circles/${circle}/discussion/reconcile?kind=post&key=${key}`,
        );
        expect(await page.getByRole("status").innerText()).toContain(
          "withdrawn",
        );
        expect(await page.locator("body").innerText()).not.toContain(
          "Invented recovery question",
        );
      } finally {
        try {
          await context.close();
        } finally {
          await closeLoopback(server);
        }
      }
    }, 30000);
