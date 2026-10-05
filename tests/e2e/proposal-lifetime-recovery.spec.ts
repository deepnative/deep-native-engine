import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { app } from "../../src/app.ts";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
test.afterAll(() => pool.end());
for (const [index, background] of (
  ["explorer", "professional", "technical"] as const
).entries()) {
  test(`[L${154 + index}] ${background} recovers uncertain proposal creation, moderation and withdrawal without replay`, async ({
    browser,
  }) => {
    const db = store(pool),
      auth = authorizationStore(pool),
      owner = randomBytes(32).toString("hex"),
      moderator = randomBytes(32).toString("hex");
    await db.create(owner, {
      background,
      goal: background === "explorer" ? "everyday" : "work",
    });
    const session = await db.session(owner);
    if (session.kind !== "active") throw Error("Missing invented member");
    const staffId = await auth.provisionStaff(
      moderator,
      "moderator",
      new Date(Date.now() + 3600000),
    );
    let delayNextCommit = false;
    const outstanding: Promise<unknown>[] = [];
    const backend = proposalStore({
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
    const origin = `http://127.0.0.1:${address.port}`;
    const application = app(db, {
      origin,
      secret: "invented-proposal-recovery",
      proposals: backend,
      authorization: auth,
    });
    const device = test.info().project.use;
    const options = {
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    };
    const memberContext = await browser.newContext(options),
      staffContext = await browser.newContext(options);
    async function uncertain(
      page: Page,
      actor: string,
      button: string,
      heading: string,
    ) {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [actor],
      );
      delayNextCommit = true;
      const response = page.waitForResponse(
        (r) => r.request().method() === "POST",
      );
      await page.getByRole("button", { name: button, exact: true }).click();
      expect((await response).status()).toBe(503);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await expect(page.locator('form[method="post"]')).toHaveCount(0);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [actor],
      );
    }
    try {
      await memberContext.addCookies([
        { name: "dne_preview", value: owner, url: origin },
      ]);
      await staffContext.addCookies([
        { name: "dne_preview", value: moderator, url: origin },
      ]);
      const page = await memberContext.newPage(),
        staffPage = await staffContext.newPage();
      await page.goto(origin + "/contribute");
      await page
        .getByLabel("Title", { exact: true })
        .fill("Invented recovery sample");
      await page
        .getByLabel("Original sample", { exact: true })
        .fill("Invented private example");
      await page
        .getByLabel("Sources and rights notes", { exact: true })
        .fill("Original invented source");
      await page
        .getByLabel("I used only invented or sample information")
        .check();
      await uncertain(
        page,
        session.learner.id,
        "Save private draft",
        "Proposal creation unconfirmed",
      );
      await expect(
        page.getByText("repeating creation can make a second draft", {
          exact: false,
        }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Check current private state" })
        .click();
      const rows = (
        await pool.query("SELECT id FROM member_proposals WHERE member_id=$1", [
          session.learner.id,
        ])
      ).rows;
      expect(rows).toHaveLength(1);
      const id = rows[0].id as string;
      await page
        .getByRole("link", { name: "Invented recovery sample", exact: true })
        .click();
      await expect(
        page.getByText("Saved revision 1.", { exact: false }),
      ).toBeVisible();
      await page.getByLabel("I created this sample or have the rights").check();
      await page
        .getByRole("button", {
          name: "Submit to private moderation",
          exact: true,
        })
        .click();
      await expect(
        page.getByText("PRIVATE SAMPLE · SUBMITTED", { exact: true }),
      ).toBeVisible();
      await staffPage.goto(origin + "/moderate/proposals");
      await expect(
        staffPage.locator(`[data-proposal-id="${id}"]`),
      ).toBeVisible();
      await uncertain(
        staffPage,
        staffId,
        "Quarantine for review",
        "Proposal moderation unconfirmed",
      );
      await staffPage
        .getByRole("link", { name: "Check current private state" })
        .click();
      await expect(
        staffPage.locator(`[data-proposal-id="${id}"]`),
      ).toContainText("quarantined");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int count FROM proposal_audit WHERE proposal_id=$1 AND action='proposal_quarantined'",
            [id],
          )
        ).rows[0].count,
      ).toBe(1);
      await page.reload();
      await expect(
        page.getByText("This proposal is quarantined.", { exact: false }),
      ).toBeVisible();
      await page
        .getByLabel("Remove the proposal text and stop moderation.")
        .check();
      await uncertain(
        page,
        session.learner.id,
        "Withdraw and redact",
        "Proposal withdrawal unconfirmed",
      );
      await page
        .getByRole("link", { name: "Check current private state" })
        .click();
      await expect(
        page.getByText("PRIVATE SAMPLE · WITHDRAWN", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Invented private example", { exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await pool.query(
            "SELECT state,body FROM member_proposals WHERE id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ state: "withdrawn", body: null }]);
    } finally {
      await memberContext.close();
      await staffContext.close();
      await Promise.allSettled(outstanding);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
        [session.learner.id, staffId],
      ]);
    }
  });
}
