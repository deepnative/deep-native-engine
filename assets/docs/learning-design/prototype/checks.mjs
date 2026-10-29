import {
  chromium,
  expect,
} from "../../../../node_modules/@playwright/test/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = process.argv[2];
const output = process.argv[3];
const caseIndex = process.argv.indexOf("--case");
const focusedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : null;
if (!origin || !output)
  throw new Error(
    "Usage: node checks.mjs <local preview URL> <evidence directory>",
  );
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const routes = ["Everyday", "Work", "Technical"];
const requests = [
  "Draft a seed-swap invitation from the source. Keep the start time and location unconfirmed; check the six helpers and forty packets.",
  "Make a task, owner and date table from the survey notes. Leave missing deadlines not specified and compare each row with its source.",
  "Suggest contact-form cases using the given requirements. Keep maximum length unspecified and mark execution not run.",
];
const repairs = [
  "Six helpers and forty seed packets are available for a one-hour seed swap on Sunday. Location and start time are to be confirmed.",
  "Mina drafts the survey; Arun checks the wording. The trial is Thursday. Other deadlines and the launch date are not agreed.",
  "A blank message must show an explanation. No tests have run and the maximum message length is unspecified.",
];
const reason =
  "I corrected the conflicting fact and kept the missing detail unknown because the source does not establish it.";
// Source-based expectations stay independent of the renderer's answer data.
const expectedClaims = [
  [
    ["Forty seed packets are available.", "Supported"],
    ["Eight helpers are available.", "Contradicted"],
    ["The seed swap starts at 10 a.m.", "Not given"],
  ],
  [
    ["Mina's survey is due Wednesday.", "Not given"],
    ["Arun checks the wording.", "Supported"],
    ["The trial is Friday instead of Thursday.", "Contradicted"],
  ],
  [
    ["All tests have run and passed.", "Contradicted"],
    ["Messages are limited to 500 characters.", "Not given"],
    ["A blank message must show an explanation.", "Supported"],
  ],
];

async function check(name, action, viewport = { width: 1280, height: 900 }) {
  if (focusedCase && !name.includes(focusedCase)) return;
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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

async function start(page, routeIndex = 0) {
  const response = await page.goto(origin);
  expect(response.status(), "The local lesson walkthrough must exist").toBe(
    200,
  );
  await page
    .getByRole("button", { name: routes[routeIndex], exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Write a useful request", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Try a fresh case", exact: true })
    .click();
  await page
    .getByLabel("Your request", { exact: true })
    .fill(requests[routeIndex]);
  await page
    .getByRole("button", { name: "Check a sample answer", exact: true })
    .click();
}

async function classify(page, routeIndex = 0) {
  for (const [index, [text, answer]] of expectedClaims[routeIndex].entries()) {
    await page
      .getByRole("group", { name: `Claim ${index + 1}: ${text}`, exact: true })
      .getByLabel(answer, { exact: true })
      .check();
  }
  await page
    .getByRole("button", { name: "Check these claims", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Repair the sample", exact: true })
    .click();
}

if (process.argv.includes("--baseline")) {
  await check(
    "PROTO-001 missing local teaching journey (expected first failure)",
    async (page) => {
      const response = await page.goto(origin);
      expect(
        response.status(),
        "Expected a runnable learning walkthrough, currently absent",
      ).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Write a useful request",
          exact: true,
        }),
      ).toBeVisible();
    },
  );
} else {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const [index, route] of routes.entries()) {
      await check(
        `PROTO-001/002/003 ${route} complete lesson loop ${viewport.width}px`,
        async (page) => {
          await start(page, index);
          await expect(
            page.getByText("Teaching sample", { exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Show a hint", exact: true })
            .click();
          await expect(
            page.getByText(
              "A contradiction needs an incompatible fact. If the source gives no answer, choose Not given.",
              { exact: true },
            ),
          ).toBeVisible();
          for (const [position, [text, answer]] of expectedClaims[
            index
          ].entries()) {
            const wrong = ["Not given", "Supported", "Contradicted"].find(
              (choice) => choice !== answer,
            );
            await page
              .getByRole("group", {
                name: `Claim ${position + 1}: ${text}`,
                exact: true,
              })
              .getByLabel(wrong, { exact: true })
              .check();
          }
          await page
            .getByRole("button", { name: "Check these claims", exact: true })
            .click();
          await expect(
            page.getByText(
              "Keep checking: compare each claim with the source.",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(page.locator(".claim-feedback")).toHaveCount(3);
          await expect(
            page.getByRole("button", {
              name: "Repair the sample",
              exact: true,
            }),
          ).toHaveCount(0);
          await classify(page, index);
          await page
            .getByLabel("Your corrected answer", { exact: true })
            .fill(repairs[index]);
          await page
            .getByLabel("What did you change, and why?", { exact: true })
            .fill(reason);
          await page
            .getByRole("button", { name: "Review my revision", exact: true })
            .click();
          await expect(page.locator("#review-request")).toHaveText(
            requests[index],
          );
          await expect(page.locator("#review-repair")).toHaveText(
            repairs[index],
          );
          await expect(
            page.getByText("Self-check, not an automatic grade.", {
              exact: true,
            }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Save in this browser", exact: true })
            .click();
          await expect(page.getByRole("status")).toContainText(
            "Saved in this browser",
          );
          await page.reload();
          await expect(page.locator("#review-repair")).toHaveText(
            repairs[index],
          );
          await expect(page.getByRole("status")).toContainText(
            "Restored from this browser",
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          expect(overflow).toBe(false);
          await page.screenshot({
            path: path.join(
              output,
              `${route.toLowerCase()}-${viewport.width}-review.png`,
            ),
            fullPage: true,
          });
        },
        viewport,
      );
    }
  }
  await check(
    "PROTO-004 route changes retain separate unsaved drafts",
    async (page) => {
      await start(page);
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await page
        .getByRole("button", { name: "Try a fresh case", exact: true })
        .click();
      await expect(
        page.getByLabel("Your request", { exact: true }),
      ).toHaveValue("");
      await page.getByLabel("Your request", { exact: true }).fill(requests[1]);
      await page.getByRole("button", { name: "Everyday", exact: true }).click();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(
        page.getByLabel("Your request", { exact: true }),
      ).toHaveValue(requests[0]);
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await expect(
        page.getByLabel("Your request", { exact: true }),
      ).toHaveValue(requests[1]);
    },
  );
  await check(
    "PROTO-005 failed browser save retains text and no false success",
    async (page) => {
      await start(page);
      await classify(page);
      await page
        .getByLabel("Your corrected answer", { exact: true })
        .fill(repairs[0]);
      await page
        .getByLabel("What did you change, and why?", { exact: true })
        .fill(reason);
      await page
        .getByRole("button", { name: "Review my revision", exact: true })
        .click();
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("Blocked", "QuotaExceededError");
        };
      });
      await page
        .getByRole("button", { name: "Save in this browser", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("Not saved");
      await expect(page.getByRole("status")).not.toContainText(
        "Saved in this browser",
      );
      await page
        .getByRole("button", { name: "Edit my revision", exact: true })
        .click();
      await expect(
        page.getByLabel("Your corrected answer", { exact: true }),
      ).toHaveValue(repairs[0]);
      await expect(
        page.getByLabel("What did you change, and why?", { exact: true }),
      ).toHaveValue(reason);
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download my work", exact: true })
        .click();
      const download = await downloadPromise;
      await download.saveAs(path.join(output, "recovered-practice.txt"));
      const recovered = await readFile(
        path.join(output, "recovered-practice.txt"),
        "utf8",
      );
      expect(recovered).toContain(repairs[0]);
      expect(recovered).toContain(reason);
    },
  );
  await check(
    "PROTO-006 malformed saved draft stays untouched and is not a success",
    async (page) => {
      await page.goto(origin);
      await page.evaluate(() =>
        localStorage.setItem("dne-content-storyboard-0.1:everyday", "{broken"),
      );
      await page.reload();
      await expect(
        page.getByRole("heading", {
          name: "Write a useful request",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("status")).toContainText(
        "could not be restored",
      );
      expect(
        await page.evaluate(() =>
          localStorage.getItem("dne-content-storyboard-0.1:everyday"),
        ),
      ).toBe("{broken");
    },
  );
  await check(
    "PROTO-007 worked request is labelled and free writing is not auto-graded",
    async (page) => {
      await page.goto(origin);
      await page
        .getByRole("button", { name: "Try a fresh case", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Use the worked request", exact: true })
        .click();
      await expect(
        page.getByText(
          "Worked request loaded. Adapt it or keep it as an example; this is not an unaided attempt.",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Check a sample answer", exact: true })
        .click();
      await classify(page);
      await page
        .getByLabel("Your corrected answer", { exact: true })
        .fill("Six helpers. Time unknown.");
      await page
        .getByLabel("What did you change, and why?", { exact: true })
        .fill("The source says six; no time is set.");
      await page
        .getByRole("button", { name: "Review my revision", exact: true })
        .click();
      await expect(
        page.getByText("Self-check, not an automatic grade.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Request began with the worked example.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(/Mastery score|You have mastered|100% mastered/),
      ).toHaveCount(0);
    },
  );
  for (const editedPart of ["request", "correction", "reason"])
    await check(
      `PROTO-008 editing the ${editedPart} clears self-checks tied to the earlier text`,
      async (page) => {
        await start(page);
        await classify(page);
        await page
          .getByLabel("Your corrected answer", { exact: true })
          .fill(repairs[0]);
        await page
          .getByLabel("What did you change, and why?", { exact: true })
          .fill(reason);
        await page
          .getByRole("button", { name: "Review my revision", exact: true })
          .click();
        const boxes = page.getByRole("checkbox");
        for (const box of await boxes.all()) await box.check();
        await page
          .getByRole("button", { name: "Edit my revision", exact: true })
          .click();
        if (editedPart === "request") {
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page
            .getByLabel("Your request", { exact: true })
            .fill("A different request using the same seed-swap source.");
          await page
            .getByRole("button", { name: "Check a sample answer", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Repair the sample", exact: true })
            .click();
        } else {
          await page
            .getByLabel(
              editedPart === "correction"
                ? "Your corrected answer"
                : "What did you change, and why?",
              { exact: true },
            )
            .fill(
              editedPart === "correction"
                ? "A new draft with an unsupported venue at the library."
                : "A changed reason that needs another self-check.",
            );
        }
        await page
          .getByRole("button", { name: "Review my revision", exact: true })
          .click();
        for (const box of await page.getByRole("checkbox").all())
          await expect(box).not.toBeChecked();
        await expect(page.getByRole("status")).toContainText("not saved");
      },
    );
}
await browser.close();
const report = {
  checkedAt: new Date().toISOString(),
  preview: origin,
  retries: 0,
  applicationCoverageClaim: false,
  results,
};
await writeFile(
  path.join(output, "results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
