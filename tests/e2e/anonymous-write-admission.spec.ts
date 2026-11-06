import { test, expect, request as apiRequest } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { ANONYMOUS_WRITE_LIMITS } from "../../src/anonymous-write-admission.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
// Desktop and mobile each fill and clear the visitor counts; one at a time, so
// clearing the counts can't change the other's result.
const JOURNEY_LOCK = 728_300;
test.afterAll(async () => {
  await pool.end();
});

test("[L300] ANON-01/07 a visitor past the signup allowance keeps their answers and starts after waiting", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock($1)", [JOURNEY_LOCK]);
  try {
    // A documentation-range address of its own, as the hosted ingress reports it.
    const address = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    const headers = { "X-Forwarded-For": address, Origin: baseURL! };
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": address });

    // Earlier starts from the same address use the whole allowance.
    for (let i = 0; i < ANONYMOUS_WRITE_LIMITS.signup.perVisitor; i++) {
      const earlier = await apiRequest.newContext({
        baseURL: baseURL!,
        extraHTTPHeaders: headers,
      });
      const form = await (await earlier.get("/")).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)![1]!;
      const started = await earlier.post("/start", {
        form: {
          csrf,
          display_name: `Earlier learner ${i}`,
          background: "explorer",
          goal: "everyday",
        },
        maxRedirects: 0,
      });
      expect(started.status()).toBe(303);
      await earlier.dispose();
    }

    await page.goto("/");
    await page.getByLabel("Display name").fill("Invented Learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    const submit = page.getByRole("button", { name: "Start my learning path" });
    const [refused] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/start")),
      submit.click(),
    ]);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toContainText(
      "Too many new accounts have been started from this network.",
    );
    await expect(page.getByLabel("Display name")).toHaveValue(
      "Invented Learner",
    );
    await expect(page.getByLabel("Your starting point")).toHaveValue(
      "explorer",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    // The window ends; the same page's form now starts normally.
    await lock.query(
      "DELETE FROM anonymous_write_windows WHERE kind='signup' AND subject<>'service'",
    );
    await submit.click();
    await expect(page).toHaveURL(/\/learn$/);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [JOURNEY_LOCK]);
    lock.release();
  }
});
