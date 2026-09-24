import { createHash } from "node:crypto";
import { test, expect, request, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await page.getByRole("link", { name: "Local circles" }).click();
  await expect(
    page.getByRole("heading", { name: "Explore learning circles" }),
  ).toBeVisible();
}

test("[L44] three learning backgrounds can opt into a suitable local topic without a paid or community action", async ({
  page,
  context,
}) => {
  await pool.query("TRUNCATE preview_circle_memberships");
  for (const [background, goal, title] of [
    ["explorer", "everyday", "Everyday AI practice"],
    ["professional", "work", "Clearer professional work"],
    ["technical", "build", "Technical AI practice"],
  ]) {
    await context.clearCookies();
    await onboard(page, background!, goal!);
    const item = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: title! }) });
    await expect(item).toContainText("Matches your current goal");
    await item.getByRole("button", { name: `Join ${title}` }).click();
    await expect(item).toContainText("You joined this local circle");
    await expect(page.getByText("NO LIVE COMMUNITY")).toBeVisible();
    await expect(
      page.getByText(/No discussion, clinic, expert, recording/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /buy|purchase|book/i }),
    ).toHaveCount(0);
  }
});

test("[L45] the last seat has one winner and joining grants no cohort content", async ({
  page,
  context,
}) => {
  await pool.query("TRUNCATE preview_circle_memberships");
  const candidates: { cookie: string; csrf: string }[] = [];
  const sessionHashes: string[] = [];
  for (let n = 0; n < 5; n += 1) {
    await context.clearCookies();
    await onboard(page, "explorer", "everyday");
    const cookie = (await context.cookies()).find(
      (entry) => entry.name === "dne_preview",
    )!.value;
    sessionHashes.push(createHash("sha256").update(cookie).digest("hex"));
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    if (n < 3) {
      await page
        .getByRole("button", { name: "Join Everyday AI practice" })
        .click();
      await expect(
        page.getByText("You joined this local circle"),
      ).toBeVisible();
    } else {
      candidates.push({ cookie, csrf });
    }
  }
  const clients = await Promise.all(
    candidates.map(({ cookie }) =>
      request.newContext({
        baseURL: "http://127.0.0.1:4317",
        extraHTTPHeaders: {
          Cookie: `dne_preview=${cookie}`,
          Origin: "http://127.0.0.1:4317",
        },
      }),
    ),
  );
  try {
    const results = await Promise.all(
      clients.map((client, index) =>
        client.post("/circles/everyday-ai/join", {
          form: { csrf: candidates[index]!.csrf },
          maxRedirects: 0,
        }),
      ),
    );
    expect(results.map((response) => response.status()).sort()).toEqual([
      303, 409,
    ]);
    const winner = results.findIndex((response) => response.status() === 303);
    await context.clearCookies();
    await context.addCookies([
      {
        name: "dne_preview",
        value: candidates[winner]!.cookie,
        url: "http://127.0.0.1:4317",
      },
    ]);
    await page.goto("/circles");
    await expect(page.getByText("You joined this local circle")).toBeVisible();
    const active = await pool.query(
      "SELECT count(*)::integer AS n FROM preview_circle_memberships WHERE circle_id='everyday-ai' AND left_at IS NULL",
    );
    expect(active.rows[0]?.n).toBe(4);
    expect(
      (
        await pool.query(
          "SELECT * FROM cohort_memberships WHERE member_id IN (SELECT id FROM principals WHERE token_hash=ANY($1::text[]))",
          [sessionHashes],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await Promise.all(clients.map((client) => client.dispose()));
  }
});

test("[L46] leaving removes own status; forged, expired and cross-origin requests cannot restore it", async ({
  page,
  context,
}) => {
  await pool.query("TRUNCATE preview_circle_memberships");
  await onboard(page, "professional", "work");
  await page
    .getByRole("button", { name: "Join Clearer professional work" })
    .click();
  await page
    .getByRole("button", { name: "Leave Clearer professional work" })
    .click();
  await expect(
    page.getByRole("button", { name: "Join Clearer professional work" }),
  ).toBeVisible();
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const blocked = await page.request.post("/circles/professional-work/join", {
    headers: { Origin: "https://wrong.example" },
    form: { csrf },
    maxRedirects: 0,
  });
  expect(blocked.status()).toBe(403);
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "dne_preview",
  )!;
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE token_hash=$1",
    [createHash("sha256").update(cookie.value).digest("hex")],
  );
  await page.goto("/circles");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("button", { name: "Start my learning path" }),
  ).toBeVisible();
  await context.clearCookies();
  await context.addCookies([
    {
      name: "dne_preview",
      value: "0".repeat(64),
      url: "http://127.0.0.1:4317",
    },
  ]);
  await page.goto("/circles");
  await expect(page).toHaveURL(/\/$/);
});
