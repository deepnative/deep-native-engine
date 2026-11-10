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

// SUPCOV-01–03 (#195 AC3): a granted staff member records that a request is
// outside current support. The member sees it on their receipt with no
// booking, price, entitlement or completion promise, and the content-free
// administrator inbox shows it. Uses the #39 administrator-answer path for the
// grant. Administrator entry sets a protected staff cookie; keep no traces.
test.use({ trace: "off" });
const control = testPool();
let pool: Pool, name: string | undefined;
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
test.afterAll(async () => {
  await pool?.end();
  if (name) await dropAttendanceBrowserDatabase(control, name);
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
      secret: "invented-coverage-review-secret",
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

test("[L332] SUPCOV-01..03 staff mark a request outside current support without promising anything", async ({
  page,
  browser,
}) => {
  const f = await boot(page);
  const memberContext = await browser.newContext(),
    member = await memberContext.newPage();
  try {
    await f.join(member, "explorer");
    await member.goto(f.origin + "/support/new");
    await member
      .getByLabel("Subject (up to 120 characters)")
      .fill("Invented: please write my thesis");
    await member
      .getByLabel("Your sample request (up to 2,000 characters)")
      .fill("INVENTED-OUT-OF-SCOPE-REQUEST");
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
    await expect(member.locator("body")).not.toContainText(
      "Outside current support",
    );

    await f.verifyAdmin();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await page.goto(f.origin + "/operator/support-assignment/inbox");
    const item = page.locator(`[data-intake-request="${requestId}"]`);
    await item
      .getByLabel(
        `I will answer request ${requestId} myself until my administrator session ends.`,
      )
      .check();
    await item
      .getByRole("button", { name: "Answer this request myself" })
      .click();
    await page.getByRole("link", { name: "Open the request" }).click();

    // SUPCOV-01: a deliberate, confirmed action, offered only once.
    await page
      .getByLabel(
        "Record that this request is outside current support. This grants no entitlement, booking, price or completion promise, and the member sees it on their receipt.",
      )
      .check();
    await page
      .getByRole("button", { name: "Mark outside current support" })
      .click();
    await expect(page.locator("body")).toContainText(
      "Outside current support · recorded",
    );
    await expect(
      page.getByRole("button", { name: "Mark outside current support" }),
    ).toHaveCount(0);
    // It is not an acknowledgement or a resolution.
    await expect(
      page.getByRole("button", { name: "Acknowledge request" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resolve request" }),
    ).toBeVisible();

    // SUPCOV-02: the member sees the record, with no promise attached.
    await member.reload();
    await expect(member.locator("body")).toContainText(
      "Outside current support · recorded",
    );
    await expect(member.locator("body")).toContainText(
      "No booking, price, entitlement or completion is promised",
    );
    await expect(member.locator("body")).toContainText(
      "No separate acknowledgement recorded",
    );
    await expect(member.locator("body")).toContainText(
      "Open; no resolution recorded",
    );

    // SUPCOV-03: the inbox shows it as metadata only.
    await page.goto(f.origin + "/operator/support-assignment/inbox");
    await expect(item).toContainText("Outside current support · ");
    await expect(page.locator("body")).not.toContainText(
      "INVENTED-OUT-OF-SCOPE-REQUEST",
    );

    // The member can still withdraw the text; the record stays content-free.
    await member
      .getByLabel(
        "Withdraw this request and remove its subject, body and all associated messages. Keep a content-free receipt.",
      )
      .check();
    await member.getByRole("button", { name: "Withdraw request text" }).click();
    await expect(member.locator("body")).toContainText("Request withdrawn");
    await expect(member.locator("body")).toContainText(
      "Outside current support · recorded",
    );
  } finally {
    await memberContext.close();
    await closeLoopback(f.server);
  }
});
