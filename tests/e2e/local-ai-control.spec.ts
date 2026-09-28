import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
const token = () => randomBytes(32).toString("hex");
test.afterAll(async () => pool.end());

test("[L77] an administrator pauses local AI while member permission stays exact", async ({
  browser,
}) => {
  const memberToken = token();
  const adminToken = token();
  const reviewerToken = token();
  const objects = fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!);
  const db = store(pool);
  await db.create(memberToken, { background: "explorer", goal: "everyday" });
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
    adminToken,
    "platform_admin",
    new Date(Date.now() + 86_400_000),
  );
  await auth.provisionStaff(
    reviewerToken,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  const uploaded = await evidenceStore(pool, objects, "browser-secret").upload(
    memberToken,
    {
      name: `local-switch-${randomBytes(8).toString("hex")}.txt`,
      mediaType: "text/plain",
      data: Buffer.from("Invented local control source"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    },
  );
  expect(uploaded.kind).toBe("created");
  if (uploaded.kind !== "created") throw Error("Synthetic source unavailable");
  await evidenceStore(pool, objects, "browser-secret").transitionQuarantine(
    uploaded.id,
    "clean",
  );
  const grant = await localAiConsentStore(
    pool,
    objects,
    deterministicRegistry({}, "test"),
  ).grant(memberToken, uploaded.id);
  expect(grant.kind).toBe("granted");
  if (grant.kind !== "granted") throw Error("Local permission unavailable");

  async function context(value: string) {
    const browserContext = await browser.newContext({ baseURL: origin });
    await browserContext.addCookies([
      {
        name: "dne_preview",
        value,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    return browserContext;
  }
  const member = await context(memberToken);
  const admin = await context(adminToken);
  const reviewer = await context(reviewerToken);
  const memberPage = await member.newPage();
  const adminPage = await admin.newPage();
  try {
    await memberPage.goto("/evidence/local-ai");
    await expect(
      memberPage.getByRole("button", { name: "Queue local simulation" }),
    ).toBeVisible();
    await memberPage
      .getByRole("button", { name: "Queue local simulation" })
      .click();
    const pendingJobId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1",
        [grant.receiptId],
      )
    ).rows[0]!.id;
    await expect(
      memberPage.getByRole("button", { name: "Run local simulation" }),
    ).toBeVisible();
    const staleCsrf = await memberPage
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    await adminPage.goto("/operator/local-ai");
    await expect(
      adminPage.getByText("Local simulation is available"),
    ).toBeVisible();
    await adminPage
      .getByLabel("Confirm pause for local simulation only")
      .check();
    await adminPage
      .getByRole("button", { name: "Pause local simulation" })
      .click();
    await expect(
      adminPage.getByText("Local simulation is paused"),
    ).toBeVisible();

    expect((await reviewer.request.get("/operator/local-ai")).status()).toBe(
      403,
    );
    expect((await member.request.get("/operator/local-ai")).status()).toBe(403);
    const reviewerHome = await reviewer.request.get("/");
    const reviewerCsrf = (await reviewerHome.text()).match(
      /name="csrf" value="([a-f0-9]+)"/,
    )![1]!;
    expect(
      (
        await reviewer.request.post("/operator/local-ai", {
          headers: { Origin: origin },
          form: { csrf: reviewerCsrf, state: "enabled", confirm: "yes" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await member.request.post("/operator/local-ai", {
          headers: { Origin: origin },
          form: { csrf: staleCsrf, state: "enabled", confirm: "yes" },
        })
      ).status(),
    ).toBe(403);
    const staleQueue = await member.request.post(
      `/evidence/local-ai/${grant.receiptId}/queue`,
      {
        headers: { Origin: origin },
        form: { csrf: staleCsrf },
      },
    );
    expect(staleQueue.status()).toBe(403);
    expect(
      (
        await pool.query(
          "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1",
          [grant.receiptId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await member.request.post(`/evidence/local-ai/${pendingJobId}/run`, {
          headers: { Origin: origin },
          form: { csrf: staleCsrf },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM adapter_jobs WHERE id=$1",
          [pendingJobId],
        )
      ).rows[0]?.status,
    ).toBe("pending");
    await memberPage.reload();
    await expect(
      memberPage.getByText("Local simulations are paused"),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("button", { name: "Withdraw permission" }),
    ).toBeVisible();
    await memberPage.getByLabel(/Withdraw local AI permission for/).check();
    await memberPage
      .getByRole("button", { name: "Withdraw permission" })
      .click();

    await adminPage
      .getByLabel("Confirm resume for local simulation only")
      .check();
    await adminPage
      .getByRole("button", { name: "Resume local simulation" })
      .click();
    await expect(
      adminPage.getByText("Local simulation is available"),
    ).toBeVisible();
    expect(
      (
        await member.request.post(
          `/evidence/local-ai/${grant.receiptId}/queue`,
          {
            headers: { Origin: origin },
            form: { csrf: staleCsrf },
          },
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await member.request.post(`/evidence/local-ai/${pendingJobId}/run`, {
          headers: { Origin: origin },
          form: { csrf: staleCsrf },
        })
      ).status(),
    ).toBe(403);
    await memberPage.reload();
    await expect(
      memberPage.getByText("Local AI permission withdrawn"),
    ).toBeVisible();
    await memberPage
      .getByLabel("I permit this exact invented sample version")
      .check();
    await memberPage
      .getByRole("button", { name: "Grant local simulation permission" })
      .click();
    await memberPage
      .getByRole("button", { name: "Queue local simulation" })
      .click();
    await memberPage
      .getByRole("button", { name: "Run local simulation" })
      .click();
    await expect(
      memberPage.getByText(
        "Simulated locally. No provider request or qualified review occurred.",
      ),
    ).toBeVisible();
  } finally {
    try {
      await pool.query(
        "UPDATE local_ai_control SET paused=false WHERE singleton=true",
      );
    } finally {
      await Promise.all([member.close(), admin.close(), reviewer.close()]);
    }
  }
});
