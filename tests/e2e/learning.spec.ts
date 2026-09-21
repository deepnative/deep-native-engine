import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { testPool } from "../support/database.ts";
const pool = testPool();
const origin = "http://127.0.0.1:4317";
const instruction =
  "Using only the sample details, create a short plan with clear actions and flag any missing information.";
const verification =
  "Compare every detail against the supplied sample, check the limits, and correct any unsupported claims.";
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
for (const [id, background, goal, title] of [
  ["L01", "explorer", "everyday", "Plan a small community event"],
  ["L02", "professional", "work", "Turn meeting notes into next steps"],
  ["L03", "technical", "build", "Review a sign-up flow"],
]) {
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
  await page.getByLabel("Your instruction to AI").fill("short");
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(page.getByRole("alert")).toContainText("at least 20 characters");
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue("short");
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
  await page.goto("/lesson");
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue("");
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
      intent: "complete",
      instruction,
      verification,
      checked: "yes",
    },
  });
  await page.request.post("/exercise", {
    headers: { Origin: origin },
    form: { csrf, intent: "draft", instruction: "Late draft" },
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
test("[L10] expired and forged sessions cannot recover private work and can restart", async ({
  page,
  context,
}) => {
  await begin(page);
  const old = await session(context);
  await pool.query(
    "UPDATE learners SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
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
      page.getByRole("heading", { name: "We could not save or load that" }),
    ).toBeVisible();
    await expect(
      page.getByText("We could not confirm the result.", { exact: false }),
    ).toBeVisible();
  } finally {
    await pool.query("ALTER TABLE unavailable_exercises RENAME TO exercises");
  }
  await page
    .getByRole("link", { name: "Return to your learning path" })
    .click();
  await page.getByRole("link", { name: "Continue exercise" }).click();
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
  // A request concurrent with a disconnect may fail honestly; one explicit reload must recover.
  const response = await page.reload();
  expect([200, 503]).toContain(response!.status());
  await page.goto("/lesson");
  await expect(page.getByLabel("Your instruction to AI")).toHaveValue(
    instruction,
  );
});
