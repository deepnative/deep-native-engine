import {
  chromium,
  expect,
} from "../../../../node_modules/@playwright/test/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Local GUI behavior only. These scenarios supplement, never replace, checks.mjs.
const [url, output] = process.argv.slice(2);
const caseIndex = process.argv.indexOf("--case");
const selectedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : null;
if (!url || !output)
  throw new Error("Usage: node gui-checks.mjs <reader URL> <evidence folder>");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const titles = [
  "Choose a task you can check",
  "Write a useful request",
  "Check an answer against its source",
  "Choose what to use and share",
  "Build a small repeatable workflow",
  "Give feedback someone can use",
];

async function check(name, action, width = 1360) {
  if (selectedCase && !name.includes(selectedCase)) return;
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const started = Date.now();
  const requests = new Map();
  const consoleErrors = [];
  page.on("request", (request) => {
    requests.set(request, {
      url: request.url(),
      startedMs: Date.now() - started,
    });
  });
  page.on("response", (response) => {
    const record = requests.get(response.request());
    if (record) record.status = response.status();
  });
  page.on("requestfinished", (request) => {
    const record = requests.get(request);
    if (record) record.finishedMs = Date.now() - started;
  });
  page.on("requestfailed", (request) => {
    const record = requests.get(request);
    if (record) record.failure = request.failure();
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await action(page, context);
    expect(errors).toEqual([]);
    results.push({ name, status: "passed", elapsedMs: Date.now() - started });
  } catch (error) {
    await page
      .screenshot({
        path: path.join(output, `${results.length}-failure.png`),
        fullPage: true,
      })
      .catch(() => {});
    results.push({
      name,
      status: "failed",
      elapsedMs: Date.now() - started,
      error: String(error),
      pageErrors: errors,
      consoleErrors,
      requests: [...requests.values()],
    });
  } finally {
    await context.close();
  }
}

async function open(page, route = "Everyday", lesson = 1) {
  const response = await page.goto(url);
  expect(response.status()).toBe(200);
  await page.getByRole("button", { name: route, exact: true }).click();
  await openCourse(page);
  await page
    .getByRole("navigation", { name: "Course path", exact: true })
    .getByRole("button", {
      name: `Lesson ${lesson}: ${titles[lesson - 1]}`,
      exact: true,
    })
    .click();
}

async function openCourse(page) {
  const menu = page.locator("#course-menu");
  if ((await menu.count()) && (await menu.getAttribute("open")) === null)
    await menu.getByText("Course contents", { exact: true }).click();
}

async function mainView(page, name) {
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

async function step(page, name) {
  await page
    .getByRole("navigation", { name: "Lesson stages", exact: true })
    .getByRole("button", { name, exact: false })
    .click();
}

async function noPageOverflow(page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

for (const width of [1360, 390]) {
  await check(
    `GUI-01 named learning path resumes actual position at ${width}px`,
    async (page) => {
      await open(page, "Work", 2);
      await step(page, "Fresh case");
      const draft = "Retained Work request: keep the missing deadline open.";
      await page.locator("#writing-transfer").fill(draft);
      await mainView(page, "Learn");
      await expect(
        page.getByRole("heading", { name: "Your learning path", exact: true }),
      ).toBeVisible();
      for (let i = 1; i <= 6; i++)
        await expect(
          page.getByRole("button", { name: `Open lesson ${i}`, exact: true }),
        ).toBeVisible();
      await page
        .getByRole("button", { name: "Continue learning", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: titles[1], exact: true }),
      ).toBeVisible();
      await expect(page.locator("#writing-transfer")).toHaveValue(draft);
      await expect(
        page
          .getByRole("navigation", { name: "Lesson stages", exact: true })
          .getByRole("button", { name: /Fresh case/ }),
      ).toHaveAttribute("aria-current", "step");
      await noPageOverflow(page);
    },
    width,
  );
}

for (const [route, correct] of [
  ["Everyday", "B"],
  ["Work", "A"],
  ["Technical", "C"],
]) {
  await check(
    `GUI-02 ${route} review follows checked mistakes and their correction`,
    async (page) => {
      await open(page, route);
      await step(page, "Try it");
      // Expected keys are read from the authored source, not imported answers.
      const wrong = correct === "A" ? "B" : "A";
      await page.locator(`input[data-question="0"][value="${wrong}"]`).check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(page.locator(".answer-feedback")).toContainText(
        "Try another choice",
      );
      await mainView(page, "Practice");
      await expect(
        page.getByRole("heading", { name: "Make it stick", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Review lesson 1", exact: true })
        .click();
      await expect(
        page.locator(`input[data-question="0"][value="${wrong}"]`),
      ).toBeChecked();
      await page
        .locator(`input[data-question="0"][value="${correct}"]`)
        .check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(page.locator(".answer-feedback")).toContainText(
        "This response matches the source.",
      );
      await mainView(page, "Practice");
      await expect(
        page.getByRole("button", { name: "Review lesson 1", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Practise lesson 1", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#course-path")).not.toContainText(
        /mastered|completed|mastery|learned/i,
      );
    },
  );
}

for (const [route, correct] of [
  ["Everyday", "B"],
  ["Work", "A"],
  ["Technical", "C"],
]) {
  await check(
    `AUDIT-REVIEW-01 ${route} keeps mistakes queued until a checked correction`,
    async (page) => {
      await open(page, route);
      await step(page, "Try it");
      const wrong = ["A", "B", "C"].filter((choice) => choice !== correct);
      const review = () =>
        page.getByRole("button", { name: "Review lesson 1", exact: true });
      await page
        .locator(`input[data-question="0"][value="${wrong[0]}"]`)
        .check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await mainView(page, "Practice");
      await review().click();
      await page
        .locator(`input[data-question="0"][value="${wrong[1]}"]`)
        .check();
      await expect(page.locator(".answer-feedback")).toBeHidden();
      await mainView(page, "Practice");
      await expect(review()).toBeVisible();
      await page
        .getByRole("button", { name: "Save in this browser", exact: true })
        .click();
      await page.reload();
      await mainView(page, "Practice");
      await expect(review()).toBeVisible();
      await review().click();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await mainView(page, "Practice");
      await expect(review()).toBeVisible();
      await review().click();
      await page
        .locator(`input[data-question="0"][value="${correct}"]`)
        .check();
      await mainView(page, "Practice");
      await expect(review()).toBeVisible();
      await review().click();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await mainView(page, "Practice");
      await expect(review()).toHaveCount(0);
    },
  );
}

await check(
  "AUDIT-REVIEW-02 restores older notebooks and keeps review route-local",
  async (page) => {
    await open(page);
    await step(page, "Try it");
    await page.locator('input[data-question="0"][value="A"]').check();
    await page
      .getByRole("button", { name: "Check answer", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save in this browser", exact: true })
      .click();
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("dne-course-reader-1:everyday:"),
      );
      const notebook = JSON.parse(localStorage.getItem(key));
      for (const lesson of notebook.state.lessons) delete lesson.reviewNeeded;
      localStorage.setItem(key, JSON.stringify(notebook));
    });
    await page.reload();
    await mainView(page, "Practice");
    await page
      .getByRole("button", { name: "Review lesson 1", exact: true })
      .click();
    await page.locator('input[data-question="0"][value="B"]').check();
    await mainView(page, "Practice");
    await expect(
      page.getByRole("button", { name: "Review lesson 1", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await mainView(page, "Practice");
    await expect(
      page.getByRole("button", { name: "Review lesson 1", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await mainView(page, "Practice");
    await expect(
      page.getByRole("button", { name: "Review lesson 1", exact: true }),
    ).toBeVisible();
  },
);

await check(
  "AUDIT-REVIEW-03 protects notebooks with malformed review state",
  async (page) => {
    await open(page);
    await page
      .getByRole("button", { name: "Save in this browser", exact: true })
      .click();
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("dne-course-reader-1:everyday:"),
      );
      const notebook = JSON.parse(localStorage.getItem(key));
      notebook.state.lessons[0].reviewNeeded = "false";
      const raw = JSON.stringify(notebook);
      localStorage.setItem(key, raw);
      return { key, raw };
    });
    await page.reload();
    await expect(page.locator("#save-status")).toContainText(
      "record is unreadable",
    );
    await expect(
      page.getByRole("button", { name: "Save in this browser", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), stored.key),
    ).toBe(stored.raw);
  },
);

await check(
  "GUI-03 My work retains route drafts through explicit save and reload",
  async (page) => {
    await open(page, "Work");
    await step(page, "Your work");
    const draft =
      "Draft from supplied Work notes: Sam prepares the instruction; the deadline remains unknown.";
    await page.locator("#writing-work").fill(draft);
    const unsaved = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    await mainView(page, "My work");
    await expect(
      page.getByRole("heading", {
        name: "Your work, kept together",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Continue writing lesson 1", exact: true })
      .click();
    await expect(page.locator("#writing-work")).toHaveValue(draft);
    expect(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      ),
    ).toEqual(unsaved);
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toContainText("Saved");
    await mainView(page, "My work");
    const pending = page.waitForEvent("download");
    await page.locator("#download").click();
    const downloaded = await pending;
    expect(await readFile(await downloaded.path(), "utf8")).toContain(draft);
    await page.reload();
    await expect(page.locator("#writing-work")).toHaveValue(draft);
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await mainView(page, "My work");
    await expect(
      page.getByRole("button", {
        name: "Continue writing lesson 1",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await mainView(page, "My work");
    await page
      .getByRole("button", { name: "Continue writing lesson 1", exact: true })
      .click();
    await expect(page.locator("#writing-work")).toHaveValue(draft);
  },
);

await check(
  "GUI-03 mobile long drafts keep explicit save reachable",
  async (page) => {
    // Reduced-viewport simulation; this does not establish native keyboard behavior.
    await page.setViewportSize({ width: 390, height: 420 });
    await open(page, "Work");
    await openCourse(page);
    await page
      .getByRole("navigation", { name: "Course path", exact: true })
      .getByRole("button", { name: "Put it all together", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Final practice steps", exact: true })
      .getByRole("button", { name: "Write a first draft", exact: true })
      .click();
    const before = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    const draft =
      "Before the handover, check the six supplied cases and ask Sam to confirm the unresolved deadline.";
    const field = page.locator("#writing-final4");
    await field.fill(draft);
    await expect(field).toBeFocused();
    expect(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      ),
    ).toEqual(before);
    await expect(page.locator("#save-indicator")).toHaveText("Unsaved changes");
    const save = page.getByRole("button", {
      name: "Save notebook",
      exact: true,
    });
    await expect(save).toBeInViewport({ ratio: 1 });
    const fieldBox = await field.boundingBox();
    const toolbarBox = await page.locator(".topbar").boundingBox();
    expect(fieldBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
    expect(fieldBox.y).toBeLessThan(420);
    await noPageOverflow(page);
    await save.click();
    await expect(page.locator("#save-indicator")).toHaveText(
      "Saved in this browser",
    );
    await expect(page.locator("#save-status")).toContainText(
      "no member account was updated",
    );
    expect(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      ),
    ).not.toEqual(before);
    await page.reload();
    await expect(field).toHaveValue(draft);
    await expect(
      page
        .getByRole("navigation", { name: "Final practice steps", exact: true })
        .getByRole("button", { name: "Write a first draft", exact: true }),
    ).toHaveAttribute("aria-current", "step");
  },
  390,
);

await check("GUI-04 keyboard next focuses the new exercise", async (page) => {
  await open(page);
  await page.locator("#next").press("Enter");
  const exercise = page.getByRole("region", { name: "Try it", exact: true });
  await expect(exercise).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const focused = document.activeElement;
        const region = document.querySelector('[aria-label="Try it"]');
        return Boolean(
          region && (focused === region || region.contains(focused)),
        );
      }),
    )
    .toBe(true);
});

await check(
  "GUI-04 feedback decision keeps the selected control focused",
  async (page) => {
    await open(page, "Everyday", 6);
    await step(page, "Fresh case");
    const decision = page.getByLabel("My decision", { exact: true });
    await decision.focus();
    await decision.selectOption({
      label: "Keep text and decline this suggestion",
    });
    await expect(decision).toBeFocused();
    await expect(decision).toHaveValue("decline");
  },
);

await check(
  "GUI-05 mobile course destinations stay named and views fit",
  async (page) => {
    await open(page);
    await openCourse(page);
    const course = page.getByRole("navigation", {
      name: "Course path",
      exact: true,
    });
    for (const title of titles)
      await expect(course.getByText(title, { exact: true })).toBeVisible();
    await expect(
      course.getByText("Put it all together", { exact: true }),
    ).toBeVisible();
    await noPageOverflow(page);
    for (const view of ["Learn", "Practice", "My work"]) {
      await mainView(page, view);
      await noPageOverflow(page);
    }
    await openCourse(page);
    await course
      .getByRole("button", { name: "Put it all together", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Final practice steps", exact: true })
      .getByRole("button", { name: "Write a first draft", exact: true })
      .click();
    await expect(page.locator("#writing-final0")).toBeVisible();
    await noPageOverflow(page);
  },
  390,
);

// Added after the first GUI implementation: coverage for its source-jump
// affordance, not presented as an additional test-first baseline.
await check(
  "GUI-05 mobile source round trips retain lesson and final writing",
  async (page) => {
    await open(page, "Work");
    await step(page, "Your work");
    const lessonDraft =
      "Use the supplied owner and keep the missing date open.";
    await page.locator("#writing-work").fill(lessonDraft);
    const before = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    await page
      .getByRole("button", { name: "Check the source", exact: true })
      .click();
    await expect(page.locator("#source-text")).toBeFocused();
    await expect(page.locator("#source-text")).toBeVisible();
    await page
      .getByRole("button", { name: "Back to exercise", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Your work", exact: true }),
    ).toBeFocused();
    await expect(page.locator("#writing-work")).toHaveValue(lessonDraft);
    await openCourse(page);
    await page
      .getByRole("navigation", { name: "Course path", exact: true })
      .getByRole("button", { name: "Put it all together", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Final practice steps", exact: true })
      .getByRole("button", { name: "Write a first draft", exact: true })
      .click();
    const firstDraft =
      "Draft a six-case handover plan and check the time budget.";
    await page.locator("#writing-final0").fill(firstDraft);
    await expect(page.locator("#final-source-reminder")).not.toHaveAttribute(
      "open",
      "",
    );
    await page
      .getByRole("button", { name: "Check the source", exact: true })
      .click();
    await expect(page.locator("#final-source-reminder")).toHaveAttribute(
      "open",
      "",
    );
    await expect(page.locator("#source-text")).toBeFocused();
    await noPageOverflow(page);
    await page
      .getByRole("button", { name: "Back to exercise", exact: true })
      .click();
    await expect(page.locator(".final-panel:not([hidden])")).toBeFocused();
    await expect(page.locator("#writing-final0")).toHaveValue(firstDraft);
    expect(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      ),
    ).toEqual(before);
  },
  390,
);

await browser.close();
await writeFile(
  path.join(output, "results.json"),
  JSON.stringify({ url, retries: 0, results }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    report: path.join(output, "results.json"),
  }),
);
process.exitCode =
  results.length === 0 || results.some((r) => r.status === "failed") ? 1 : 0;
