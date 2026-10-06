import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { test, expect, type Page, type Browser } from "@playwright/test";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { supportAssignmentStore } from "../../src/support-assignment.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback } from "../support/loopback-server.ts";
const pool = testPool();
test.beforeAll(() => migrate(pool));
test.afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
async function fixture() {
  const members = store(pool),
    auth = authorizationStore(pool),
    support = supportRequestStore(pool);
  const owner = fresh(),
    admin = fresh(),
    operator = fresh(),
    reviewer = fresh();
  const expires = new Date(Date.now() + 3600000);
  await members.create(owner, { background: "professional", goal: "work" });
  const member = await members.session(owner);
  if (member.kind !== "active") throw Error("Missing invented member");
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires),
    staffId = await auth.provisionStaff(operator, "operator", expires);
  await auth.provisionStaff(reviewer, "reviewer", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "Invented private boundary request",
    body: "Invented private boundary content",
  });
  if (!("receipt" in created)) throw Error("Missing invented receipt");
  return {
    members,
    auth,
    support,
    owner,
    admin,
    operator,
    reviewer,
    adminId,
    staffId,
    expires,
    requestId: created.receipt.requestId,
  };
}
async function preview(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { enabled?: boolean; mode?: "test" | "live"; backend?: Pool } = {},
) {
  const server = createServer((req, res) => application(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing isolated listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const application = app(f.members, {
    origin,
    secret: "invented-boundary-preview",
    mode: options.mode ?? "test",
    localStaffEntry: true,
    localSupportAssignment: options.enabled ?? true,
    staffEntry: staffEntryStore(pool),
    supportAssignment: supportAssignmentStore(
      options.backend ?? pool,
      "invented-boundary-cursor",
    ),
    supportRequests: f.support,
  });
  return { origin, server };
}
async function context(browser: Browser, origin: string) {
  const device = test.info().project.use;
  return browser.newContext({
    baseURL: origin,
    viewport: device.viewport,
    userAgent: device.userAgent,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  });
}
async function signin(page: Page, token: string) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(token);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools" }),
  ).toBeVisible();
}
test("[L177] SUPADM-05-BOUNDARIES SUPADM-08-READS-ROLLBACK actual staff roles, explicit identity and disabled/live administration deny safely", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const f = await fixture();
  const local = await preview(f);
  const c = await context(browser, local.origin);
  const page = await c.newPage();
  try {
    await signin(page, f.reviewer);
    expect((await page.goto("/operator/support-assignment"))!.status()).toBe(
      403,
    );
    expect((await page.goto("/operator/assignment-id"))!.status()).toBe(403);
    await signin(page, f.operator);
    await page
      .getByRole("link", { name: "My local assignment ID", exact: true })
      .click();
    await expect(page.locator("[data-assignment-id]")).toHaveText(f.staffId);
    expect((await page.goto("/operator/support-assignment"))!.status()).toBe(
      403,
    );
    await signin(page, f.admin);
    await page
      .getByRole("link", { name: "Support request assignments", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Check exact references" }),
    ).toBeVisible();
    await page.getByLabel("Exact request receipt ID").fill(f.requestId);
    await page.getByLabel("Exact operator assignment ID").fill(f.adminId);
    await page.getByRole("button", { name: "Check exact references" }).click();
    await expect(
      page.getByRole("heading", { name: "Support assignment unavailable" }),
    ).toBeVisible();
    await c.clearCookies();
    await c.addCookies([
      { name: "dne_preview", value: f.admin, url: local.origin },
    ]);
    expect((await page.goto("/operator/support-assignment"))!.status()).toBe(
      403,
    );
    await signin(page, f.admin);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.adminId],
    );
    expect((await page.goto("/operator/support-assignment"))!.status()).toBe(
      403,
    );
    for (const options of [{ enabled: false }, { mode: "live" as const }]) {
      const denied = await preview(f, options);
      try {
        expect(
          (await page.goto(
            denied.origin + "/operator/support-assignment",
          ))!.status(),
        ).toBe(404);
        await expect(
          page.getByRole("heading", { name: "Support assignment unavailable" }),
        ).toBeVisible();
      } finally {
        await closeLoopback(denied.server);
      }
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM support_request_grants WHERE request_id=$1",
          [f.requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    // Rollback hides only the administration UI, not existing exact access.
    const retained = await fixture();
    const grant = await retained.support.grant(retained.admin, {
      requestId: retained.requestId,
      staffId: retained.staffId,
      role: "operator",
      idempotencyKey: randomUUID(),
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(+retained.expires - 1000),
    });
    if (!("grantId" in grant)) throw Error("Missing retained grant");
    const rollback = await preview(retained, { enabled: false });
    const retainedContext = await context(browser, rollback.origin);
    const retainedPage = await retainedContext.newPage();
    const privateRoot = await realpath(
      await mkdtemp(join(tmpdir(), "dne477-cli-")),
    );
    try {
      await retainedContext.addCookies([
        { name: "dne_preview", value: retained.owner, url: rollback.origin },
      ]);
      expect(
        (await retainedPage.goto(`/support/${retained.requestId}`))!.status(),
      ).toBe(200);
      await signin(retainedPage, retained.operator);
      const exact = `/operator/support/${retained.requestId}?grant=${grant.grantId}`;
      expect((await retainedPage.goto(exact))!.status()).toBe(200);
      expect(
        (await retainedPage.goto("/operator/support-assignment"))!.status(),
      ).toBe(404);
      const inputs = join(privateRoot, "support-admin");
      await mkdir(inputs, { mode: 0o700 });
      await writeFile(
        join(inputs, "admin.json"),
        JSON.stringify({ token: retained.admin }),
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(
        join(inputs, "revoke.json"),
        JSON.stringify({ grantId: grant.grantId }),
        { mode: 0o600, flag: "wx" },
      );
      const command = await promisify(execFile)(
        process.execPath,
        ["src/support-admin-main.ts", "revoke", "revoke.json"],
        {
          env: {
            ...process.env,
            DNE_DATABASE_URL: process.env.DNE_TEST_DATABASE_URL,
            DNE_APP_MODE: "test",
            DNE_PRIVATE_STORAGE_ROOT: privateRoot,
            DNE_LOCAL_SUPPORT_ASSIGNMENT: "disabled",
          },
          timeout: 15000,
        },
      );
      expect(JSON.parse(command.stdout)).toEqual({
        status: "complete",
        action: "revoke",
      });
      expect(command.stderr).toBe("");
      expect((await retainedPage.goto(exact))!.status()).toBe(403);
      await retainedPage.goto("/staff");
      await retainedPage
        .getByRole("button", { name: "Sign out of staff tools", exact: true })
        .click();
      expect(
        (await retainedPage.goto(`/support/${retained.requestId}`))!.status(),
      ).toBe(200);
    } finally {
      await retainedContext.close();
      await closeLoopback(rollback.server);
      await rm(privateRoot, { recursive: true, force: true });
    }
  } finally {
    await c.close();
    await closeLoopback(local.server);
  }
});
test("[L178] SUPADM-07-RECOVERY SUPADM-08-READS-ROLLBACK recovers an actual committed assignment by original key and browses bounded historical pages without mutations", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const f = await fixture();
  let loseNextCommit = false,
    lostReplies = 0;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && loseNextCommit) {
            loseNextCommit = false;
            lostReplies++;
            throw Error("Invented lost COMMIT reply");
          }
          return result;
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  const local = await preview(f, { backend: wrapped });
  const c = await context(browser, local.origin);
  const page = await c.newPage();
  try {
    await signin(page, f.admin);
    await page
      .getByRole("link", { name: "Support request assignments", exact: true })
      .click();
    await page.getByLabel("Exact request receipt ID").fill(f.requestId);
    await page.getByLabel("Exact operator assignment ID").fill(f.staffId);
    await page.getByRole("button", { name: "Check exact references" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm support assignment" }),
    ).toBeVisible();
    const key = await page.locator('input[name="idempotencyKey"]').inputValue();
    const start = new Date(Date.now() - 60000).toISOString(),
      end = new Date(+f.expires - 1000).toISOString();
    await page.getByLabel("Starts at (UTC)").fill(start);
    await page.getByLabel("Expires at (UTC)").fill(end);
    await page
      .getByLabel(
        "I confirm this exact request, operator and finite UTC window.",
      )
      .check();
    loseNextCommit = true;
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/assign") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Assign this request", exact: true })
      .click();
    expect((await response).status()).toBe(503);
    expect(lostReplies).toBe(1);
    await expect(
      page.getByRole("heading", { name: "Support assignment unavailable" }),
    ).toBeVisible();
    await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(key);
    await expect(page.getByLabel("Starts at (UTC)")).toHaveValue(start);
    await expect(page.getByLabel("Starts at (UTC)")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(
      page.getByLabel(
        "I confirm this exact request, operator and finite UTC window.",
      ),
    ).not.toBeChecked();
    const committed = (
      await pool.query(
        "SELECT id FROM support_request_grants WHERE request_id=$1 AND idempotency_key=$2",
        [f.requestId, key],
      )
    ).rows;
    expect(committed).toHaveLength(1);
    await page
      .getByRole("link", {
        name: "Inspect saved assignment state",
        exact: true,
      })
      .click();
    await expect(page.locator("[data-grant]")).toHaveCount(1);
    await expect(page.locator("[data-grant]")).toHaveAttribute(
      "data-grant",
      committed[0].id,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM support_request_events WHERE request_id=$1 AND action='grant-created'",
          [f.requestId],
        )
      ).rows[0].n,
    ).toBe(1);
    // Historical rows are invented fixtures, not claimed browser-created grants.
    const expectedIds = new Set<string>([committed[0].id]);
    for (let n = 0; n < 104; n++) {
      const id = randomUUID();
      expectedIds.add(id);
      const state = n % 4;
      const starts =
        state === 0
          ? new Date(Date.now() + 60000)
          : new Date(Date.now() - 120000);
      const ends =
        state === 1
          ? new Date(Date.now() - 60000)
          : new Date(+f.expires - 1000);
      await pool.query(
        "INSERT INTO support_request_grants(id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          f.requestId,
          f.staffId,
          state === 3 ? "platform_admin" : "operator",
          starts,
          ends,
          f.adminId,
          randomUUID(),
          state === 2 ? new Date() : null,
        ],
      );
    }
    const eventCount = (
      await pool.query(
        "SELECT count(*)::int n FROM support_request_events WHERE request_id=$1",
        [f.requestId],
      )
    ).rows[0].n;
    await page.goto("/operator/support-assignment");
    await page.getByLabel("Request receipt ID to inspect").fill(f.requestId);
    await page
      .getByRole("button", {
        name: "Inspect saved assignment state",
        exact: true,
      })
      .click();
    const seen: string[] = [];
    const states = new Set<string>();
    let pages = 0;
    for (;;) {
      await expect(
        page.getByRole("heading", { name: "Support assignment history" }),
      ).toBeVisible();
      const grants = page.locator("[data-grant]");
      expect(await grants.count()).toBeLessThanOrEqual(20);
      seen.push(
        ...(await grants.evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-grant")!),
        )),
      );
      pages++;
      const text = await page.locator("main").innerText();
      for (const state of await grants.evaluateAll((nodes) =>
        nodes.map((node) => {
          const term = [...node.querySelectorAll("dt")].find(
            (item) => item.textContent === "Observed state",
          );
          return term?.nextElementSibling?.textContent ?? "";
        }),
      ))
        states.add(state);
      expect(text).not.toContain("Invented private boundary content");
      expect(text).not.toContain(f.admin);
      expect(text).not.toContain(f.operator);
      const next = page.getByRole("link", {
        name: "Next assignments",
        exact: true,
      });
      if ((await next.count()) === 0) break;
      expect(pages).toBeLessThan(7);
      await next.click();
    }
    expect(pages).toBe(6);
    expect(seen).toHaveLength(105);
    expect(new Set(seen)).toEqual(expectedIds);
    expect(states).toEqual(
      new Set(["scheduled", "expired", "revoked", "ineffective", "current"]),
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM support_request_events WHERE request_id=$1",
          [f.requestId],
        )
      ).rows[0].n,
    ).toBe(eventCount);
  } finally {
    await c.close();
    await closeLoopback(local.server);
  }
});
