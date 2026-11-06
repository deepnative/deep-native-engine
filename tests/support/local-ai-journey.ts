import { expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { store } from "../../src/store.ts";

export const aiOrigin = "http://127.0.0.1:4317";

export function aiStorage() {
  return fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!);
}

export async function aiMember(pool: Pool) {
  const token = randomBytes(32).toString("hex");
  const members = store(pool);
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}

export async function signIn(page: Page, token: string, url = aiOrigin) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: token,
      url,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

export function grantStudyRequests(
  pool: Pool,
  memberId: string,
  quantity: number,
) {
  return syntheticLedger(pool).grant(
    memberId,
    "study_requests",
    quantity,
    randomUUID(),
    {
      startsAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2100-01-01T00:00:00.000Z",
    },
  );
}

export async function savedSample(pool: Pool, page: Page) {
  const title = `Invented-${randomUUID()}.txt`;
  await page.goto("/evidence");
  await page.getByLabel("Sample title").fill(title);
  await page
    .getByLabel("Invented text sample")
    .fill("Invented private source for a simulated study request");
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
  const id = (
    await pool.query<{ id: string }>(
      "SELECT id FROM evidence_objects WHERE original_name=$1",
      [title],
    )
  ).rows[0]!.id;
  await evidenceStore(pool, aiStorage(), "browser-secret").transitionQuarantine(
    id,
    "clean",
  );
  await page.goto("/evidence/local-ai");
  return {
    id,
    item: page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) }),
  };
}

export async function permitSample(pool: Pool, page: Page) {
  const sample = await savedSample(pool, page);
  await sample.item
    .getByLabel("I permit this exact invented sample version")
    .check();
  await sample.item
    .getByRole("button", { name: "Grant local simulation permission" })
    .click();
  await expect(
    sample.item.getByRole("button", { name: "Withdraw permission" }),
  ).toBeVisible();
  return sample;
}

// What a member could replay later: only the metered form carries a request key.
export async function savedForm(
  item: ReturnType<Page["locator"]>,
  suffix: "/queue" | "/queue-metered",
) {
  const form = item.locator(`form[action$="${suffix}"]`);
  const key = form.locator('[name="key"]');
  return {
    action: (await form.getAttribute("action"))!,
    fields: {
      csrf: await form.locator('[name="csrf"]').inputValue(),
      ...(suffix === "/queue-metered"
        ? { key: await key.inputValue(), confirm: "yes" }
        : {}),
    },
  };
}

export async function withdrawPermission(item: ReturnType<Page["locator"]>) {
  await item
    .locator('form[action$="/withdraw"]')
    .locator('input[name="confirm"]')
    .check();
  await item.getByRole("button", { name: "Withdraw permission" }).click();
  await expect(
    item.getByRole("button", { name: "Withdraw permission" }),
  ).toHaveCount(0);
}

export async function memberJobs(pool: Pool, memberId: string) {
  return (
    await pool.query<{
      id: string;
      mode: string;
      adapter: string;
      status: string;
    }>(
      "SELECT id,mode,adapter,status FROM adapter_jobs WHERE member_id=$1 ORDER BY created_at,id",
      [memberId],
    )
  ).rows;
}

export async function studyBalance(pool: Pool, grantId: string) {
  return (
    await pool.query<{ available: number; reserved: number; consumed: number }>(
      "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
      [grantId],
    )
  ).rows[0]!;
}
