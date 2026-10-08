import {
  test,
  expect,
  devices,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { studyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
test.use({ trace: "off" });
async function confirm(page: Page, kind: string) {
  const checkbox = page.getByRole("checkbox", {
    name: `I explicitly confirm this exact ${kind} instruction.`,
    exact: true,
  });
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("button", { name: `Confirm ${kind}`, exact: true })
    .click();
}
test("[L200] TESTISSUE-06/08 all audiences deliberately inspect and recover original request, issue and withdrawal after rollback or a successful COMMIT lost reply", async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const original = process.env.DNE_TEST_DATABASE_URL;
  if (
    !original ||
    !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(original).pathname)
  )
    throw Error("Expected generated private browser database");
  const ownUrl = new URL(original),
    adminUrl = new URL(original),
    name = `dne_test_${randomBytes(16).toString("hex")}`;
  ownUrl.pathname = `/${name}`;
  adminUrl.pathname = "/postgres";
  const pool = new Pool({ connectionString: ownUrl.href }),
    control = new Pool({ connectionString: adminUrl.href });
  const contexts: BrowserContext[] = [];
  let created = false,
    server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
  let armed: "request" | "issue" | "withdraw" | null = null,
    boundary: "before" | "after" = "after",
    interrupted = 0;
  const faulty = {
    connect: async () => {
      const client = await pool.connect();
      let writing: typeof armed = null;
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values: unknown[] = []) => {
              if (
                sql.startsWith("INSERT INTO browser_study_fixture_operations")
              )
                writing = values[4] as typeof armed;
              const interrupt =
                sql === "COMMIT" && armed !== null && writing === armed;
              if (interrupt) {
                armed = null;
                interrupted++;
                if (boundary === "before")
                  throw Error("Invented interruption before commit");
              }
              const result = await target.query(sql, values);
              if (interrupt && boundary === "after")
                throw Error(
                  "Invented lost acknowledgement after successful commit",
                );
              return result;
            };
          const entry = Reflect.get(target, property);
          return typeof entry === "function" ? entry.bind(target) : entry;
        },
      });
    },
  } as unknown as Pool;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    const healthy = studyUnitFixtureStore(pool, {
        mode: "test",
        enabled: true,
      }),
      uncertain = studyUnitFixtureStore(faulty, {
        mode: "test",
        enabled: true,
      });
    const options: Parameters<typeof app>[1] = {
      origin: "http://127.0.0.1",
      secret: "invented-study-fixture-recovery",
      mode: "test",
      localStaffEntry: true,
      localTestUnitIssuance: true,
      staffEntry: staffEntryStore(pool),
      studyUnitFixtures: {
        ...healthy,
        request: uncertain.request,
        issue: uncertain.issue,
        withdraw: uncertain.withdraw,
      },
    };
    server = await listenLoopback(app(store(pool), options));
    options.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const device =
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"];
    const staffContext = await browser.newContext(device);
    contexts.push(staffContext);
    const staff = await staffContext.newPage(),
      credential = randomBytes(32).toString("hex");
    const administratorId = await authorizationStore(pool).provisionStaff(
      credential,
      "platform_admin",
      new Date(Date.now() + 3600000),
    );
    await staff.goto(options.origin + "/staff/sign-in");
    await staff.getByLabel("Trusted local staff credential").fill(credential);
    await staff
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    async function recover(page: Page, kind: "request" | "issue" | "withdraw") {
      const originalKey = await page.locator('input[name="key"]').inputValue();
      const before = interrupted;
      armed = kind;
      await confirm(page, kind);
      await expect(
        page.getByRole("heading", {
          name: "Local test fixture unavailable",
          exact: true,
        }),
      ).toBeVisible();
      expect(interrupted).toBe(before + 1);
      expect(await page.locator('input[name="key"]').inputValue()).toBe(
        originalKey,
      );
      await page
        .getByRole("button", {
          name: "Inspect original operation",
          exact: true,
        })
        .click();
      // Read-only inspection never executes the original instruction.
      expect(interrupted).toBe(before + 1);
      if (boundary === "before") {
        await expect(
          page.getByRole("heading", {
            name: "Original operation has no saved receipt",
            exact: true,
          }),
        ).toBeVisible();
        expect(await page.locator('input[name="key"]').inputValue()).toBe(
          originalKey,
        );
        await confirm(page, kind);
      }
      await expect(
        page.getByRole("heading", {
          name: "Saved local test fixture",
          exact: true,
        }),
      ).toBeVisible();
      const row = (
        await pool.query(
          "SELECT request_id FROM browser_study_fixture_operations WHERE operation_id=$1",
          [originalKey],
        )
      ).rows;
      expect(row).toHaveLength(1);
      return row[0].request_id as string;
    }
    for (const [background, goal] of [
      ["explorer", "everyday"],
      ["professional", "work"],
      ["technical", "build"],
    ] as const) {
      for (const injected of ["before", "after"] as const) {
        boundary = injected;
        const context = await browser.newContext(device);
        contexts.push(context);
        const page = await context.newPage();
        await page.goto(options.origin);
        await page.getByLabel("Your starting point").selectOption(background);
        await page.getByLabel("What would you like to do?").selectOption(goal);
        await page
          .getByLabel("I'll use invented or sample information")
          .check();
        await page
          .getByRole("button", { name: "Start my learning path", exact: true })
          .click();
        await page.goto(options.origin + "/member/test-unit-request");
        await page.getByLabel("Administrator reference").fill(administratorId);
        await page
          .getByRole("button", { name: "Review request", exact: true })
          .click();
        const requestId = await recover(page, "request");
        await staff.goto(options.origin + "/operator/study-test-units");
        await staff
          .getByLabel("Member-supplied request reference")
          .fill(requestId);
        await staff
          .getByRole("button", { name: "Review exact request", exact: true })
          .click();
        expect(await recover(staff, "issue")).toBe(requestId);
        const originalWindow = (
          await pool.query(
            "SELECT grant_expires_at FROM browser_study_fixture_requests WHERE id=$1",
            [requestId],
          )
        ).rows[0].grant_expires_at;
        await page.goto(options.origin + "/member/test-unit-request");
        await page
          .getByRole("button", {
            name: "Review fixture withdrawal",
            exact: true,
          })
          .click();
        expect(await recover(page, "withdraw")).toBe(requestId);
        await page.reload();
        await expect(
          page
            .locator("dt")
            .filter({ hasText: /^State$/ })
            .locator("+ dd"),
        ).toHaveText("withdrawn");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const facts = await pool.query(
          "SELECT r.grant_expires_at,g.quantity,g.available,g.reserved,g.consumed,g.expired FROM browser_study_fixture_requests r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id WHERE r.id=$1",
          [requestId],
        );
        expect(facts.rows).toEqual([
          {
            grant_expires_at: originalWindow,
            quantity: 3,
            available: 0,
            reserved: 0,
            consumed: 0,
            expired: 3,
          },
        ]);
        const events = await pool.query(
          "SELECT operation,quantity FROM synthetic_entitlement_events WHERE grant_id=(SELECT grant_id FROM browser_study_fixture_requests WHERE id=$1) ORDER BY operation",
          [requestId],
        );
        expect(events.rows).toEqual([
          { operation: "expire", quantity: 3 },
          { operation: "grant", quantity: 3 },
        ]);
      }
    }
    expect(interrupted).toBe(18);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM browser_study_fixture_requests",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM synthetic_entitlement_grants",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
  } finally {
    for (const context of contexts) await context.close();
    if (server) await closeLoopback(server);
    await pool.end();
    if (created) {
      expect(
        (
          await control.query(
            "SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=$1",
            [name],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      await control.query(`DROP DATABASE "${name}"`);
    }
    await control.end();
  }
});
