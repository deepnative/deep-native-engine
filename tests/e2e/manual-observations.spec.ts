import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
const token = () => randomBytes(32).toString("hex");
test.use({ trace: "on" });
test.afterAll(async () => pool.end());

test("[L72] only a platform admin records invented, unverified observations for equivalent learners", async ({
  browser,
}, info) => {
  const projectMarker = info.project.name === "desktop-chromium" ? "D" : "M";
  const adminToken = token();
  const reviewerToken = token();
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
  const admin = await browser.newContext({ baseURL: origin });
  const reviewer = await browser.newContext({ baseURL: origin });
  await admin.addCookies([
    {
      name: "dne_preview",
      value: adminToken,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await reviewer.addCookies([
    {
      name: "dne_preview",
      value: reviewerToken,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await admin.newPage();
  try {
    const backgrounds = ["technical", "professional", "explorer"] as const;
    for (const [index, background] of backgrounds.entries()) {
      const memberToken = token();
      await store(pool).create(memberToken, {
        background,
        goal: background === "explorer" ? "everyday" : "work",
      });
      const session = await store(pool).session(memberToken);
      expect(session.kind).toBe("active");
      if (session.kind !== "active")
        throw new Error("Synthetic member missing");
      const member = await browser.newContext({ baseURL: origin });
      try {
        await member.addCookies([
          {
            name: "dne_preview",
            value: memberToken,
            url: origin,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
        expect(
          (await member.request.get("/operator/test-receipts")).status(),
        ).toBe(403);
        await page.goto("/operator/test-receipts");
        await expect(page.getByText("INTERNAL SYNTHETIC TEST")).toBeVisible();
        const csrf = await page.locator('input[name="csrf"]').inputValue();
        const idempotencyKey = await page
          .locator('input[name="idempotencyKey"]')
          .inputValue();
        const form = {
          csrf,
          idempotencyKey,
          memberId: session.learner.id,
          evidenceReference: `SYN-BROWSER-${projectMarker}-${index}`,
          amountCents: "1200",
          confirm: "yes",
        };
        await page
          .getByLabel("Existing local member ID")
          .fill(session.learner.id);
        await page
          .getByLabel("Invented evidence reference (SYN- prefix)")
          .fill(form.evidenceReference);
        await page.getByLabel("Invented CAD cents").fill(form.amountCents);
        await page
          .getByLabel(
            "This is invented test evidence, not a payment confirmation",
          )
          .check();
        await page
          .getByRole("button", { name: "Record unverified observation" })
          .click();
        await expect(page).toHaveURL(origin + "/operator/test-receipts");
        await expect(page.getByText(form.evidenceReference)).toBeVisible();
        await expect(page.getByText("unverified_manual").first()).toBeVisible();
        expect(
          (
            await member.request.post("/operator/test-receipts", {
              headers: { origin },
              form,
            })
          ).status(),
        ).toBe(403);
        expect(
          (
            await admin.request.post("/operator/test-receipts", {
              headers: { origin },
              form,
              maxRedirects: 0,
            })
          ).status(),
        ).toBe(303);
        expect(
          (
            await admin.request.post("/operator/test-receipts", {
              headers: { origin },
              form: { ...form, amountCents: "1300" },
            })
          ).status(),
        ).toBe(409);
        expect(
          (
            await admin.request.post("/operator/test-receipts", {
              headers: { origin },
              form: { ...form, idempotencyKey: randomUUID(), csrf: "forged" },
            })
          ).status(),
        ).toBe(403);
      } finally {
        await member.close();
      }
    }
    expect(
      (await reviewer.request.get("/operator/test-receipts")).status(),
    ).toBe(403);
    const reviewerHome = await reviewer.request.get("/");
    const reviewerCsrf = (await reviewerHome.text()).match(
      /name="csrf" value="([a-f0-9]+)"/,
    )?.[1];
    expect(reviewerCsrf).toBeTruthy();
    expect(
      (
        await reviewer.request.post("/operator/test-receipts", {
          headers: { origin },
          form: {
            csrf: reviewerCsrf!,
            idempotencyKey: randomUUID(),
            memberId: randomUUID(),
            evidenceReference: "SYN-REVIEWER-DENIED",
            amountCents: "100",
            confirm: "yes",
          },
        })
      ).status(),
    ).toBe(403);
    const html = await page.content();
    expect(html).toContain("not provider verification");
    expect(html).not.toContain("paid invoice issued");
    const rows = await pool.query(
      "SELECT status FROM synthetic_manual_observations WHERE evidence_reference LIKE $1",
      [`SYN-BROWSER-${projectMarker}-%`],
    );
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((row) => row.status === "unverified_manual")).toBe(
      true,
    );
  } finally {
    await reviewer.close();
    await admin.close();
  }
});
