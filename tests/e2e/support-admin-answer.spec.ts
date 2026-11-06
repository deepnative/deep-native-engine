import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { testPool } from "../support/database.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { supportAssignmentStore } from "../../src/support-assignment.ts";

// ADMSUP-01–04 (#39): on the hosted configuration an administrator who
// entered through their verified account answers a member's support request.
// Administrator entry sets a protected staff cookie; keep no network traces.
test.use({ trace: "off" });
const control = testPool();
let pool: Pool,
  name: string | undefined,
  failed = false;
// shi@deepnative.io holds the seeded admin role, so this file owns its database.
// Setup runs in beforeAll, outside the journey's own time budget.
test.beforeAll(async () => {
  name = "dne_test_" + randomBytes(16).toString("hex");
  await control.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  url.pathname = "/" + name;
  pool = new Pool({ connectionString: url.href });
  await migrate(pool);
});
test.afterEach(() => {
  if (test.info().status !== test.info().expectedStatus) failed = true;
});
test.afterAll(async () => {
  await pool?.end();
  // A failed case keeps its database for diagnosis.
  if (name && !failed) await dropAttendanceBrowserDatabase(control, name);
  await control.end();
});

async function boot(page: Page) {
  const members = store(pool);
  let origin = "http://127.0.0.1:0",
    link = "";
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "invented-admin-answer-secret",
      localStaffEntry: true,
      localSupportAssignment: true,
      memberEmail: memberEmailAccess(
        pool,
        {
          async send(_address, value) {
            link = value;
          },
        },
        origin,
      ),
      administratorEntry: administratorEntry(pool),
      staffEntry: staffEntryStore(pool),
      supportRequests: supportRequestStore(pool),
      supportAssignment: supportAssignmentStore(pool),
    }),
  );
  const bound = server.address();
  if (!bound || typeof bound === "string") throw Error("No owned listener");
  origin = `http://127.0.0.1:${bound.port}`;
  const join = async (target: Page, background: "explorer" | "technical") => {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background, goal: "everyday" });
    await target
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
  };
  await join(page, "technical");
  return {
    origin,
    server,
    join,
    async verifyAdmin() {
      await page.goto(origin + "/email/attach");
      await page.getByLabel("Email address").fill("shi@deepnative.io");
      await page
        .getByRole("button", { name: "Send verification link" })
        .click();
      await expect.poll(() => link).not.toBe("");
      await page.goto(link.replace("http://127.0.0.1:0", origin));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Email linked" }),
      ).toBeVisible();
    },
  };
}

test("[L300] ADMSUP-01..04 an administrator answers a member's support request themselves, then revokes it", async ({
  page,
  browser,
}) => {
  const f = await boot(page);
  const memberContext = await browser.newContext(),
    member = await memberContext.newPage();
  try {
    // A member sends a request through the ordinary form.
    await f.join(member, "explorer");
    await member.goto(f.origin + "/support/new");
    await member
      .getByLabel("Subject (up to 120 characters)")
      .fill("Invented: lesson will not open");
    await member
      .getByLabel("Your sample request (up to 2,000 characters)")
      .fill("INVENTED-MEMBER-REQUEST-TEXT");
    await member
      .getByLabel(
        "I used only invented or sample information and want to send this private request.",
      )
      .check();
    await member
      .getByRole("button", { name: "Send private sample request" })
      .click();
    await expect(
      member.getByRole("heading", { name: "Private support receipt" }),
    ).toBeVisible();
    const requestId = new URL(member.url()).pathname.split("/").at(-1)!;

    // The administrator enters through their verified account and finds it.
    await f.verifyAdmin();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    await page.goto(f.origin + "/staff");
    await page
      .getByRole("link", { name: "Support request assignments", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Open support intake inbox", exact: true })
      .click();
    const item = page.locator(`[data-intake-request="${requestId}"]`);
    await expect(page.locator("body")).not.toContainText(
      "INVENTED-MEMBER-REQUEST-TEXT",
    );
    await item
      .getByLabel(
        `I will answer request ${requestId} myself until my administrator session ends.`,
      )
      .check();
    await item
      .getByRole("button", { name: "Answer this request myself" })
      .click();
    await expect(
      page.getByRole("heading", { name: "You can answer this request" }),
    ).toBeVisible();
    const grantId = (
      await page.locator("[data-assignment-grant]").innerText()
    ).trim();

    // ADMSUP-02: note, acknowledge, reply and resolve.
    await page.getByRole("link", { name: "Open the request" }).click();
    await expect(page.locator("body")).toContainText(
      "INVENTED-MEMBER-REQUEST-TEXT",
    );
    await page
      .getByLabel("Internal note (up to 2,000 characters)")
      .fill("INVENTED-INTERNAL-NOTE");
    await page
      .getByLabel("Save this information as an internal staff-only note.")
      .check();
    await page.getByRole("button", { name: "Save internal note" }).click();
    await page
      .getByLabel("Record a separate acknowledgement of this request.")
      .check();
    await page.getByRole("button", { name: "Acknowledge request" }).click();
    await page
      .getByLabel("Member-visible reply (up to 2,000 characters)")
      .fill("Invented reply: try reloading the lesson.");
    await page.getByLabel("Send this reply to the member.").check();
    await page
      .getByRole("button", { name: "Send member-visible reply" })
      .click();
    await expect(page.locator("body")).toContainText(
      "Invented reply: try reloading the lesson.",
    );

    await member.goto(`${f.origin}/support/${requestId}`);
    await expect(member.locator("body")).toContainText(
      "Invented reply: try reloading the lesson.",
    );
    await expect(member.locator("body")).not.toContainText(
      "INVENTED-INTERNAL-NOTE",
    );
    await expect(member.locator("body")).toContainText("Acknowledged");

    // ADMSUP-04: revoking the grant refuses a fresh read; the member keeps it.
    await page.goto(
      `${f.origin}/operator/support-assignment/history?requestId=${requestId}`,
    );
    const grant = page.locator(`[data-grant="${grantId}"]`);
    await expect(grant).toContainText("platform_admin");
    await grant.getByLabel("I confirm revoking this exact grant only.").check();
    await grant.getByRole("button", { name: "Revoke this grant" }).click();
    await expect(
      page.getByRole("heading", { name: "Support assignment revoked" }),
    ).toBeVisible();
    const denied = await page.goto(
      `${f.origin}/operator/support/${requestId}?grant=${grantId}`,
    );
    expect(denied!.status()).toBe(403);
    await expect(page.locator("body")).not.toContainText(
      "INVENTED-MEMBER-REQUEST-TEXT",
    );
    await member.reload();
    await expect(member.locator("body")).toContainText(
      "Invented reply: try reloading the lesson.",
    );
  } finally {
    await memberContext.close();
    await closeLoopback(f.server);
  }
});
