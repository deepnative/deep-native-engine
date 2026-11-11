import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import { memberReference } from "../support/course-bundle-journey.ts";
import {
  deleteAccount,
  expectBackupExpiryNamed,
  expectBillingRetained,
  issuedInvoiceWithPayment,
} from "../support/billing-retention-journey.ts";
import { staffTrace } from "../support/staff-trace.ts";

// ROADMAP-09-D: owner and outsider export, member-authorized operator export
// and its denials (none, expired, out of scope), then deletion of source and
// derived data with the retained billing and backup exceptions disclosed (#12
// D08, owner 10 Nov 2026). Invented data on its own database; nothing is
// payable. Staff credentials stay out of traces.
// Staff sign in here, so traces are off except in a full-release run, which
// needs one per execution: see ../support/staff-trace.ts.
test.use({ trace: staffTrace });
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

async function exportJson(page: Page, origin: string, query = "") {
  const response = await page.request.get(
    `${origin}/api/member/export${query}`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return JSON.stringify(await response.json());
}
async function operatorRequest(
  f: Fixture,
  operator: Page,
  reference: string,
  scope: "learning" | "support" | "billing",
) {
  await operator.goto(f.origin + "/operator/member-records");
  await operator.getByLabel("Student reference").fill(reference);
  await operator.getByLabel("Records").selectOption(scope);
}
async function expectRefused(operator: Page, hidden: string[]) {
  // Refused for lack of the member's permission (403), not as a malformed
  // request (400), which shows the same heading.
  const [response] = await Promise.all([
    operator.waitForResponse(
      (answer) =>
        answer.request().method() === "POST" &&
        answer.url().endsWith("/operator/member-records"),
    ),
    operator.getByRole("button", { name: "Download records" }).click(),
  ]);
  expect(response.status()).toBe(403);
  await expect(
    operator.getByRole("heading", { name: "Download refused" }),
  ).toBeVisible();
  await expect(operator.locator("main")).toContainText(
    "hasn't allowed operators to download these records right now",
  );
  const text = (await operator.locator("main").textContent()) ?? "";
  for (const value of hidden) expect(text).not.toContain(value);
}

test("[F-ROADMAP-09-D] member and operator export stay within authorization, and deletion removes active and derived data while disclosing what is kept", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    await f.publishFixture();
    const admin = (await f.staff("platform_admin")).page;
    const operator = (await f.staff("operator")).page;
    const owner = await f.member(),
      outsider = await f.member("professional", "work");
    const ownerId = await memberReference(owner, f.origin),
      outsiderId = await memberReference(outsider, f.origin);
    expect(outsiderId).not.toBe(ownerId);
    const tag = randomBytes(4).toString("hex"),
      ownerTitle = `Invented owner milestone ${tag}`,
      outsiderTitle = `Invented outsider milestone ${tag}`,
      supportBody = `Invented owner support body ${tag}`;
    for (const [member, title] of [
      [ownerId, ownerTitle],
      [outsiderId, outsiderTitle],
    ])
      await f.pool.query(
        `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
         VALUES($1,$2,'Invented goal',$3,'Invented next step')`,
        [randomUUID(), member, title],
      );
    await f.pool.query(
      `INSERT INTO support_requests(id,member_id,workspace_id,intake_key,subject,body)
       VALUES($1,$2,$2,$3,'Invented subject',$4)`,
      [randomUUID(), ownerId, randomUUID(), supportBody],
    );

    await requiredCheck(1, async () => {
      const own = await exportJson(owner, f.origin);
      expect(own).toContain(ownerId);
      expect(own).toContain(ownerTitle);
      expect(own).not.toContain(outsiderTitle);
      expect(own).not.toContain(outsiderId);
    });
    await requiredCheck(2, async () => {
      for (const query of ["", `?member_id=${ownerId}`]) {
        const other = await exportJson(outsider, f.origin, query);
        expect(other).toContain(outsiderTitle);
        expect(other).not.toContain(ownerTitle);
        expect(other).not.toContain(ownerId);
      }
      const anonymous = await browser.newContext();
      try {
        const denied = await anonymous.request.get(
          f.origin + "/api/member/export",
        );
        expect(denied.status()).toBe(403);
        expect(await denied.text()).not.toContain(ownerTitle);
      } finally {
        await anonymous.close();
      }
    });

    // The owner allows operators to download learning records for 7 days.
    await owner.goto(f.origin + "/account/record-access");
    await owner.getByRole("radio", { name: /^Learning records/ }).check();
    await owner.getByRole("button", { name: "Allow for 7 days" }).click();
    await expect(
      owner.locator('[data-record-access="learning"]'),
    ).toContainText("No downloads yet.");
    await requiredCheck(5, async () => {
      await operatorRequest(f, operator, ownerId, "learning");
      const [download] = await Promise.all([
        operator.waitForEvent("download"),
        operator.getByRole("button", { name: "Download records" }).click(),
      ]);
      const saved = info.outputPath("learning.json");
      await download.saveAs(saved);
      const payload = JSON.parse(await readFile(saved, "utf8"));
      expect(payload).toMatchObject({
        version: "operator-member-records-v1",
        reference: ownerId,
        scope: "learning",
      });
      expect(payload.records.milestones).toEqual([
        expect.objectContaining({ milestoneTitle: ownerTitle }),
      ]);
      const text = JSON.stringify(payload);
      expect(text).not.toContain(outsiderTitle);
      expect(text).not.toContain(outsiderId);
      expect(text).not.toContain(supportBody);
    });
    await requiredCheck(6, async () => {
      await operatorRequest(f, operator, outsiderId, "learning");
      await expectRefused(operator, [outsiderTitle]);
    });
    await requiredCheck(7, async () => {
      // An invented permission the outsider gave three days ago, which
      // expired yesterday.
      await f.pool.query(
        `INSERT INTO member_record_access(id,member_id,scope,created_at,expires_at)
         VALUES($1,$2,'learning',clock_timestamp()-interval '3 days',clock_timestamp()-interval '1 day')`,
        [randomUUID(), outsiderId],
      );
      await operatorRequest(f, operator, outsiderId, "learning");
      await expectRefused(operator, [outsiderTitle]);
    });
    await requiredCheck(8, async () => {
      for (const scope of ["support", "billing"] as const) {
        await operatorRequest(f, operator, ownerId, scope);
        await expectRefused(operator, [supportBody, ownerTitle]);
      }
      // The refusal was about scope: once the owner allows support requests,
      // the same request downloads them, and still no learning records.
      await owner.goto(f.origin + "/account/record-access");
      await owner.getByRole("radio", { name: /^Support requests/ }).check();
      await owner.getByRole("button", { name: "Allow for 7 days" }).click();
      await expect(
        owner.locator('[data-record-access="support"]'),
      ).toContainText("No downloads yet.");
      await operatorRequest(f, operator, ownerId, "support");
      const [download] = await Promise.all([
        operator.waitForEvent("download"),
        operator.getByRole("button", { name: "Download records" }).click(),
      ]);
      const saved = info.outputPath("support.json");
      await download.saveAs(saved);
      const allowed = await readFile(saved, "utf8");
      expect(JSON.parse(allowed)).toMatchObject({
        reference: ownerId,
        scope: "support",
      });
      expect(allowed).toContain(supportBody);
      expect(allowed).not.toContain(ownerTitle);
    });

    // Source evidence with a derived text extract, and an issued, paid invoice.
    const csrf = await owner.locator('input[name="csrf"]').first().inputValue();
    const source = Buffer.from(`Invented source material ${tag}.`),
      derived = Buffer.from(`Invented text extract ${tag}.`);
    const uploaded = await owner.request.post(f.origin + "/api/evidence", {
      headers: {
        Origin: f.origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "text/plain",
        "X-Evidence-Name": `invented-${tag}.txt`,
        "X-Evidence-Rights": "confirmed",
        "X-Evidence-Scopes": "private-review",
      },
      data: source,
    });
    expect(uploaded.status()).toBe(201);
    const { id: evidenceId } = (await uploaded.json()) as { id: string };
    const evidence = evidenceStore(
      f.pool,
      fileObjectStorage(f.storageRoot),
      "invented-roadmap-09-d-secret",
    );
    expect(await evidence.transitionQuarantine(evidenceId, "clean")).toBe(true);
    const derivativeId = await evidence.addDerivative(
      evidenceId,
      "text-extract",
      derived,
    );
    const key = async (sql: string, id: string) =>
      join(
        f.storageRoot,
        (await f.pool.query<{ k: string }>(sql, [id])).rows[0]!.k,
      );
    const sourcePath = await key(
        "SELECT storage_key AS k FROM evidence_objects WHERE id=$1",
        evidenceId,
      ),
      derivedPath = await key(
        "SELECT storage_key AS k FROM evidence_derivatives WHERE id=$1",
        derivativeId,
      );
    expect(await readFile(sourcePath)).toEqual(source);
    expect(await readFile(derivedPath)).toEqual(derived);
    const { invoiceId } = await issuedInvoiceWithPayment(f, admin, owner);

    const status = await deleteAccount(f, owner);
    await requiredCheck(3, async () => {
      for (const [sql, id] of [
        ["SELECT id FROM evidence_objects WHERE id=$1", evidenceId],
        ["SELECT id FROM evidence_derivatives WHERE id=$1", derivativeId],
        ["SELECT id FROM learning_milestones WHERE member_id=$1", ownerId],
        ["SELECT id FROM support_requests WHERE member_id=$1", ownerId],
        ["SELECT id FROM member_record_access WHERE member_id=$1", ownerId],
        ["SELECT id FROM learners WHERE id=$1", ownerId],
      ] as [string, string][])
        expect((await f.pool.query(sql, [id])).rowCount, sql).toBe(0);
      for (const path of [sourcePath, derivedPath])
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      // The outsider's own records are untouched.
      expect(
        (
          await f.pool.query(
            "SELECT id FROM learning_milestones WHERE member_id=$1",
            [outsiderId],
          )
        ).rowCount,
      ).toBe(1);
    });
    await requiredCheck(4, async () => {
      await expectBillingRetained(f, status, invoiceId, ownerId);
      await expectBackupExpiryNamed(owner, status);
    });
  } finally {
    await f.close();
  }
});
