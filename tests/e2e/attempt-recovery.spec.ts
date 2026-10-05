import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
test.afterAll(() => pool.end());
async function publishAssignment(id: string) {
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
    kind: "assignment",
    origin: "curated",
    title: "Invented private recovery assignment",
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
  test(`[L${163 + index}] ${background} recovers private attempt changes and history without replay`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const db = store(pool),
      credential = randomBytes(32).toString("hex");
    const contentId = `SYN-${772 + index * 2 + (test.info().project.name === "desktop-chromium" ? 0 : 1)}`;
    await publishAssignment(contentId);
    await db.create(credential, {
      background,
      goal:
        background === "explorer"
          ? "everyday"
          : background === "technical"
            ? "build"
            : "work",
    });
    const session = await db.session(credential);
    if (session.kind !== "active") throw Error("Missing invented learner");
    expect(await db.chooseAssignment(session.learner.id, contentId, 1)).toBe(
      true,
    );
    let commitsToDelay = 0;
    const outstanding: Promise<unknown>[] = [];
    const backend = attemptStore({
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (
              sql === "COMMIT" &&
              commitsToDelay > 0 &&
              --commitsToDelay === 0
            ) {
              const delay = pool.query("SELECT pg_sleep(2.5)");
              outstanding.push(delay);
              await delay;
            }
            return result;
          },
          release: (error?: Error | boolean) => client.release(error),
        };
      },
    } as unknown as Pool);
    const server = createServer((req, res) => application(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const application = app(db, {
      origin,
      secret: "invented-attempt-browser-recovery",
      attempts: backend,
      catalog: catalogStore(pool),
    });
    const device = test.info().project.use;
    const context = await browser.newContext({
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    });
    const state = async () =>
      (
        await pool.query(
          `SELECT a.*,COALESCE((SELECT jsonb_agg(s ORDER BY s.sequence) FROM assignment_submission_snapshots s WHERE s.attempt_id=a.id),'[]'::jsonb) snapshots, COALESCE((SELECT jsonb_agg(r ORDER BY r.sequence) FROM assignment_submission_reflections r WHERE r.attempt_id=a.id),'[]'::jsonb) reflections FROM assignment_attempts a WHERE member_id=$1 ORDER BY id`,
          [session.learner.id],
        )
      ).rows;
    try {
      await context.addCookies([
        { name: "dne_preview", value: credential, url: origin },
      ]);
      const page = await context.newPage();
      for (const uncertain of [false, true]) {
        await page.goto(origin + "/learn");
        let id = "";
        for (const action of [
          "start",
          "save",
          "submit",
          "reflection-save",
          "reflection-delete",
          "revise",
          "remove",
        ] as const) {
          const names = {
            start: "Start or return to this private attempt",
            save: "Save private draft",
            submit: "Submit saved version locally",
            "reflection-save": "Save private reflection for submission 1",
            "reflection-delete": "Delete reflection 1",
            revise: "Revise privately",
            remove: "Delete attempt",
          };
          const name = names[action];
          const form = page
            .locator("form")
            .filter({ has: page.getByRole("button", { name, exact: true }) });
          if (action === "save")
            await form
              .getByLabel("Private sample response")
              .fill(
                `Invented private response for ${background}; verify this exact source.`,
              );
          if (action === "reflection-save")
            await form
              .getByLabel("Evidence I can point to")
              .fill(`Invented retained reflection for ${background}`);
          const confirmation = form.locator('input[type="checkbox"]');
          if (await confirmation.count()) await confirmation.check();
          if (uncertain) {
            await pool.query(
              "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
              [session.learner.id],
            );
            commitsToDelay = [
              "save",
              "submit",
              "reflection-save",
              "reflection-delete",
              "revise",
            ].includes(action)
              ? 2
              : 1;
          }
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.request().method() === "POST" &&
                r.url().includes("/assignments/attempts/"),
            ),
            form.getByRole("button", { name, exact: true }).click(),
          ]);
          expect(response.status()).toBe(uncertain ? 503 : 303);
          await Promise.all(outstanding);
          const durable = await state();
          expect(durable).toHaveLength(action === "remove" ? 0 : 1);
          if (action === "start") id = durable[0].id;
          if (action === "save")
            expect(durable[0]).toMatchObject({
              revision: 2,
              response: `Invented private response for ${background}; verify this exact source.`,
            });
          if (action === "submit") expect(durable[0].snapshots).toHaveLength(1);
          if (action === "reflection-save")
            expect(durable[0].reflections[0]).toMatchObject({
              revision: 1,
              evidence: `Invented retained reflection for ${background}`,
            });
          if (action === "reflection-delete")
            expect(durable[0].reflections[0]).toMatchObject({
              revision: 2,
              evidence: "",
            });
          if (action === "revise") {
            expect(durable[0]).toMatchObject({
              revision: 3,
              response: "",
              submitted_at: null,
            });
            expect(durable[0].snapshots).toHaveLength(1);
          }
          if (uncertain) {
            const title =
              action === "save"
                ? "Save outcome unknown"
                : action === "submit"
                  ? "Submission outcome unknown"
                  : action === "revise"
                    ? "Revision outcome unknown"
                    : action.startsWith("reflection-")
                      ? "Reflection outcome unknown"
                      : "Assignment attempt unconfirmed";
            await expect(
              page.getByRole("heading", { name: title, exact: true }),
            ).toBeVisible();
            await expect(page.locator("form")).toHaveCount(0);
            await expect(page.locator("body")).not.toContainText(
              "Invented private recovery assignment",
            );
            await expect(
              page.getByRole("region", {
                name: "Private local submission history",
              }),
            ).toHaveCount(0);
            if (action === "save" || action === "submit") {
              const copy = page.getByLabel(
                "Response to copy before leaving this page",
              );
              await expect(copy).toHaveValue(
                `Invented private response for ${background}; verify this exact source.`,
              );
              await expect(copy).toHaveAttribute("readonly", "");
            } else
              await expect(page.locator("body")).not.toContainText(
                `Invented private response for ${background}`,
              );
            if (action === "reflection-save") {
              const copy = page.getByLabel("Evidence I can point to, to copy", {
                exact: true,
              });
              await expect(copy).toHaveValue(
                `Invented retained reflection for ${background}`,
              );
              await expect(copy).toHaveAttribute("readonly", "");
            } else
              await expect(page.locator("body")).not.toContainText(
                `Invented retained reflection for ${background}`,
              );
            await pool.query(
              "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
              [session.learner.id],
            );
            if (action === "start" || action === "remove") {
              await page
                .getByRole("link", {
                  name: "Check current private attempts",
                  exact: true,
                })
                .click();
              if (action !== "remove")
                await page
                  .locator(`a[href="/assignments/attempts/${id}"]`)
                  .click();
            } else
              await page
                .getByRole("link", {
                  name: action.startsWith("reflection-")
                    ? "Inspect the current saved attempt"
                    : "Reload this attempt",
                  exact: true,
                })
                .click();
          }

          if (action === "remove")
            await expect(
              page.getByText("No private assignment attempts yet"),
            ).toBeVisible();
          else
            await expect(
              page.getByRole("heading", {
                name: "Invented private recovery assignment",
                exact: true,
              }),
            ).toBeVisible();
          if (
            action === "submit" ||
            action.startsWith("reflection-") ||
            action === "revise"
          )
            await expect(
              page.getByRole("region", {
                name: "Private local submission history",
              }),
            ).toContainText(`Invented private response for ${background}`);
          if (action === "reflection-save")
            await expect(
              page.getByLabel("Evidence I can point to"),
            ).toHaveValue(`Invented retained reflection for ${background}`);
          if (action === "reflection-delete")
            await expect(
              page.getByText("This private reflection was deleted.", {
                exact: false,
              }),
            ).toBeVisible();
          await page.reload();
          expect(await state()).toEqual(durable);
        }
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
