import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
test.afterAll(() => pool.end());
for (const [index, background] of (
  ["explorer", "professional", "technical"] as const
).entries()) {
  test(`[L${151 + index}] ${background} recovers committed private feedback after unconfirmed save and withdrawal without replay`, async ({
    browser,
  }) => {
    const token = randomBytes(32).toString("hex"),
      db = store(pool);
    await db.create(token, {
      background,
      goal: background === "explorer" ? "everyday" : "work",
    });
    const session = await db.session(token);
    if (session.kind !== "active") throw Error("Missing invented member");
    let delayNextCommit = false;
    const outstanding: Promise<unknown>[] = [];
    const backend = workflowFeedbackStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
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
    let application: ReturnType<typeof app>;
    const server = createServer((req, res) => application(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No local listener");
    const origin = `http://127.0.0.1:${address.port}`;
    application = app(db, {
      origin,
      secret: "invented-feedback-recovery",
      workflowFeedback: backend,
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
      await page.goto(origin + "/workflow-feedback/WF-001");
      for (const [revision, note] of [
        [0, "Invented first note"],
        [1, "Invented corrected note"],
      ] as const) {
        await page.getByLabel("Your private feedback on version 1").fill(note);
        await page
          .getByLabel("I am saving private feedback using only invented text")
          .check();
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
          [session.learner.id],
        );
        delayNextCommit = true;
        const reply = page.waitForResponse(
          (r) => r.url().endsWith("/save") && r.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Save private feedback" })
          .click();
        expect((await reply).status()).toBe(503);
        await expect(
          page.getByRole("heading", { name: "Feedback save unconfirmed" }),
        ).toBeVisible();
        expect(
          (
            await pool.query(
              "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
              [session.learner.id],
            )
          ).rows,
        ).toEqual([{ note, revision: revision + 1 }]);
        await pool.query(
          "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
          [session.learner.id],
        );
        await page.goto(origin + "/workflow-feedback/WF-001");
        await expect(
          page.getByLabel("Your private feedback on version 1"),
        ).toHaveValue(note);
      }
      await page.getByLabel("Remove my private note for version 1").check();
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [session.learner.id],
      );
      delayNextCommit = true;
      const reply = page.waitForResponse(
        (r) => r.url().endsWith("/withdraw") && r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Withdraw version 1 feedback" })
        .click();
      expect((await reply).status()).toBe(503);
      await expect(
        page.getByRole("heading", { name: "Feedback withdrawal unconfirmed" }),
      ).toBeVisible();
      expect(
        (
          await pool.query(
            "SELECT 1 FROM workflow_feedback WHERE member_id=$1",
            [session.learner.id],
          )
        ).rowCount,
      ).toBe(0);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [session.learner.id],
      );
      await page.goto(origin + "/workflow-feedback/WF-001");
      await expect(
        page.getByLabel("Your private feedback on version 1"),
      ).toHaveValue("");
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
