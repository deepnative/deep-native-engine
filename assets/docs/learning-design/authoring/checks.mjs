import {
  chromium,
  expect,
} from "../../../../node_modules/@playwright/test/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [url, output] = process.argv.slice(2);
const filterAt = process.argv.indexOf("--case");
const filter = filterAt >= 0 ? process.argv[filterAt + 1] : null;
if (!url || !output)
  throw new Error(
    "Usage: node checks.mjs <url> <evidence directory> [--case text]",
  );
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const budgetKey = "dne-content-workshop-1:budget";
const budgetFeedback =
  "The budget is undecided: no amount, including $200, is established. Leave it open.";
const freshFeedback =
  "Room 4 is not given because no room has been chosen. Retain nine people, forty-five minutes and Wednesday.";
const staffingRequest =
  "Suggest a two-hour Saturday plan for twelve volunteers. Show duration and volunteers needed at the same time. Keep venue, budget and start time undecided; I will check duration and peak staffing.";

async function check(name, action, width = 1360) {
  if (filter && !name.includes(filter)) return;
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const started = Date.now();
  try {
    await action(page, context);
    expect(errors).toEqual([]);
    results.push({ name, status: "passed", elapsedMs: Date.now() - started });
  } catch (error) {
    await page
      .screenshot({
        path: path.join(output, `failure-${results.length}.png`),
        fullPage: true,
      })
      .catch(() => {});
    results.push({
      name,
      status: "failed",
      elapsedMs: Date.now() - started,
      error: String(error),
    });
  } finally {
    await context.close();
  }
}
async function open(page, caseId = "budget") {
  await page.goto(`${url}#${caseId}`);
}
async function budget(
  page,
  reason = "I separated an unknown budget and room from facts that conflict with the source.",
) {
  await page
    .getByLabel("Answer key", { exact: true })
    .selectOption("Not given");
  await page
    .getByLabel("Answer explanation", { exact: true })
    .fill(budgetFeedback);
  await page
    .getByLabel("Fresh-case key", { exact: true })
    .selectOption("Not given");
  await page
    .getByLabel("Fresh-case explanation", { exact: true })
    .fill(freshFeedback);
  await page.getByLabel("Why this revision?", { exact: true }).fill(reason);
}
async function inspect(page) {
  await page
    .getByRole("button", { name: "Preview this draft", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "I checked this draft against the source and critique",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Check this draft", exact: true })
    .click();
}
async function save(page) {
  await page
    .getByRole("button", { name: "Save local revision", exact: true })
    .click();
}
async function download(page, name) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  return readFile(await (await pending).path(), "utf8");
}
async function noPageOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const width of [1360, 390]) {
  await check(
    `AUTHOR-001/002 budget correction journey at ${width}px`,
    async (page) => {
      await open(page);
      await expect(
        page.getByRole("heading", {
          name: "Make the next draft better.",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("#source")).toContainText(
        "venue and budget are undecided",
      );
      await expect(
        page.getByText("The budget is $200.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("The group meets in Room 4.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("#critique")).toContainText("Not given");
      await expect(page.locator("#original")).toContainText("Contradicted");
      await budget(page);
      await inspect(page);
      await expect(page.locator("#check-status")).toContainText(
        "Ready to save a local revision",
      );
      await page
        .getByRole("group", { name: "Try the question", exact: true })
        .getByLabel("Not given", { exact: true })
        .check();
      await page
        .getByRole("button", { name: "Check main answer", exact: true })
        .click();
      await expect(page.locator("#main-feedback")).toContainText(
        budgetFeedback,
      );
      await page
        .getByRole("group", { name: "Try the fresh question", exact: true })
        .getByLabel("Not given", { exact: true })
        .check();
      await page
        .getByRole("button", { name: "Check fresh answer", exact: true })
        .click();
      await expect(page.locator("#fresh-feedback")).toContainText(
        freshFeedback,
      );
      await save(page);
      await expect(page.locator("#save-status")).toContainText(
        "Saved local revision 2",
      );
      await page.reload();
      await expect(
        page.getByLabel("Answer explanation", { exact: true }),
      ).toHaveValue(budgetFeedback);
      await expect(page.locator("#history")).toContainText("Revision 2");
      await expect(page.locator("#original")).toContainText("Contradicted");
      await expect(page.locator("#save-status")).toContainText(
        "Restored local revision 2",
      );
      const record = JSON.parse(
        await download(page, "Download draft and history"),
      );
      expect(record.saved.revisions).toHaveLength(1);
      expect(record.original.fields.answer).toBe("Contradicted");
      expect(record.saved.revisions[0].fields.answer).toBe("Not given");
      await inspect(page);
      await noPageOverflow(page);
      await page.screenshot({
        path: path.join(output, `budget-${width}.png`),
        fullPage: true,
      });
    },
    width,
  );
  await check(
    `AUTHOR-003 staffing revision journey at ${width}px`,
    async (page) => {
      await open(page, "staffing");
      await expect(
        page.getByText(
          "The request asks for activity and duration columns. What useful instruction should be added?",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByLabel("Worked request", { exact: true })
        .fill(staffingRequest);
      await page
        .getByLabel("Correct choice wording", { exact: true })
        .fill(
          "Keep venue, budget and start time unknown; add volunteers needed at the same time.",
        );
      await page
        .getByLabel("Answer explanation", { exact: true })
        .fill(
          "Check peak staffing, not the sum across successive activities. Twelve people can work again in the next slot.",
        );
      await page
        .getByLabel("Fresh-case worked request", { exact: true })
        .fill(
          "Plan one hour on Sunday with six helpers and forty seed packets. Show simultaneous helper demand per activity; keep location and start time unknown.",
        );
      await page
        .getByLabel("Why this revision?", { exact: true })
        .fill(
          "The earlier request checked duration but did not make peak staffing inspectable.",
        );
      await inspect(page);
      await expect(page.locator("#preview")).toContainText(staffingRequest);
      await expect(page.locator("#comparison")).toContainText(
        "volunteers needed at the same time",
      );
      await expect(page.locator("#check-status")).toContainText(
        "Wording was checked by you",
      );
      await save(page);
      await expect(page.locator("#save-status")).toContainText(
        "Saved local revision 2",
      );
      await noPageOverflow(page);
      await page.screenshot({
        path: path.join(output, `staffing-${width}.png`),
        fullPage: true,
      });
    },
    width,
  );
}

await check(
  "AUTHOR-002 wrong keys and missing reason cannot be checked",
  async (page) => {
    await open(page);
    await inspect(page);
    await expect(page.locator("#check-status")).toContainText(
      "Both claims need Not given",
    );
    await expect(
      page.getByRole("button", { name: "Save local revision", exact: true }),
    ).toBeDisabled();
    await budget(page, "");
    await inspect(page);
    await expect(page.locator("#check-status")).toContainText("Explain why");
    await expect(
      page.getByRole("button", { name: "Save local revision", exact: true }),
    ).toBeDisabled();
  },
);

await check(
  "AUTHOR-004 edited content invalidates checks and stays literal",
  async (page) => {
    await open(page);
    await budget(page);
    await inspect(page);
    await expect(
      page.getByRole("button", { name: "Save local revision", exact: true }),
    ).toBeEnabled();
    const literal =
      '<img src=x onerror="window.injected=true"> The amount is not given.';
    await page.getByLabel("Answer explanation", { exact: true }).fill(literal);
    await expect(
      page.getByRole("checkbox", {
        name: "I checked this draft against the source and critique",
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(page.locator("#preview")).toContainText("Preview out of date");
    await expect(
      page.getByRole("button", { name: "Save local revision", exact: true }),
    ).toBeDisabled();
    await inspect(page);
    await expect(page.locator("#preview")).toContainText(literal);
    expect(await page.locator("#preview img, #comparison img").count()).toBe(0);
    const record = JSON.parse(
      await download(page, "Download draft and history"),
    );
    expect(record.draft.fields.feedback).toBe(literal);
    await page
      .getByLabel("Why this revision?", { exact: true })
      .fill("A new reason needs another check.");
    await expect(
      page.getByRole("checkbox", {
        name: "I checked this draft against the source and critique",
        exact: true,
      }),
    ).not.toBeChecked();
    await page.locator("h1").click();
    const pending = page.waitForEvent("dialog");
    const leaving = page.goto("about:blank");
    const dialog = await pending;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
    await leaving;
  },
);

await check(
  "AUTHOR-004 preview without writing does not warn on leaving",
  async (page) => {
    await open(page);
    await page
      .getByRole("button", { name: "Preview this draft", exact: true })
      .click();
    let dialogs = 0;
    page.on("dialog", async (d) => {
      dialogs++;
      await d.accept();
    });
    await page.goto("about:blank");
    expect(dialogs).toBe(0);
  },
);

await check(
  "AUTHOR-005 failed save preserves a downloadable draft and permits retry",
  async (page) => {
    await open(page);
    await budget(page);
    await inspect(page);
    await page.evaluate(() => {
      window.originalWorkshopSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith("dne-content-workshop-1:"))
          throw new Error("fixture quota");
        return window.originalWorkshopSet.call(this, k, v);
      };
    });
    await save(page);
    await expect(page.locator("#save-status")).toContainText(
      "Could not confirm a save",
    );
    await expect(
      page.getByLabel("Answer explanation", { exact: true }),
    ).toHaveValue(budgetFeedback);
    const record = JSON.parse(
      await download(page, "Download draft and history"),
    );
    expect(record.draft.fields.feedback).toBe(budgetFeedback);
    expect(record.saved.revisions).toHaveLength(0);
    await page.evaluate(() => {
      Storage.prototype.setItem = window.originalWorkshopSet;
    });
    await save(page);
    await expect(page.locator("#save-status")).toContainText(
      "Saved local revision 2",
    );
  },
);

for (const [label, raw] of [
  ["malformed", "{broken original"],
  [
    "different fixture",
    JSON.stringify({
      version: 1,
      fixtureVersion: "old",
      caseId: "budget",
      revisions: [],
    }),
  ],
]) {
  await check(
    `AUTHOR-006 ${label} record remains recoverable`,
    async (page) => {
      await page.addInitScript(
        ({ key, raw }) => localStorage.setItem(key, raw),
        { key: budgetKey, raw },
      );
      await open(page);
      await expect(page.locator("#save-status")).toContainText(
        "Stored copy is protected",
      );
      await budget(page);
      await inspect(page);
      await expect(
        page.getByRole("button", { name: "Save local revision", exact: true }),
      ).toBeDisabled();
      expect(await download(page, "Download stored copy")).toBe(raw);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), budgetKey),
      ).toBe(raw);
    },
  );
}

await check(
  "AUTHOR-007 concurrent local revisions are compared and deliberately rebased",
  async (page, context) => {
    await open(page);
    const other = await context.newPage();
    await open(other);
    await budget(page, "First tab corrects both keys.");
    await inspect(page);
    await save(page);
    await budget(other, "Second tab supplies a different explanation.");
    const otherFeedback =
      "No amount is supplied. Unknown is not an incompatible amount.";
    await other
      .getByLabel("Answer explanation", { exact: true })
      .fill(otherFeedback);
    await inspect(other);
    await save(other);
    await expect(other.locator("#save-status")).toContainText(
      "A newer local revision exists",
    );
    await expect(
      other.getByLabel("Answer explanation", { exact: true }),
    ).toHaveValue(otherFeedback);
    await other
      .getByRole("button", { name: "Check this draft", exact: true })
      .click();
    await expect(
      other.getByRole("button", { name: "Save local revision", exact: true }),
    ).toBeDisabled();
    await expect(other.locator("#check-status")).toContainText(
      "Compare the latest saved revision",
    );
    await other
      .getByRole("button", { name: "Compare latest saved", exact: true })
      .click();
    await expect(other.locator("#incoming")).toContainText(budgetFeedback);
    await other
      .getByRole("button", {
        name: "Keep my draft on latest base",
        exact: true,
      })
      .click();
    await expect(
      other.getByRole("checkbox", {
        name: "I checked this draft against the source and critique",
        exact: true,
      }),
    ).not.toBeChecked();
    await inspect(other);
    await save(other);
    await expect(other.locator("#save-status")).toContainText(
      "Saved local revision 3",
    );
    const record = JSON.parse(
      await download(other, "Download draft and history"),
    );
    expect(record.saved.revisions.map((r) => r.fields.feedback)).toEqual([
      budgetFeedback,
      otherFeedback,
    ]);
    await other.close();
  },
);

await check(
  "AUTHOR-008 cases and learner storage remain separate",
  async (page) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "dne-course-reader-1:everyday:fixture",
        "keep learner bytes",
      );
      localStorage.setItem("dne-prototype-fixture", "keep prototype bytes");
    });
    await open(page);
    await budget(page);
    await page
      .getByRole("button", { name: "Simultaneous staffing", exact: true })
      .click();
    await page
      .getByLabel("Worked request", { exact: true })
      .fill("Separate unsaved staffing draft.");
    await page
      .getByRole("button", { name: "Budget classification", exact: true })
      .click();
    await expect(
      page.getByLabel("Answer explanation", { exact: true }),
    ).toHaveValue(budgetFeedback);
    await inspect(page);
    await save(page);
    await page
      .getByRole("button", { name: "Simultaneous staffing", exact: true })
      .click();
    await expect(
      page.getByLabel("Worked request", { exact: true }),
    ).toHaveValue("Separate unsaved staffing draft.");
    expect(
      await page.evaluate(() => [
        localStorage.getItem("dne-course-reader-1:everyday:fixture"),
        localStorage.getItem("dne-prototype-fixture"),
      ]),
    ).toEqual(["keep learner bytes", "keep prototype bytes"]);
  },
);

await browser.close();
await writeFile(
  path.join(output, "results.json"),
  JSON.stringify({ url, retries: 0, results }, null, 2),
);
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    report: path.join(output, "results.json"),
  }),
);
if (results.some((r) => r.status === "failed")) process.exitCode = 1;
