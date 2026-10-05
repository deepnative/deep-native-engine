import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { usefulnessStore } from "../../src/usefulness.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
test.afterAll(() => pool.end());
async function publishLesson(id: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented practical step",
    body: "Choose a practical next step using invented facts only.",
    owner: "Synthetic editor",
    sources: "Original invented source",
    rights: "Owned synthetic text",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
  return { catalog, editor };
}

for (const [index, background] of (
  ["explorer", "professional", "technical"] as const
).entries()) {
  test(`[L${160 + index}] ${background} recovers private usefulness mutations without replay`, async ({
    browser,
  }) => {
    const db = store(pool),
      token = randomBytes(32).toString("hex");
    // Reserve SYN-760..765 for this fixture; assignment history owns 860..862.
    const lessonId = `SYN-${760 + index * 2 + (test.info().project.name === "desktop-chromium" ? 0 : 1)}`;
    await publishLesson(lessonId);
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
    if (session.kind !== "active") throw Error("Missing invented learner");
    await db.openLesson(session.learner.id, lessonId, 1);
    await db.advanceLesson(session.learner.id, lessonId, 1, "start");
    await db.advanceLesson(session.learner.id, lessonId, 1, "complete");
    let delayNext = false;
    const outstanding: Promise<unknown>[] = [];
    const backend = usefulnessStore({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && delayNext) {
              delayNext = false;
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
    if (!address || typeof address === "string") throw Error("No listener");
    const origin = `http://127.0.0.1:${address.port}`,
      application = app(db, {
        origin,
        secret: "invented-usefulness-recovery",
        usefulness: backend,
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
      await page.goto(origin + "/progress");
      const activity = page.getByRole("listitem").filter({
        has: page.getByRole("heading", { name: "Invented practical step" }),
      });
      const state = async () =>
        (
          await pool.query(
            "SELECT * FROM lesson_usefulness WHERE member_id=$1",
            [session.learner.id],
          )
        ).rows;
      for (const uncertain of [false, true])
        for (const action of ["save", "correct", "withdraw"] as const) {
          if (action !== "withdraw")
            await activity
              .getByLabel("Your answer")
              .selectOption(action === "save" ? "helpful" : "not_yet");
          // The withdrawal confirmation belongs to its separate form.
          const name =
            action === "save"
              ? "Save my usefulness answer"
              : action === "correct"
                ? "Correct my usefulness answer"
                : "Withdraw my usefulness answer";
          const form = activity
            .locator("form")
            .filter({ has: page.getByRole("button", { name, exact: true }) });
          await form.locator('input[name="confirm"]').check();
          if (uncertain) {
            await pool.query(
              "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
              [session.learner.id],
            );
            delayNext = true;
          }
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.request().method() === "POST" &&
                r.url().endsWith("/usefulness"),
            ),
            form.getByRole("button", { name, exact: true }).click(),
          ]);
          expect(response.status()).toBe(uncertain ? 503 : 303);
          await Promise.all(outstanding);
          const durable = await state();
          expect(durable).toHaveLength(action === "withdraw" ? 0 : 1);
          if (action !== "withdraw")
            expect(durable[0]).toMatchObject({
              choice: action === "save" ? "helpful" : "not_yet",
              revision: action === "save" ? 1 : 2,
            });
          if (uncertain) {
            await expect(
              page.getByRole("heading", {
                name: "Usefulness response unconfirmed",
              }),
            ).toBeVisible();
            await expect(page.locator("form")).toHaveCount(0);
            await pool.query(
              "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
              [session.learner.id],
            );
            await page
              .getByRole("link", {
                name: "Check current private activity",
                exact: true,
              })
              .click();
          }
          if (action === "withdraw")
            await expect(activity).not.toContainText("Your current answer:");
          else
            await expect(activity).toContainText(
              action === "save"
                ? "Helpful for my next step"
                : "Not helpful yet",
            );
          await page.waitForLoadState("load");
          await page.reload();
          await expect(activity).toBeVisible();
          expect(await state()).toEqual(durable);
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
