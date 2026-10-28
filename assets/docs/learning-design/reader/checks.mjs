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
    final: "five helpers for ninety minutes",
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
}
async function step(page, name) {
  await page
    .getByRole("navigation", { name: "Lesson stages" })
    .getByRole("button", { name, exact: false })
    .click();
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
        await page
          .getByRole("button", { name: "Put it all together", exact: true })
          .click();
        const draft =
          "My task: make a CAP-W action table; check each owner and date against the brief.";
        await page.getByLabel("1. Task and check", { exact: true }).fill(draft);
        const worked = page.locator(".lesson-body details");
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
            name: "Write one page of instructions Noor Not specified",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          worked.getByRole("row", {
            name: "Gather four comments Lee Not specified",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          worked.getByRole("row", {
            name: "Try the check-in process Not specified Wednesday",
            exact: true,
          }),
        ).toBeVisible();
        const trialDay = worked.getByRole("cell", {
          name: "Wednesday",
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
          "Who owns the continuation decision, and when will it be made?",
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
        await page
          .getByRole("button", { name: "Put it all together", exact: true })
          .click();
        const draft =
          "My CAP-T plan: trace PNG expectations to the 3 MB rule and leave execution not run.";
        await page.getByLabel("1. Task and check", { exact: true }).fill(draft);
        const worked = page.locator(".lesson-body details");
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
          "1 MB PNG Accept PNG up to 3 MB Not run None",
          "PNG at the stated 3 MB limit Accept Inclusive 3 MB limit Not run None",
          "4 MB PNG Reject 3 MB size limit Not run None",
          "1 MB JPEG Unspecified Other formats unspecified Not run None",
        ]) {
          await expect(
            worked.getByRole("row", { name: row, exact: true }),
          ).toBeVisible();
        }
        await expect(worked).toContainText(
          "Do not replace the unknown JPEG rule with either accept or reject",
        );
        await expect(worked).toContainText(
          "If a later test starts but stops before a response",
        );
        await expect(worked).toContainText("interrupted/unconfirmed");
        await expect(worked).toContainText(
          "Keep that attempt separate from CAP-T's original no-tests-run brief",
        );
        await expect(worked).toContainText(
          "This is self-written practice feedback",
        );
        await expect(worked).not.toContainText("UPLOAD-1");
        await expect(worked).not.toContainText("2 MB");
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
          await page.locator(`[data-lesson="${i}"]`).click();
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
        await page
          .getByRole("button", { name: "Put it all together", exact: true })
          .click();
        await expect(page.locator("#source-text")).toContainText(
          "five helpers for ninety minutes",
        );
        await page.getByRole("button", { name: "Work", exact: true }).click();
        await page.locator('[data-lesson="1"]').click();
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
      await page.locator('[data-lesson="4"]').click();
      await step(page, "Try it");
      await expect(page.locator("fieldset legend")).toContainText(
        "45 minutes with seven helpers",
      );
      await page.locator('[data-lesson="5"]').click();
      await step(page, "Try it");
      await expect(page.locator("fieldset legend")).toContainText(
        "Eight helpers will start at 10 a.m.",
      );
      await page
        .getByRole("button", { name: "Technical", exact: true })
        .click();
      await page.locator('[data-lesson="5"]').click();
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
      await page
        .getByRole("button", {
          name: "Lesson 2: Write a useful request",
          exact: true,
        })
        .click();
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
          await page.locator(`[data-lesson="${lesson}"]`).click();
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
            await page
              .locator(`[data-writing="final"][data-index="${i}"]`)
              .fill(
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
          await page
            .getByRole("button", { name: "Put it all together", exact: true })
            .click();
          for (let i = 0; i < 6; i++)
            await page
              .locator(`[data-writing="final"][data-index="${i}"]`)
              .fill(`Original criterion ${i + 1}`);
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
        const input = page.locator(`[data-writing="${field}"]`).first();
        await input.fill(literal);
        if (field === "transfer") await step(page, "Your work");
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
  await page.locator('[data-lesson="5"]').click();
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
    await page.locator('[data-lesson="5"]').click();
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
          await page.locator(`[data-lesson="${index}"]`).click();
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
        await page.locator('[data-lesson="1"]').click();
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
