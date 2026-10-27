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
            await page.locator(".lesson-body details summary").click();
            await expect(page.locator(".lesson-body details")).toHaveAttribute(
              "open",
              "",
            );
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
        await expect(page.locator("#save-status")).toContainText(
          "Saved work could not be restored",
        );
        await expect(page.locator("#save")).toBeDisabled();
        await step(page, "Your work");
        await page
          .getByLabel("Your lesson work", { exact: true })
          .fill("New separate practice writing.");
        expect(await downloadText(page, page.locator("#download-stored"))).toBe(
          raw,
        );
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
