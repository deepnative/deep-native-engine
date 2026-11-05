import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { administratorDiagnostics } from "../../src/administrator-diagnostics.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { migrate, store } from "../../src/store.ts";
import { supportAssignmentStore } from "../../src/support-assignment.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { testPool } from "../support/database.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const control = testPool();
test.afterAll(() => control.end());

test("[L295] WAITWORK-01/02/09 an administrator notices a waiting support request on the console", async ({
  page,
}) => {
  // A database of its own: the shared browser lane's data is never ours.
  const name = "dne_test_" + randomBytes(16).toString("hex");
  await control.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.href });
  await migrate(pool);
  const members = store(pool),
    secret = "invented-browser-work-waiting-secret",
    assignments = supportAssignmentStore(pool, secret),
    owner = randomBytes(32).toString("hex"),
    requester = randomBytes(32).toString("hex");
  let origin = "http://127.0.0.1:0",
    link = "";
  const email = memberEmailAccess(
    pool,
    {
      async send(_address, value) {
        link = value;
      },
    },
    origin,
  );
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret,
      localStaffEntry: true,
      memberEmail: email,
      administratorEntry: administratorEntry(pool),
      administratorDiagnostics: administratorDiagnostics(pool),
      staffEntry: staffEntryStore(pool),
      supportRequests: supportRequestStore(pool),
      supportAssignment: assignments,
      localSupportAssignment: true,
    }),
  );
  try {
    const bound = server.address();
    if (!bound || typeof bound === "string") throw Error("No owned listener");
    origin = `http://127.0.0.1:${bound.port}`;
    for (const token of [owner, requester])
      await members.create(token, { background: "explorer", goal: "everyday" });
    const created = await supportRequestStore(pool).create(requester, {
      idempotencyKey: randomUUID(),
      subject: "INVENTED-PRIVATE-SUBJECT",
      body: "INVENTED-PRIVATE-BODY",
    });
    if (!("receipt" in created)) throw Error("No invented support request");

    await page
      .context()
      .addCookies([{ name: "dne_preview", value: owner, url: origin }]);
    await page.goto(origin + "/email/attach");
    await page.getByLabel("Email address").fill("shi@deepnative.io");
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect.poll(() => link).not.toBe("");
    await page.goto(link.replace("http://127.0.0.1:0", origin));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.goto(origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();

    await page.goto(origin + "/operator");
    const card = page.locator("#work-waiting"),
      row = card.locator('[data-work-queue="support"]');
    await expect(
      card.getByRole("heading", { name: "Work waiting" }),
    ).toBeVisible();
    await expect(row.getByRole("cell").nth(0)).toHaveText("1");
    await expect(row.getByRole("cell").nth(1)).toHaveText("Under a minute");
    await expect(row).toContainText(
      "No support operator is set up on this site",
    );
    const console = await page.locator("main").innerText();
    expect(console).not.toContain("INVENTED-PRIVATE");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/work-waiting-${test.info().project.name}.png`,
      fullPage: true,
    });

    await row.getByRole("link", { name: "Support requests" }).click();
    await expect(page).toHaveURL(origin + "/operator/support-assignment/inbox");

    // Assigned through the store: hosted entry can't create an operator (#195).
    const staff = (await page.context().cookies()).find(
      (cookie) => cookie.name === "dne_staff",
    )!.value;
    const operator = await authorizationStore(pool).provisionStaff(
      randomBytes(32).toString("hex"),
      "operator",
      new Date(Date.now() + 3600000),
    );
    const granted = await assignments.assign(staff, {
      requestId: created.receipt.requestId,
      staffId: operator,
      idempotencyKey: randomUUID(),
      startsAt: new Date(Date.now() - 60000),
      expiresAt: new Date(Date.now() + 1800000),
    });
    expect(granted.kind).toBe("ready");

    await page.goto(origin + "/operator");
    await expect(row.getByRole("cell").nth(0)).toHaveText("0");
    await expect(row.getByRole("cell").nth(1)).toHaveText("—");
    await expect(row.getByRole("cell").nth(2)).toContainText("1 · oldest");
    await expect(row.getByRole("cell").nth(3)).toHaveText("1");
  } finally {
    await closeLoopback(server);
    await pool.end();
    await dropAttendanceBrowserDatabase(control, name);
  }
});
