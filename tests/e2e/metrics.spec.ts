import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

test("[L47] operator sees labelled preview aggregates while a learner cannot read them", async ({
  browser,
  page,
}) => {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "operator",
    new Date(Date.now() + 86_400_000),
  );
  const operator = await browser.newContext({ baseURL: origin });
  await operator.addCookies([
    {
      name: "dne_preview",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  try {
    const baseline = await (
      await operator.request.get("/operator/metrics")
    ).json();
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await page
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await page.getByRole("link", { name: "Local circles" }).click();
    await page
      .getByRole("button", { name: "Join Everyday AI practice" })
      .click();
    const denied = await page.request.get("/operator/metrics");
    expect(denied.status()).toBe(403);
    const response = await operator.request.get("/operator/metrics");
    expect(response.status()).toBe(200);
    const report = await response.json();
    expect(report.scope).toBe("synthetic-local-preview");
    expect(report.counts.members).toBe(baseline.counts.members + 1);
    expect(report.counts.participated).toBe(baseline.counts.participated + 1);
    expect(report.definitions.participated).toContain(
      "Leaving does not remove",
    );
    expect(JSON.stringify(report)).not.toContain("token_hash");
  } finally {
    await operator.close();
  }
});
