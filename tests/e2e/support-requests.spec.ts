import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  support = supportRequestStore(pool),
  auth = authorizationStore(pool),
  origin = "http://127.0.0.1:4317";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
test.afterAll(async () => pool.end());
async function onboard(
  page: Page,
  background: (typeof audiences)[number][0],
  goal: (typeof audiences)[number][1],
) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(
    page.getByRole("link", { name: "Private sample support", exact: true }),
  ).toBeVisible();
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === COOKIE,
  )!;
  return cookie.value;
}
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
async function intake(page: Page, suffix: string) {
  await page.goto("/support/new");
  const key = await page.locator('[name="idempotencyKey"]').inputValue(),
    csrf = await page.locator('[name="csrf"]').inputValue();
  const subject = `Invented ${suffix} request`,
    body = `  Sample ${suffix} <request>\n`;
  await page.getByLabel("Subject (up to 120 characters)").fill(subject);
  await page
    .getByLabel("Your sample request (up to 2,000 characters)")
    .fill(body);
  await page
    .getByLabel(
      "I used only invented or sample information and want to send this private request.",
    )
    .check();
  await page
    .getByRole("button", { name: "Send private sample request" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private sample support receipt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-support-body]")).toHaveText(body);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  // Native URL-encoded forms normalize textarea LF to CRLF before transmission.
  return { id, key, csrf, subject, body: body.replace(/\n/g, "\r\n") };
}
async function operators() {
  const admin = randomBytes(32).toString("hex"),
    operator = randomBytes(32).toString("hex"),
    expiry = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expiry);
  const staffId = await auth.provisionStaff(operator, "operator", expiry);
  const grant = async (id: string) => {
    const result = await support.grant(admin, {
      idempotencyKey: randomUUID(),
      requestId: id,
      staffId,
      role: "operator",
      startsAt: new Date(Date.now() - 60000),
      expiresAt: expiry,
    });
    expect(result.kind).toBe("created");
    if (!("grantId" in result))
      throw new Error("Synthetic grant fixture unavailable");
    return result.grantId;
  };
  return { admin, operator, grant };
}
async function post(page: Page, path: string, form: Record<string, string>) {
  return page.request.post(path, {
    form,
    headers: { Origin: origin },
    maxRedirects: 0,
  });
}
function formFor(page: Page, label: string) {
  return page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: label, exact: true }) });
}
async function fields(form: Locator) {
  return {
    csrf: await form.locator('[name="csrf"]').inputValue(),
    grantId: await form.locator('[name="grantId"]').inputValue(),
    idempotencyKey: await form.locator('[name="idempotencyKey"]').inputValue(),
    confirm: "yes",
  };
}
async function sendMessage(page: Page, kind: "note" | "reply", body: string) {
  const label =
      kind === "note" ? "Save internal note" : "Send member-visible reply",
    form = formFor(page, label),
    count = await page.locator("[data-support-message]").count();
  const savedFields = await fields(form);
  await form.locator("textarea").fill(body);
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: label }).click();
  await expect(page.locator("[data-support-message]")).toHaveCount(count + 1);
  await expect(page.locator("[data-support-message]").first()).toHaveText(body);
  return { ...savedFields, body };
}
async function resolve(page: Page) {
  const form = formFor(page, "Resolve request locally"),
    savedFields = await fields(form);
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Resolve request locally" }).click();
  await expect(page.getByRole("status")).toContainText(
    "This request cannot be reopened",
  );
  await expect(page.locator("form")).toHaveCount(0);
  return savedFields;
}
async function exported(page: Page) {
  const response = await page.request.get("/api/member/export");
  expect(response.status()).toBe(200);
  return response.json();
}
// Approved #427 blueprint: v72 adds L106-L110 (105 -> 110 journeys).
// Each critical journey below covers all three backgrounds on desktop and mobile.
// These five local synthetic journeys do not change the full-MVP acceptance scope.
test("[L106] all three audiences validate private sample intake, retain exact receipts and recover without automatic replay", async ({
  page,
}) => {
  for (const [background, goal] of audiences)
    await test.step(background, async () => {
      await onboard(page, background, goal);
      await page
        .getByRole("link", { name: "Private sample support", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Your private support requests",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "New private sample request", exact: true })
        .click();
      await expect(
        page.getByText("Local sample support · coverage unverified", {
          exact: false,
        }),
      ).toBeVisible();
      const original = await page
        .locator('[name="idempotencyKey"]')
        .inputValue();
      await page.getByLabel("Subject (up to 120 characters)").fill("   ");
      await page
        .getByLabel("Your sample request (up to 2,000 characters)")
        .fill("Invented <validation>");
      await page
        .getByLabel(
          "I used only invented or sample information and want to send this private request.",
        )
        .check();
      await page
        .getByRole("button", { name: "Send private sample request" })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Correct the request before sending",
      );
      await expect(page.locator('[name="idempotencyKey"]')).toHaveValue(
        original,
      );
      await page
        .getByRole("link", { name: "Enter a nonblank subject", exact: false })
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#subject")).toBeFocused();
      await page
        .getByLabel("Subject (up to 120 characters)")
        .fill(`Synthetic ${background}`);
      const csrf = await page.locator('[name="csrf"]').inputValue();
      await page
        .getByRole("button", { name: "Send private sample request" })
        .click();
      await expect(page.locator("[data-support-body]")).toHaveText(
        "Invented <validation>",
      );
      const path = new URL(page.url()).pathname,
        saved = {
          csrf,
          idempotencyKey: original,
          subject: `Synthetic ${background}`,
          body: "Invented <validation>",
          synthetic: "yes",
        };
      const replay = await post(page, "/support", saved);
      expect(replay.status()).toBe(303);
      expect(replay.headers().location).toBe(path);
      const conflict = await post(page, "/support", {
        ...saved,
        body: "Changed synthetic text",
      });
      expect(conflict.status()).toBe(409);
      expect(await conflict.text()).toContain(`/support/receipts/${original}`);
      expect(await conflict.text()).not.toContain("<form");
      await page.goto(`/support/receipts/${original}`);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.locator("[data-support-body]")).toHaveText(saved.body);
      await page.reload();
      await expect(
        page.getByText("No separate acknowledgement recorded", { exact: true }),
      ).toBeVisible();
      await page.goto("/support");
      await expect(
        page
          .getByRole("list", { name: "Private support requests" })
          .locator(":scope > li"),
      ).toHaveCount(1);
    });
});
test("[L107] all three audiences receive only deliberate replies while exact-granted operators keep notes separate and acknowledge explicitly", async ({
  page,
}) => {
  for (const [background, goal] of audiences)
    await test.step(background, async () => {
      const owner = await onboard(page, background, goal),
        item = await intake(page, background),
        staff = await operators();
      await session(page, staff.operator);
      await page.goto("/operator/support");
      await expect(
        page.getByText("No currently granted requests on this page.", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        (
          await page.request.get(
            `/operator/support/${item.id}?grant=${randomUUID()}`,
          )
        ).status(),
      ).toBe(403);
      const grant = await staff.grant(item.id);
      await page.reload();
      await page
        .getByRole("link", {
          name: `${item.subject} · ${item.id}`,
          exact: true,
        })
        .click();
      await expect(
        page.getByText("No separate acknowledgement recorded", { exact: true }),
      ).toBeVisible();
      await sendMessage(page, "note", `INTERNAL_${background}_ONLY`);
      await sendMessage(
        page,
        "reply",
        `Invented member-visible ${background} reply`,
      );
      await expect(
        page.getByText("No separate acknowledgement recorded", { exact: true }),
      ).toBeVisible();
      await session(page, owner);
      await page.goto(`/support/${item.id}`);
      await expect(page.locator("[data-support-reply]")).toHaveText(
        `Invented member-visible ${background} reply`,
      );
      await expect(
        page.getByText("Synthetic operator", { exact: false }),
      ).toBeVisible();
      expect(await page.content()).not.toContain(`INTERNAL_${background}_ONLY`);
      expect(await page.content()).not.toContain(grant);
      await session(page, staff.admin);
      expect(
        (
          await page.request.get(`/operator/support/${item.id}?grant=${grant}`)
        ).status(),
      ).toBe(403);
      await session(page, staff.operator);
      await page.goto(`/operator/support/${item.id}?grant=${grant}`);
      const form = formFor(page, "Acknowledge request locally");
      await form.getByRole("checkbox").check();
      await form
        .getByRole("button", { name: "Acknowledge request locally" })
        .click();
      await expect(
        page.getByText("Acknowledged locally", { exact: false }),
      ).toBeVisible();
      await session(page, owner);
      await page.goto(`/support/${item.id}`);
      await expect(
        page.getByText("Acknowledged locally", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Open; no resolution recorded", { exact: true }),
      ).toBeVisible();
    });
});
test("[L108] all three audiences see independent resolution while terminal replay respects exact keys and revoked grants", async ({
  page,
}) => {
  for (const [background, goal] of audiences)
    await test.step(background, async () => {
      const owner = await onboard(page, background, goal),
        item = await intake(page, `${background} unacknowledged`),
        staff = await operators(),
        grant = await staff.grant(item.id);
      await session(page, staff.operator);
      await page.goto(`/operator/support/${item.id}?grant=${grant}`);
      const staleAck = await fields(
        formFor(page, "Acknowledge request locally"),
      );
      const reply = await sendMessage(
        page,
        "reply",
        `Reply before resolving ${background}`,
      );
      const resolution = await resolve(page);
      expect(
        (
          await post(page, `/operator/support/${item.id}/resolve`, resolution)
        ).status(),
      ).toBe(303);
      expect(
        (
          await post(page, `/operator/support/${item.id}/resolve`, {
            ...resolution,
            idempotencyKey: randomUUID(),
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await post(page, `/operator/support/${item.id}/acknowledge`, staleAck)
        ).status(),
      ).toBe(409);
      expect(
        (
          await post(page, `/operator/support/${item.id}/replies`, reply)
        ).status(),
      ).toBe(409);
      await session(page, owner);
      await page.goto(`/support/${item.id}`);
      await expect(
        page.getByText("No separate acknowledgement recorded", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Resolved locally", { exact: false }),
      ).toBeVisible();
      const second = await intake(page, `${background} acknowledged`),
        secondGrant = await staff.grant(second.id);
      await session(page, staff.operator);
      await page.goto(`/operator/support/${second.id}?grant=${secondGrant}`);
      const ack = formFor(page, "Acknowledge request locally");
      await ack.getByRole("checkbox").check();
      await ack.getByRole("button").click();
      await expect(
        page.getByText("Acknowledged locally", { exact: false }),
      ).toBeVisible();
      await resolve(page);
      await session(page, owner);
      await page.goto(`/support/${second.id}`);
      await expect(
        page.getByText("Acknowledged locally", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Resolved locally", { exact: false }),
      ).toBeVisible();
      expect((await support.revoke(staff.admin, grant)).kind).toBe("revoked");
      await session(page, staff.operator);
      expect(
        (
          await post(page, `/operator/support/${item.id}/resolve`, resolution)
        ).status(),
      ).toBe(403);
      expect(
        (
          await page.request.get(`/operator/support/${item.id}?grant=${grant}`)
        ).status(),
      ).toBe(403);
    });
});
test("[L109] all three audiences privately withdraw open or resolved requests and export only owner text plus visible replies", async ({
  page,
}) => {
  for (const [background, goal] of audiences)
    await test.step(background, async () => {
      const owner = await onboard(page, background, goal),
        item = await intake(page, `${background} withdrawal`),
        staff = await operators(),
        grant = await staff.grant(item.id);
      await session(page, staff.operator);
      await page.goto(`/operator/support/${item.id}?grant=${grant}`);
      await sendMessage(page, "note", `INTERNAL_WITHDRAW_${background}`);
      const reply = await sendMessage(
        page,
        "reply",
        `Visible withdrawal reply ${background}`,
      );
      await resolve(page);
      const other = await onboard(page, background, goal);
      expect(other).not.toBe(owner);
      const otherCsrf = await page
        .locator('[name="csrf"]')
        .first()
        .inputValue();
      expect((await page.request.get(`/support/${item.id}`)).status()).toBe(
        403,
      );
      const privateReceipt = await page.request.get(
        `/support/receipts/${item.key}`,
      );
      expect(privateReceipt.status()).toBe(404);
      expect(await privateReceipt.text()).not.toContain(item.subject);
      expect(await privateReceipt.text()).not.toContain(item.body);
      expect(
        (
          await post(page, `/support/${item.id}/withdraw`, {
            csrf: otherCsrf,
            confirm: "yes",
          })
        ).status(),
      ).toBe(403);
      await session(page, owner);
      await page.goto(`/support/${item.id}`);
      const before = await exported(page);
      expect(before.records.supportRequests).toEqual([
        expect.objectContaining({
          id: item.id,
          subject: item.subject,
          body: item.body,
          coverageState: "unverified",
        }),
      ]);
      expect(before.records.supportReplies).toEqual([
        expect.objectContaining({
          requestId: item.id,
          body: reply.body,
          attribution: "Synthetic operator",
        }),
      ]);
      expect(JSON.stringify(before)).not.toContain(
        `INTERNAL_WITHDRAW_${background}`,
      );
      const csrf = await page.locator('[name="csrf"]').inputValue();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Withdraw request text" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toContainText(
        "content-free receipt remains",
      );
      await expect(
        page.locator("[data-support-body], [data-support-reply], form"),
      ).toHaveCount(0);
      expect(await page.content()).not.toContain(item.subject);
      expect(
        (
          await post(page, `/support/${item.id}/withdraw`, {
            csrf,
            confirm: "yes",
          })
        ).status(),
      ).toBe(303);
      const after = await exported(page);
      expect(after.records.supportRequests).toEqual([
        expect.objectContaining({
          id: item.id,
          subject: null,
          body: null,
          state: "withdrawn",
        }),
      ]);
      expect(after.records.supportReplies).toEqual([]);
      expect(JSON.stringify(after)).not.toContain(reply.body);
      await session(page, staff.operator);
      expect(
        (
          await page.request.get(`/operator/support/${item.id}?grant=${grant}`)
        ).status(),
      ).toBe(410);
      expect(
        (
          await post(page, `/operator/support/${item.id}/replies`, reply)
        ).status(),
      ).toBe(410);
      await session(page, owner);
      const open = await intake(page, `${background} open withdrawal`);
      await expect(
        page.getByText("Open; no resolution recorded", { exact: true }),
      ).toBeVisible();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Withdraw request text" }).click();
      await expect(page.getByRole("status")).toContainText(
        "content-free receipt remains",
      );
      expect(await page.content()).not.toContain(open.subject);
      const bothWithdrawn = await exported(page);
      expect(bothWithdrawn.records.supportRequests).toHaveLength(2);
      expect(bothWithdrawn.records.supportRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: open.id,
            state: "withdrawn",
            body: null,
            resolvedAt: null,
          }),
          expect.objectContaining({
            id: item.id,
            state: "withdrawn",
            body: null,
            resolvedAt: expect.any(String),
          }),
        ]),
      );
      expect(bothWithdrawn.records.supportReplies).toEqual([]);
    });
});
test("[L110] all three audiences page bounded owner and exact-granted histories without exposing internal notes or mixing timelines", async ({
  page,
}) => {
  test.setTimeout(90000);
  for (const [background, goal] of audiences)
    await test.step(background, async () => {
      const owner = await onboard(page, background, goal),
        staff = await operators();
      const requests: { id: string; grant: string }[] = [];
      for (let index = 0; index < 21; index++) {
        const result = await support.create(owner, {
          idempotencyKey: randomUUID(),
          subject: `Synthetic ${background} page ${index}`,
          body: `Invented paged request ${index}`,
        });
        expect(result.kind).toBe("created");
        if (!("receipt" in result))
          throw new Error("Synthetic request fixture unavailable");
        requests.push({
          id: result.receipt.requestId,
          grant: await staff.grant(result.receipt.requestId),
        });
      }
      const oldest = requests[0]!,
        scope = { requestId: oldest.id, grantId: oldest.grant };
      for (let index = 0; index < 21; index++) {
        expect(
          (
            await support.reply(
              staff.operator,
              scope,
              randomUUID(),
              `Visible page reply ${index}`,
            )
          ).kind,
        ).toBe("applied");
        expect(
          (
            await support.note(
              staff.operator,
              scope,
              randomUUID(),
              `INTERNAL_PAGE_${background}_${index}`,
            )
          ).kind,
        ).toBe("applied");
      }
      await page.goto("/support");
      await expect(
        page
          .getByRole("list", { name: "Private support requests" })
          .locator(":scope > li"),
      ).toHaveCount(20);
      await page.getByRole("link", { name: "Next page", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page
          .getByRole("list", { name: "Private support requests" })
          .locator(":scope > li"),
      ).toHaveCount(1);
      await expect(
        page.getByRole("link", {
          name: `Synthetic ${background} page 0 · ${oldest.id}`,
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("link", {
          name: `Synthetic ${background} page 0 · ${oldest.id}`,
          exact: true,
        })
        .click();
      await expect(page.locator("[data-support-reply]")).toHaveCount(20);
      await expect(page.locator("[data-support-reply]").first()).toHaveText(
        "Visible page reply 20",
      );
      expect(await page.content()).not.toContain("INTERNAL_PAGE_");
      await page.getByRole("link", { name: "Next page", exact: true }).click();
      await expect(page.locator("[data-support-reply]")).toHaveCount(1);
      await expect(page.locator("[data-support-reply]")).toHaveText(
        "Visible page reply 0",
      );
      expect(await page.content()).not.toContain("INTERNAL_PAGE_");
      const ownerCursorURL = page.url();
      await session(page, staff.operator);
      expect(
        (await page.request.get(ownerCursorURL, { maxRedirects: 0 })).status(),
      ).toBe(303);
      await page.goto("/operator/support");
      await expect(
        page
          .getByRole("list", { name: "Granted support requests" })
          .locator(":scope > li"),
      ).toHaveCount(20);
      await page.getByRole("link", { name: "Next page", exact: true }).click();
      await expect(
        page
          .getByRole("list", { name: "Granted support requests" })
          .locator(":scope > li"),
      ).toHaveCount(1);
      await page
        .getByRole("link", {
          name: `Synthetic ${background} page 0 · ${oldest.id}`,
          exact: true,
        })
        .click();
      await expect(page.locator("[data-support-message]")).toHaveCount(20);
      await expect(page.locator("[data-support-message]").first()).toHaveText(
        `INTERNAL_PAGE_${background}_20`,
      );
      await page.getByRole("link", { name: "Next page", exact: true }).click();
      await expect(page.locator("[data-support-message]").first()).toHaveText(
        `INTERNAL_PAGE_${background}_10`,
      );
      await expect(page.locator("[data-support-message]")).toHaveCount(20);
      await page.getByRole("link", { name: "Next page", exact: true }).click();
      await expect(page.locator("[data-support-message]")).toHaveCount(2);
      await expect(page.locator("[data-support-message]").first()).toHaveText(
        `INTERNAL_PAGE_${background}_0`,
      );
      await expect(
        page.getByRole("link", { name: "Next page", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("link", { name: "Return to newest", exact: true })
        .click();
      await expect(page.locator("[data-support-message]")).toHaveCount(20);
      await expect(page.locator("[data-support-message]").first()).toHaveText(
        `INTERNAL_PAGE_${background}_20`,
      );
    });
});
