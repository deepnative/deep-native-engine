import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

let server: Server;
let origin: string;
const key = "dne-pages-demo-v1";
const assets = new Map([
  ["/deep-native-engine/", ["site/index.html", "text/html"]],
  ["/deep-native-engine/styles.css", ["site/styles.css", "text/css"]],
  ["/deep-native-engine/favicon.svg", ["site/favicon.svg", "image/svg+xml"]],
  ["/deep-native-engine/demo.js", ["public/pages-demo.js", "text/javascript"]],
]);

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const asset = assets.get(request.url!);
    if (!asset || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": asset[1] });
    response.end(await readFile(asset[0]!));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/deep-native-engine/`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("[L210] PAGES-DEMO-01 visitors in all three directions save, complete and reload the browser sample", async ({
  page,
}) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" || !request.url().startsWith(origin))
      unexpected.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(origin);
  await page
    .getByRole("link", { name: "Try the sample demo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "One small task. Your first step." }),
  ).toBeVisible();
  await expect(page.locator(".header-cta")).toHaveAttribute(
    "href",
    "https://engine.deepnative.io/learn",
  );
  await expect(page.locator("#sample-demo")).toContainText(
    "not the user portal",
  );
  await expect(page.locator("#sample-demo")).toContainText("no live AI call");
  await expect(page.locator("form")).toHaveCount(0);
  for (const direction of ["general", "professional", "technical"]) {
    await page
      .getByRole("button", { name: "Reset this sample", exact: true })
      .click();
    await page
      .getByLabel("Your learning direction", { exact: true })
      .selectOption(direction);
    const response = `Codex invented ${direction} sample:\nDraft the invitation using the provided time and place. Flag unconfirmed capacity and accessibility arrangements.`;
    await page
      .getByLabel("Your sample instruction", { exact: true })
      .fill(response);
    await page
      .getByRole("button", { name: "Save sample draft", exact: true })
      .click();
    await expect(page.locator("#demo-status")).toContainText("draft saved");
    await page.reload();
    await expect(
      page.getByLabel("Your learning direction", { exact: true }),
    ).toHaveValue(direction);
    await expect(
      page.getByLabel("Your sample instruction", { exact: true }),
    ).toHaveValue(response);
    await expect(page.locator("#demo-progress")).toHaveText(
      "0 / 1 sample completed",
    );
    await page.getByLabel("I checked the goal", { exact: false }).check();
    await page
      .getByRole("button", { name: "Complete sample", exact: true })
      .click();
    await expect(page.locator("#demo-status")).toContainText(
      "not an assessment",
    );
    await page.reload();
    await expect(page.locator("#demo-progress")).toHaveText(
      "1 / 1 sample completed",
    );
    await expect(
      page.getByLabel("Your sample instruction", { exact: true }),
    ).toHaveValue(response);
    await expect(
      page.getByLabel("I checked the goal", { exact: false }),
    ).toBeChecked();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(unexpected).toEqual([]);
});

test("[L211] PAGES-DEMO-02 correction retains work, edits require a fresh self-check, and reset affects only this sample", async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(() =>
    sessionStorage.setItem("unrelated-example", "keep this"),
  );
  await page
    .getByRole("button", { name: "Complete sample", exact: true })
    .click();
  await expect(
    page.getByLabel("Your learning direction", { exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("Your learning direction", { exact: true })
    .selectOption("general");
  await page
    .getByRole("button", { name: "Complete sample", exact: true })
    .click();
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "Write a sample response",
  );
  const response = "Codex sample: use only the brief and flag unknown details.";
  await page
    .getByLabel("Your sample instruction", { exact: true })
    .fill(response);
  await page
    .getByRole("button", { name: "Complete sample", exact: true })
    .click();
  await expect(
    page.getByLabel("I checked the goal", { exact: false }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue(response);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
  await page.getByLabel("I checked the goal", { exact: false }).check();
  await page
    .getByRole("button", { name: "Complete sample", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("#demo-progress")).toHaveText(
    "1 / 1 sample completed",
  );
  await page
    .getByLabel("Your sample instruction", { exact: true })
    .fill(response + " Revised.");
  await expect(
    page.getByLabel("I checked the goal", { exact: false }),
  ).not.toBeChecked();
  await expect(page.locator("#demo-progress")).toHaveText(
    "Unsaved sample changes",
  );
  await page
    .getByRole("button", { name: "Reset this sample", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue("");
  await expect(page.locator("#demo-progress")).toHaveText(
    "0 / 1 sample completed",
  );
  expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
  expect(
    await page.evaluate(() => sessionStorage.getItem("unrelated-example")),
  ).toBe("keep this");
});

test("[L212] PAGES-DEMO-03 malformed and unavailable storage stay honest; the no-script sample remains readable", async ({
  page,
  browser,
}) => {
  await page.goto(origin);
  await page.evaluate((k) => {
    sessionStorage.setItem(k, "broken sample");
    sessionStorage.setItem("unrelated-example", "keep this");
  }, key);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("could not be read");
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue("");
  expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBe(
    "broken sample",
  );
  await page
    .getByLabel("Your learning direction", { exact: true })
    .selectOption("general");
  await page
    .getByLabel("Your sample instruction", { exact: true })
    .fill("Codex recovery sample");
  await page
    .getByRole("button", { name: "Save sample draft", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue("Codex recovery sample");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Synthetic browser storage denial");
    };
  });
  await page
    .getByLabel("Your sample instruction", { exact: true })
    .fill("Keep this unsaved sample");
  await page
    .getByRole("button", { name: "Save sample draft", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("not saved");
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue("Keep this unsaved sample");
  await page.reload();
  await expect(
    page.getByLabel("Your sample instruction", { exact: true }),
  ).toHaveValue("Codex recovery sample");
  expect(
    await page.evaluate(() => sessionStorage.getItem("unrelated-example")),
  ).toBe("keep this");
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    viewport: page.viewportSize(),
  });
  try {
    const noScript = await plain.newPage();
    await noScript.goto(origin);
    await expect(noScript.locator("#demo-script-note")).toBeVisible();
    await expect(noScript.locator("#demo-script-note")).toContainText(
      "Sample controls need JavaScript",
    );
    await expect(
      noScript
        .getByRole("heading", { name: "Give AI a clear task.", exact: true })
        .last(),
    ).toBeVisible();
    await expect(
      noScript.getByRole("button", { name: "Complete sample", exact: true }),
    ).toBeDisabled();
    await expect(noScript.locator("#demo-script-note a")).toHaveAttribute(
      "href",
      "https://engine.deepnative.io/learn",
    );
  } finally {
    await plain.close();
  }
});
