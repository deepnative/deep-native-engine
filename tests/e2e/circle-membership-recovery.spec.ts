import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
test.afterAll(() => pool.end());
for (const [index, background] of (
  ["explorer", "professional", "technical"] as const
).entries()) {
  test(`[L${157 + index}] ${background} recovers uncertain circle join and leave without replaying membership generations`, async ({
    browser,
  }) => {
    // This prescribed matrix runs serially against its generated test database.
    // Match the existing circle capacity fixture; no preview/member database is used.
    await pool.query("TRUNCATE preview_circle_memberships");
    const db = store(pool),
      token = randomBytes(32).toString("hex");
    await db.create(token, {
      background,
      goal:
        background === "explorer"
          ? "everyday"
          : background === "technical"
            ? "build"
            : "work",
    });
    const session = await db.session(token);
    if (session.kind !== "active") throw Error("Missing invented member");
    let delayNextCommit = false;
    const outstanding: Promise<unknown>[] = [];
    const backend = circleStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && delayNextCommit) {
              delayNextCommit = false;
              const delay = pool.query("SELECT pg_sleep(2.5)");
              outstanding.push(delay);
              await delay;
            }
            return result;
          },
          release: (error?: Error) => client.release(error),
        };
      },
    } as unknown as Pool);
    const server = createServer((req, res) => application(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing listener");
    const origin = `http://127.0.0.1:${address.port}`,
      application = app(db, {
        origin,
        secret: "invented-circle-recovery",
        circles: backend,
      });
    const device = test.info().project.use;
    const context = await browser.newContext({
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    });
    try {
      await context.addCookies([
        { name: "dne_preview", value: token, url: origin },
      ]);
      const page = await context.newPage();
      await page.goto(origin + "/circles");
      const item = page.getByRole("listitem").filter({
        has: page.getByRole("heading", {
          name: "Everyday AI practice",
          exact: true,
        }),
      });
      const state = async () => ({
        membership: (
          await pool.query(
            "SELECT generation,joined_at,left_at FROM preview_circle_memberships WHERE member_id=$1",
            [session.learner.id],
          )
        ).rows,
        history: (
          await pool.query(
            "SELECT generation,joined_at,left_at FROM preview_circle_membership_history WHERE member_id=$1 ORDER BY generation",
            [session.learner.id],
          )
        ).rows,
      });
      await item
        .getByRole("button", { name: "Join Everyday AI practice", exact: true })
        .click();
      await page.reload();
      await expect(item).toContainText("You joined this local circle");
      await item
        .getByRole("button", {
          name: "Leave Everyday AI practice",
          exact: true,
        })
        .click();
      await page.reload();
      await expect(
        item.getByRole("button", {
          name: "Join Everyday AI practice",
          exact: true,
        }),
      ).toBeVisible();
      const departed = await state();
      expect(departed.membership[0]).toMatchObject({
        generation: "1",
        left_at: expect.any(Date),
      });
      for (const action of ["join", "leave"] as const) {
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
          [session.learner.id],
        );
        delayNextCommit = true;
        const [response] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.request().method() === "POST" && r.url().endsWith("/" + action),
          ),
          item
            .getByRole("button", {
              name: `${action === "join" ? "Join" : "Leave"} Everyday AI practice`,
              exact: true,
            })
            .click(),
        ]);
        expect(response.status()).toBe(503);
        await expect(
          page.getByRole("heading", {
            name: "Circle membership unconfirmed",
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.locator('form[method="post"]')).toHaveCount(0);
        await Promise.all(outstanding);
        const committed = await state();
        expect(committed.membership[0]).toMatchObject({
          generation: "2",
          left_at: action === "join" ? null : expect.any(Date),
        });
        expect(
          committed.history.filter((row) => row.generation === "1"),
        ).toEqual(departed.membership);
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
          [session.learner.id],
        );
        await page
          .getByRole("link", { name: "Check current membership", exact: true })
          .click();
        await page.reload();
        await expect(
          item.getByRole("button", {
            name: `${action === "join" ? "Leave" : "Join"} Everyday AI practice`,
            exact: true,
          }),
        ).toBeVisible();
        expect(await state()).toEqual(committed);
      }
    } finally {
      await context.close();
      await Promise.allSettled(outstanding);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.query("DELETE FROM principals WHERE id=$1", [
        session.learner.id,
      ]);
    }
  });
}
