import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

test("[F-BUILD-10-C] pending save and uncertain storage result recover without duplicate work", async ({
  page,
}, info) => {
  const n = info.project.name === "desktop-chromium" ? 1 : 2;
  const contentId = `BCT-90${n}`;
  const title = `Invented pending save ${n}`;
  const response = `Invented response ${randomBytes(6).toString("hex")}`;
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id: contentId,
    version: 1,
    kind: "assignment",
    origin: "curated",
    title,
    body: "Write a private invented response to this sample brief.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: "Compare the response with the invented brief.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, contentId, 1)).toBe(true);
  expect(await catalog.approve(reviewer, contentId, 1, true)).toBe(true);
  expect(await catalog.publish(editor, contentId, 1)).toBe(true);

  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await choices
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  const attemptId = page.url().split("/").at(-1)!;
  expect(attemptId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByLabel("Private sample response").fill(response);
  await page.getByLabel("I used only invented or sample information").check();

  // Scope the fault to this attempt; the request still passes through the real
  // browser, Express handler and PostgreSQL update path.
  await pool.query(
    `CREATE FUNCTION test_reject_b10c_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${attemptId}'::uuid THEN
          RAISE EXCEPTION 'synthetic attempt write fault';
        END IF;
        RETURN NEW;
      END $$`,
  );
  await pool.query(
    "CREATE TRIGGER test_reject_b10c_update BEFORE UPDATE ON assignment_attempts FOR EACH ROW EXECUTE FUNCTION test_reject_b10c_update()",
  );
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/assignments/attempts/${attemptId}/save`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  // Observe the product DOM after its submit handler, before navigation.
  // Playwright's normal page queries wait for the held navigation to finish.
  await page.evaluate(() => {
    const form = document.querySelector("form[data-attempt-save]");
    if (!form) throw new Error("Assignment save form missing");
    form.addEventListener("submit", () => {
      const status = form.querySelector('[role="status"]');
      const button = form.querySelector('button[type="submit"]');
      console.info(
        "__B10C_PENDING__" +
          JSON.stringify({
            text: status?.textContent,
            hidden: status?.hasAttribute("hidden"),
            live: status?.getAttribute("aria-live"),
            disabled: button?.hasAttribute("disabled"),
            prematureSuccess: document.body.textContent?.includes(
              "private draft saved",
            ),
          }),
      );
    });
  });
  try {
    await requiredCheck(1, async () => {
      const pendingMessage = page.waitForEvent("console", {
        predicate: (message) =>
          message.type() === "info" &&
          message.text().startsWith("__B10C_PENDING__"),
      });
      const saveRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith(`/${attemptId}/save`) &&
          request.method() === "POST",
      );
      const saveClick = page
        .getByRole("button", { name: "Save private draft" })
        .click();
      const pendingState = JSON.parse(
        (await pendingMessage).text().slice("__B10C_PENDING__".length),
      );
      await saveRequest;
      expect(pendingState).toEqual({
        text: "Saving private draft… Please wait; the result is not confirmed.",
        hidden: false,
        live: "polite",
        disabled: true,
        prematureSuccess: false,
      });
      const pending = await pool.query(
        "SELECT response,revision,saved_at FROM assignment_attempts WHERE id=$1",
        [attemptId],
      );
      expect(pending.rows).toMatchObject([
        { response: "", revision: 1, saved_at: null },
      ]);
      release?.();
      await saveClick;
    });
    await requiredCheck(2, async () => {
      await expect(
        page.getByRole("heading", { name: "Save outcome unknown" }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toContainText(
        "The storage result could not be confirmed.",
      );
      await expect(
        page.getByLabel("Response to copy before leaving this page"),
      ).toHaveValue(response);
      const unchanged = await pool.query(
        "SELECT response,revision,saved_at FROM assignment_attempts WHERE id=$1",
        [attemptId],
      );
      expect(unchanged.rows).toMatchObject([
        { response: "", revision: 1, saved_at: null },
      ]);
      await pool.query(
        "DROP TRIGGER test_reject_b10c_update ON assignment_attempts",
      );
      await pool.query("DROP FUNCTION test_reject_b10c_update()");
      await page.unroute(`**/assignments/attempts/${attemptId}/save`);
      await page.getByRole("link", { name: "Reload this attempt" }).click();
      await expect(page.getByLabel("Private sample response")).toHaveValue("");
      await page.getByLabel("Private sample response").fill(response);
      await page
        .getByLabel("I used only invented or sample information")
        .check();
      await page.getByRole("button", { name: "Save private draft" }).click();
      await expect(page.getByLabel("Private sample response")).toHaveValue(
        response,
      );
      const saved = await pool.query(
        "SELECT response,revision,saved_at FROM assignment_attempts WHERE id=$1",
        [attemptId],
      );
      expect(saved.rows).toMatchObject([{ response, revision: 2 }]);
      expect(saved.rows[0]!.saved_at).not.toBeNull();
    });
  } finally {
    release?.();
    await pool.query(
      "DROP TRIGGER IF EXISTS test_reject_b10c_update ON assignment_attempts",
    );
    await pool.query("DROP FUNCTION IF EXISTS test_reject_b10c_update()");
  }
});
