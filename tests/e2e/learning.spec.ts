import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { readdir } from "node:fs/promises";
const pool = testPool();
const origin = "http://127.0.0.1:4317";
const instruction =
  "Using only the sample details, create a short plan with clear actions and flag any missing information.";
const verification =
  "Compare every detail against the supplied sample, check the limits, and correct any unsupported claims.";
test("[L24] foundation and coaching hypotheses agree across page and server", async ({
  page,
}) => {
  await page.goto("/readiness");
  await page
    .getByRole("link", { name: "Access and coaching planning" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Access and coaching planning" }),
  ).toBeVisible();
  await expect(page.getByText("NO LIVE PURCHASE")).toBeVisible();
  await expect(
    page.getByText("approved a no-purchase private/local preview", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("production terms remain undecided", { exact: false }),
  ).toBeVisible();
  const response = await page.request.get("/api/offer-hypotheses");
  expect(response.ok()).toBe(true);
  const catalog = await response.json();
  expect(catalog.foundation.interimDecision).toBe(
    "approved-no-purchase-private-preview",
  );
  expect(catalog.foundation.live).toBe("pending-owner-decision");
  expect(catalog.foundation.liveActivationEnabled).toBe(false);
  expect(catalog.foundation.priceCents).toBeNull();
  expect(catalog.foundation.participationLimit).toBeNull();
  expect(catalog.foundation.aiAllowance).toBeNull();
  for (const offer of catalog.coaching) {
    expect(offer.livePurchasable).toBe(false);
    await expect(
      page.getByText(
        new RegExp(
          `${offer.id}.*${(offer.priceCents / 100).toLocaleString("en-CA")}`,
        ),
      ),
    ).toBeVisible();
    await expect(
      page.getByText(offer.termsVersion, { exact: false }).first(),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: /buy|purchase|accept/i }),
  ).toHaveCount(0);
  expect((await page.request.get("/checkout")).status()).toBe(404);
});
test.afterAll(async () => {
  await pool.end();
});
async function begin(page: Page, background = "explorer", goal = "everyday") {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await page.getByRole("link", { name: "Open lesson" }).click();
}
async function fill(page: Page) {
  await page.getByLabel("Your instruction to AI").fill(instruction);
  await page.getByLabel("How will you check the result?").fill(verification);
}
async function session(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (c) => c.name === "dne_preview",
  )!;
  const hash = createHash("sha256").update(cookie.value).digest("hex");
  const rows = await pool.query("SELECT id FROM learners WHERE token_hash=$1", [
    hash,
  ]);
  return { cookie, id: rows.rows[0]?.id as string };
}
async function staff(role: StaffRole) {
  const credential = randomBytes(32).toString("hex");
  return {
    token: credential,
    id: await authorizationStore(pool).provisionStaff(
      credential,
      role,
      new Date(Date.now() + 86_400_000),
    ),
  };
}
async function useToken(context: BrowserContext, value: string) {
  await context.clearCookies();
  await context.addCookies([
    {
      name: "dne_preview",
      value,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function csrfToken(page: Page) {
  return page.locator('input[name="csrf"]').first().inputValue();
}
async function uploadEvidence(
  page: Page,
  csrf: string,
  options: {
    name?: string;
    type?: string;
    scopes?: string;
    circle?: string;
    rights?: boolean;
    data?: Buffer;
  } = {},
) {
  const headers: Record<string, string> = {
    Origin: origin,
    "X-CSRF-Token": csrf,
    "Content-Type": options.type ?? "text/plain",
    "X-Evidence-Name": options.name ?? "sample.txt",
    "X-Evidence-Rights": options.rights === false ? "missing" : "confirmed",
    "X-Evidence-Scopes": options.scopes ?? "private-review",
  };
  if (options.circle) headers["X-Learning-Circle-Id"] = options.circle;
  return page.request.post("/api/evidence", {
    headers,
    data: options.data ?? Buffer.from("Synthetic private evidence"),
  });
}
for (const [id, background, goal, title] of [
  ["L01", "explorer", "everyday", "Plan a small community event"],
  ["L02", "professional", "work", "Turn meeting notes into next steps"],
  ["L03", "technical", "build", "Review a sign-up flow"],
] as const) {
  test(`[${id}] ${background} completes a suitable learning exercise`, async ({
    page,
  }, testInfo) => {
    await begin(page, background, goal);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await fill(page);
    await page.getByLabel("I checked the context").check();
    await page.getByRole("button", { name: "Complete exercise" }).click();
    await expect(
      page.getByText("Exercise completed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No AI or qualified reviewer", { exact: false }),
    ).toBeVisible();
    await page.getByRole("link", { name: "See your progress" }).click();
    await expect(page.getByText("Completed · self-assessed")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("progressbar", { name: "Exercises completed" }),
    ).toHaveAttribute("value", "1");
    if (id === "L01")
      await page.screenshot({
        path: `artifacts/learning-${testInfo.project.name}.png`,
        fullPage: true,
      });
  });
}
for (const [id, background, goal, extraName, extraValue] of [
  ["L21", "explorer", "everyday", "domain_tags", "education"],
  ["L22", "professional", "work", "background_tags", "technical"],
  ["L23", "technical", "build", "it_roles", "security"],
] as const) {
  test(`[${id}] ${background} can revise direction while keeping original practice`, async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await page.getByLabel("Your starting point").selectOption(background);
    await page.getByLabel("What would you like to do?").selectOption(goal);
    await page
      .locator(`input[name="${extraName}"][value="${extraValue}"]`)
      .check();
    await page.getByLabel("Experience with AI").selectOption("some");
    await page.getByLabel("Keep an exploratory path open").check();
    await page.getByLabel("I'll use invented or sample information").check();
    await page.getByRole("button", { name: "Start my learning path" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    const { id: learnerId } = await session(context);
    const initial = await pool.query("SELECT * FROM learners WHERE id=$1", [
      learnerId,
    ]);
    expect(initial.rows[0][extraName]).toContain(extraValue);
    expect(initial.rows[0].experience).toBe("some");
    expect(initial.rows[0].exploratory).toBe(true);
    await page.getByRole("link", { name: "Open lesson" }).click();
    const originalTitle = await page.locator("#exercise-title").innerText();
    await page
      .getByLabel("Your instruction to AI")
      .fill("A sample draft that must retain its original context");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByRole("link", { name: "Your learning path" }).click();
    await page
      .getByLabel("What would you like to do?")
      .selectOption(goal === "everyday" ? "work" : "everyday");
    await page.getByRole("button", { name: "Save my direction" }).click();
    await expect(page).toHaveURL(/\/learn$/);
    await page.reload();
    await page.getByRole("link", { name: "Open lesson" }).click();
    await expect(page.locator("#exercise-title")).not.toHaveText(originalTitle);
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
    await expect(
      page.getByText("A sample draft that must retain its original context", {
        exact: true,
      }),
    ).toBeVisible();
  });
}
test("[L29] exploratory learner revises a time-fitting plan without rewriting saved practice", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("Experience with AI").selectOption("new");
  await page.getByLabel("Time zone (optional)").fill("UTC");
  await page.getByLabel("Weekly time available").selectOption("15");
  await page.getByLabel("Keep an exploratory path open").check();
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const plan = page.getByRole("region", { name: "Your starter plan" });
  await expect(plan).toContainText("Plan a small community event");
  await expect(plan.locator("li")).toHaveCount(1);
  await expect(plan).toContainText("Next session: try the sample exercise");
  await expect(plan).toContainText("another direction later");
  await page.reload();
  await expect(page.getByLabel("Weekly time available")).toHaveValue("15");
  await page.getByRole("link", { name: "Open lesson" }).click();
  await page
    .getByLabel("Your instruction to AI")
    .fill("A sample draft for the community event");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Your learning path" }).click();
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByLabel("Experience with AI").selectOption("some");
  await page.getByLabel("Time zone (optional)").fill("America/Toronto");
  await page.getByLabel("Weekly time available").selectOption("60");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(plan).toContainText("Turn meeting notes into next steps");
  await expect(plan.locator("li")).toHaveCount(3);
  await expect(plan).toContainText("America/Toronto");
  await page.getByRole("link", { name: "Open lesson" }).click();
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
  await expect(
    page.getByText("A sample draft for the community event", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#exercise-title")).toHaveText(
    "Turn meeting notes into next steps",
  );
});

test("[L101] completed starter plan advances without attributing an earlier goal to a new one", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("Weekly time available").selectOption("15");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const plan = page.getByRole("region", { name: "Your starter plan" });
  await expect(plan).toContainText("Next session: try the sample exercise");
  await page.getByRole("link", { name: "Open lesson" }).click();
  await fill(page);
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await page.getByRole("link", { name: "See your progress" }).click();
  await page.reload();
  await expect(
    plan
      .getByRole("status")
      .filter({ hasText: "completed for your current goal" }),
  ).toContainText("completed for your current goal");
  await expect(plan).not.toContainText("try the sample exercise");
  await expect(
    plan.getByRole("link", { name: "Review saved starter exercise" }),
  ).toHaveAttribute("href", "/lesson");
  await plan
    .getByRole("link", { name: "Review saved starter exercise" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/lesson$/);
  await page.goBack();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto("/");
    await other.getByLabel("Your starting point").selectOption("explorer");
    await other
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await other.getByLabel("Weekly time available").selectOption("15");
    await other.getByLabel("I'll use invented or sample information").check();
    await other.getByRole("button", { name: "Start my learning path" }).click();
    await expect(
      other.getByRole("region", { name: "Your starter plan" }),
    ).toContainText("Next session: try the sample exercise");
  } finally {
    await otherContext.close();
  }
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await expect(plan).toContainText("Turn meeting notes into next steps");
  await expect(plan).not.toContainText("completed for your current goal");
  await expect(plan).toContainText("Next session: try the sample exercise");
  await page.getByRole("link", { name: "Open lesson" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/lesson$/);
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
});
test("[L30] professional can correct an invalid time zone and retain a noncoding 30-minute plan", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByLabel("Experience with AI").selectOption("some");
  await page.getByLabel("Time zone (optional)").fill("Mars/Olympus");
  await page.getByLabel("Weekly time available").selectOption("30");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).not.toHaveURL(/\/learn$/);
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByLabel("Experience with AI").selectOption("some");
  await page.getByLabel("Time zone (optional)").fill("America/Toronto");
  await page.getByLabel("Weekly time available").selectOption("30");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const plan = page.getByRole("region", { name: "Your starter plan" });
  await expect(plan).toContainText("Turn meeting notes into next steps");
  await expect(plan.locator("li")).toHaveCount(2);
  await expect(plan).toContainText("America/Toronto");
  await expect(
    page.getByRole("button", { name: /buy|purchase|book/i }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Weekly time available")).toHaveValue("30");
});
test("[L78] profile error preserves every intended edit until keyboard correction saves it", async ({
  browser,
}) => {
  const unrelatedContext = await browser.newContext();
  try {
    const unrelatedPage = await unrelatedContext.newPage();
    await begin(unrelatedPage, "explorer", "everyday");
    await unrelatedPage.goto("/learn");
    for (const [background, startingGoal, nextGoal] of [
      ["explorer", "everyday", "work"],
      ["professional", "work", "build"],
      ["technical", "build", "everyday"],
    ] as const) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto("/");
        await page.getByLabel("Your starting point").selectOption(background);
        await page
          .getByLabel("What would you like to do?")
          .selectOption(startingGoal);
        await page
          .locator('input[name="domain_tags"][value="education"]')
          .check();
        await page.getByLabel("Experience with AI").selectOption("some");
        await page.getByLabel("Time zone (optional)").fill("UTC");
        await page.getByLabel("Weekly time available").selectOption("30");
        await page
          .getByLabel("I'll use invented or sample information")
          .check();
        await page
          .getByRole("button", { name: "Start my learning path" })
          .click();
        await expect(page).toHaveURL(/\/learn$/);

        const member = await session(context);
        await page.getByRole("link", { name: "Open lesson" }).click();
        const originalTitle = await page.locator("#exercise-title").innerText();
        const originalDraft = `Invented practice for ${background} before editing profile`;
        await page.getByLabel("Your instruction to AI").fill(originalDraft);
        await page.getByRole("button", { name: "Save draft" }).click();
        await page.getByRole("link", { name: "Your learning path" }).click();
        const saved = async () =>
          (
            await pool.query(
              "SELECT goal,domain_tags,experience,time_zone,weekly_minutes FROM learners WHERE id=$1",
              [member.id],
            )
          ).rows[0];
        const before = await saved();
        const plan = page.getByRole("region", { name: "Your starter plan" });
        const originalPlan = await plan.innerText();
        await page
          .getByLabel("What would you like to do?")
          .selectOption(nextGoal);
        await page
          .locator('input[name="domain_tags"][value="education"]')
          .uncheck();
        await page
          .locator('input[name="domain_tags"][value="finance"]')
          .check();
        await page.getByLabel("Experience with AI").selectOption("");
        await page.getByLabel("Weekly time available").selectOption("60");
        await page.getByLabel("Time zone (optional)").fill("Mars/Olympus");

        const invalidResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith("/profile") &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Save my direction" }).click();
        expect((await invalidResponse).status()).toBe(422);
        await expect(page.getByLabel("What would you like to do?")).toHaveValue(
          nextGoal,
        );
        await expect(page).toHaveTitle(/error/i);
        await expect(page.getByRole("alert")).toContainText(/not saved/i);
        await expect(
          page.locator('input[name="domain_tags"][value="education"]'),
        ).not.toBeChecked();
        await expect(
          page.locator('input[name="domain_tags"][value="finance"]'),
        ).toBeChecked();
        await expect(page.getByLabel("Experience with AI")).toHaveValue("");
        await expect(page.getByLabel("Weekly time available")).toHaveValue(
          "60",
        );
        const timezone = page.getByLabel("Time zone (optional)");
        await expect(timezone).toHaveValue("Mars/Olympus");
        await expect(timezone).toHaveAttribute("aria-invalid", "true");
        const descriptionId = await timezone.getAttribute("aria-describedby");
        expect(descriptionId).toMatch(/timezone-error/);
        await expect(page.locator("#timezone-error")).toBeVisible();
        const errorLink = page.getByRole("alert").getByRole("link", {
          name: /Time zone/i,
        });
        await expect(errorLink).toHaveAttribute("href", "#timezone");
        await page
          .getByRole("link", {
            name: "Download my structured preview records",
          })
          .focus();
        await page.keyboard.press("Tab");
        await expect(errorLink).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(timezone).toBeFocused();
        expect(await saved()).toEqual(before);
        expect(await plan.innerText()).toBe(originalPlan);
        await unrelatedPage.reload();
        await expect(
          unrelatedPage.getByLabel("What would you like to do?"),
        ).toHaveValue("everyday");
        await expect(
          unrelatedPage.getByLabel("Time zone (optional)"),
        ).toHaveValue("");
        await expect(
          unrelatedPage.locator('input[name="domain_tags"][value="finance"]'),
        ).not.toBeChecked();
        await expect(unrelatedPage.getByText("Mars/Olympus")).toHaveCount(0);

        await timezone.fill("America/Toronto");
        await page.getByRole("button", { name: "Save my direction" }).click();
        await expect(page).toHaveURL(/\/learn$/);
        await page.reload();
        await expect(page.getByLabel("What would you like to do?")).toHaveValue(
          nextGoal,
        );
        await expect(
          page.locator('input[name="domain_tags"][value="finance"]'),
        ).toBeChecked();
        await expect(
          page.locator('input[name="domain_tags"][value="education"]'),
        ).not.toBeChecked();
        await expect(page.getByLabel("Experience with AI")).toHaveValue("");
        await expect(page.getByLabel("Weekly time available")).toHaveValue(
          "60",
        );
        await expect(page.getByLabel("Time zone (optional)")).toHaveValue(
          "America/Toronto",
        );
        expect(await saved()).toMatchObject({
          goal: nextGoal,
          domain_tags: ["finance"],
          experience: null,
          time_zone: "America/Toronto",
          weekly_minutes: 60,
        });
        await page.getByRole("link", { name: "Open lesson" }).click();
        await expect(page.locator("#exercise-title")).not.toHaveText(
          originalTitle,
        );
        await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
        await expect(
          page.getByText(originalDraft, { exact: true }),
        ).toBeVisible();
        expect(
          (
            await pool.query(
              "SELECT lesson_version,goal_at_start,instruction FROM exercises WHERE learner_id=$1",
              [member.id],
            )
          ).rows[0],
        ).toMatchObject({
          lesson_version: 1,
          goal_at_start: startingGoal,
          instruction: originalDraft,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await unrelatedContext.close();
  }
});
test("[L79] onboarding error keeps safe choices until one-field correction creates a member", async ({
  browser,
}) => {
  const unrelatedContext = await browser.newContext();
  try {
    const unrelatedPage = await unrelatedContext.newPage();
    await unrelatedPage.goto("/");
    await unrelatedPage
      .getByLabel("Your starting point")
      .selectOption("technical");
    await unrelatedPage
      .getByLabel("What would you like to do?")
      .selectOption("build");
    await unrelatedPage
      .getByLabel("Time zone (optional)")
      .fill("America/Vancouver");
    await unrelatedPage
      .getByLabel("I'll use invented or sample information")
      .check();
    await unrelatedPage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    await expect(unrelatedPage).toHaveURL(/\/learn$/);
    const unrelated = await session(unrelatedContext);

    for (const [background, goal, expectedExercise] of [
      ["explorer", "everyday", "Plan a small community event"],
      ["professional", "work", "Turn meeting notes into next steps"],
      ["technical", "build", "Review a sign-up flow"],
    ] as const) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto("/");
        await page.getByLabel("Your starting point").selectOption(background);
        await page.getByLabel("What would you like to do?").selectOption(goal);
        await page
          .locator('input[name="domain_tags"][value="education"]')
          .check();
        await page
          .locator('input[name="domain_tags"][value="education"]')
          .uncheck();
        await page
          .locator('input[name="domain_tags"][value="finance"]')
          .check();
        await page.getByLabel("Experience with AI").selectOption("some");
        await page.getByLabel("Experience with AI").selectOption("");
        await page.getByLabel("Weekly time available").selectOption("60");
        await page.getByLabel("Time zone (optional)").fill("Mars/Olympus");
        await page
          .getByLabel("I'll use invented or sample information")
          .check();

        const invalidResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith("/start") &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Start my learning path" })
          .click();
        expect((await invalidResponse).status()).toBe(422);
        await expect(page.getByLabel("Your starting point")).toHaveValue(
          background,
        );
        await expect(page.getByLabel("What would you like to do?")).toHaveValue(
          goal,
        );
        await expect(page).toHaveTitle(/error/i);
        await expect(page.getByRole("alert")).toContainText(/not saved/i);
        await expect(
          page.locator('input[name="domain_tags"][value="finance"]'),
        ).toBeChecked();
        await expect(
          page.locator('input[name="domain_tags"][value="education"]'),
        ).not.toBeChecked();
        await expect(page.getByLabel("Experience with AI")).toHaveValue("");
        await expect(page.getByLabel("Weekly time available")).toHaveValue(
          "60",
        );
        await expect(
          page.getByLabel("I'll use invented or sample information"),
        ).toBeChecked();
        const timezone = page.getByLabel("Time zone (optional)");
        await expect(timezone).toHaveValue("Mars/Olympus");
        await expect(timezone).toHaveAttribute("aria-invalid", "true");
        await expect(timezone).toHaveAttribute(
          "aria-describedby",
          /timezone-error/,
        );
        await expect(page.locator("#timezone-error")).toBeVisible();
        const errorLink = page
          .getByRole("alert")
          .getByRole("link", { name: /Time zone/i });
        await expect(errorLink).toHaveAttribute("href", "#timezone");
        await page.locator("a.brand").focus();
        await page.keyboard.press("Tab");
        await expect(errorLink).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(timezone).toBeFocused();
        // Deletion recovery can change the global learner count during this journey.
        expect((await session(context)).id).toBeUndefined();
        expect(
          (await page.request.get("/learn", { maxRedirects: 0 })).status(),
        ).toBe(303);
        await unrelatedPage.reload();
        await expect(
          unrelatedPage.getByLabel("Time zone (optional)"),
        ).toHaveValue("America/Vancouver");
        await expect(page.getByText("America/Vancouver")).toHaveCount(0);
        expect((await session(unrelatedContext)).id).toBe(unrelated.id);

        if (background === "explorer") {
          const missingAcknowledgement = await page.request.post("/start", {
            headers: { Origin: origin },
            form: {
              csrf: await csrfToken(page),
              background,
              goal,
              domain_tags: "finance",
              experience: "",
              timezone: "America/Toronto",
              weekly_minutes: "60",
            },
          });
          expect(missingAcknowledgement.status()).toBe(422);
          expect(await missingAcknowledgement.text()).not.toMatch(
            /name="synthetic"[^>]*checked/,
          );
          expect((await session(context)).id).toBeUndefined();
        }

        await timezone.fill("America/Toronto");
        await page
          .getByRole("button", { name: "Start my learning path" })
          .click();
        await expect(page).toHaveURL(/\/learn$/);
        const member = await session(context);
        expect(member.id).toBeTruthy();
        const saved = await pool.query(
          "SELECT background,goal,domain_tags,experience,time_zone,weekly_minutes FROM learners WHERE id=$1",
          [member.id],
        );
        expect(saved.rowCount).toBe(1);
        expect(saved.rows[0]).toEqual({
          background,
          goal,
          domain_tags: ["finance"],
          experience: null,
          time_zone: "America/Toronto",
          weekly_minutes: 60,
        });
        await expect(
          page.getByRole("region", { name: "Your starter plan" }),
        ).toContainText(expectedExercise);
        await page.reload();
        await expect(page.getByLabel("Your starting point")).toHaveValue(
          background,
        );
        await expect(page.getByLabel("What would you like to do?")).toHaveValue(
          goal,
        );
        await expect(
          page.locator('input[name="domain_tags"][value="finance"]'),
        ).toBeChecked();
        await expect(page.getByLabel("Weekly time available")).toHaveValue(
          "60",
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await unrelatedContext.close();
  }
});
test("[L31] technical learner sees an experienced, private plan without a coding prerequisite", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("technical");
  await page.getByLabel("What would you like to do?").selectOption("build");
  await page.getByLabel("Experience with AI").selectOption("experienced");
  await page.getByLabel("Time zone (optional)").fill("America/Vancouver");
  await page.getByLabel("Weekly time available").selectOption("120");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  const plan = page.getByRole("region", { name: "Your starter plan" });
  await expect(plan).toContainText("Review a sign-up flow");
  await expect(plan).toContainText("self-reported Experienced");
  await expect(plan).toContainText("No coding is required");
  await expect(plan.locator("li")).toHaveCount(3);
  const other = await browser.newContext();
  try {
    const anotherPage = await other.newPage();
    await anotherPage.goto("/");
    await anotherPage
      .getByLabel("Your starting point")
      .selectOption("explorer");
    await anotherPage
      .getByLabel("What would you like to do?")
      .selectOption("everyday");
    await anotherPage
      .getByLabel("I'll use invented or sample information")
      .check();
    await anotherPage
      .getByRole("button", { name: "Start my learning path" })
      .click();
    const anotherPlan = anotherPage.getByRole("region", {
      name: "Your starter plan",
    });
    await expect(anotherPlan).not.toContainText("America/Vancouver");
    await expect(anotherPlan).toContainText("Not specified");
    await expect(anotherPlan).not.toContainText("Review a sign-up flow");
  } finally {
    await other.close();
  }
});
test("[L04] draft survives reload and returning to the path", async ({
  page,
}) => {
  await begin(page);
  await page.getByLabel("Your instruction to AI").fill("An unfinished thought");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByText("Your draft is saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
    "An unfinished thought",
  );
  await page.getByRole("link", { name: "Your learning path" }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
});
test("[L05] invalid completion keeps input but does not claim it was saved", async ({
  page,
  context,
}) => {
  await begin(page);
  await page.getByLabel("Your instruction to AI").fill(instruction);
  await page.getByLabel("How will you check the result?").fill("Check notes");
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(page).toHaveTitle(/Error in your exercise/);
  await expect(page.getByRole("alert")).toContainText(
    "How will you check the result?",
  );
  await expect(page.getByRole("alert")).not.toContainText(
    "Your instruction to AI",
  );
  const check = page.getByLabel("How will you check the result?");
  await expect(check).toHaveValue("Check notes");
  await expect(check).toHaveAttribute("aria-invalid", "true");
  await expect(check).toHaveAttribute(
    "aria-describedby",
    "verification-help verification-error",
  );
  await expect(page.getByLabel("Your instruction to AI")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByRole("link", { name: "Your learning path" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: /How will you check the result\?/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(check).toBeFocused();
  await expect(
    page.getByText("Your draft is saved", { exact: false }),
  ).toHaveCount(0);
  const { id } = await session(context);
  expect(
    (
      await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
        id,
      ])
    ).rows[0].count,
  ).toBe("0");
  await check.fill(verification);
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(page).not.toHaveTitle(/Error in your exercise/);
  await expect(page.getByText("Exercise completed")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Exercise completed")).toBeVisible();
  await page.goto("/lesson");
  await expect(page.getByText(instruction)).toBeVisible();
});
test("[L06] independent sessions cannot select another learner to read or overwrite", async ({
  page,
  context,
  browser,
}) => {
  await begin(page);
  await page
    .getByLabel("Your instruction to AI")
    .fill("Private text belonging to learner A");
  await page.getByRole("button", { name: "Save draft" }).click();
  const a = await session(context);
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await begin(b, "professional", "work");
    await expect(b.getByLabel("Your instruction to AI")).toHaveValue("");
    const csrf = await b.locator('input[name="csrf"]').inputValue();
    await other.request.post(`${origin}/exercise`, {
      headers: { Origin: origin },
      form: {
        csrf,
        lesson_id: "clear-instructions",
        lesson_version: "1",
        goal: "work",
        intent: "draft",
        instruction: "Own text",
        learner_id: a.id,
      },
    });
    await page.reload();
    await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
      "Private text belonging to learner A",
    );
    await b.goto(`${origin}/lesson?learner_id=${a.id}`);
    await expect(b.getByLabel("Your instruction to AI")).toHaveValue(
      "Own text",
    );
  } finally {
    await other.close();
  }
});
test("[L07] cross-origin and CSRF attacks cannot save or delete progress", async ({
  page,
  context,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  for (const [from, value] of [
    ["http://attacker.invalid", csrf],
    [origin, "bad-token"],
    ["null", csrf],
  ]) {
    const r = await page.request.post("/exercise", {
      headers: { Origin: from! },
      form: {
        csrf: value!,
        lesson_id: "clear-instructions",
        lesson_version: "1",
        goal: "everyday",
        intent: "complete",
        instruction,
        verification,
        checked: "yes",
      },
    });
    expect(r.status()).toBe(403);
  }
  const deleted = await page.request.post("/delete", {
    headers: { Origin: origin },
    form: { confirm: "yes" },
  });
  expect(deleted.status()).toBe(403);
  await page.reload();
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
    instruction,
  );
  const { id } = await session(context);
  expect(
    (
      await pool.query(
        "SELECT completed_at FROM exercises WHERE learner_id=$1",
        [id],
      )
    ).rows[0].completed_at,
  ).toBeNull();
});
test("[L08] repeated or late submissions preserve the completed version", async ({
  page,
  context,
}) => {
  await begin(page);
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  await fill(page);
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  const { id } = await session(context);
  const before = (
    await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [id])
  ).rows[0];
  await page.request.post("/exercise", {
    headers: { Origin: origin },
    form: {
      csrf,
      lesson_id: "clear-instructions",
      lesson_version: "1",
      goal: "everyday",
      intent: "complete",
      instruction,
      verification,
      checked: "yes",
    },
  });
  await page.request.post("/exercise", {
    headers: { Origin: origin },
    form: {
      csrf,
      lesson_id: "clear-instructions",
      lesson_version: "1",
      goal: "everyday",
      intent: "draft",
      instruction: "Late draft",
    },
  });
  expect(
    (await pool.query("SELECT * FROM exercises WHERE learner_id=$1", [id]))
      .rows,
  ).toEqual([before]);
  await page.reload();
  await expect(page.getByText(instruction, { exact: true })).toBeVisible();
});
test("[L09] deleting the preview removes owned records and invalidates the old cookie", async ({
  page,
  context,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  const old = await session(context);
  await page.goto("/learn");
  await page.getByLabel("Delete my local preview").check();
  await page.getByRole("button", { name: "Delete this preview" }).click();
  expect(
    (await pool.query("SELECT count(*) FROM learners WHERE id=$1", [old.id]))
      .rows[0].count,
  ).toBe("0");
  expect(
    (
      await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
        old.id,
      ])
    ).rows[0].count,
  ).toBe("0");
  await context.addCookies([old.cookie]);
  await page.goto("/learn");
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
});
test("[L95] an accepted pending local deletion finishes without the old browser session", async ({
  page,
  context,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  const old = await session(context);
  // The real confirmation and partial-object failure are exercised against
  // PostgreSQL/object storage by the integration test. This browser fixture
  // starts from that accepted durable marker after a simulated interruption.
  await pool.query(
    `UPDATE workspaces SET deleting_at=clock_timestamp()-INTERVAL '1 minute'
     WHERE owner_principal_id=$1`,
    [old.id],
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [old.id],
  );
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::integer AS n FROM principals WHERE id=$1",
            [old.id],
          )
        ).rows[0]?.n,
      { timeout: 15_000 },
    )
    .toBe(0);
  expect(
    (
      await pool.query("SELECT count(*) FROM exercises WHERE learner_id=$1", [
        old.id,
      ])
    ).rows[0]?.count,
  ).toBe("0");
  await context.addCookies([old.cookie]);
  await page.goto("/learn");
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
});
test("[L10] expired and forged sessions cannot recover private work and can restart", async ({
  page,
  context,
}) => {
  await begin(page);
  const old = await session(context);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
    [old.id],
  );
  await page.goto("/learn");
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((c) => c.name === "dne_preview")?.value,
  ).not.toBe(old.cookie.value);
  await begin(page);
  await context.addCookies([{ ...old.cookie, value: "0".repeat(64) }]);
  await page.goto("/lesson");
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
});
test("[L11] multiple tabs, keyboard navigation, safe rendering and narrow layout work", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const second = await context.newPage();
  await second.goto(origin);
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/learn$/);
  await page.getByRole("link", { name: "Open lesson" }).click();
  const hostile = "<script>window.compromised=true</script>";
  await page.getByLabel("Your instruction to AI").fill(hostile);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(hostile);
  expect(await page.evaluate(() => Object.hasOwn(window, "compromised"))).toBe(
    false,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await second.close();
});
test("[L12] database failure is honest and prior saved progress is recoverable", async ({
  page,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  await page
    .getByLabel("Your instruction to AI")
    .fill("A new attempt that may not be saved.");
  await pool.query("ALTER TABLE exercises RENAME TO unavailable_exercises");
  try {
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Save outcome unknown" }),
    ).toBeVisible();
    await expect(
      page.getByText("The storage result could not be confirmed", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Attempted instruction")).toHaveCount(0);
    await expect(page.getByLabel("Attempted way to check")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(
      "A new attempt that may not be saved.",
    );
  } finally {
    await pool.query("ALTER TABLE unavailable_exercises RENAME TO exercises");
  }
  await page.goto("/lesson");
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
    instruction,
  );
});

test("[L13] lost idle database connections do not terminate the server and saved work recovers", async ({
  page,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  const lost = await pool.query(
    "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname=current_database() AND application_name='deep-native-preview' AND state='idle'",
  );
  expect(lost.rowCount).toBeGreaterThan(0);
  expect(lost.rows.every((r: { terminated: boolean }) => r.terminated)).toBe(
    true,
  );
  // Re-request the current URL after the disconnect. A request concurrent with it may fail honestly.
  const response = await page.goto(page.url());
  expect([200, 503]).toContain(response!.status());
  await page.goto("/lesson");
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
    instruction,
  );
});

test("[L14] integration readiness labels every provider as simulated", async ({
  page,
}) => {
  await page.goto("/readiness");
  await expect(
    page.getByRole("heading", { name: "Integration readiness" }),
  ).toBeVisible();
  await expect(page.getByText("TEST ENVIRONMENT")).toBeVisible();
  for (const kind of [
    "ai",
    "payment",
    "storage",
    "calendar",
    "email",
    "auth",
    "analytics",
  ])
    await expect(page.getByText(`${kind} · simulated`)).toBeVisible();
  await expect(
    page.getByText("no external side effect occurs", { exact: false }),
  ).toHaveCount(7);
  await expect(page.getByText("configured", { exact: false })).toHaveCount(0);
});

test("[L15] member identity owns one private workspace and direct API parameters cannot cross it", async ({
  page,
  context,
  browser,
}) => {
  await begin(page);
  await page.getByLabel("Your instruction to AI").fill("Private member A work");
  await page.getByRole("button", { name: "Save draft" }).click();
  const a = await session(context);
  const own = await page.request.get(`/api/workspaces/${a.id}/private`);
  expect(own.status()).toBe(200);
  expect((await own.json()).records[0].instruction).toBe(
    "Private member A work",
  );
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await begin(b, "professional", "work");
    const denied = await b.request.get(
      `/api/workspaces/${a.id}/private?workspace_id=${a.id}`,
    );
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden" });
  } finally {
    await other.close();
  }
});

test("[L16] staff assignments expire or revoke and purpose-bound support reads are audited", async ({
  page,
  context,
  browser,
}) => {
  await begin(page);
  await fill(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  const owner = await session(context),
    access = authorizationStore(pool),
    admin = await staff("platform_admin"),
    coach = await staff("coach"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor"),
    operator = await staff("operator"),
    future = new Date(Date.now() + 60_000);
  const coachGrant = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    "coach assigned lesson",
    future,
  );
  await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.id,
    "reviewer",
    "review assigned lesson",
    future,
  );
  const supportGrant = await access.grantSupport(
    admin.id,
    operator.id,
    owner.id,
    "operator",
    "resolve browser case",
    future,
  );
  for (const [credential, status] of [
    [coach.token, 200],
    [reviewer.token, 403],
    [editor.token, 403],
  ] as const) {
    const staffContext = await browser.newContext();
    try {
      await useToken(staffContext, credential);
      const response = await staffContext.request.get(
        `/api/workspaces/${owner.id}/private`,
      );
      expect(response.status()).toBe(status);
      if (status === 403) {
        expect(await response.json()).toEqual({ error: "forbidden" });
        expect((await response.text()).includes(instruction)).toBe(false);
      }
    } finally {
      await staffContext.close();
    }
  }
  const reviewerContext = await browser.newContext();
  try {
    await useToken(reviewerContext, reviewer.token);
    const denied = await reviewerContext.request.get(
      `/api/workspaces/${owner.id}/private?workspace_id=${owner.id}&purpose=review%20assigned%20lesson`,
    );
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden" });
    expect((await denied.text()).includes(instruction)).toBe(false);
  } finally {
    await reviewerContext.close();
  }
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',
         expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE id=$1`,
    [coachGrant],
  );
  const expiredCoach = await browser.newContext();
  try {
    await useToken(expiredCoach, coach.token);
    expect(
      (
        await expiredCoach.request.get(`/api/workspaces/${owner.id}/private`)
      ).status(),
    ).toBe(403);
  } finally {
    await expiredCoach.close();
  }
  await pool.query(
    `UPDATE assignment_grants
     SET starts_at=CURRENT_TIMESTAMP-INTERVAL '1 hour',
         expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour'
     WHERE id=$1`,
    [coachGrant],
  );
  const currentCoach = await browser.newContext();
  try {
    await useToken(currentCoach, coach.token);
    expect(
      (
        await currentCoach.request.get(`/api/workspaces/${owner.id}/private`)
      ).status(),
    ).toBe(200);
  } finally {
    await currentCoach.close();
  }
  expect(await access.revokeAssignment(admin.id, coachGrant)).toBe(true);
  const revokedCoach = await browser.newContext();
  try {
    await useToken(revokedCoach, coach.token);
    expect(
      (
        await revokedCoach.request.get(`/api/workspaces/${owner.id}/private`)
      ).status(),
    ).toBe(403);
  } finally {
    await revokedCoach.close();
  }
  const support = await browser.newContext();
  try {
    await useToken(support, operator.token);
    expect(
      (
        await support.request.get(`/api/workspaces/${owner.id}/private`)
      ).status(),
    ).toBe(403);
    expect(
      (
        await support.request.get(
          `/api/workspaces/${owner.id}/private?purpose=resolve%20browser%20case`,
        )
      ).status(),
    ).toBe(200);
    await pool.query(
      "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
      [operator.id],
    );
    expect(
      (
        await support.request.get(
          `/api/workspaces/${owner.id}/private?purpose=resolve%20browser%20case`,
        )
      ).status(),
    ).toBe(403);
  } finally {
    await support.close();
  }
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM authorization_audit WHERE grant_type='support' AND grant_id=$1 AND action='workspace_read'",
        [supportGrant],
      )
    ).rows[0].count,
  ).toBe("1");
  const coachEvents = (
    await pool.query(
      "SELECT action,actor_id,staff_id FROM authorization_audit WHERE grant_id=$1 ORDER BY id",
      [coachGrant],
    )
  ).rows;
  expect(coachEvents).toEqual([
    { action: "grant_created", actor_id: admin.id, staff_id: coach.id },
    { action: "workspace_read", actor_id: coach.id, staff_id: coach.id },
    { action: "workspace_read", actor_id: coach.id, staff_id: coach.id },
    { action: "grant_revoked", actor_id: admin.id, staff_id: coach.id },
  ]);
  const audit = JSON.stringify(
    (
      await pool.query(
        "SELECT * FROM authorization_audit WHERE workspace_id=$1",
        [owner.id],
      )
    ).rows,
  );
  for (const privateValue of [
    instruction,
    verification,
    "resolve browser case",
    "coach assigned lesson",
    operator.token,
    coach.token,
  ])
    expect(audit).not.toContain(privateValue);
});

test("[L17] cohort membership exposes only its shared content and cannot grant staff privilege", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await begin(page, "technical", "build");
  const member = await session(context),
    cohort = `group-${testInfo.project.name}`;
  await pool.query("INSERT INTO cohorts(id) VALUES($1)", [cohort]);
  await pool.query(
    "INSERT INTO cohort_content(cohort_id,content_id,body) VALUES($1,'guide','Permitted shared guide')",
    [cohort],
  );
  await pool.query(
    "INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content) VALUES($1,$2,true)",
    [cohort, member.id],
  );
  const shared = await page.request.get(`/api/cohorts/${cohort}/content/guide`);
  expect(shared.status()).toBe(200);
  expect((await shared.json()).body).toBe("Permitted shared guide");
  expect(
    (await page.request.get(`/api/cohorts/${cohort}/content/private`)).status(),
  ).toBe(403);
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour'
     WHERE cohort_id=$1 AND member_id=$2`,
    [cohort, member.id],
  );
  expect(
    (await page.request.get(`/api/cohorts/${cohort}/content/guide`)).status(),
  ).toBe(403);
  await pool.query(
    `UPDATE cohort_memberships
     SET expires_at=NULL,revoked_at=CURRENT_TIMESTAMP
     WHERE cohort_id=$1 AND member_id=$2`,
    [cohort, member.id],
  );
  expect(
    (await page.request.get(`/api/cohorts/${cohort}/content/guide`)).status(),
  ).toBe(403);
  const outsider = await browser.newContext();
  try {
    const other = await outsider.newPage();
    await begin(other, "explorer", "everyday");
    expect(
      (
        await other.request.get(`/api/cohorts/${cohort}/content/guide`)
      ).status(),
    ).toBe(403);
  } finally {
    await outsider.close();
  }
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM staff_profiles WHERE principal_id=$1",
        [member.id],
      )
    ).rows[0].count,
  ).toBe("0");
});

test("[L54] changing learner direction cannot mint staff or another workspace access", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await begin(ownerPage);
    const owner = await session(ownerContext);
    for (const [index, background, goal, nextBackground, nextGoal] of [
      [1, "explorer", "everyday", "professional", "work"],
      [2, "professional", "work", "technical", "build"],
      [3, "technical", "build", "explorer", "everyday"],
    ] as const) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await begin(page, background, goal);
        const member = await session(context);
        const csrf = await csrfToken(page);
        const changed = await page.request.post("/profile", {
          headers: { Origin: origin },
          maxRedirects: 0,
          form: {
            csrf,
            background: nextBackground,
            goal: nextGoal,
            synthetic: "yes",
            role: "editor",
            staff_role: "platform_admin",
            principal_kind: "staff",
            workspace_id: owner.id,
            offer: "Professional",
          },
        });
        expect(changed.status()).toBe(303);
        expect(changed.headers().location).toBe("/learn");
        const saved = await pool.query(
          `SELECT l.background,l.goal,p.kind,
                  (SELECT count(*) FROM staff_profiles s WHERE s.principal_id=p.id) AS staff_count
           FROM learners l JOIN principals p ON p.id=l.id WHERE l.id=$1`,
          [member.id],
        );
        expect(saved.rows[0]).toEqual({
          background: nextBackground,
          goal: nextGoal,
          kind: "member",
          staff_count: "0",
        });
        const invalid = await page.request.post("/profile", {
          headers: { Origin: origin },
          form: {
            csrf,
            background: "platform_admin",
            goal: nextGoal,
            synthetic: "yes",
          },
        });
        expect(invalid.status()).toBe(422);
        expect(
          (
            await pool.query("SELECT background FROM learners WHERE id=$1", [
              member.id,
            ])
          ).rows[0].background,
        ).toBe(nextBackground);
        const staffPage = await page.request.get("/editor/library");
        expect(staffPage.status()).toBe(403);
        expect(await staffPage.text()).not.toContain(
          "Create a synthetic draft",
        );
        expect(
          (
            await page.request.get(`/api/workspaces/${owner.id}/private`)
          ).status(),
        ).toBe(403);
        const draftId = `ADV-${String(index).padStart(3, "0")}`;
        const write = await page.request.post("/editor/library", {
          headers: { Origin: origin },
          form: {
            csrf,
            id: draftId,
            version: "1",
            kind: "lesson",
            title: "Unauthorized sample",
            body: "Invented content only.",
            owner: "Member",
            sources: "Original sample",
            rights: "Owned sample",
          },
        });
        expect(write.status()).toBe(422);
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM content_versions WHERE id=$1",
              [draftId],
            )
          ).rows[0].count,
        ).toBe("0");
      } finally {
        await context.close();
      }
    }
  } finally {
    await ownerContext.close();
  }
});

test("[L18] explicit consent, quarantine and fresh authorization protect private evidence", async ({
  page,
  context,
  browser,
}) => {
  await begin(page);
  const csrf = await csrfToken(page);
  expect(
    (
      await uploadEvidence(page, csrf, {
        name: "unsafe.html",
        type: "text/html",
        data: Buffer.from("<script>never run</script>"),
      })
    ).status(),
  ).toBe(422);
  const uploaded = await uploadEvidence(page, csrf);
  expect(uploaded.status()).toBe(201);
  const { id } = await uploaded.json();
  expect(
    (
      await page.request.post(`/api/evidence/${id}/review`, {
        headers: { Origin: origin, "X-CSRF-Token": csrf },
      })
    ).status(),
  ).toBe(409);
  const storageRoot = process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!;
  const evidence = evidenceStore(
    pool,
    fileObjectStorage(storageRoot),
    "test-only-scanner-secret",
  );
  expect(await evidence.transitionQuarantine(id, "clean")).toBe(true);
  expect(
    (
      await page.request.post(`/api/evidence/${id}/review`, {
        headers: { Origin: origin, "X-CSRF-Token": csrf },
      })
    ).status(),
  ).toBe(204);
  const linkResponse = await page.request.post(
    `/api/evidence/${id}/download-link`,
    { headers: { Origin: origin, "X-CSRF-Token": csrf } },
  );
  expect(linkResponse.status()).toBe(200);
  const link = (await linkResponse.json()).href as string;
  const download = await page.request.get(link);
  expect(download.status()).toBe(200);
  expect(await download.body()).toEqual(
    Buffer.from("Synthetic private evidence"),
  );
  const outsider = await browser.newContext();
  try {
    const other = await outsider.newPage();
    await begin(other, "professional", "work");
    expect((await other.request.get(link)).status()).toBe(403);
  } finally {
    await outsider.close();
  }
  expect(
    (
      await pool.query(
        "SELECT count(*) FROM evidence_review_submissions WHERE evidence_id=$1",
        [id],
      )
    ).rows[0].count,
  ).toBe("1");
  expect((await session(context)).id).toBeTruthy();
});

test("[L19] staff evidence access is audited and revocation stops downloads", async ({
  page,
  context,
  browser,
}) => {
  await begin(page, "professional", "work");
  const csrf = await csrfToken(page),
    uploaded = await uploadEvidence(page, csrf, {
      name: "review.pdf",
      type: "application/pdf",
      scopes: "private-review",
      data: Buffer.from("%PDF-synthetic-review"),
    }),
    { id } = await uploaded.json(),
    owner = await session(context),
    access = authorizationStore(pool),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "test-only-scanner-secret",
    ),
    admin = await staff("platform_admin"),
    reviewer = await staff("reviewer"),
    editor = await staff("editor");
  expect(uploaded.status()).toBe(201);
  await evidence.transitionQuarantine(id, "clean");
  await expect(evidence.destinationAllowed(id, "private-review")).resolves.toBe(
    true,
  );
  await expect(
    evidence.destinationAllowed(id, "community-publication"),
  ).resolves.toBe(false);
  await expect(
    evidence.destinationAllowed(id, "learning-circle:group-a"),
  ).resolves.toBe(false);
  const grant = await access.grantAssignment(
    admin.id,
    reviewer.id,
    owner.id,
    "reviewer",
    "review browser evidence",
    new Date(Date.now() + 60_000),
  );
  const reviewerPage = await browser.newPage();
  try {
    await useToken(reviewerPage.context(), reviewer.token);
    await reviewerPage.goto("/");
    const reviewerFormCsrf = await csrfToken(reviewerPage);
    const ownerLink = await page.request.post(
      `/api/evidence/${id}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": csrf } },
    );
    expect(ownerLink.status()).toBe(200);
    const preSubmission = await reviewerPage.request.post(
      `/api/evidence/${id}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": reviewerFormCsrf } },
    );
    expect(preSubmission.status()).toBe(403);
    expect(await preSubmission.json()).toEqual({ error: "forbidden" });
    const guessedLink = await reviewerPage.request.get(
      (await ownerLink.json()).href as string,
    );
    expect(guessedLink.status()).toBe(403);
    expect(await guessedLink.json()).toEqual({ error: "forbidden" });
    const submitted = await page.request.post(`/api/evidence/${id}/review`, {
      headers: { Origin: origin, "X-CSRF-Token": csrf },
    });
    expect(submitted.status()).toBe(204);
    const second = await uploadEvidence(page, csrf, {
      name: "other-submitted.txt",
      data: Buffer.from("Different synthetic submission in the same workspace"),
    });
    expect(second.status()).toBe(201);
    const { id: secondId } = (await second.json()) as { id: string };
    expect(await evidence.transitionQuarantine(secondId, "clean")).toBe(true);
    expect(
      (
        await page.request.post(`/api/evidence/${secondId}/review`, {
          headers: { Origin: origin, "X-CSRF-Token": csrf },
        })
      ).status(),
    ).toBe(204);
    const noExactGrant = await reviewerPage.request.post(
      `/api/evidence/${secondId}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": reviewerFormCsrf } },
    );
    expect(noExactGrant.status()).toBe(403);
    const submissionId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [id],
      )
    ).rows[0]!.id;
    const exactGrant = await access.grantEvidenceReview(
      admin.id,
      reviewer.id,
      grant,
      submissionId,
      "synthetic exact browser review",
      new Date(Date.now() + 60_000),
    );
    const issued = await reviewerPage.request.post(
      `/api/evidence/${id}/download-link`,
      { headers: { Origin: origin, "X-CSRF-Token": reviewerFormCsrf } },
    );
    expect(issued.status()).toBe(200);
    const link = (await issued.json()).href as string;
    const downloaded = await reviewerPage.request.get(link);
    expect(downloaded.status()).toBe(200);
    expect(await downloaded.body()).toEqual(
      Buffer.from("%PDF-synthetic-review"),
    );
    const staffEvents = async () =>
      (
        await pool.query(
          `SELECT actor_id,staff_id,workspace_id,evidence_id,grant_type,grant_id,assignment_grant_id,action
         FROM authorization_audit WHERE evidence_id=$1 AND staff_id=$2 ORDER BY id`,
          [id, reviewer.id],
        )
      ).rows;
    const firstEvents = await staffEvents();
    expect(firstEvents).toEqual(
      ["evidence_link_issued", "evidence_bytes_loaded"].map((action) => ({
        actor_id: reviewer.id,
        staff_id: reviewer.id,
        workspace_id: owner.id,
        evidence_id: id,
        grant_type: "evidence_review",
        grant_id: exactGrant,
        assignment_grant_id: grant,
        action,
      })),
    );
    expect(await access.revokeEvidenceReview(admin.id, exactGrant)).toBe(true);
    expect((await reviewerPage.request.get(link)).status()).toBe(403);
    expect(await staffEvents()).toEqual(firstEvents);
    const replacementGrant = await access.grantEvidenceReview(
      admin.id,
      reviewer.id,
      grant,
      submissionId,
      "replacement synthetic browser review",
      new Date(Date.now() + 60_000),
    );
    expect((await reviewerPage.request.get(link)).status()).toBe(200);
    const replacementEvents = await staffEvents();
    expect(replacementEvents).toEqual([
      ...firstEvents,
      {
        ...firstEvents[1],
        grant_id: replacementGrant,
      },
    ]);
    expect(await access.revokeAssignment(admin.id, grant)).toBe(true);
    expect((await reviewerPage.request.get(link)).status()).toBe(403);
    expect(await staffEvents()).toEqual(replacementEvents);
  } finally {
    await reviewerPage.context().close();
  }
  const editorPage = await browser.newPage();
  try {
    await useToken(editorPage.context(), editor.token);
    await editorPage.goto("/");
    expect(
      (
        await editorPage.request.post(`/api/evidence/${id}/download-link`, {
          headers: {
            Origin: origin,
            "X-CSRF-Token": await csrfToken(editorPage),
          },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await editorPage.context().close();
  }
  const coach = await staff("coach");
  const coachAssignment = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    "synthetic audited browser coaching",
    new Date(Date.now() + 60_000),
  );
  const coachPage = await browser.newPage();
  try {
    await useToken(coachPage.context(), coach.token);
    await coachPage.goto("/");
    const issued = await coachPage.request.post(
      `/api/evidence/${id}/download-link`,
      {
        headers: { Origin: origin, "X-CSRF-Token": await csrfToken(coachPage) },
      },
    );
    expect(issued.status()).toBe(200);
    const link = (await issued.json()).href as string;
    const loaded = await coachPage.request.get(link);
    expect(loaded.status()).toBe(200);
    expect(await loaded.body()).toEqual(Buffer.from("%PDF-synthetic-review"));
    const coachEvents = async () =>
      (
        await pool.query(
          "SELECT actor_id,staff_id,workspace_id,evidence_id,grant_type,grant_id,assignment_grant_id,action FROM authorization_audit WHERE evidence_id=$1 AND staff_id=$2 ORDER BY id",
          [id, coach.id],
        )
      ).rows;
    const recorded = await coachEvents();
    expect(recorded).toEqual(
      ["evidence_link_issued", "evidence_bytes_loaded"].map((action) => ({
        actor_id: coach.id,
        staff_id: coach.id,
        workspace_id: owner.id,
        evidence_id: id,
        grant_type: "assignment",
        grant_id: coachAssignment,
        assignment_grant_id: coachAssignment,
        action,
      })),
    );
    expect(
      (
        await page.request.post(`/api/evidence/${id}/revoke-private-review`, {
          headers: { Origin: origin, "X-CSRF-Token": csrf },
        })
      ).status(),
    ).toBe(204);
    expect((await coachPage.request.get(link)).status()).toBe(403);
    expect(await coachEvents()).toEqual(recorded);
  } finally {
    await coachPage.context().close();
  }
});

test("[L20] circle sharing and deletion remove evidence and derived private data", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await begin(page, "technical", "build");
  const owner = await session(context),
    csrf = await csrfToken(page),
    circle = `evidence-${testInfo.project.name}`;
  await pool.query("INSERT INTO cohorts(id) VALUES($1)", [circle]);
  await pool.query(
    `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
     VALUES($1,$2,true)`,
    [circle, owner.id],
  );
  const uploaded = await uploadEvidence(page, csrf, {
      scopes: "learning-circle",
      circle,
    }),
    { id } = await uploaded.json(),
    evidence = evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "test-only-scanner-secret",
    );
  expect(uploaded.status()).toBe(201);
  await evidence.transitionQuarantine(id, "clean");
  await evidence.addDerivative(id, "thumbnail", Buffer.from("thumbnail"));
  const privateKeys = (
    await pool.query(
      `SELECT storage_key FROM evidence_objects WHERE id=$1
       UNION ALL
       SELECT storage_key FROM evidence_derivatives WHERE evidence_id=$1`,
      [id],
    )
  ).rows.map((row) => row.storage_key as string);
  const circleContext = await browser.newContext();
  try {
    const circlePage = await circleContext.newPage();
    await begin(circlePage, "explorer", "everyday");
    const circleMember = await session(circleContext);
    await pool.query(
      `INSERT INTO cohort_memberships(cohort_id,member_id,can_read_shared_content)
       VALUES($1,$2,true)`,
      [circle, circleMember.id],
    );
    const issued = await circlePage.request.post(
      `/api/evidence/${id}/download-link`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": await csrfToken(circlePage),
        },
      },
    );
    expect(issued.status()).toBe(200);
    const link = (await issued.json()).href as string;
    await pool.query(
      "UPDATE cohort_memberships SET revoked_at=CURRENT_TIMESTAMP WHERE cohort_id=$1 AND member_id=$2",
      [circle, circleMember.id],
    );
    expect((await circlePage.request.get(link)).status()).toBe(403);
  } finally {
    await circleContext.close();
  }
  expect(
    (
      await page.request.delete(`/api/evidence/${id}`, {
        headers: { Origin: origin, "X-CSRF-Token": csrf },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await pool.query("SELECT count(*) FROM evidence_objects WHERE id=$1", [
        id,
      ])
    ).rows[0].count,
  ).toBe("0");
  const remaining = await readdir(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!);
  for (const key of privateKeys) expect(remaining).not.toContain(key);
});
