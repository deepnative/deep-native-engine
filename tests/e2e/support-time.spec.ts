import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool);
const origin = "http://127.0.0.1:4317";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
test.afterAll(async () => pool.end());
async function session(page: Page, token: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function hold(page: Page, requestId: string, ceiling: number) {
  await page.goto(`/support/${requestId}`);
  await page
    .getByLabel("Maximum support and preparation minutes")
    .fill(String(ceiling));
  await page
    .getByLabel(
      "Hold this ceiling from my existing private support test minutes",
    )
    .check();
  await page
    .getByRole("button", { name: "Hold support test minutes", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "support test minutes held" }),
  ).toHaveText(`${ceiling} support test minutes held`);
  const result = await support.time!.receipt(
    (await page.context().cookies()).find((cookie) => cookie.name === COOKIE)!
      .value,
    requestId,
  );
  if (result.kind !== "ready" || !result.value)
    throw Error("Missing held test minutes");
  return result.value.allocationId;
}
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${124 + index}] ${background} holds, cancels, begins and partially settles private support minutes without text or accounting leakage`, async ({
    page,
  }) => {
    const token = randomBytes(32).toString("hex"),
      adminToken = randomBytes(32).toString("hex"),
      operatorToken = randomBytes(32).toString("hex"),
      expiry = new Date(Date.now() + 3600000);
    await members.create(token, { background, goal });
    const member = await members.session(token);
    if (member.kind !== "active") throw Error("Invented member missing");
    const adminId = await auth.provisionStaff(
        adminToken,
        "platform_admin",
        expiry,
      ),
      operatorId = await auth.provisionStaff(operatorToken, "operator", expiry);
    try {
      await ledger.grant(
        member.learner.id,
        "support_minutes",
        20,
        randomUUID(),
        {
          startsAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: expiry.toISOString(),
        },
      );
      const intake = await support.create(token, {
        idempotencyKey: randomUUID(),
        subject: "Invented browser request",
        body: "PRIVATE REQUEST MUST NOT REACH TIME OPERATOR",
      });
      if (!("receipt" in intake)) throw Error("Missing request");
      const requestId = intake.receipt.requestId;
      await session(page, token);
      const cancelled = await hold(page, requestId, 20);
      await page.getByLabel("Cancel this unstarted allocation").check();
      await page
        .getByRole("button", { name: "Cancel unstarted support allocation" })
        .click();
      await expect(
        page.getByText("State: cancelled.", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Hold this ceiling from my existing"),
      ).not.toBeChecked();
      const allocationId = await hold(page, requestId, 20);
      expect(allocationId).not.toBe(cancelled);
      const granted = await support.time!.grant(adminToken, {
        requestId,
        allocationId,
        staffId: operatorId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: new Date(Date.now() - 60000),
        expiresAt: expiry,
      });
      if (!("grantId" in granted)) throw Error("Missing exact time grant");
      const href = `/operator/support-time/${requestId}?allocation=${allocationId}&grant=${granted.grantId}`;
      expect((await page.goto(href))!.status()).toBe(403);
      await session(page, operatorToken);
      const noteGrant = await support.grant(adminToken, {
        requestId,
        staffId: operatorId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: new Date(Date.now() - 60000),
        expiresAt: expiry,
      });
      if (!("grantId" in noteGrant))
        throw Error("Missing wrong-purpose fixture");
      expect(
        (await page.goto(
          `/operator/support-time/${requestId}?allocation=${allocationId}&grant=${noteGrant.grantId}`,
        ))!.status(),
      ).toBe(403);
      await page.goto("/operator/support-time");
      await page
        .getByRole("link", { name: `Support test allocation · ${requestId}` })
        .click();
      await expect(
        page.getByText("PRIVATE REQUEST MUST NOT REACH TIME OPERATOR"),
      ).toHaveCount(0);
      await page
        .getByLabel("Begin this private invented support effort")
        .check();
      await page
        .getByRole("button", { name: "Begin support test effort", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("State: begun");
      const start = new Date(Date.now() - 3600000),
        end = new Date(+start + 600000),
        prepEnd = new Date(+end + 300000);
      await page
        .getByLabel("Support start (UTC)", { exact: true })
        .fill(start.toISOString());
      await page
        .getByLabel("Support end (UTC)", { exact: true })
        .fill(end.toISOString());
      await page
        .getByLabel("Preparation start (UTC, optional)")
        .fill(end.toISOString());
      await page
        .getByLabel("Preparation end (UTC, optional)")
        .fill(prepEnd.toISOString());
      await page.getByLabel("Record these invented intervals once").check();
      const originalKey = await page
          .locator('[name="idempotencyKey"]')
          .inputValue(),
        csrf = await page.locator('[name="csrf"]').inputValue();
      const fault = `test_support_fault_${randomUUID().replaceAll("-", "")}`;
      const excessive = await page.request.post(
        `/operator/support-time/${requestId}/record`,
        {
          headers: { Origin: origin },
          maxRedirects: 0,
          form: {
            csrf,
            allocationId,
            grantId: granted.grantId,
            idempotencyKey: originalKey,
            confirm: "yes",
            supportStart: start.toISOString(),
            supportEnd: new Date(+start + 21 * 60000).toISOString(),
            preparationStart: "",
            preparationEnd: "",
          },
        },
      );
      expect(excessive.status()).toBe(409);
      try {
        await pool.query(
          `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.allocation_id::text=TG_ARGV[0] AND NEW.action='recorded' THEN RAISE EXCEPTION 'Invented commit failure'; END IF; RETURN NEW; END $$`,
        );
        await pool.query(
          `CREATE CONSTRAINT TRIGGER ${fault} AFTER INSERT ON support_time_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fault}('${allocationId}')`,
        );
        await page
          .getByRole("button", { name: "Record and settle test effort" })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          "cannot be confirmed",
        );
        await expect(page.getByRole("alert")).toContainText(
          "Nothing is retried automatically",
        );
      } finally {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${fault} ON support_time_events`,
        );
        await pool.query(`DROP FUNCTION IF EXISTS ${fault}()`);
      }
      await page
        .getByRole("link", { name: "Inspect saved support state" })
        .click();
      await expect(page.getByRole("status")).toContainText("State: begun");
      const recovered = await page.request.post(
        `/operator/support-time/${requestId}/record`,
        {
          headers: { Origin: origin },
          maxRedirects: 0,
          form: {
            csrf,
            allocationId,
            grantId: granted.grantId,
            idempotencyKey: originalKey,
            confirm: "yes",
            supportStart: start.toISOString(),
            supportEnd: end.toISOString(),
            preparationStart: end.toISOString(),
            preparationEnd: prepEnd.toISOString(),
          },
        },
      );
      expect(recovered.status()).toBe(303);
      await page.goto(href);
      await expect(page.getByRole("status")).toContainText("State: completed");
      await expect(
        page.getByText("Confirmed ceiling: 20. Consumed: 15. Released: 5.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Record and settle test effort" }),
      ).toHaveCount(0);
      await session(page, token);
      await page.goto(`/support/${requestId}`);
      await expect(
        page.getByText(
          "Confirmed ceiling: 20. Consumed: 15. Released: 5. State: completed.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(
        granted.grantId,
      );
      expect(await page.locator("body").innerText()).not.toContain(operatorId);
      await page.goto("/member/test-units");
      const units = page.locator('[data-test-unit-category="support_minutes"]');
      await expect(units.locator('[data-field="usable"]')).toHaveText("5");
      await expect(units.locator('[data-field="held"]')).toHaveText("0");
      await expect(units.locator('[data-field="consumed"]')).toHaveText("15");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const createRequest = async () => {
        const result = await support.create(token, {
          idempotencyKey: randomUUID(),
          subject: "Invented withdrawal",
          body: "PRIVATE WITHDRAWN TEXT",
        });
        if (!("receipt" in result)) throw Error("Missing withdrawal fixture");
        return result.receipt.requestId;
      };
      const neverBegun = await createRequest();
      await hold(page, neverBegun, 5);
      await page
        .getByLabel("Withdraw this request and remove its subject")
        .check();
      await page.getByRole("button", { name: "Withdraw request text" }).click();
      await expect(
        page.getByText("State: cancelled.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("PRIVATE WITHDRAWN TEXT")).toHaveCount(0);
      const unresolvedRequest = await createRequest(),
        unresolvedAllocation = await hold(page, unresolvedRequest, 5);
      const unresolvedGrant = await support.time!.grant(adminToken, {
        requestId: unresolvedRequest,
        allocationId: unresolvedAllocation,
        staffId: operatorId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: new Date(Date.now() - 60000),
        expiresAt: expiry,
      });
      if (!("grantId" in unresolvedGrant))
        throw Error("Missing second time grant");
      const unresolvedHref = `/operator/support-time/${unresolvedRequest}?allocation=${unresolvedAllocation}&grant=${unresolvedGrant.grantId}`;
      await session(page, operatorToken);
      await page.goto(unresolvedHref);
      await page
        .getByLabel("Begin this private invented support effort")
        .check();
      await page
        .getByRole("button", { name: "Begin support test effort", exact: true })
        .click();
      const conflicting = await page.request.post(
        `/operator/support-time/${unresolvedRequest}/record`,
        {
          headers: { Origin: origin },
          maxRedirects: 0,
          form: {
            csrf: await page.locator('[name="csrf"]').inputValue(),
            allocationId: unresolvedAllocation,
            grantId: unresolvedGrant.grantId,
            idempotencyKey: await page
              .locator('[name="idempotencyKey"]')
              .inputValue(),
            confirm: "yes",
            supportStart: start.toISOString(),
            supportEnd: new Date(+start + 4 * 60000).toISOString(),
            preparationStart: "",
            preparationEnd: "",
          },
        },
      );
      expect(conflicting.status()).toBe(409);
      await session(page, token);
      await page.goto(`/support/${unresolvedRequest}`);
      await page
        .getByLabel("Withdraw this request and remove its subject")
        .check();
      await page.getByRole("button", { name: "Withdraw request text" }).click();
      await expect(
        page.getByText("State: needs_reconciliation.", { exact: false }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "support test minutes held" }),
      ).toHaveText("5 support test minutes held");
      const exported = await page.request.get("/api/member/export"),
        records = (await exported.json()).records;
      expect(exported.status()).toBe(200);
      expect(records.supportTimeEntries).toHaveLength(1);
      expect(records.supportTimeEntries[0]).toMatchObject({
        supportMinutes: 10,
        preparationMinutes: 5,
      });
      expect(JSON.stringify(records.supportTimeAllocations)).not.toContain(
        operatorId,
      );
      expect(JSON.stringify(records.supportTimeEntries)).not.toContain(
        granted.grantId,
      );
      await page.goto("/learn");
      await page.getByLabel("Delete my local preview").check();
      await page.getByRole("button", { name: "Delete this preview" }).click();
      expect((await page.request.get("/api/member/export")).status()).toBe(403);
      await session(page, operatorToken);
      expect((await page.goto(unresolvedHref))!.status()).toBe(403);
    } finally {
      await members.remove(member.learner.id);
      await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
        [adminId, operatorId],
      ]);
    }
  });
}
