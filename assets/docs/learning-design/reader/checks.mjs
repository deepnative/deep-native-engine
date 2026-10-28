import {
  chromium,
  expect,
} from "../../../../node_modules/@playwright/test/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [url, output] = process.argv.slice(2);
const caseIndex = process.argv.indexOf("--case");
const selectedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : null;
if (!url || !output)
  throw new Error(
    "Usage: node checks.mjs <reader URL> <evidence folder> [--baseline]",
  );
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
async function check(name, action, viewport = { width: 1360, height: 950 }) {
  if (selectedCase && !name.includes(selectedCase)) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const started = Date.now();
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
    });
  } finally {
    await context.close();
  }
}

if (process.argv.includes("--baseline")) {
  await check(
    "READER-001 missing complete-course reader (expected first failure)",
    async (page) => {
      await page.goto(url);
      await expect(
        page.getByRole("heading", {
          name: "Choose a task you can check",
          exact: true,
        }),
      ).toBeVisible({ timeout: 3000 });
      await expect(
        page.getByRole("navigation", { name: "Course path" }),
      ).toBeVisible();
    },
  );
}

const titles = [
  "Choose a task you can check",
  "Write a useful request",
  "Check an answer against its source",
  "Choose what to use and share",
  "Build a small repeatable workflow",
  "Give feedback someone can use",
];
// Expected keys and source phrases were read from the authored lessons, not
// imported from the reader's generated answer data.
const expected = {
  Everyday: {
    route: "everyday",
    sources: [
      "Twelve volunteers",
      "Twelve volunteers",
      "Twelve volunteers",
      "six helpers, forty seed packets",
      "six helpers available",
      "six helpers and forty packets",
    ],
    keys: [
      ["B"],
      ["C"],
      ["Supported", "Contradicted", "Not given"],
      ["B"],
      ["B"],
      ["A"],
    ],
    fresh: [
      "eight helpers",
      "six helpers",
      "nine people",
      "ten helpers",
      "Four helpers",
      "nine people",
    ],
    final: "eighteen confirmed guests and two helpers",
  },
  Work: {
    route: "work",
    sources: [
      "Sam will write",
      "Sam writes",
      "assigned owner is Sam",
      "client's name",
      "Mina drafts",
      "Mina drafts",
    ],
    keys: [
      ["A"],
      ["B"],
      ["Supported", "Contradicted", "Not given"],
      ["C"],
      ["C"],
      ["C"],
    ],
    fresh: [
      "three comments",
      "Mina drafts",
      "Noor",
      "eighteen support requests",
      "Jo on Friday",
      "Noor",
    ],
    final: "Noor writes one page",
  },
  Technical: {
    route: "technical",
    sources: [
      "email and password",
      "email and password",
      "No tests have been run",
      "access token",
      "contact form requires",
      "No tests have been run",
    ],
    keys: [
      ["C"],
      ["A"],
      ["Supported", "Contradicted", "Not given"],
      ["A"],
      ["A"],
      ["B"],
    ],
    fresh: [
      "PDFs up to 2 MB",
      "blank message",
      "PNG images up to 4 MB",
      "PDF up to 2 MB",
      "3 MB PDF",
      "PDFs up to 2 MB",
    ],
    final: "PNG images up to 3 MB",
  },
};
async function start(page, name = "Everyday") {
  const response = await page.goto(url);
  expect(response.status()).toBe(200);
  await page.getByRole("button", { name, exact: true }).click();
  await enterCurrentLesson(page);
}
async function enterCurrentLesson(page) {
  // New empty notebooks open the named learning path; saved sessions still
  // restore their lesson directly. This is navigation setup, not an assertion.
  if (
    await page
      .getByRole("heading", { name: "Your learning path", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Continue learning", exact: true })
      .click();
}
async function openCourse(page) {
  const menu = page.locator("#course-menu");
  if ((await menu.count()) && (await menu.getAttribute("open")) === null)
    await menu.getByText("Course contents", { exact: true }).click();
}
async function selectLesson(page, index) {
  await openCourse(page);
  await page.locator(`[data-lesson="${index}"]`).click();
}
async function step(page, name) {
  await enterCurrentLesson(page);
  await page
    .getByRole("navigation", { name: "Lesson stages" })
    .getByRole("button", { name, exact: false })
    .click();
}
const finalStages = [
  "Read the brief",
  "Write a first draft",
  "Read the update",
  "Revise and check",
];
async function finalStep(page, index) {
  await page
    .getByRole("navigation", { name: "Final practice steps", exact: true })
    .getByRole("button", { name: finalStages[index], exact: true })
    .click();
}
async function fillFinal(page, index, value) {
  await finalStep(page, index < 5 ? 1 : 3);
  await page.locator(`#writing-final${index}`).fill(value);
}
async function downloadText(page, button) {
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  return readFile(await download.path(), "utf8");
}

if (!process.argv.includes("--baseline")) {
  for (const width of [1360, 390]) {
    await check(
      `READER-003 Work final worked record at ${width}px`,
      async (page) => {
        await start(page, "Work");
        await selectLesson(page, 6);
        const draft =
          "My task: make a CAP-W action table; check each owner and date against the brief.";
        await fillFinal(page, 0, draft);
        await finalStep(page, 3);
        const worked = page.locator("#final-comparison");
        await worked.locator("summary").click();
        for (const title of [
          "1. Task and check.",
          "2. Request.",
          "3. Claim check and repair.",
          "4. Use/share decision.",
          "5. Repeatable workflow.",
          "6. Practice feedback and revision.",
        ]) {
          await expect(worked.getByText(title, { exact: true })).toBeVisible();
        }
        await expect(
          worked.getByRole("row", {
            name: "Retain one-page instruction draft Noor Received; not trial-tested",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          worked.getByRole("row", {
            name: "Consolidate four written comments Lee Friday noon",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          worked.getByRole("row", {
            name: "Facilitate six-case remote pilot, 11:00–11:30 Mira Thursday",
            exact: true,
          }),
        ).toBeVisible();
        const trialDay = worked.getByRole("cell", {
          name: "Thursday",
          exact: true,
        });
        expect(
          await trialDay.evaluate((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return new Set(
              [...range.getClientRects()].map((rect) => Math.round(rect.top)),
            ).size;
          }),
          "The ordinary date word should remain on one line inside its cell",
        ).toBe(1);
        await expect(worked).toContainText(
          "Monday, with the meeting time still to be confirmed",
        );
        await expect(worked).toContainText(
          "Recover the source before confirming the draft",
        );
        await expect(worked).toContainText("This is practice feedback");
        await expect(
          page.getByLabel("1. Task and check", { exact: true }),
        ).toHaveValue(draft);
        await expect(page.locator("#self-check")).not.toBeChecked();
        await expect(page.locator("#source-text")).toContainText(
          "Noor writes one page",
        );
        await expect(worked).not.toContainText("PILOT-1");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await worked.screenshot({
          path: path.join(output, `work-record-${width}.png`),
        });
      },
      { width, height: 950 },
    );
    await check(
      `READER-003 Technical final worked record at ${width}px`,
      async (page) => {
        await start(page, "Technical");
        await selectLesson(page, 6);
        const draft =
          "My CAP-T2 investigation: separate supplied observations from new boundary checks and their not-run status.";
        await fillFinal(page, 0, draft);
        await finalStep(page, 3);
        const worked = page.locator("#final-comparison");
        await worked.locator("summary").click();
        for (const title of [
          "1. Task and check.",
          "2. Request.",
          "3. Claim check and repair.",
          "4. Use/share decision.",
          "5. Repeatable workflow.",
          "6. Practice feedback and revision.",
        ]) {
          await expect(worked.getByText(title, { exact: true })).toBeVisible();
        }
        for (const row of [
          "Valid PNG, 2,999,999 bytes Accept R1 Not run None",
          "Valid PNG, 3,000,000 bytes Accept R1 inclusive limit Not run None",
          "Valid PNG, 3,000,001 bytes Reject R1 Not run None",
          "Valid JPEG, 1,000,000 bytes Unspecified R1 has no JPEG decision Not run None",
        ]) {
          await expect(
            worked.getByRole("row", { name: row, exact: true }),
          ).toBeVisible();
        }
        await expect(worked).toContainText(
          "do not replace the unknown JPEG rule with either accept or reject",
        );
        await expect(worked).toContainText(
          "Inspect the available request/storage outcome for T03",
        );
        await expect(worked).toContainText("interrupted/unconfirmed");
        await expect(worked).toContainText(
          "Keep T01–T03 as observations of web2.4-r7/api2.4-a5",
        );
        await expect(worked).toContainText(
          "This is supplied practice feedback",
        );
        await expect(worked).not.toContainText("UPLOAD-1");
        await expect(worked).toContainText(
          "R0 does not define release 2.4 expectations",
        );
        await expect(
          page.getByLabel("1. Task and check", { exact: true }),
        ).toHaveValue(draft);
        await expect(page.locator("#self-check")).not.toBeChecked();
        await expect(page.locator("#source-text")).toContainText(
          "No tests have been run",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await worked.screenshot({
          path: path.join(output, `technical-record-${width}.png`),
        });
      },
      { width, height: 950 },
    );
  }
  await check(
    "READER-002 rehearsal correct feedback leads forward",
    async (page) => {
      await start(page);
      await step(page, "Try it");
      await page.locator('input[value="A"]').check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(page.locator(".answer-feedback")).toContainText(
        "Try another choice",
      );
      await page.locator('input[value="B"]').check();
      await page
        .getByRole("button", { name: "Check answer", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Try it", exact: true }),
      ).not.toContainText(/try again/i);
      await expect(page.locator("#practice-guidance")).toContainText(
        "fresh case",
      );
      await page.locator('input[value="C"]').check();
      await expect(page.locator("#practice-guidance")).not.toContainText(
        "matches",
      );
    },
  );

  for (const width of [1360, 390])
    await check(
      `READER-010 rehearsal own project stays visible at ${width}px`,
      async (page) => {
        const source =
          "BOOK-1: eight helpers, thirty books, free, Sunday afternoon; location unconfirmed. <draft>";
        await start(page);
        await step(page, "Your work");
        await page.getByLabel("Your lesson work", { exact: true }).fill(source);
        for (let i = 1; i < 6; i++) {
          await selectLesson(page, i);
          await step(page, "Your work");
          await expect(page.locator("#source-text")).toHaveText(source);
          await expect(page.locator(".source-card")).toContainText(
            "Your starting work",
          );
          await expect(page.locator(".source-note")).toContainText(
            "original source",
          );
          await expect(page.locator(".source-note")).toBeVisible();
          await expect(
            page.getByLabel("Your lesson work", { exact: true }),
          ).toHaveValue("");
          if (i === 1) {
            await page
              .getByLabel("Your lesson work", { exact: true })
              .fill(
                "Draft a headline and two-sentence invitation using BOOK-1. Keep the location unconfirmed; add no exact time or guarantee that everyone receives a book. I will check every fact against BOOK-1.",
              );
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            await page.screenshot({
              path: path.join(output, `continuing-project-${width}.png`),
              fullPage: true,
            });
          }
        }
        await step(page, "Fresh case");
        await expect(page.locator("#source-text")).toContainText("nine people");
        await selectLesson(page, 6);
        await expect(page.locator("#source-text")).toContainText(
          "eighteen confirmed guests and two helpers",
        );
        await page.getByRole("button", { name: "Work", exact: true }).click();
        await selectLesson(page, 1);
        await step(page, "Your work");
        await expect(page.locator("#source-text")).not.toContainText("BOOK-1");
        await expect(page.locator(".source-card")).toContainText(
          "Example source",
        );
      },
      { width, height: 950 },
    );

  await check(
    "READER-011 rehearsal questions include the compared drafts",
    async (page) => {
      await start(page);
      await selectLesson(page, 4);
      await step(page, "Try it");
      await expect(page.locator("fieldset legend")).toContainText(
        "45 minutes with seven helpers",
      );
      await selectLesson(page, 5);
      await step(page, "Try it");
      await expect(page.locator("fieldset legend")).toContainText(
        "Eight helpers will start at 10 a.m.",
      );
      await page
        .getByRole("button", { name: "Technical", exact: true })
        .click();
      await selectLesson(page, 5);
      await step(page, "Try it");
      await expect(page.locator("fieldset legend")).toContainText(
        "Maximum message length: 500",
      );
      await expect(page.locator("fieldset legend")).toContainText(
        "Maximum message length: unspecified",
      );
    },
  );

  for (const [previousKind, storageFailure] of [
    ["original", false],
    ["versioned", false],
    ["original", true],
  ]) {
    await check(
      `READER-012 rehearsal ${previousKind} previous version with ${storageFailure ? "failed" : "successful"} current save`,
      async (page) => {
        await start(page);
        await step(page, "Your work");
        await page
          .getByLabel("Your lesson work", { exact: true })
          .fill("Earlier BOOK-1 source and work.");
        await page
          .getByLabel("I compared this work with the criteria above", {
            exact: true,
          })
          .check();
        await page.locator("#save").click();
        const previous = await page.evaluate((kind) => {
          const currentKey = Object.keys(localStorage).find((k) =>
            k.startsWith("dne-course-reader-1:everyday"),
          );
          const value = JSON.parse(localStorage.getItem(currentKey));
          const currentHash = value.contentHash;
          value.contentHash = "a".repeat(64);
          value.state.lessons[0].selections = ["a retired answer option"];
          const raw = JSON.stringify(value);
          localStorage.removeItem(currentKey);
          const previousKey = `dne-course-reader-1:everyday${kind === "versioned" ? ":" + value.contentHash : ""}`;
          localStorage.setItem(previousKey, raw);
          return { raw, currentHash, previousKey };
        }, previousKind);
        await page.reload();
        await expect(page.locator("#save")).toBeEnabled();
        await expect(page.locator("#save-status")).toContainText(
          "earlier content version",
        );
        await page.locator("#earlier-notebooks summary").click();
        expect(
          await downloadText(page, page.locator("#download-earlier")),
        ).toBe(previous.raw);
        await step(page, "Your work");
        await expect(
          page.getByLabel("Your lesson work", { exact: true }),
        ).toHaveValue("");
        await expect(page.locator("#self-check")).not.toBeChecked();
        await page
          .getByLabel("Your lesson work", { exact: true })
          .fill("Current BOOK-1 draft, deliberately rechecked.");
        if (storageFailure)
          await page.evaluate(() => {
            Storage.prototype.setItem = () => {
              throw new Error("Test save unavailable");
            };
          });
        await page.locator("#save").click();
        if (storageFailure) {
          await expect(page.locator("#save-status")).toContainText(
            "Saving failed",
          );
          expect(await downloadText(page, page.locator("#download"))).toContain(
            "Current BOOK-1 draft",
          );
        } else {
          await page.reload();
          await expect(
            page.getByLabel("Your lesson work", { exact: true }),
          ).toHaveValue("Current BOOK-1 draft, deliberately rechecked.");
          await page.locator("#earlier-notebooks summary").click();
          expect(
            await downloadText(page, page.locator("#download-earlier")),
          ).toBe(previous.raw);
        }
        expect(
          await page.evaluate(
            (k) => localStorage.getItem(k),
            previous.previousKey,
          ),
        ).toBe(previous.raw);
      },
    );
  }

  await check(
    "READER-006 rehearsal damaged current version is not overwritten",
    async (page) => {
      await start(page);
      await step(page, "Your work");
      await page
        .getByLabel("Your lesson work", { exact: true })
        .fill("Saved current notebook.");
      await page.locator("#save").click();
      const damagedKey = await page.evaluate(() => {
        const storedKey = Object.keys(localStorage).find((k) =>
          k.startsWith("dne-course-reader-1:everyday:"),
        );
        localStorage.setItem(storedKey, "{damaged current notebook");
        return storedKey;
      });
      await page.reload();
      await expect(page.locator("#save")).toBeDisabled();
      expect(await downloadText(page, page.locator("#download-stored"))).toBe(
        "{damaged current notebook",
      );
      expect(
        await page.evaluate((k) => localStorage.getItem(k), damagedKey),
      ).toBe("{damaged current notebook");
    },
  );
  await check(
    "READER-004 leave warning protects writing without interrupting reading",
    async (page) => {
      let dialogs = 0;
      page.on("dialog", () => {
        dialogs++;
      });
      await start(page);
      await selectLesson(page, 1);
      await page.reload();
      expect(
        dialogs,
        "Reading/navigation alone should not prompt on reload",
      ).toBe(0);
      await step(page, "Your work");
      await page
        .getByLabel("Your lesson work", { exact: true })
        .fill("An unsaved source-based draft worth protecting.");
      await page.reload();
      expect(dialogs, "Unsaved writing should trigger the leave warning").toBe(
        1,
      );
    },
  );
  for (const [name, data] of Object.entries(expected)) {
    await check(
      `READER-009 ${name} fresh-case source follows the exercise`,
      async (page) => {
        await start(page, name);
        for (let lesson = 0; lesson < 6; lesson++) {
          await selectLesson(page, lesson);
          await step(page, "Fresh case");
          await expect(page.locator("#source-text")).toContainText(
            data.fresh[lesson],
          );
          await expect(page.locator(".source-card .eyebrow")).toContainText(
            "Fresh source",
          );
          await step(page, "Your work");
          await expect(page.locator(".source-card .eyebrow")).toContainText(
            "Example source",
          );
        }
      },
    );
  }
  for (const [name, data] of Object.entries(expected)) {
    for (const width of [1360, 390]) {
      await check(
        `READER-001/002/003/008 ${name} complete sequence at ${width}px`,
        async (page) => {
          await start(page, name);
          for (let lesson = 0; lesson < 6; lesson++) {
            await expect(
              page.getByRole("heading", { name: titles[lesson], exact: true }),
            ).toBeVisible();
            await expect(page.locator("#source-text")).toContainText(
              data.sources[lesson],
            );
            const body = page.getByRole("region", {
              name: "See an example",
              exact: true,
            });
            await expect(body).toContainText(
              `Source ${data.route === "everyday" ? "E" : data.route === "work" ? "W" : "T"}${lesson + 1}`,
            );
            const other = data.route === "everyday" ? "W" : "E";
            await expect(body).not.toContainText(
              `Source ${other}${lesson + 1}`,
            );
            await step(page, "Try it");
            await page.locator("#hint summary").click();
            await expect(page.locator("#hint")).toHaveAttribute("open", "");
            for (let q = 0; q < data.keys[lesson].length; q++) {
              const field = page.locator("fieldset").nth(q);
              const answer = data.keys[lesson][q];
              const wrong =
                answer === "A"
                  ? "B"
                  : answer.length === 1
                    ? "A"
                    : answer === "Supported"
                      ? "Contradicted"
                      : "Supported";
              await field.locator(`input[value="${wrong}"]`).check();
            }
            await page
              .getByRole("button", { name: /^Check answers?$/ })
              .click();
            await expect(
              page.locator(".answer-feedback").first(),
            ).toContainText("Try another choice");
            for (let q = 0; q < data.keys[lesson].length; q++)
              await page
                .locator("fieldset")
                .nth(q)
                .locator(`input[value="${data.keys[lesson][q]}"]`)
                .check();
            await page
              .getByRole("button", { name: /^Check answers?$/ })
              .click();
            await expect(page.locator(".answer-feedback.positive")).toHaveCount(
              data.keys[lesson].length,
            );
            await step(page, "Fresh case");
            await expect(
              page.getByRole("region", { name: "Fresh case", exact: true }),
            ).toContainText(data.fresh[lesson]);
            await page
              .getByLabel("Your fresh-case attempt", { exact: true })
              .fill(
                `${name} fresh attempt for lesson ${lesson + 1}: keep the source facts and explain the check.`,
              );
            const workedComparison =
              lesson === 1
                ? page.locator(".lesson-body > details").filter({
                    has: page.getByText("Compare with a worked request", {
                      exact: true,
                    }),
                  })
                : page.locator(".lesson-body > details");
            await workedComparison.locator(":scope > summary").click();
            await expect(workedComparison).toHaveAttribute("open", "");
            await step(page, "Your work");
            await page
              .getByLabel("Your lesson work", { exact: true })
              .fill(
                `${name} artifact ${lesson + 1}: my source, useful output, check and unresolved detail.`,
              );
            await page
              .getByLabel("I compared this work with the criteria above", {
                exact: true,
              })
              .check();
            expect(await page.locator("#course-path").innerText()).not.toMatch(
              /completed|mastery|learned/i,
            );
            if (lesson === 0)
              await page.screenshot({
                path: path.join(output, `${data.route}-${width}-lesson.png`),
                fullPage: true,
              });
            await page.locator("#next").click();
          }
          await expect(
            page.getByRole("heading", {
              name: "Put it all together",
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.locator("#source-text")).toContainText(data.final);
          await page.locator("#notebook summary").click();
          await expect(page.locator("#notebook")).toContainText(
            `${name} artifact 1`,
          );
          await expect(page.locator("#notebook")).toContainText(
            `${name} artifact 6`,
          );
          for (let i = 0; i < 6; i++)
            await fillFinal(
              page,
              i,
              `${name} final step ${i + 1}: compare this decision with the supplied final source.`,
            );
          await page
            .getByLabel("I compared this work with the criteria above", {
              exact: true,
            })
            .check();
          await page.locator("#save").click();
          await expect(page.locator("#save-status")).toContainText(
            "Saved in this browser",
          );
          const exported = await downloadText(
            page,
            page.locator("#download-final"),
          );
          expect(exported).toContain(`${name} artifact 1`);
          expect(exported).toContain(`${name} final step 6`);
          expect(exported).toContain(data.final);
          await page.reload();
          await expect(
            page.getByRole("heading", {
              name: "Put it all together",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.locator('[data-writing="final"][data-index="5"]'),
          ).toHaveValue(
            `${name} final step 6: compare this decision with the supplied final source.`,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: path.join(output, `${data.route}-${width}-final.png`),
            fullPage: true,
          });
        },
        { width, height: 950 },
      );
    }
  }

  await check(
    "READER-004 route drafts, explicit save/resume and unchanged prototype storage",
    async (page) => {
      await page.goto(`${url}#route=constructor`);
      await enterCurrentLesson(page);
      await expect(
        page.getByRole("heading", { name: titles[0], exact: true }),
      ).toBeVisible({ timeout: 1500 });
      await expect(
        page.getByRole("button", { name: "Everyday", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await start(page);
      await page.evaluate(() =>
        localStorage.setItem(
          "dne-content-storyboard-0.1:everyday",
          "existing-prototype-copy",
        ),
      );
      await step(page, "Your work");
      await page
        .getByLabel("Your lesson work", { exact: true })
        .fill("Saved Everyday source and check.");
      await page.locator("#save").click();
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await step(page, "Your work");
      await page
        .getByLabel("Your lesson work", { exact: true })
        .fill("Unsaved Work source and check.");
      await page.getByRole("button", { name: "Everyday", exact: true }).click();
      await expect(
        page.getByLabel("Your lesson work", { exact: true }),
      ).toHaveValue("Saved Everyday source and check.");
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await expect(
        page.getByLabel("Your lesson work", { exact: true }),
      ).toHaveValue("Unsaved Work source and check.");
      await page.reload();
      await step(page, "Your work");
      await expect(
        page.getByLabel("Your lesson work", { exact: true }),
      ).toHaveValue("");
      await page.getByRole("button", { name: "Everyday", exact: true }).click();
      await expect(
        page.getByLabel("Your lesson work", { exact: true }),
      ).toHaveValue("Saved Everyday source and check.");
      expect(
        await page.evaluate(() =>
          localStorage.getItem("dne-content-storyboard-0.1:everyday"),
        ),
      ).toBe("existing-prototype-copy");
    },
  );

  await check(
    "READER-005 failed save preserves editable writing and downloadable sources",
    async (page) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("Test quota failure", "QuotaExceededError");
        };
      });
      await start(page);
      await step(page, "Your work");
      await page
        .getByLabel("Your lesson work", { exact: true })
        .fill("Keep this source-based recovery draft.");
      await page.locator("#save").click();
      await expect(page.locator("#save-status")).toContainText("Saving failed");
      await expect(
        page.getByLabel("Your lesson work", { exact: true }),
      ).toHaveValue("Keep this source-based recovery draft.");
      const text = await downloadText(page, page.locator("#download"));
      expect(text).toContain("Keep this source-based recovery draft.");
      expect(text).toContain("Twelve volunteers");
    },
  );

  for (const [name, raw] of [
    ["malformed", "{broken saved record"],
    [
      "older content",
      '{"version":1,"contentHash":"older-content","route":"everyday","state":{}}',
    ],
  ]) {
    await check(
      `READER-006 ${name} saved copy remains recoverable`,
      async (page) => {
        await page.addInitScript(
          (raw) => localStorage.setItem("dne-course-reader-1:everyday", raw),
          raw,
        );
        await start(page);
        if (name === "malformed") {
          await expect(page.locator("#save-status")).toContainText(
            "Saved work could not be restored",
          );
          await expect(page.locator("#save")).toBeDisabled();
        } else {
          await expect(page.locator("#save-status")).toContainText(
            "earlier content version",
          );
          await expect(page.locator("#save")).toBeEnabled();
        }
        await step(page, "Your work");
        await page
          .getByLabel("Your lesson work", { exact: true })
          .fill("New separate practice writing.");
        if (name === "older content")
          await page.locator("#earlier-notebooks summary").click();
        expect(
          await downloadText(
            page,
            page.locator(
              name === "malformed" ? "#download-stored" : "#download-earlier",
            ),
          ),
        ).toBe(raw);
        expect(await downloadText(page, page.locator("#download"))).toContain(
          "New separate practice writing.",
        );
        expect(
          await page.evaluate(() =>
            localStorage.getItem("dne-course-reader-1:everyday"),
          ),
        ).toBe(raw);
      },
    );
  }

  for (const field of ["work", "transfer", "final"]) {
    await check(
      `READER-007 ${field} edit clears self-check and preserves literal text`,
      async (page) => {
        await start(page);
        if (field === "final") {
          await selectLesson(page, 6);
          for (let i = 0; i < 6; i++)
            await fillFinal(page, i, `Original criterion ${i + 1}`);
        } else {
          await step(page, "Your work");
          await page
            .getByLabel("Your lesson work", { exact: true })
            .fill("Original inspected work.");
        }
        await page
          .getByLabel("I compared this work with the criteria above", {
            exact: true,
          })
          .check();
        const literal =
          '<img src=x onerror="window.readerInjected=true"> revised practice';
        if (field === "transfer") await step(page, "Fresh case");
        if (field === "final") await finalStep(page, 1);
        const input = page.locator(`[data-writing="${field}"]`).first();
        await input.fill(literal);
        if (field === "transfer") await step(page, "Your work");
        if (field === "final") await finalStep(page, 3);
        await expect(
          page.getByLabel("I compared this work with the criteria above", {
            exact: true,
          }),
        ).not.toBeChecked();
        if (field !== "final") {
          await page.locator("#notebook summary").click();
          await expect(page.locator("#notebook")).toContainText(literal);
        }
        await page.locator("#save").click();
        await page.reload();
        expect(await page.evaluate(() => Boolean(window.readerInjected))).toBe(
          false,
        );
        expect(await downloadText(page, page.locator("#download"))).toContain(
          literal,
        );
      },
    );
  }
}

async function openFeedback(page, name = "Everyday") {
  await start(page, name);
  await selectLesson(page, 5);
  await step(page, "Fresh case");
}

const feedbackExamples = {
  Everyday: {
    source: "nine people and forty-five minutes on Wednesday",
    comment: "make it twelve people in Room 4",
    decision: "decline",
    current: "Nine people will meet; the room is undecided.",
    reason:
      "The source gives nine people and no chosen room. A complete-looking sentence cannot establish twelve people or Room 4.",
    question: "Which updated source establishes twelve people or Room 4?",
    version: 1,
  },
  Work: {
    source: "Noor is the assigned agenda owner; Lee invites participants",
    comment: "fix the agenda owner",
    decision: "addressed",
    current: "Noor is the agenda owner; Lee invites participants.",
    reason:
      "V2 already assigns the agenda to Noor. The comment remains on v1 and is not a new review of v2.",
    question: "",
    version: 2,
  },
  Technical: {
    source: "PDFs up to 2 MB. No test has run",
    comment: "separate the expected rejection from the actual execution status",
    decision: "revise",
    current:
      "Expected result: reject a 3 MB PDF under the 2 MB rule. Execution: not run.",
    reason:
      "The requirement supports expected rejection. No execution supports a passing result.",
    question: "",
    version: 2,
  },
};

for (const width of [1360, 390]) {
  for (const [name, example] of Object.entries(feedbackExamples)) {
    await check(
      `READER-013/014/015 feedback ${name} decision journey at ${width}px`,
      async (page) => {
        await openFeedback(page, name);
        await expect(
          page.getByRole("heading", {
            name: "Decide what to do with the feedback",
            exact: true,
          }),
        ).toBeVisible({ timeout: 3000 });
        await expect(page.locator("#feedback-source")).toContainText(
          example.source,
        );
        await expect(page.locator("#feedback-comment")).toContainText(
          example.comment,
        );
        await expect(page.locator("#feedback-comment")).toContainText(
          "Comment on v1",
        );
        await expect(page.locator("#feedback-comment")).toContainText(
          "Supplied practice feedback",
        );
        await page
          .getByLabel("My decision", { exact: true })
          .selectOption(example.decision);
        if (example.decision === "revise")
          await page
            .getByLabel("Revised text", { exact: true })
            .fill(example.current);
        await page
          .getByLabel("My reason", { exact: true })
          .fill(example.reason);
        if (example.question)
          await page
            .getByLabel("Clarification to keep (optional)", { exact: true })
            .fill(example.question);
        await page
          .getByRole("button", {
            name: "Add decision to my notebook",
            exact: true,
          })
          .click();
        await expect(page.locator("#feedback-current")).toContainText(
          `Current draft · v${example.version}`,
        );
        await expect(page.locator("#feedback-current")).toContainText(
          example.current,
        );
        await expect(page.locator("#feedback-decisions")).toContainText(
          example.reason,
        );
        await expect(page.locator("#feedback-versions")).toContainText("v1");
        if (name === "Technical")
          await expect(page.locator("#feedback-versions")).toContainText(
            "3 MB PDF rejection test: passed.",
          );
        await expect(page.locator("#feedback-notice")).toContainText(
          "Save in this browser",
        );
        await expect(page.locator("#save-status")).toContainText(
          "Unsaved changes",
        );
        await page.locator("#save").click();
        await page.reload();
        await expect(page.locator("#feedback-decisions")).toContainText(
          example.reason,
        );
        await expect(page.locator("#feedback-current")).toContainText(
          example.current,
        );
        await expect(page.locator("#save-status")).toContainText("Restored");
        const exported = await downloadText(page, page.locator("#download"));
        for (const text of [
          example.reason,
          example.current,
          example.question,
          "Comment on v1",
          "No question was sent",
        ])
          expect(exported).toContain(text);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.locator("#feedback-workflow").screenshot({
          path: path.join(
            output,
            `feedback-${name.toLowerCase()}-${width}.png`,
          ),
        });
      },
      { width, height: 950 },
    );
  }
}

async function keepFeedback(page) {
  await page
    .getByRole("button", { name: "Add decision to my notebook", exact: true })
    .click();
}

await check(
  "READER-014 feedback decisions require a valid action and preserve version history",
  async (page) => {
    await openFeedback(page, "Technical");
    await keepFeedback(page);
    await expect(page.locator("#feedback-notice")).toContainText(
      "Choose what to do",
    );
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("addressed");
    await keepFeedback(page);
    await expect(page.locator("#feedback-notice")).toContainText(
      "Give a reason",
    );
    await page
      .getByLabel("My reason", { exact: true })
      .fill("No newer draft exists yet.");
    await keepFeedback(page);
    await expect(page.locator("#feedback-notice")).toContainText(
      "no newer draft",
    );
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("revise");
    await keepFeedback(page);
    await expect(page.locator("#feedback-notice")).toContainText(
      "different, nonempty",
    );
    await page.getByLabel("Revised text", { exact: true }).fill(" ");
    await keepFeedback(page);
    await expect(page.locator("#feedback-notice")).toContainText(
      "different, nonempty",
    );
    await expect(page.locator("#feedback-decisions")).toContainText(
      "No decision recorded",
    );
    await page
      .getByLabel("Revised text", { exact: true })
      .fill(feedbackExamples.Technical.current);
    await page
      .getByLabel("My reason", { exact: true })
      .fill(feedbackExamples.Technical.reason);
    await keepFeedback(page);
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("addressed");
    await page
      .getByLabel("My reason", { exact: true })
      .fill("The correction is now in v2; the comment still refers to v1.");
    await keepFeedback(page);
    await expect(page.locator("#feedback-current")).toContainText(
      "Current draft · v2",
    );
    await expect(
      page.locator("#feedback-decisions .decision-record"),
    ).toHaveCount(2);
    await expect(page.locator("#feedback-versions")).not.toContainText(
      "Draft v3",
    );
    await expect(page.locator("#feedback-comment")).toContainText(
      "Comment on v1",
    );
    await keepFeedback(page);
    await expect(
      page.locator("#feedback-decisions .decision-record"),
    ).toHaveCount(2);
    await page.locator("#save").click();
    await page.reload();
    await expect(
      page.locator("#feedback-decisions .decision-record"),
    ).toHaveCount(2);
  },
);

await check(
  "READER-015 feedback save failure retains the earlier save and new response",
  async (page) => {
    await openFeedback(page);
    await page.locator("#save").click();
    const baseline = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("dne-course-reader-1:everyday:"),
      );
      return { key, raw: localStorage.getItem(key) };
    });
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("decline");
    await page
      .getByLabel("My reason", { exact: true })
      .fill(feedbackExamples.Everyday.reason);
    await page
      .getByLabel("Clarification to keep (optional)", { exact: true })
      .fill(feedbackExamples.Everyday.question);
    await keepFeedback(page);
    await page.evaluate(() => {
      window.feedbackSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith("dne-course-reader-1:"))
          throw new Error("fixture storage failure");
        return window.feedbackSetItem.call(this, k, v);
      };
    });
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toContainText("Saving failed");
    await expect(page.locator("#feedback-decisions")).toContainText(
      feedbackExamples.Everyday.reason,
    );
    expect(
      await page.evaluate((key) => localStorage.getItem(key), baseline.key),
    ).toBe(baseline.raw);
    const exported = await downloadText(page, page.locator("#download"));
    expect(exported).toContain(feedbackExamples.Everyday.reason);
    expect(exported).toContain(feedbackExamples.Everyday.question);
    await page.evaluate(() => {
      Storage.prototype.setItem = window.feedbackSetItem;
    });
    await page.locator("#save").click();
    await page.reload();
    await expect(page.locator("#feedback-decisions")).toContainText(
      feedbackExamples.Everyday.reason,
    );
  },
);

for (const corruption of [
  "wrong comment version",
  "rewritten retained artifact",
  "another route",
]) {
  await check(
    `READER-015 feedback ${corruption} record is protected`,
    async (page) => {
      await openFeedback(page, "Work");
      await page
        .getByLabel("My decision", { exact: true })
        .selectOption("addressed");
      await page
        .getByLabel("My reason", { exact: true })
        .fill(feedbackExamples.Work.reason);
      await keepFeedback(page);
      await page.locator("#save").click();
      const saved = await page.evaluate((kind) => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("dne-course-reader-1:work:"),
        );
        const value = JSON.parse(localStorage.getItem(key));
        if (kind === "wrong comment version")
          value.state.feedback.records[0].commentVersion = 2;
        if (kind === "rewritten retained artifact")
          value.state.feedback.records[0].text =
            "A changed draft pretending to be retained.";
        if (kind === "another route") value.state.feedback.caseId = "L6-E-X";
        const raw = JSON.stringify(value);
        localStorage.setItem(key, raw);
        return { key, raw };
      }, corruption);
      await page.reload();
      await expect(page.locator("#save-status")).toContainText(
        "record is unreadable",
      );
      await expect(page.locator("#save")).toBeDisabled();
      expect(await downloadText(page, page.locator("#download-stored"))).toBe(
        saved.raw,
      );
      expect(
        await page.evaluate((key) => localStorage.getItem(key), saved.key),
      ).toBe(saved.raw);
    },
  );
}

await check(
  "READER-015/016 feedback unfinished drafts survive save and remain separate by route",
  async (page) => {
    await openFeedback(page);
    const dialogs = [];
    page.on("dialog", (dialog) => dialogs.push(dialog.type()));
    await page.goto("about:blank");
    expect(dialogs).toEqual([]);
    await openFeedback(page);
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("decline");
    await page
      .getByLabel("My reason", { exact: true })
      .fill("Everyday unfinished source check.");
    await page
      .getByLabel("Clarification to keep (optional)", { exact: true })
      .fill("An unsent Everyday question.");
    await page.locator("#save").click();
    await page.reload();
    await expect(page.getByLabel("My reason", { exact: true })).toHaveValue(
      "Everyday unfinished source check.",
    );
    await expect(page.locator("#feedback-decisions")).toContainText(
      "No decision recorded",
    );
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await selectLesson(page, 5);
    await step(page, "Fresh case");
    await expect(page.getByLabel("My reason", { exact: true })).toHaveValue("");
    await page
      .getByLabel("My reason", { exact: true })
      .fill("Separate unsaved Work response.");
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await expect(page.getByLabel("My reason", { exact: true })).toHaveValue(
      "Everyday unfinished source check.",
    );
    const exported = await downloadText(page, page.locator("#download"));
    expect(exported).toContain("Unfinished response (not a recorded decision)");
    expect(exported).not.toContain("Separate unsaved Work response.");
    await page.goto("about:blank");
    expect(dialogs).toEqual(["beforeunload"]);
  },
);

await check(
  "READER-016 feedback edits clear the lesson self-check and preserve literal proposals",
  async (page) => {
    await openFeedback(page);
    await step(page, "Your work");
    await page
      .getByLabel("Your lesson work", { exact: true })
      .fill("Previously self-checked lesson work.");
    await page
      .getByLabel("I compared this work with the criteria above", {
        exact: true,
      })
      .check();
    await step(page, "Fresh case");
    const literal =
      '<img src=x onerror="window.feedbackInjected=true"> a proposed alternative';
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("revise");
    await page.getByLabel("Revised text", { exact: true }).fill(literal);
    await expect(page.locator("#feedback-proposed")).toHaveText(literal);
    await page
      .getByLabel("My decision", { exact: true })
      .selectOption("decline");
    await page
      .getByLabel("My reason", { exact: true })
      .fill("Keep the original source facts. " + literal);
    await keepFeedback(page);
    await expect(page.locator("#feedback-current")).toContainText(
      feedbackExamples.Everyday.current,
    );
    await expect(page.locator("#feedback-decisions")).toContainText(
      "Unapplied proposal retained",
    );
    expect(await page.locator("#feedback-workflow img").count()).toBe(0);
    await step(page, "Your work");
    await expect(
      page.getByLabel("I compared this work with the criteria above", {
        exact: true,
      }),
    ).not.toBeChecked();
    await page.locator("#save").click();
    await page.reload();
    expect(await page.evaluate(() => Boolean(window.feedbackInjected))).toBe(
      false,
    );
    expect(await downloadText(page, page.locator("#download"))).toContain(
      literal,
    );
  },
);

// Source-derived expectations for the revised alternatives. These are not
// imported from course.mjs, and do not grade learners' free writing.
const refinedPractice = {
  Everyday: {
    1: [
      ["at the library", "The library is not established"],
      ["leaving venue and budget open", "B keeps the task within E1"],
      ["adding staff counts", "Adding staff counts across sequential slots"],
    ],
    2: [
      ["total volunteer-hours", "A total of volunteer-hours can hide"],
      ["use 9 a.m.", "B supplies a start time that E2 does not give"],
      ["at the same time", "C exposes the peak staffing demand"],
    ],
    4: [
      ["names replaced by initials", "A still carries phone numbers"],
      ["invented brief", "B keeps the useful planning facts"],
      [
        "Publish the real invitation",
        "C turns practice into a real public release",
      ],
    ],
    5: [
      [
        "swap 45 min / 7",
        "A totals sixty minutes but still needs seven helpers",
      ],
      ["swap 40 min / 6", "B passes both stated checks"],
      [
        "swap 45 min / 6",
        "C fits the helper limit but still totals sixty-five minutes",
      ],
    ],
    6: [
      ["I checked the notes, not the event", "A repairs both claims using E6"],
      [
        "confirmed start",
        "B fixes the count but keeps an unsupported start time",
      ],
      ["both the helper count and time unknown", "C discards the known count"],
    ],
  },
  Work: {
    1: [
      ["leave missing fields open", "A preserves W1's separate commitments"],
      ["Tuesday for every date", "B transfers the trial date"],
      ["Alex for the announcement", "C assigns Alex a task"],
    ],
    2: [
      ["every task next Tuesday", "A transfers the process test date"],
      ["each populated cell", "B makes the source check explicit"],
      [
        "announcement to Alex",
        "C preserves dates but invents an announcement owner",
      ],
    ],
    4: [
      ["original complaint", "A changes a name but reuses the real complaint"],
      ["reading access covers", "B treats reading access as permission"],
      ["fictional library-team note", "C preserves the task structure"],
    ],
    5: [
      ["Thursday for any date", "A checks owners but invents deadlines"],
      ["Mina for the trial", "B checks dates but invents the trial owner"],
      ["unsupported cells not specified", "C checks both kinds of commitment"],
    ],
    6: [
      ["Thursday as Mina's deadline", "A borrows the trial date"],
      ["remove Mina's owner entry", "B removes a known owner"],
      ["which source gives her", "C retains the known task"],
    ],
  },
  Technical: {
    1: [
      [
        "mark those checks passed",
        "A treats a requirement as an execution result",
      ],
      [
        "account privacy as covered",
        "B assumes invalid-input cases also cover account privacy",
      ],
      ["record not run", "C produces candidate cases"],
    ],
    2: [
      [
        "missing input limits open",
        "A keeps requirements and execution separate",
      ],
      ["eight-character minimum", "B adds a password minimum"],
      ["privacy passed", "C turns expected wording into a passing result"],
    ],
    4: [
      [
        "invented email and blank message",
        "A creates the required practice case",
      ],
      ["no new permission needed", "B treats redaction as permission"],
      ["customer's original email", "C still uses the customer's address"],
    ],
    5: [
      ["finish the missing cases manually", "A keeps the retained source"],
      ["expected results passed", "B confuses an expectation with execution"],
      ["Retry from memory", "C abandons the available source"],
    ],
    6: [
      ["record v2 as reviewed", "A invents a new review"],
      ["already addressed, with no new review", "B records the two changes"],
      ["overwrite v1", "C overwrites the evidence"],
    ],
  },
};
for (const width of [1360, 390]) {
  for (const [routeName, lessons] of Object.entries(refinedPractice)) {
    for (const [number, choices] of Object.entries(lessons)) {
      await check(
        `READER-017 ${routeName} lesson ${number} practice diagnoses all choices at ${width}px`,
        async (page) => {
          await start(page, routeName);
          const index = Number(number) - 1;
          await selectLesson(page, index);
          await expect(page.locator("#source-text")).toContainText(
            expected[routeName].sources[index],
          );
          await step(page, "Try it");
          for (const [choiceIndex, [label, feedback]] of choices.entries()) {
            const key = "ABC"[choiceIndex];
            const field = page.locator("fieldset");
            await expect(
              field.locator("label.choice").nth(choiceIndex),
            ).toContainText(label);
            await field.locator(`input[value="${key}"]`).check();
            await page
              .getByRole("button", { name: "Check answer", exact: true })
              .click();
            await expect(field.locator(`input[value="${key}"]`)).toBeChecked();
            await expect(field.locator(".answer-feedback")).toContainText(
              `You chose ${key}.`,
            );
            await expect(field.locator(".answer-feedback")).toContainText(
              feedback,
            );
            await expect(
              field.locator(".answer-feedback.positive"),
            ).toHaveCount(key === expected[routeName].keys[index][0] ? 1 : 0);
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          if (routeName === "Everyday" && Number(number) === 2)
            await page.locator(".lesson-body").screenshot({
              path: path.join(output, `refined-request-${width}.png`),
            });
          await step(page, "Fresh case");
          await expect(page.locator("#source-text")).toContainText(
            expected[routeName].fresh[index],
          );
        },
        { width, height: 950 },
      );
    }
  }
}

const dialogueCases = {
  Everyday: {
    hint: "How many visitors does L2-E-X say will attend?",
    repair: "forty packets does not tell us the number of visitors",
    unsupported: "L2-E-X does not confirm a library booking",
    draft:
      "Attempt: Invite everyone to the library at ten and promise each visitor a packet.",
    revised:
      "Repair: Draft a one-hour Sunday seed-swap invitation with six helpers and forty packets; keep location and start time open and promise no packet per visitor.\nReason: L2-E-X gives packet stock, not attendance or a booking.",
  },
  Work: {
    hint: "Which task does L2-W-X attach Thursday to?",
    repair: "Thursday belongs to the trial",
    unsupported: "L2-W-X does not give Arun a review deadline",
    draft:
      "Attempt: Make Mina's survey and Arun's review due Thursday; Mina owns the launch.",
    revised:
      "Repair: List Mina's survey and Arun's wording check with dates not specified; Thursday's trial has no named owner. Keep launch date open.\nReason: The note assigns Thursday to the trial, not to either task deadline.",
  },
  Technical: {
    hint: "Which sentence in L2-T-X supplies a 500-character limit?",
    repair: "an expected explanation is not an observed result",
    unsupported: "L2-T-X leaves maximum message length unspecified",
    draft:
      "Attempt: Write passing blank-message tests and use a 500-character maximum.",
    revised:
      "Repair: Propose cases with input, expected behavior, source requirement and execution not run. Include a blank message and leave maximum length unspecified.\nReason: L2-T-X supplies a requirement but no execution result or maximum length.",
  },
};
for (const width of [1360, 390]) {
  for (const [name, sample] of Object.entries(dialogueCases)) {
    await check(
      `READER-018 ${name} supplied follow-up and retained revision at ${width}px`,
      async (page) => {
        await start(page, name);
        await selectLesson(page, 1);
        await step(page, "Fresh case");
        const writing = page.getByLabel("Your fresh-case attempt", {
          exact: true,
        });
        await writing.fill(sample.draft);
        const dialogue = page.locator(".lesson-body > details").filter({
          has: page.getByText(`Follow the ${name} repair conversation`, {
            exact: true,
          }),
        });
        await expect(dialogue).toHaveCount(1);
        await dialogue.locator(":scope > summary").click();
        await expect(dialogue).toContainText("Supplied teaching conversation");
        await expect(dialogue).toContainText(
          "not a reply generated from your writing",
        );
        await expect(dialogue).toContainText(sample.hint);
        await expect(writing).toHaveValue(sample.draft);
        const repaired = dialogue.locator("details").filter({
          has: page.getByText("Read the repair and reason", { exact: true }),
        });
        await repaired.locator("summary").click();
        await expect(repaired).toContainText(sample.repair);
        const limits = dialogue.locator("details").filter({
          has: page.getByText(
            "When evidence is missing or a request goes beyond the source",
            { exact: true },
          ),
        });
        await limits.locator("summary").click();
        await expect(limits).toContainText("I need to see the revised request");
        await expect(limits).toContainText(sample.unsupported);
        await expect(writing).toHaveValue(sample.draft);
        const record = `${sample.draft}\n${sample.revised}`;
        await writing.fill(record);
        await page
          .getByRole("button", { name: "Save in this browser", exact: true })
          .click();
        const exported = await downloadText(page, page.locator("#download"));
        expect(exported).toContain(record);
        expect(exported).toContain(
          "Local practice writing; no automatic grade or independent review.",
        );
        await page.reload();
        await expect(writing).toHaveValue(record);
        await expect(page.locator("#source-text")).toContainText(
          expected[name].fresh[1],
        );
        await page
          .getByText(`Follow the ${name} repair conversation`, { exact: true })
          .click();
        await page
          .getByText("Read the repair and reason", { exact: true })
          .click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await dialogue.screenshot({
          path: path.join(
            output,
            `dialogue-${expected[name].route}-${width}.png`,
          ),
        });
      },
      { width, height: 950 },
    );
  }
}

const contributionFields = {
  problem: "Problem and source version",
  first: "First proposal",
  revision: "Revised proposal (optional)",
  reason: "Reason and evidence",
  rights: "Sources and rights note",
  attribution: "Intended attribution (optional)",
};
const contributionDraft = {
  problem:
    "WF-LAB-01 v1 borrows Friday for two task deadlines that the source leaves open.",
  first:
    "Keep each date with its own task. Put not specified in missing date cells.",
  revision:
    "Keep sourced dates and proposed dates in separate columns. Label suggestions; do not turn them into commitments.",
  reason:
    "Friday belongs to the trial. Suggestions can be useful when their origin is visible. Checked against the invented brief, not a real team.",
  rights:
    "Original invented learning example based on WF-LAB-01 v1. No member or client text; no external reuse permission inferred.",
};
async function openContribution(page, name = "Everyday") {
  await start(page, name);
  await selectLesson(page, 6);
  await finalStep(page, 3);
  const opener = page.getByText("Shape a contribution (optional)", {
    exact: true,
  });
  await expect(opener).toHaveCount(1);
  await opener.click();
}
async function fillContribution(page) {
  for (const [key, value] of Object.entries(contributionDraft))
    await page.getByLabel(contributionFields[key], { exact: true }).fill(value);
}
for (const width of [1360, 390]) {
  for (const name of ["Everyday", "Work", "Technical"]) {
    await check(
      `READER-019 ${name} contribution draft and worked revision at ${width}px`,
      async (page) => {
        await openContribution(page, name);
        await expect(page.locator("#contribution-source")).toContainText(
          "WF-LAB-01 · version 1",
        );
        await expect(page.locator("#contribution-source")).toContainText(
          "Nora drafts invitations",
        );
        await expect(
          page.getByLabel("Intended audience", { exact: true }),
        ).toHaveValue("private");
        await fillContribution(page);
        await page
          .getByText("Compare a complete proposal and its revision", {
            exact: true,
          })
          .click();
        await expect(page.locator("#contribution-teaching")).toContainText(
          "Borrowing Friday",
        );
        await expect(page.locator("#contribution-teaching")).toContainText(
          "Proposed date",
        );
        await expect(page.locator("#contribution-teaching")).toContainText(
          "Withdraw sharing",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (name === "Work")
          await page
            .locator("#contribution-teaching .table-wrap")
            .filter({ hasText: "Proposed date" })
            .screenshot({
              path: path.join(output, `contribution-table-${width}.png`),
            });

        await expect(
          page.getByLabel("First proposal", { exact: true }),
        ).toHaveValue(contributionDraft.first);
        await page
          .getByLabel(
            "I checked this proposal against its source and sharing boundaries",
            { exact: true },
          )
          .check();
        await page.locator("#save").click();
        const exported = await downloadText(page, page.locator("#download"));
        for (const value of Object.values(contributionDraft))
          expect(exported).toContain(value);
        expect(exported).toContain("WF-LAB-01 · version 1");
        expect(exported).toContain("Not submitted or shared");
        await page.reload();
        await page
          .getByText("Shape a contribution (optional)", { exact: true })
          .click();
        for (const [key, value] of Object.entries(contributionDraft))
          await expect(
            page.getByLabel(contributionFields[key], { exact: true }),
          ).toHaveValue(value);
        await expect(page.locator("#contribution-check")).toBeChecked();
        await expect(page.locator("#contribution-status")).toContainText(
          "Not submitted or shared",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.locator("#contribution-workspace").screenshot({
          path: path.join(
            output,
            `contribution-${expected[name].route}-${width}.png`,
          ),
        });
      },
      { width, height: 950 },
    );
  }
  await check(
    `READER-020 contribution edits and cancelled sharing intent at ${width}px`,
    async (page) => {
      await openContribution(page);
      for (let i = 0; i < 6; i++)
        await fillFinal(page, i, `Retained final decision ${i + 1}.`);
      await page.locator("#self-check").check();
      await page
        .getByText("Shape a contribution (optional)", { exact: true })
        .click();
      await fillContribution(page);
      await page.locator("#contribution-check").check();
      await page
        .getByLabel("Revised proposal (optional)", { exact: true })
        .fill("Changed proposal with a proposed-date column.");
      await expect(page.locator("#contribution-check")).not.toBeChecked();
      await expect(page.locator("#self-check")).toBeChecked();
      await page.locator("#contribution-check").check();
      await page
        .getByLabel("Intended audience", { exact: true })
        .selectOption("members-later");
      await expect(page.locator("#contribution-check")).not.toBeChecked();
      await expect(page.locator("#contribution-check")).toBeDisabled();
      await page
        .getByLabel("Intended attribution (optional)", { exact: true })
        .fill("Invented workshop learner");
      await page.locator("#contribution-check").check();
      await page
        .getByLabel("Intended attribution (optional)", { exact: true })
        .fill("Invented contributor");
      await expect(page.locator("#contribution-check")).not.toBeChecked();
      await page.locator("#contribution-check").check();
      await page
        .getByRole("button", { name: "Cancel this sharing plan", exact: true })
        .click();
      await expect(
        page.getByLabel("Intended audience", { exact: true }),
      ).toHaveValue("private");
      await expect(
        page.getByLabel("Intended attribution (optional)", { exact: true }),
      ).toHaveValue("");
      await expect(
        page.getByLabel("First proposal", { exact: true }),
      ).toHaveValue(contributionDraft.first);
      await expect(
        page.getByLabel("Revised proposal (optional)", { exact: true }),
      ).toHaveValue("Changed proposal with a proposed-date column.");
      await expect(page.locator("#self-check")).toBeChecked();
      await expect(page.locator("#contribution-check")).not.toBeChecked();
      await page.locator("#save").click();
      await page.reload();
      await page
        .getByText("Shape a contribution (optional)", { exact: true })
        .click();
      await expect(
        page.getByLabel("Intended audience", { exact: true }),
      ).toHaveValue("private");
      await expect(page.locator("#self-check")).toBeChecked();
    },
    { width, height: 950 },
  );
}
await check(
  "READER-021 failed save keeps literal contribution writing downloadable",
  async (page) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Test quota failure", "QuotaExceededError");
      };
    });
    await openContribution(page);
    const literal =
      '<img src=x onerror="window.contributionInjected=true"> retain my draft';
    await page.getByLabel("First proposal", { exact: true }).fill(literal);
    await page
      .getByLabel("Intended audience", { exact: true })
      .selectOption("members-later");
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toContainText("Saving failed");
    await expect(
      page.getByLabel("First proposal", { exact: true }),
    ).toHaveValue(literal);
    const text = await downloadText(page, page.locator("#download"));
    expect(text).toContain(literal);
    expect(text).toContain("Member-only sharing considered for later");
    expect(text).toContain("Not submitted or shared");
    expect(text).toContain("Nora drafts invitations");
    expect(await page.locator("#contribution-workspace img").count()).toBe(0);
    expect(
      await page.evaluate(() => Boolean(window.contributionInjected)),
    ).toBe(false);
  },
);
for (const kind of ["missing optional worksheet", "unreadable worksheet"]) {
  await check(
    `READER-022 ${kind} preserves the stored learning record`,
    async (page) => {
      await openContribution(page);
      await fillFinal(page, 0, "Keep this saved task and check.");
      await finalStep(page, 3);
      await page
        .getByText("Shape a contribution (optional)", { exact: true })
        .click();
      await fillContribution(page);
      await page.locator("#save").click();
      const saved = await page.evaluate((kind) => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("dne-course-reader-1:everyday:"),
        );
        const value = JSON.parse(localStorage.getItem(key));
        if (kind === "missing optional worksheet")
          delete value.state.contribution;
        else value.state.contribution.audience = "published-to-everyone";
        const raw = JSON.stringify(value);
        localStorage.setItem(key, raw);
        return { key, raw };
      }, kind);
      await page.reload();
      if (kind === "missing optional worksheet") {
        await expect(page.locator("#writing-final0")).toHaveValue(
          "Keep this saved task and check.",
        );
        await page
          .getByText("Shape a contribution (optional)", { exact: true })
          .click();
        await expect(
          page.getByLabel("First proposal", { exact: true }),
        ).toHaveValue("");
        await expect(page.locator("#save")).toBeEnabled();
      } else {
        await expect(page.locator("#save-status")).toContainText(
          "record is unreadable",
        );
        await expect(page.locator("#save")).toBeDisabled();
        expect(await downloadText(page, page.locator("#download-stored"))).toBe(
          saved.raw,
        );
        expect(
          await page.evaluate((key) => localStorage.getItem(key), saved.key),
        ).toBe(saved.raw);
      }
    },
  );
}
await check(
  "READER-022 contribution drafts remain separate by route and warn on unsaved departure",
  async (page) => {
    await openContribution(page);
    await page
      .getByLabel("First proposal", { exact: true })
      .fill("Everyday private proposal.");
    await page.locator("#save").click();
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await selectLesson(page, 6);
    await finalStep(page, 3);
    await page
      .getByText("Shape a contribution (optional)", { exact: true })
      .click();
    await expect(
      page.getByLabel("First proposal", { exact: true }),
    ).toHaveValue("");
    await page
      .getByLabel("First proposal", { exact: true })
      .fill("Work unsaved contribution.");
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await page
      .getByText("Shape a contribution (optional)", { exact: true })
      .click();
    await expect(
      page.getByLabel("First proposal", { exact: true }),
    ).toHaveValue("Everyday private proposal.");
    expect(await downloadText(page, page.locator("#download"))).not.toContain(
      "Work unsaved contribution.",
    );
    const dialogs = [];
    page.on("dialog", (d) => dialogs.push(d.type()));
    await page.goto("about:blank");
    expect(dialogs).toEqual(["beforeunload"]);
  },
);

for (const width of [1360, 390]) {
  await check(
    `READER-023 realistic Work brief preserves first plan and later revision at ${width}px`,
    async (page) => {
      await start(page, "Work");
      await selectLesson(page, 6);
      await expect(
        page.getByRole("heading", {
          name: "The handover pilot: plans changed",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".lesson-body")).toContainText(
        "S3 · Wednesday 09:00",
      );
      const first =
        "First update: Thursday remote pilot, three participants. Six cases are ready; twelve sequential cases would need 46 minutes. Propose six in 28 minutes, leaving two minutes. Scope and facilitator still need a decision.";
      for (let i = 0; i < 6; i++)
        await fillFinal(
          page,
          i,
          `Decision ${i + 1}: retain the dated notes and explain the draft.`,
        );
      await fillFinal(page, 2, first);
      await finalStep(page, 3);
      await page.locator("#self-check").check();
      await finalStep(page, 2);
      await expect(page.locator(".lesson-body")).toContainText(
        "U1 · Wednesday 15:10",
      );
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#self-check")).toBeChecked();
      const revised =
        "Revision after U1: six ready cases are now approved, Mira facilitates Thursday 11:00–11:30 remotely, and Lee gathers four comments by Friday noon. Monday's continuation decision has no time yet. Reason: replace my proposed scope and open ownership with U1's explicit decision; no claim the pilot has succeeded.";
      await fillFinal(page, 5, revised);
      await expect(page.locator("#self-check")).not.toBeChecked();
      await page
        .getByText("Compare with a worked record", { exact: true })
        .click();
      const worked = page.locator("#final-comparison");
      await expect(worked).toContainText("5 + (12 × 3) + 5 = 46 minutes");
      await expect(worked).toContainText("5 + (6 × 3) + 5 = 28 minutes");
      await expect(worked).toContainText("Five cases would take 25 minutes");
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revised);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator("#self-check").check();
      await page.locator("#save").click();
      const exported = await downloadText(page, page.locator("#download"));
      for (const text of [
        first,
        revised,
        "S1 · Monday 09:00",
        "S3 · Wednesday 09:00",
        "U1 · Wednesday 15:10",
        "six ready cases",
      ])
        expect(exported).toContain(text);
      await page.reload();
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revised);
      await expect(page.locator("#self-check")).toBeChecked();
      await page
        .locator(".lesson-body")
        .screenshot({ path: path.join(output, `realistic-work-${width}.png`) });
    },
    { width, height: 950 },
  );
}

for (const width of [1360, 390]) {
  await check(
    `READER-024 realistic Technical investigation keeps observations and revision at ${width}px`,
    async (page) => {
      await start(page, "Technical");
      await selectLesson(page, 6);
      await expect(
        page.getByRole("heading", {
          name: "The upload bug: what do we actually know?",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".lesson-body")).toContainText(
        "T03 · interrupted attempt",
      );
      const first =
        "Initial finding: R1 accepts valid PNG through 3,000,000 bytes. T01 blocks the 2,500,000-byte PNG in web2.4-r7 before a request. T02's success limits the failure claim. T03 is unconfirmed. A stale client rule is a hypothesis; reproduce with the same fixture and inspect a matched service run.";
      for (let i = 0; i < 6; i++)
        await fillFinal(
          page,
          i,
          `Investigation decision ${i + 1}: keep source version and expected/actual separate.`,
        );
      await fillFinal(page, 2, first);
      await finalStep(page, 3);
      await page.locator("#self-check").check();
      await finalStep(page, 2);
      await expect(page.locator(".lesson-body")).toContainText(
        "R2 · requirement for the next candidate",
      );
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#self-check")).toBeChecked();
      const revision =
        "Revision after R2/D1: add JPEG below/at/above 3,000,000-byte checks for the next candidate. Keep T01–T03 on their original builds. The client change is only a proposed patch; record new build IDs and fresh browser/service results before calling it fixed. Do not rewrite the interrupted attempt as a rejection.";
      await fillFinal(page, 5, revision);
      await expect(page.locator("#self-check")).not.toBeChecked();
      await page
        .getByText("Compare with a worked record", { exact: true })
        .click();
      const worked = page.locator("#final-comparison");
      for (const text of [
        "2,999,999",
        "3,000,000",
        "3,000,001",
        "hypothesis",
        "Unconfirmed",
        "proposed patch",
      ])
        await expect(worked).toContainText(text);
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revision);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator("#self-check").check();
      await page.locator("#save").click();
      const exported = await downloadText(page, page.locator("#download"));
      for (const text of [
        first,
        revision,
        "R0 · superseded rule",
        "R1 · current requirement",
        "T03 · interrupted attempt",
        "R2 · requirement for the next candidate",
        "D1 · proposed patch",
      ])
        expect(exported).toContain(text);
      await page.reload();
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revision);
      await expect(page.locator("#self-check")).toBeChecked();
      await page.locator(".lesson-body").screenshot({
        path: path.join(output, `realistic-technical-${width}.png`),
      });
    },
    { width, height: 950 },
  );
}

for (const width of [1360, 390]) {
  await check(
    `READER-025 realistic Everyday plan keeps attendance states and revision at ${width}px`,
    async (page) => {
      await start(page, "Everyday");
      await selectLesson(page, 6);
      await expect(
        page.getByRole("heading", {
          name: "The book swap: who is actually coming?",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".lesson-body")).toContainText(
        "S1 · current venue confirmation",
      );
      const first =
        "First reminder: Saturday 7 November, Cedar Room, 1:30–3 p.m.; up to three books per confirmed guest. Eighteen guests plus two helpers use all twenty places. Four people are waiting, not confirmed. Maximum incoming books are 54, not a promised total. Display two per guest first and hold any third books in the box.";
      for (let i = 0; i < 6; i++)
        await fillFinal(
          page,
          i,
          `Everyday decision ${i + 1}: keep source and open questions visible.`,
        );
      await fillFinal(page, 2, first);
      await finalStep(page, 3);
      await page.locator("#self-check").check();
      await finalStep(page, 2);
      await expect(page.locator(".lesson-body")).toContainText(
        "U1 · Friday reply snapshot",
      );
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#self-check")).toBeChecked();
      const revision =
        "Revised plan: two cancellations and one accepted replacement leave seventeen confirmed guests, plus two helpers. One invitation is pending until 6 p.m.; keep that one place reserved and the other two people on the waitlist. Nineteen are confirmed in the room; twenty if the pending person accepts. Plan for at most 54 books, but neither attendance nor actual books is guaranteed. Check replies before offering the reserved place again.";
      await fillFinal(page, 5, revision);
      await expect(page.locator("#self-check")).not.toBeChecked();
      await page
        .getByText("Compare with a worked record", { exact: true })
        .click();
      const worked = page.locator("#final-comparison");
      for (const text of [
        "18 + 2 = 20",
        "18 × 3 = 54",
        "17 + 2 = 19",
        "one reserved place",
        "36 books",
        "18 books",
        "not a promise",
      ])
        await expect(worked).toContainText(text);
      await expect(worked).toContainText("1 p.m. is setup access");
      await expect(worked).toContainText("This is supplied practice feedback");
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revision);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator("#self-check").check();
      await page.locator("#save").click();
      const exported = await downloadText(page, page.locator("#download"));
      for (const text of [
        first,
        revision,
        "S0 · old invitation",
        "S1 · current venue confirmation",
        "S2 · attendance and materials",
        "U1 · Friday reply snapshot",
      ])
        expect(exported).toContain(text);
      await page.reload();
      await expect(page.locator("#writing-final2")).toHaveValue(first);
      await expect(page.locator("#writing-final5")).toHaveValue(revision);
      await expect(page.locator("#self-check")).toBeChecked();
      await page.locator(".lesson-body").screenshot({
        path: path.join(output, `realistic-everyday-${width}.png`),
      });
    },
    { width, height: 950 },
  );
}

const guidedCases = {
  Everyday: {
    title: "The book swap: who is actually coming?",
    source: "S1 · current venue confirmation",
    update: "U1 · Friday reply snapshot",
  },
  Work: {
    title: "The handover pilot: plans changed",
    source: "S3 · Wednesday 09:00",
    update: "U1 · Wednesday 15:10",
  },
  Technical: {
    title: "The upload bug: what do we actually know?",
    source: "R1 · current requirement",
    update: "R2 · requirement for the next candidate",
  },
};
for (const width of [1360, 390]) {
  for (const [name, content] of Object.entries(guidedCases)) {
    await check(
      `READER-026 ${name} guided final practice retains drafts and position at ${width}px`,
      async (page) => {
        await start(page, name);
        await selectLesson(page, 6);
        const nav = page.getByRole("navigation", {
          name: "Final practice steps",
          exact: true,
        });
        await expect(nav).toBeVisible();
        await expect(nav.getByRole("button")).toHaveCount(4);
        await expect(
          nav.getByRole("button", { name: "Read the brief", exact: true }),
        ).toHaveAttribute("aria-current", "step");
        await expect(
          page.getByRole("heading", { name: content.title, exact: true }),
        ).toBeVisible();
        await expect(page.locator('[data-final-panel="0"]')).toContainText(
          content.source,
        );
        await expect(page.locator('[data-final-panel="2"]')).not.toBeVisible();
        await page.locator("#next").click();
        await expect(
          nav.getByRole("button", { name: "Write a first draft", exact: true }),
        ).toHaveAttribute("aria-current", "step");
        await page.locator("#back").click();
        await expect(
          nav.getByRole("button", { name: "Read the brief", exact: true }),
        ).toHaveAttribute("aria-current", "step");
        await finalStep(page, 3);
        await expect(page.locator("#self-check")).toBeDisabled();
        await expect(page.locator("#self-check")).not.toBeChecked();
        await finalStep(page, 1);
        await expect(
          page.locator("#final-source-reminder"),
        ).not.toHaveAttribute("open", "");
        const task = page.getByLabel("1. Task and check", { exact: true });
        await expect(task).toBeVisible();
        const box = await task.boundingBox();
        expect(box.y).toBeLessThan(950);
        if (width === 390) {
          const reference = await page
            .locator(".final-workspace .reference")
            .boundingBox();
          expect(reference.y).toBeGreaterThan(box.y);
        }
        await page.screenshot({
          path: path.join(
            output,
            `guided-${name.toLowerCase()}-${width}-draft.png`,
          ),
        });
        const first = `${name} first draft: <img src=x onerror="window.guidedInjected=true"> retain the source and explain my choice.`;
        for (let i = 0; i < 5; i++)
          await fillFinal(
            page,
            i,
            i === 2 ? first : `${name} first-pass decision ${i + 1}.`,
          );
        await finalStep(page, 2);
        await expect(page.locator('[data-final-panel="2"]')).toContainText(
          content.update,
        );
        await expect(page.locator("#retained-draft-update")).toContainText(
          first,
        );
        await page
          .getByText("Your retained first draft", { exact: true })
          .click();
        await expect(page.locator("#retained-draft-update pre")).toHaveText(
          first,
        );
        await finalStep(page, 3);
        const revision = `${name} revision: keep the original, explain the new evidence and my reason.`;
        await fillFinal(page, 5, revision);
        await page
          .getByText("Compare with a worked record", { exact: true })
          .click();
        await expect(page.locator("#writing-final2")).toHaveValue(first);
        await expect(page.locator("#writing-final5")).toHaveValue(revision);
        await page.locator("#self-check").check();
        await finalStep(page, 0);
        await finalStep(page, 2);
        await expect(page.locator("#self-check")).toBeChecked();
        expect(await page.evaluate(() => Boolean(window.guidedInjected))).toBe(
          false,
        );
        await page.locator("#save").click();
        const exported = await downloadText(page, page.locator("#download"));
        for (const text of [
          first,
          revision,
          content.source,
          content.update,
          "Final practice step: Read the update",
        ])
          expect(exported).toContain(text);
        await page.reload();
        await expect(
          nav.getByRole("button", { name: "Read the update", exact: true }),
        ).toHaveAttribute("aria-current", "step");
        await expect(page.locator("#writing-final2")).toHaveValue(first);
        await expect(page.locator("#writing-final5")).toHaveValue(revision);
        await expect(page.locator("#self-check")).toBeChecked();
        await fillFinal(page, 0, `${name} changed task and check.`);
        await finalStep(page, 3);
        await expect(page.locator("#self-check")).not.toBeChecked();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(await page.locator("[data-final-panel]:visible").count()).toBe(
          1,
        );
        expect(await page.locator("#course-path").innerText()).not.toMatch(
          /completed|mastery|learned/i,
        );
      },
      { width, height: 950 },
    );
  }
}
await check(
  "READER-027 older compatible final notebook gains a default step only in memory",
  async (page) => {
    await start(page);
    await selectLesson(page, 6);
    for (let i = 0; i < 6; i++)
      await fillFinal(page, i, `Preserved prior field ${i + 1}.`);
    await page.locator("#self-check").check();
    await page.locator("#save").click();
    const previous = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("dne-course-reader-1:everyday:"),
      );
      const value = JSON.parse(localStorage.getItem(key));
      delete value.state.finalStep;
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      return { key, raw };
    });
    await page.reload();
    await expect(
      page
        .getByRole("navigation", { name: "Final practice steps" })
        .getByRole("button", { name: "Read the brief", exact: true }),
    ).toHaveAttribute("aria-current", "step");
    for (let i = 0; i < 6; i++)
      await expect(page.locator(`#writing-final${i}`)).toHaveValue(
        `Preserved prior field ${i + 1}.`,
      );
    await expect(page.locator("#self-check")).toBeChecked();
    expect(
      await page.evaluate((k) => localStorage.getItem(k), previous.key),
    ).toBe(previous.raw);
    await finalStep(page, 2);
    expect(
      await page.evaluate((k) => localStorage.getItem(k), previous.key),
    ).toBe(previous.raw);
    await page.locator("#save").click();
    expect(
      await page.evaluate(
        (k) => JSON.parse(localStorage.getItem(k)).state.finalStep,
        previous.key,
      ),
    ).toBe(2);
  },
);
for (const invalid of [4, "1"]) {
  await check(
    `READER-027 unreadable final stage ${JSON.stringify(invalid)} protects the original record`,
    async (page) => {
      await start(page);
      await selectLesson(page, 6);
      await fillFinal(page, 2, "Retain this exact old writing.");
      await page.locator("#save").click();
      const previous = await page.evaluate((invalid) => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("dne-course-reader-1:everyday:"),
        );
        const value = JSON.parse(localStorage.getItem(key));
        value.state.finalStep = invalid;
        const raw = JSON.stringify(value);
        localStorage.setItem(key, raw);
        return { key, raw };
      }, invalid);
      await page.reload();
      await expect(page.locator("#save")).toBeDisabled();
      await expect(page.locator("#save-status")).toContainText(
        "record is unreadable",
      );
      expect(await downloadText(page, page.locator("#download-stored"))).toBe(
        previous.raw,
      );
      expect(
        await page.evaluate((k) => localStorage.getItem(k), previous.key),
      ).toBe(previous.raw);
    },
  );
}
await check(
  "READER-028 failed staged save keeps all current writing downloadable",
  async (page) => {
    await start(page);
    await selectLesson(page, 6);
    await fillFinal(page, 2, "Original first draft for the new case.");
    await page.locator("#save").click();
    const previous = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("dne-course-reader-1:everyday:"),
      );
      return { key, raw: localStorage.getItem(key) };
    });
    await fillFinal(page, 5, "Retained revision and reason after the update.");
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error("Test save unavailable");
      };
    });
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toContainText("Saving failed");
    await fillFinal(page, 2, "Still editable after failed saving.");
    const text = await downloadText(page, page.locator("#download"));
    expect(text).toContain("Still editable after failed saving.");
    expect(text).toContain("Retained revision and reason after the update.");
    expect(
      await page.evaluate((k) => localStorage.getItem(k), previous.key),
    ).toBe(previous.raw);
  },
);
await check(
  "READER-028 stages and unsaved writing remain separate between routes",
  async (page) => {
    await start(page);
    await selectLesson(page, 6);
    await fillFinal(page, 2, "Everyday first draft.");
    await page.locator("#save").click();
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await selectLesson(page, 6);
    await finalStep(page, 3);
    await expect(page.locator("#writing-final2")).toHaveValue("");
    await fillFinal(page, 5, "Work unsaved revision.");
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await expect(
      page
        .getByRole("navigation", { name: "Final practice steps" })
        .getByRole("button", { name: "Write a first draft", exact: true }),
    ).toHaveAttribute("aria-current", "step");
    await expect(page.locator("#writing-final2")).toHaveValue(
      "Everyday first draft.",
    );
    expect(await downloadText(page, page.locator("#download"))).not.toContain(
      "Work unsaved revision.",
    );
    const dialogs = [];
    page.on("dialog", (d) => dialogs.push(d.type()));
    await page.goto("about:blank");
    expect(dialogs).toEqual(["beforeunload"]);
  },
);

const fieldGuideCases = {
  Everyday: {
    output: "A useful reminder, capacity checklist and retained reply update.",
    instructions: [
      "name the useful output and its check",
      "write a request for an AI assistant or colleague",
      "100–160 word reminder for confirmed guests",
      "choose which details belong in the reminder versus the internal checklist",
      "describe how to check changed notes and recover missing information",
      "Distinguish confirmed guests, a reserved pending place and the remaining waitlist",
    ],
    checks: [
      "Check people and books separately",
      "Label that as an upper bound",
    ],
    revision:
      "The snapshot does not tell you whether the pending person eventually accepts",
  },
  Work: {
    output:
      "A short pilot update, action list, capacity check and retained revision.",
    instructions: [
      "state the useful output and a check",
      "write a request you could give an AI assistant or a colleague",
      "100–160 word team update",
      "identify its reader",
      "describe how you will check the next update",
      "write a revised team update and explain the changes from your first draft",
    ],
    checks: [
      "short task/owner/timing list",
      "current facts, recommendations and open questions",
    ],
    revision: "Do not claim the pilot has happened",
  },
  Technical: {
    output: "A reproducible investigation, test plan and retained revision.",
    instructions: [
      "name the useful handoff and the check it must support",
      "requirements, observations and hypotheses separate",
      "100–180 word investigation summary",
      "for the intended reader",
      "for the workflow that keeps new runs traceable",
      "Identify what R2 changes, what D1 does not prove",
    ],
    checks: [
      "concise reproduction steps and a small test plan",
      "below/at/above boundary cases",
    ],
    revision: "Keep T01–T03 attached to their original builds",
  },
};
for (const width of [1360, 390]) {
  for (const [name, content] of Object.entries(fieldGuideCases)) {
    await check(
      `READER-029 ${name} field guidance stays beside retained writing at ${width}px`,
      async (page) => {
        await start(page, name);
        await selectLesson(page, 6);
        await finalStep(page, 1);
        await expect(page.locator("#writing-final0-guide")).toBeVisible();
        await expect(page.locator("#final-output")).toHaveText(
          `Your output: ${content.output}`,
        );
        const firstField = await page.locator("#writing-final0").boundingBox();
        expect(firstField.y).toBeLessThan(950);
        const writing = [];
        for (let i = 0; i < 6; i++) {
          await finalStep(page, i < 5 ? 1 : 3);
          const guide = page.locator(`#writing-final${i}-guide`);
          await expect(guide).toBeVisible();
          expect((await guide.innerText()).toLowerCase()).toContain(
            content.instructions[i].toLowerCase(),
          );
          expect(
            await guide.evaluate((node) => node.nextElementSibling.id),
          ).toBe(`writing-final${i}`);
          await expect(page.locator(`#writing-final${i}`)).toHaveValue("");
          writing.push(
            `${name} retained field ${i + 1}: my source-based decision and reason.`,
          );
          await fillFinal(page, i, writing[i]);
        }
        await expect(page.locator("#writing-final5-guide")).toContainText(
          content.revision,
        );
        await page.locator("#self-check").check();
        await finalStep(page, 1);
        for (const text of content.checks)
          await expect(page.locator("#writing-final2-guide")).toContainText(
            text,
          );
        await expect(page.locator("#self-check")).toBeChecked();
        for (let i = 0; i < 6; i++)
          await expect(page.locator(`#writing-final${i}`)).toHaveValue(
            writing[i],
          );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.locator("#writing-final2-guide").screenshot({
          path: path.join(
            output,
            `field-guidance-${name.toLowerCase()}-${width}.png`,
          ),
        });
        await finalStep(page, 3);
        await page.locator("#save").click();
        const exported = await downloadText(page, page.locator("#download"));
        for (const value of writing) expect(exported).toContain(value);
        expect(exported).toContain(content.instructions[2]);
        expect(exported).toContain(content.revision);
        await page.reload();
        await expect(page.locator("#writing-final5-guide")).toBeVisible();
        await expect(page.locator("#self-check")).toBeChecked();
        for (let i = 0; i < 6; i++)
          await expect(page.locator(`#writing-final${i}`)).toHaveValue(
            writing[i],
          );
        await expect(page.locator("#course-path")).not.toContainText(
          /mastered|completed/i,
        );
      },
      { width, height: 950 },
    );
  }
}

// Targets derive from the authored criterion and the lesson's stated outcome.
const reviewTargets = {
  Everyday: [
    ["Usable reminder", 2, "room"],
    ["Correct headcount", 3, "reserved"],
    ["Feasible book plan", 5, "upper bound"],
    ["Useful revision", 6, "unchanged"],
    ["Next action", 5, "reply"],
    ["Deliberate audience", 4, "internal"],
  ],
  Work: [
    ["Current facts and changed requirements", 3, "S2"],
    ["A usable output", 2, "owner"],
    ["Sound feasibility reasoning", 5, "minutes"],
    ["Useful judgment", 1, "recommendation"],
    ["A retained revision", 6, "U1"],
    ["Honest limits", 3, "unknown"],
  ],
  Technical: [
    ["Applicable requirement", 3, "R1"],
    ["Reproducible finding", 2, "fixture"],
    ["Bounded conclusion", 3, "T03"],
    ["Useful next action", 5, "browser"],
    ["Retained revision", 6, "R2"],
    ["Honest execution record", 5, "not run"],
  ],
};
async function reviewFinal(page, name = "Everyday") {
  await start(page, name);
  await selectLesson(page, 6);
  for (let i = 0; i < 6; i++)
    await fillFinal(
      page,
      i,
      `${name} retained field ${i + 1}: my source-based decision and reason.`,
    );
  await finalStep(page, 3);
  await page.locator("#self-check").check();
}
async function openReview(page, criterion, lesson) {
  const row = page.getByRole("region", { name: criterion, exact: true });
  await row.locator("summary").click();
  await row
    .getByRole("button", {
      name: `Practise lesson ${lesson}: ${titles[lesson - 1]}`,
      exact: true,
    })
    .click();
}
for (const width of [1360, 390]) {
  for (const [name, targets] of Object.entries(reviewTargets)) {
    await check(
      `READER-030 ${name} each criterion leads to practice and retained writing at ${width}px`,
      async (page) => {
        await reviewFinal(page, name);
        const before = await downloadText(page, page.locator("#download"));
        await expect(
          page.getByRole("heading", {
            name: "Review your record",
            exact: true,
          }),
        ).toBeVisible({ timeout: 3000 });
        for (const [index, [criterion, lesson, phrase]] of targets.entries()) {
          const row = page.getByRole("region", {
            name: criterion,
            exact: true,
          });
          await expect(row).toContainText(phrase);
          await openReview(page, criterion, lesson);
          await expect(
            page.getByRole("heading", {
              name: titles[lesson - 1],
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("region", { name: "Try it", exact: true }),
          ).toBeVisible();
          await expect(page.locator("#source-text")).toContainText(
            expected[name].sources[lesson - 1],
          );
          await expect(page.locator("#practice-return")).toContainText(
            criterion,
          );
          await expect(page.locator("#practice-return")).toContainText(phrase);
          if (index === 0) {
            await page.locator("#practice-return").screenshot({
              path: path.join(
                output,
                `review-${name.toLowerCase()}-${width}-practice.png`,
              ),
            });
          }
          await page
            .getByRole("button", {
              name: "Return to my final record",
              exact: true,
            })
            .click();
          await expect(row).toBeFocused();
          for (let i = 0; i < 6; i++)
            await expect(page.locator(`#writing-final${i}`)).toHaveValue(
              `${name} retained field ${i + 1}: my source-based decision and reason.`,
            );
          await expect(page.locator("#self-check")).toBeChecked();
          await expect(page.locator("#practice-return")).toHaveCount(0);
        }
        expect(await downloadText(page, page.locator("#download"))).toBe(
          before,
        );
        // Exercise an actual mistake/correction, not only a navigation round trip.
        const [criterion, lesson] = targets[0];
        await openReview(page, criterion, lesson);
        const answers = expected[name].keys[lesson - 1];
        for (const [index, answer] of answers.entries()) {
          const wrong =
            answer.length === 1
              ? answer === "A"
                ? "B"
                : "A"
              : answer === "Supported"
                ? "Contradicted"
                : "Supported";
          await page
            .locator("fieldset")
            .nth(index)
            .locator(`input[value="${wrong}"]`)
            .check();
        }
        await page.getByRole("button", { name: /^Check answers?$/ }).click();
        await expect(page.locator(".answer-feedback").first()).toContainText(
          "Try another choice",
        );
        for (const [index, answer] of answers.entries())
          await page
            .locator("fieldset")
            .nth(index)
            .locator(`input[value="${answer}"]`)
            .check();
        await page.getByRole("button", { name: /^Check answers?$/ }).click();
        await expect(page.locator(".answer-feedback.positive")).toHaveCount(
          answers.length,
        );
        await page
          .getByRole("button", {
            name: "Return to my final record",
            exact: true,
          })
          .click();
        for (let i = 0; i < 6; i++)
          await expect(page.locator(`#writing-final${i}`)).toHaveValue(
            `${name} retained field ${i + 1}: my source-based decision and reason.`,
          );
        await expect(page.locator("#self-check")).toBeChecked();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.locator("#final-review").screenshot({
          path: path.join(
            output,
            `review-${name.toLowerCase()}-${width}-criteria.png`,
          ),
        });
        await fillFinal(
          page,
          5,
          `${name} revised after revisiting a weak criterion.`,
        );
        await expect(page.locator("#self-check")).not.toBeChecked();
        await page.locator("#save").click();
        await page.reload();
        await expect(page.locator("#writing-final5")).toHaveValue(
          `${name} revised after revisiting a weak criterion.`,
        );
        await expect(page.locator("#self-check")).not.toBeChecked();
      },
      { width, height: 950 },
    );
  }
}
await check(
  "READER-031 old compatible records stay unchanged until explicit save",
  async (page) => {
    await reviewFinal(page);
    await page.locator("#save").click();
    const old = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("dne-course-reader-1:everyday:"),
      );
      const value = JSON.parse(localStorage.getItem(key));
      delete value.state.reviewCriterion;
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      return { key, raw };
    });
    await page.reload();
    await expect(page.locator("#writing-final5")).toHaveValue(
      "Everyday retained field 6: my source-based decision and reason.",
    );
    await expect(page.locator("#self-check")).toBeChecked();
    await openReview(page, "Correct headcount", 3);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), old.key),
    ).toBe(old.raw);
    await page.locator("#save").click();
    await page.reload();
    await expect(page.locator("#practice-return")).toContainText(
      "Correct headcount",
    );
    await expect(
      page.getByRole("region", { name: "Try it", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Return to my final record", exact: true })
      .click();
    await expect(page.locator("#writing-final5")).toHaveValue(
      "Everyday retained field 6: my source-based decision and reason.",
    );
    await expect(page.locator("#self-check")).toBeChecked();
  },
);
for (const invalid of [-1, 6, "1"]) {
  await check(
    `READER-031 invalid review context ${JSON.stringify(invalid)} protects the stored original`,
    async (page) => {
      await reviewFinal(page);
      await page.locator("#save").click();
      const raw = await page.evaluate((value) => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("dne-course-reader-1:everyday:"),
        );
        const saved = JSON.parse(localStorage.getItem(key));
        saved.state.reviewCriterion = value;
        const raw = JSON.stringify(saved);
        localStorage.setItem(key, raw);
        return { key, raw };
      }, invalid);
      await page.reload();
      await expect(page.locator("#save")).toBeDisabled();
      await expect(page.locator("#save-status")).toContainText("unreadable");
      expect(await downloadText(page, page.locator("#download-stored"))).toBe(
        raw.raw,
      );
      expect(
        await page.evaluate((key) => localStorage.getItem(key), raw.key),
      ).toBe(raw.raw);
    },
  );
}
await check(
  "READER-031 saved return contexts stay separate by route and preserve failed-save writing",
  async (page) => {
    await reviewFinal(page);
    await openReview(page, "Correct headcount", 3);
    await page.locator("#save").click();
    await page.getByRole("button", { name: "Work", exact: true }).click();
    await selectLesson(page, 6);
    for (let i = 0; i < 6; i++)
      await fillFinal(page, i, `Work separate field ${i + 1}.`);
    await finalStep(page, 3);
    await openReview(page, "Sound feasibility reasoning", 5);
    await page.locator("#save").click();
    await page.reload();
    await expect(page.locator("#practice-return")).toContainText(
      "Sound feasibility reasoning",
    );
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    await expect(page.locator("#practice-return")).toContainText(
      "Correct headcount",
    );
    await page
      .getByRole("button", { name: "Return to my final record", exact: true })
      .click();
    await fillFinal(page, 5, "Everyday new revision kept after failed save.");
    await openReview(page, "Correct headcount", 3);
    const before = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error("Test rejected save");
      };
    });
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toContainText("Saving failed");
    const exported = await downloadText(page, page.locator("#download"));
    expect(exported).toContain("Everyday new revision kept after failed save.");
    expect(exported).toContain("S1 · current venue confirmation");
    expect(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage)),
      ),
    ).toEqual(before);
    await page
      .getByRole("button", { name: "Return to my final record", exact: true })
      .click();
    await expect(page.locator("#writing-final5")).toHaveValue(
      "Everyday new revision kept after failed save.",
    );
    await expect(page.locator("#self-check")).not.toBeChecked();
  },
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
