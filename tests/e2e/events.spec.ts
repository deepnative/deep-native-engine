import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(
  page: Page,
  background: string,
  goal: string,
  timezone = "",
) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  if (timezone) await page.getByLabel("Time zone (optional)").fill(timezone);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
}

async function retainedCounts() {
  const result = await pool.query<{
    circles: number;
    reservations: number;
    ledger: number;
    slotHolds: number;
    consents: number;
  }>(`SELECT
      (SELECT count(*)::integer FROM preview_circle_memberships) AS circles,
      (SELECT count(*)::integer FROM synthetic_entitlement_reservations) AS reservations,
      (SELECT count(*)::integer FROM synthetic_entitlement_events) AS ledger,
      (SELECT count(*)::integer FROM synthetic_slot_holds) AS "slotHolds",
      (SELECT count(*)::integer FROM local_ai_receipts) AS consents`);
  return result.rows[0]!;
}

test("[L82] three backgrounds discover synthetic events by keyboard without enrollment or retained writes", async ({
  page,
  context,
}) => {
  const before = await retainedCounts();
  for (const [background, goal, id, version, timezone] of [
    ["explorer", "everyday", "everyday-ai-preview", "2", "America/Toronto"],
    ["professional", "work", "professional-work-preview", "1", ""],
    [
      "technical",
      "build",
      "technical-practice-preview",
      "1",
      "America/Toronto",
    ],
  ]) {
    await context.clearCookies();
    await onboard(page, background!, goal!, timezone!);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const eventLink = page.getByRole("link", { name: "Explore local events" });
    await eventLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/events$/);
    await expect(
      page.getByRole("heading", { name: "Explore sample events" }),
    ).toBeVisible();
    await expect(page.getByText(/Access and cost: unresolved/)).toBeVisible();
    await expect(page.getByText(/Expert coverage: unresolved/)).toBeVisible();
    await expect(page.getByText(/Recording: unresolved/)).toBeVisible();
    await expect(
      page.getByText("Synthetic preview; enrollment unavailable").first(),
    ).toBeVisible();
    const detail = page.locator(`a[href="/events/${id}/${version}"]`);
    await expect(detail).toBeVisible();
    await detail.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/events/${id}/${version}$`));
    await expect(
      page.getByText(`Version ${version}`, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic preview; enrollment unavailable"),
    ).toBeVisible();
    await expect(page.getByText("Access and cost: unresolved")).toBeVisible();
    await expect(page.getByText("Expert coverage: unresolved")).toBeVisible();
    await expect(page.getByText("Recording: unresolved")).toBeVisible();
    await expect(page.getByText(/UTC 2030-11-/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /enroll|book|reserve|pay/i }),
    ).toHaveCount(0);
    if (timezone) {
      await expect(
        page.getByText("America/Toronto", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText(/GMT-0[45]/)).toBeVisible();
    } else {
      const recovery = page.getByRole("link", { name: "Set your time zone" });
      await expect(recovery).toHaveAttribute("href", "/learn#timezone");
      await recovery.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/learn#timezone$/);
      await expect(page.getByLabel("Time zone (optional)")).toBeVisible();
      await page.goto(`/events/${id}/${version}`);
    }
    const forged = await page.request.post(`/events/${id}/${version}/enroll`, {
      headers: { Origin: "http://127.0.0.1:4317" },
      form: { csrf },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(404);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/events");
  const explore = page.getByRole("link", { name: "Explore other topics" });
  await explore.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/events\?all=1$/);
  await expect(page.getByText("Exploring all topics")).toBeVisible();
  await expect(
    page.locator('a[href="/events/everyday-ai-preview/2"]'),
  ).toBeVisible();
  await expect(
    page.locator('a[href="/events/professional-work-preview/1"]'),
  ).toBeVisible();
  await page.goto("/events/everyday-ai-preview/2");
  await expect(page.getByText("GMT-04:00", { exact: false })).toBeVisible();
  await page.goto("/events/professional-work-preview/1");
  await expect(page.getByText("GMT-05:00", { exact: false })).toBeVisible();
  const replaced = await page.goto("/events/everyday-ai-preview/1");
  expect(replaced?.status()).toBe(410);
  await expect(page.getByText("This event version was replaced")).toBeVisible();
  const retired = await page.goto("/events/retired-learning-preview/1");
  expect(retired?.status()).toBe(410);
  await expect(page.getByText("This event version was retired")).toBeVisible();
  const past = await page.goto("/events/past-learning-preview/1");
  expect(past?.status()).toBe(410);
  await expect(page.getByText("This event has already started")).toBeVisible();
  const missing = await page.goto("/events/unknown-preview/1");
  expect(missing?.status()).toBe(404);
  await expect(page.getByText("Event version unavailable")).toBeVisible();
  expect(await retainedCounts()).toEqual(before);
  const cookie = (await context.cookies()).find(
    (entry) => entry.name === "dne_preview",
  )!;
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE token_hash=$1",
    [createHash("sha256").update(cookie.value).digest("hex")],
  );
  await page.goto("/events");
  await expect(page).toHaveURL(/\/$/);
  await context.clearCookies();
  await onboard(page, "explorer", "everyday");
  const revokedCookie = (await context.cookies()).find(
    (entry) => entry.name === "dne_preview",
  )!;
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1",
    [createHash("sha256").update(revokedCookie.value).digest("hex")],
  );
  await page.goto("/events");
  await expect(page).toHaveURL(/\/$/);
  await context.clearCookies();
  const staffToken = randomBytes(32).toString("hex");
  const staffId = randomUUID();
  await pool.query(
    "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'staff',CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    [staffId, createHash("sha256").update(staffToken).digest("hex")],
  );
  await context.addCookies([
    {
      name: "dne_preview",
      value: staffToken,
      url: "http://127.0.0.1:4317",
    },
  ]);
  await page.goto("/events");
  await expect(page).toHaveURL(/\/$/);
  expect(await retainedCounts()).toEqual(before);
  await pool.query("DELETE FROM principals WHERE id=$1", [staffId]);
});
