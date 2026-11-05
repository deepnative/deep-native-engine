import { memberExportStore } from "../../src/member-export.ts";
import { billingProfileStore } from "../../src/billing-profile.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";
import { catalogStore } from "../../src/catalog.ts";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { testPool } from "../support/database.ts";
import { expectReadableAtNarrowWidth } from "../support/narrow-readability.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { migrate, store, hash } from "../../src/store.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { administratorDiagnostics } from "../../src/administrator-diagnostics.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { coachViewStore } from "../../src/coach-view.ts";
import { accountRoleAdmin } from "../../src/account-role-admin.ts";
const control = testPool();
let pool: Pool,
  resource: { name: string; oid: number; marker: string } | undefined;
let parent: { principals: number; content: number };
let courseVersion = 0;
const parentCounts = async () =>
  (
    await control.query<{ principals: number; content: number }>(
      "SELECT (SELECT count(*)::integer FROM principals) AS principals,(SELECT count(*)::integer FROM content_versions) AS content",
    )
  ).rows[0]!;
test.beforeEach(async () => {
  // Every case gets a fresh database; its first synthetic course starts at version1.
  courseVersion = 0;
  parent = await parentCounts();
  const name = "dne_test_" + randomBytes(16).toString("hex"),
    marker = "administrator-browser-565-" + randomBytes(16).toString("hex");
  await control.query(`CREATE DATABASE "${name}"`);
  await control.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  const oid = (
    await control.query<{ oid: number }>(
      "SELECT oid FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0]!.oid;
  resource = { name, oid, marker };
  const url = new URL(process.env.DNE_TEST_DATABASE_URL!);
  url.pathname = "/" + name;
  pool = new Pool({ connectionString: url.href });
  await migrate(pool);
  await test.info().attach("administrator-owned-database", {
    body: JSON.stringify(resource),
    contentType: "application/json",
  });
});
test.afterEach(async () => {
  await pool?.end();
  if (resource) {
    const actual = (
      await control.query<{ oid: number; marker: string }>(
        "SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
        [resource.name],
      )
    ).rows[0];
    expect(actual).toEqual({ oid: resource.oid, marker: resource.marker });
    if (test.info().status === test.info().expectedStatus)
      await dropAttendanceBrowserDatabase(control, resource.name);
    resource = undefined;
  }
  // The shared browser lane's identities and seeded curriculum are never ours to clear.
  expect(await parentCounts()).toEqual(parent);
});
test.afterAll(() => control.end());
async function fixture(
  page: Page,
  address = "shi@deepnative.io",
  background: "explorer" | "professional" | "technical" = "explorer",
  lostCommit = false,
) {
  const members = store(pool),
    token = randomBytes(32).toString("hex");
  await members.create(token, { background, goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("No invented member");
  await members.save(token, {
    revision: 0,
    instruction: "Invented retained learning draft",
    verification: "Check the sample",
    complete: false,
  });
  let origin = "http://127.0.0.1:0",
    link = "",
    commits = 0;
  const email = memberEmailAccess(
    pool,
    {
      async send(_address, value) {
        link = value;
      },
    },
    origin,
  );
  const fault = {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const r = await client.query(sql, args);
          if (sql === "COMMIT" && lostCommit) {
            lostCommit = false;
            commits++;
            throw Error("Invented lost acknowledgement");
          }
          return r;
        },
        release: (error?: Error) => client.release(error),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const actual = administratorEntry(pool);
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "invented-browser-admin-secret",
      localStaffEntry: true,
      memberEmail: email,
      administratorEntry: {
        ...actual,
        enter: (token) => administratorEntry(fault).enter(token),
      },
      administratorDiagnostics: administratorDiagnostics(pool),
      coachView: coachViewStore(pool),
      roleAdmin: accountRoleAdmin(pool),
      staffEntry: staffEntryStore(pool),
      billingProfiles: billingProfileStore(pool),
      memberExport: memberExportStore(pool),
      simpleInvoices: simpleInvoiceStore(pool, {
        sample: true,
        issuer: "Invented issuer",
        instructions: "Sample not payable",
      }),
    }),
  );
  const bound = server.address();
  if (!bound || typeof bound === "string") throw Error("No owned listener");
  origin = `http://127.0.0.1:${bound.port}`;
  await page
    .context()
    .addCookies([{ name: "dne_preview", value: token, url: origin }]);
  return {
    origin,
    token,
    id: session.learner.id,
    members,
    email,
    server,
    get emailLink() {
      return link;
    },
    get commits() {
      return commits;
    },
    async publishCourse() {
      const editor = randomBytes(32).toString("hex"),
        reviewer = randomBytes(32).toString("hex"),
        expiry = new Date(Date.now() + 3600000);
      const auth = authorizationStore(pool);
      await auth.provisionStaff(editor, "editor", expiry);
      await auth.provisionStaff(reviewer, "reviewer", expiry);
      const catalog = catalogStore(pool),
        version = ++courseVersion;
      const item = {
        id: "ADM-565",
        version,
        kind: "lesson" as const,
        origin: "curated" as const,
        title: "Invented owner-entry course",
        body: "Invented local course; compare a short sample checklist against its source.",
        owner: "Synthetic editor",
        sources: "Original invented text",
        rights: "Owned synthetic text",
        goals: [],
        backgrounds: [],
        domains: [],
        prerequisites: "None",
        rubric: null,
        rubricVersion: null,
      };
      expect(await catalog.createDraft(editor, item)).toBe(true);
      expect(await catalog.submit(editor, item.id, version)).toBe(true);
      expect(await catalog.approve(reviewer, item.id, version, true)).toBe(
        true,
      );
      expect(await catalog.publish(editor, item.id, version)).toBe(true);
    },
    async verify() {
      await page.goto(origin + "/email/attach");
      await page.getByLabel("Email address").fill(address);
      await page
        .getByRole("button", { name: "Send verification link" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Check your email" }),
      ).toBeVisible();
      await expect.poll(() => link).not.toBe("");
      await page.goto(link.replace("http://127.0.0.1:0", origin));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Email linked" }),
      ).toBeVisible();
    },
  };
}
test("[L269] both verified owner identities explicitly enter finite billing administration and retain learning", async ({
  page,
}) => {
  for (const [address, background] of [
    [" Shi@DeepNative.io ", "professional"],
    ["TOM@deepnative.io", "technical"],
  ] as const) {
    const f = await fixture(page, address, background);
    try {
      await f.verify();
      await f.publishCourse();
      expect((await page.goto(f.origin + "/operator/invoices"))?.status()).toBe(
        403,
      );
      await page.goto(f.origin + "/account");
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Administration", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Enter administration" }),
      ).toBeVisible();
      // ADMIN-LAYOUT-01: Enter and End share one row and line up (#639).
      const [enter, end] = await Promise.all(
        ["Enter administration", "End administration for this sign-in"].map(
          (name) => page.getByRole("button", { name }).boundingBox(),
        ),
      );
      // Same row (desktop) or a clean stack (narrow), never half offset.
      expect(
        Math.abs(enter!.y - end!.y) <= 1 || end!.y >= enter!.y + enter!.height,
      ).toBe(true);
      await page.getByRole("button", { name: "Enter administration" }).click();
      await expect(
        page.getByRole("heading", { name: "Administration console" }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Courses and invoices", exact: true })
        .click();
      await page.getByLabel("Learner", { exact: true }).selectOption(f.id);
      await page
        .getByRole("checkbox", { name: /Invented owner-entry course/ })
        .check();
      await page
        .getByLabel("Amount for Invented owner-entry course (CAD)", {
          exact: true,
        })
        .fill("1.00");
      await page
        .getByLabel("Starts on (UTC date)")
        .fill(new Date().toISOString().slice(0, 10));
      const [prepared] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url() === f.origin + "/operator/invoices/plans",
        ),
        page
          .getByRole("button", { name: "Prepare course billing proposal" })
          .click(),
      ]);
      expect(prepared.status()).toBe(303);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM simple_invoice_plans WHERE owner_id=$1",
            [f.id],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query("SELECT 1 FROM simple_invoices WHERE owner_id=$1", [
            f.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await page.context().cookies(f.origin)).find(
          (x) => x.name === "dne_preview",
        )?.value,
      ).toBe(f.token);
      await page.goto(f.origin + "/account");
      await expect(page.getByText(f.id, { exact: false })).toBeVisible();
      expect(await f.members.progress(f.id)).toMatchObject({
        instruction: "Invented retained learning draft",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await closeLoopback(f.server);
      await page.context().clearCookies();
    }
  }
});
test("[L270] unverified, unrelated, alias, lookalike and legacy credentials cannot enter or open direct billing", async ({
  page,
}) => {
  for (const address of [
    "shi@deepnative.io",
    "info@deepnative.io",
    "tom+alias@deepnative.io",
    "tom@deepnatlve.io",
  ]) {
    const f = await fixture(page, address);
    try {
      if (address !== "shi@deepnative.io") await f.verify();
      else {
        await page.goto(f.origin + "/email/attach");
        await page.getByLabel("Email address").fill(address);
        await page
          .getByRole("button", { name: "Send verification link" })
          .click();
        await expect(
          page.getByRole("heading", { name: "Check your email" }),
        ).toBeVisible();
      }
      expect((await page.goto(f.origin + "/admin"))?.status()).toBe(403);
      await expect(
        page.getByRole("heading", { name: "Administration unavailable" }),
      ).toBeVisible();
      expect((await page.goto(f.origin + "/operator/invoices"))?.status()).toBe(
        403,
      );
      if (address === "shi@deepnative.io") {
        const legacy = randomBytes(32).toString("hex");
        await authorizationStore(pool).provisionStaff(
          legacy,
          "platform_admin",
          new Date(Date.now() + 60000),
        );
        await page
          .context()
          .addCookies([{ name: "dne_staff", value: legacy, url: f.origin }]);
        expect(
          (await page.goto(f.origin + "/operator/invoices"))?.status(),
        ).toBe(403);
      }
    } finally {
      await closeLoopback(f.server);
      await page.context().clearCookies();
    }
  }
  expect(
    (await pool.query("SELECT 1 FROM administrator_sessions")).rowCount,
  ).toBe(0);
});
test("[L271] deliberate end and member signout revoke admin access while retaining the same learning account", async ({
  page,
  browser,
}) => {
  const f = await fixture(page);
  const other = await browser.newContext();
  try {
    await f.verify();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    const outsider = await other.newPage();
    expect(
      (await outsider.goto(f.origin + "/operator/invoices"))?.status(),
    ).toBe(403);
    await page.goto(f.origin + "/admin");
    await page
      .getByRole("button", { name: "End administration for this sign-in" })
      .click();
    expect((await page.goto(f.origin + "/operator/invoices"))?.status()).toBe(
      403,
    );
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    await page.goto(f.origin + "/account");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await page.goto(f.origin + "/operator/invoices"))?.status()).toBe(
      403,
    );
    expect(await f.members.progress(f.id)).toMatchObject({
      instruction: "Invented retained learning draft",
    });
  } finally {
    await other.close();
    await closeLoopback(f.server);
  }
});
test("[L272] lost entry acknowledgement returns no staff cookie and recovers only after deliberate ending", async ({
  page,
}) => {
  const f = await fixture(page, "shi@deepnative.io", "explorer", true);
  try {
    await f.verify();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration unavailable" }),
    ).toBeVisible();
    expect(f.commits).toBe(1);
    expect(
      (await page.context().cookies(f.origin)).some(
        (x) => x.name === "dne_staff",
      ),
    ).toBe(false);
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration unavailable" }),
    ).toBeVisible();
    expect(f.commits).toBe(1);
    await page.goto(f.origin + "/admin");
    await page
      .getByRole("button", { name: "End administration for this sign-in" })
      .click();
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
  } finally {
    await closeLoopback(f.server);
  }
});

test("[L277] ADMINCON01–04 selects an exact learner, composes existing terms and keeps private work isolated", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.verify();
    await f.publishCourse();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    await page.getByLabel("Search by name or account reference").fill(f.id);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .locator(".member-table tbody tr")
      .getByRole("link")
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Selected learner", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("console-selected.png"),
      fullPage: true,
    });
    await expect(
      page.getByText("Invented retained learning draft", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Compose courses for this learner" })
      .click();
    await expect(page.getByLabel("Learner", { exact: true })).toHaveValue(f.id);
    await page
      .getByRole("checkbox", { name: /Invented owner-entry course/ })
      .check();
    await page
      .getByLabel("Amount for Invented owner-entry course (CAD)", {
        exact: true,
      })
      .fill("12.00");
    await page
      .getByLabel("Starts on (UTC date)")
      .fill(new Date().toISOString().slice(0, 10));
    await page
      .getByRole("button", { name: "Prepare course billing proposal" })
      .click();
    expect(
      (await pool.query("SELECT owner_id,state FROM simple_invoice_plans"))
        .rows,
    ).toEqual([{ owner_id: f.id, state: "offered" }]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM simple_invoices"))
        .rows[0].n,
    ).toBe(0);
    await page.goto(f.origin + "/admin");
    await page
      .getByRole("button", { name: "End administration for this sign-in" })
      .click();
    expect(
      (await page.goto(f.origin + "/operator?ownerId=" + f.id))?.status(),
    ).toBe(403);
    expect(await f.members.progress(f.id)).toMatchObject({
      instruction: "Invented retained learning draft",
    });
  } finally {
    await closeLoopback(f.server);
  }
});

test("[L280] BILLPROFILE01–04 saves a private billing recipient, resumes the same proposal after email recovery and preserves invoice history", async ({
  page,
}) => {
  const f = await fixture(page, "tom@deepnative.io", "professional");
  try {
    await f.verify();
    await f.publishCourse();
    await page.goto(f.origin + "/account");
    await page
      .getByRole("link", { name: "Billing recipient", exact: true })
      .click();
    await page
      .getByLabel("Invoice recipient name")
      .fill("Invented original recipient");
    await page
      .getByLabel("Invoice email", { exact: true })
      .fill("billing@example.invalid");
    await page.getByRole("button", { name: "Save billing recipient" }).click();
    await expect(page.locator('input[name="revision"]')).toHaveValue("1");
    await page.waitForLoadState("load");
    await page.reload();
    await expect(page.getByLabel("Invoice email", { exact: true })).toHaveValue(
      "billing@example.invalid",
    );
    await page.goto(f.origin + "/account/coaching");
    await expect(page.getByLabel("Invoice recipient name")).toHaveValue(
      "Invented original recipient",
    );
    await page.goto(f.origin + "/admin");
    await page
      .getByRole("button", { name: "Enter administration", exact: true })
      .click();
    const staff = (await page.context().cookies(f.origin)).find(
      (c) => c.name === "dne_staff",
    )!.value;
    const invoices = simpleInvoiceStore(pool, {
      sample: true,
      issuer: "Invented issuer",
      instructions: "Sample not payable",
    });
    const p = await invoices.propose(staff, {
      ownerId: f.id,
      operationId: crypto.randomUUID(),
      courses: [{ id: "ADM-565", version: 1, amountCents: 1200 }],
      cadence: "monthly",
      startsOn: new Date().toISOString().slice(0, 10),
      taxCents: 0,
    });
    if (p.kind !== "ready") throw Error("Missing proposal");
    await page.goto(f.origin + "/account");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.goto(f.origin + "/courses/proposals/" + p.value.planId);
    await expect(
      page.getByRole("heading", { name: "Return to your course proposal" }),
    ).toBeVisible();
    const priorLink = f.emailLink;
    await page
      .getByRole("link", { name: "Email sign-in", exact: true })
      .click();
    await page.getByLabel("Email address").fill("tom@deepnative.io");
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => f.emailLink).not.toBe(priorLink);
    await page.goto(f.emailLink.replace("http://127.0.0.1:0", f.origin));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(
      f.origin + "/account/purchases#plan-" + p.value.planId,
    );
    await expect(page.getByLabel("Invoice recipient name")).toHaveValue(
      "Invented original recipient",
    );
    await page
      .getByRole("checkbox", { name: /I accept these exact courses/ })
      .check();
    await page
      .getByRole("button", { name: "Accept courses and create invoice" })
      .click();
    await expect(
      page.getByText("SAMPLE · NOT PAYABLE", { exact: true }),
    ).toBeVisible();
    const invoiceUrl = page.url();
    await page.goto(f.origin + "/account/billing");
    await page
      .getByLabel("Invoice recipient name")
      .fill("Invented changed recipient");
    await page.getByRole("button", { name: "Save billing recipient" }).click();
    await page.goto(invoiceUrl);
    await expect(
      page.getByText("Invented original recipient", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Invented changed recipient", { exact: true }),
    ).toHaveCount(0);
    await page.goto(f.origin + "/account/purchases");
    await page.getByRole("checkbox", { name: /Stop future invoices/ }).check();
    await page.getByRole("button", { name: "Cancel future billing" }).click();
    await expect(
      page.getByText("SAMPLE · NOT PAYABLE · cancelled", { exact: true }),
    ).toBeVisible();
    expect(await f.members.progress(f.id)).toMatchObject({
      instruction: "Invented retained learning draft",
    });
    await page.goto(f.origin + "/account/billing");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("billing-profile.png"),
      fullPage: true,
    });
  } finally {
    await closeLoopback(f.server);
  }
});

test("[L287] ADMINTABLE-01..05 an administrator pages and searches 60 learners and keeps the selection", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const members = store(pool);
    await pool.query(
      "UPDATE learners SET display_name='Zed Owner' WHERE id=$1",
      [f.id],
    );
    for (let index = 1; index <= 59; index++) {
      const token = randomBytes(32).toString("hex");
      await members.create(token, { background: "technical", goal: "build" });
      const session = await members.session(token);
      if (session.kind !== "active") throw Error("No invented learner");
      await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
        session.learner.id,
        `Invented learner ${String(index).padStart(2, "0")}`,
      ]);
      if (index === 1)
        await pool.query(
          `INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision,submitted_revision)
           VALUES($1,'2026-10',10320,'Invented','invented@example.test','submitted',1,1)`,
          [session.learner.id],
        );
    }
    await f.verify();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    const table = page.locator(".member-table");
    const rows = table.locator("tbody tr");
    const pager = page.getByRole("navigation", { name: "Learner pages" });
    await expect(rows).toHaveCount(25);
    await expect(page.getByText("Showing 1–25 of 60")).toBeVisible();
    await expect(rows.first()).toContainText("Invented learner 01");
    // CONSOLECOACH-01: the latest saved month, its hours and state.
    await expect(rows.first().locator(".member-coaching")).toHaveText(
      "October 2026172h · Awaiting review",
    );
    await expect(rows.nth(1).locator(".member-coaching")).toHaveText("—");
    await expect(pager.getByRole("link", { name: "Next" })).toBeVisible();
    await expect(pager.getByRole("link", { name: "Previous" })).toHaveCount(0);
    const fits = async () => {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const control of await page
        .locator(
          ".member-table a, .member-pager a, .portal-search input:not([type=hidden]), .portal-search button",
        )
        .all())
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
          40,
        );
    };
    await fits();
    await page.screenshot({
      path: test.info().outputPath("learner-table.png"),
      fullPage: true,
    });

    await pager.getByRole("link", { name: "Next" }).click();
    await expect(page.getByText("Showing 26–50 of 60")).toBeVisible();
    await page.getByRole("link", { name: "Invented learner 30" }).click();
    // CONSOLECOACH-02: choosing a learner brings their summary into view.
    await expect(
      page.getByRole("heading", { name: "Selected learner", exact: true }),
    ).toBeInViewport();
    await expect(page.locator(".portal-summary")).toContainText(
      "Invented learner 30",
    );
    await expect(page.getByText("Showing 26–50 of 60")).toBeVisible();
    await expect(
      rows.filter({ hasText: "Invented learner 30" }),
    ).toHaveAttribute("aria-current", "true");

    await pager.getByRole("link", { name: "Next" }).click();
    await expect(page.getByText("Showing 51–60 of 60")).toBeVisible();
    await expect(page.locator(".portal-summary")).toContainText(
      "Invented learner 30",
    );
    await expect(pager.getByRole("link", { name: "Next" })).toHaveCount(0);
    await expect(rows.last()).toContainText("Zed Owner");

    await page
      .getByLabel("Search by name or account reference")
      .fill("LEARNER 1");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("Showing 1–10 of 10")).toBeVisible();
    await expect(rows).toHaveCount(10);
    await expect(table).not.toContainText("Invented learner 20");
    await fits();
    await page.getByRole("link", { name: "Clear search" }).click();
    await expect(page.getByText("Showing 1–25 of 60")).toBeVisible();
    await expect(table).not.toContainText("Invented retained learning draft");
    await expect(table).not.toContainText("shi@deepnative.io");
  } finally {
    await closeLoopback(f.server);
  }
});
test("[L288] DIAG-01..03 an administrator checks an email's account and link history from Diagnostics", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.verify();
    await page.goto(f.origin + "/admin");
    // READABLE-04: on a wide screen the intro uses the page width.
    if (page.viewportSize()!.width >= 1000)
      expect(
        await page
          .locator(".portal-intro > p")
          .first()
          .evaluate(
            (paragraph) =>
              paragraph.getBoundingClientRect().height /
              parseFloat(getComputedStyle(paragraph).lineHeight),
          ),
      ).toBeLessThan(2.5);
    await page.screenshot({
      path: `artifacts/administration-intro-${test.info().project.name}.png`,
    });
    await page.getByRole("button", { name: "Enter administration" }).click();
    // FRICTION-11: staff tools link to the administration console.
    await page.goto(f.origin + "/staff");
    await page.getByRole("link", { name: "Administration console" }).click();
    await page.getByRole("link", { name: "Diagnostics", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Diagnostics", level: 1 }),
    ).toBeVisible();
    const site = page.locator(".diagnostics-table").last();
    await expect(
      site.getByRole("row", { name: "Accounts 1", exact: true }),
    ).toContainText("1");
    await expect(
      site.getByRole("row", { name: "Verified emails 1", exact: true }),
    ).toContainText("1");
    const lookup = async (address: string) => {
      await page.getByLabel("Email address").fill(address);
      await page.getByRole("button", { name: "Look up" }).click();
      await expect(
        page.getByRole("heading", { name: address, level: 2 }),
      ).toBeVisible();
      // The address is posted, never placed in the page URL.
      expect(page.url()).toBe(f.origin + "/operator/diagnostics/email");
    };
    await lookup("shi@deepnative.io");
    await expect(
      page.getByRole("row", { name: /^Verified email (?!s)/ }),
    ).toContainText(f.id);
    await expect(
      page.getByText(/Link-an-email link · .* UTC · used/),
    ).toBeVisible();
    await lookup("nobody@example.test");
    await expect(
      page.getByRole("row", { name: /^Verified email (?!s)/ }),
    ).toContainText("No account uses this address");
    await expect(
      page.getByText("No links were created for this address."),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("diagnostics.png"),
      fullPage: true,
    });
    // DIAG-03: the lookup wrote nothing.
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM member_email_links"))
        .rows[0].n,
    ).toBe(1);
  } finally {
    await closeLoopback(f.server);
  }
});
test("[L290] ROLES-01..05 each account type lands on its own view and an owner switches views without gaining authority", async ({
  page,
}) => {
  const header = () =>
    page.getByRole("navigation", { name: "Main navigation" });
  const fits = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  const signInAgain = async (
    f: Awaited<ReturnType<typeof fixture>>,
    address: string,
  ) => {
    await page.goto(f.origin + "/account/sign-out");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.goto(f.origin + "/email/sign-in");
    await page.getByLabel("Email address").fill(address);
    const before = f.emailLink;
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect.poll(() => f.emailLink).not.toBe(before);
    await page.goto(f.emailLink.replace("http://127.0.0.1:0", f.origin));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  };
  const owner = await fixture(page);
  try {
    await owner.verify();
    await pool.query(
      "UPDATE learners SET display_name='Invented Coachee' WHERE id=$1",
      [owner.id],
    );
    await pool.query(
      `INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision,submitted_revision)
       VALUES($1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),90,'Invented Coachee','shi@deepnative.io','submitted',1,1)`,
      [owner.id],
    );
    // #684/#689: a coach sees only assigned learners; Shi is a default coach.
    // ROLES-02: an owner without a saved view lands on Administration.
    await signInAgain(owner, "shi@deepnative.io");
    await expect(page).toHaveURL(owner.origin + "/admin");
    await expect(
      header().getByRole("link", { name: "Administration", exact: true }),
    ).toBeVisible();
    for (const view of ["student", "coach"])
      await expect(
        header().getByRole("button", { name: `Switch to ${view} view` }),
      ).toBeVisible();
    await fits();

    // ROLES-03: the coach view lists saved hours, never billing.
    await header()
      .getByRole("button", { name: "Switch to coach view" })
      .click();
    await expect(page).toHaveURL(owner.origin + "/coach");
    await expect(
      page.getByRole("heading", { name: "Coaching", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: "Invented Coachee 1h 30m Submitted" }),
    ).toBeVisible();
    await expect(page.getByText(/CAD|\$/)).toHaveCount(0);
    await expect(
      header().getByRole("link", { name: "Coaching", exact: true }),
    ).toBeVisible();
    await expect(
      header().getByRole("link", { name: "Administration", exact: true }),
    ).toHaveCount(0);
    await fits();
    await page.screenshot({
      path: test.info().outputPath("coach-view.png"),
      fullPage: true,
    });

    // ROLES-05: the admin view grants nothing until Enter administration.
    await header()
      .getByRole("button", { name: "Switch to admin view" })
      .click();
    await expect(page).toHaveURL(owner.origin + "/admin");
    expect((await page.request.get(owner.origin + "/operator")).status()).toBe(
      403,
    );
    await page.getByRole("button", { name: "Enter administration" }).click();
    await expect(
      page.getByRole("heading", { name: "Administration console" }),
    ).toBeVisible();
    // Switching to the student view keeps the administrator session.
    await header()
      .getByRole("button", { name: "Switch to student view" })
      .click();
    await expect(page).toHaveURL(owner.origin + "/learn");
    await expect(
      header().getByRole("link", {
        name: "Monthly coaching hours",
        exact: true,
      }),
    ).toBeVisible();
    expect((await page.request.get(owner.origin + "/operator")).status()).toBe(
      200,
    );
    // ROLES-03: the chosen view is remembered on the next sign-in.
    await signInAgain(owner, "shi@deepnative.io");
    await expect(page).toHaveURL(owner.origin + "/learn");
  } finally {
    await closeLoopback(owner.server);
  }

  // ROLES-01/04: a student sees student links only and cannot take a view.
  const student = await fixture(page, "member@example.test");
  try {
    await student.verify();
    await signInAgain(student, "member@example.test");
    await expect(page).toHaveURL(student.origin + "/learn");
    await page.goto(student.origin + "/account");
    await expect(
      header().getByRole("link", { name: "Monthly coaching hours" }),
    ).toBeVisible();
    await expect(
      header().getByRole("button", { name: /^Switch to/ }),
    ).toHaveCount(0);
    await expect(
      header().getByRole("link", { name: "Administration" }),
    ).toHaveCount(0);
    const coach = await page.goto(student.origin + "/coach");
    expect(coach?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Coaching is for coaches" }),
    ).toBeVisible();
    await fits();
  } finally {
    await closeLoopback(student.server);
  }
});
test("[L292] ROLEADMIN/COACHLINK/DEFCOACH an administrator grants a coach role, sets a learner's coaches and removes the role", async ({
  page,
  browser,
}) => {
  const fits = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  // Cookies ignore ports, so the future coach gets their own browser context.
  const coachContext = await browser.newContext();
  const coachPage = await coachContext.newPage();
  const coach = await fixture(coachPage, "coach@example.test");
  const owner = await fixture(page);
  try {
    await coach.verify();
    await owner.verify();
    await pool.query(
      "UPDATE learners SET display_name=CASE id WHEN $1 THEN 'Invented Coach' ELSE 'Invented Owner' END WHERE id=ANY($2::uuid[])",
      [coach.id, [coach.id, owner.id]],
    );
    const ada = randomBytes(32).toString("hex");
    await owner.members.create(ada, {
      background: "explorer",
      goal: "everyday",
    });
    const adaSession = await owner.members.session(ada);
    if (adaSession.kind !== "active") throw Error("No invented learner");
    const adaId = adaSession.learner.id;
    await pool.query(
      "UPDATE learners SET display_name='Invented Ada' WHERE id=$1",
      [adaId],
    );
    await pool.query(
      `INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision)
       VALUES($1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),90,'Invented Ada','ada@example.test','draft',1)`,
      [adaId],
    );

    // ROLEADMIN-01/04: the Roles page lists holders; the owner's own admin role stays.
    await page.goto(owner.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    await page.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Roles", level: 1 }),
    ).toBeVisible();
    const ownRow = page.getByRole("row", { name: /Invented Owner/ });
    await expect(ownRow.getByText("(you)")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Remove admin role from Invented Owner",
      }),
    ).toHaveCount(0);
    await fits();

    // ROLEADMIN-02: grant the coach role to a typed, verified email.
    await page.getByLabel("Verified email").fill(" Coach@Example.test ");
    await page.getByLabel("Coach", { exact: true }).check();
    await page.getByRole("button", { name: "Give role" }).click();
    await expect(page).toHaveURL(owner.origin + "/operator/roles");
    await expect(
      page.getByRole("button", {
        name: "Remove coach role from Invented Coach",
      }),
    ).toBeVisible();
    // #696 ROLE-LABEL-01: Tom has not signed up here, so his row shows a hint.
    await expect(
      page.getByRole("row", { name: /to…@deepnative\.io · not signed up yet/ }),
    ).toBeVisible();
    // #659: at phone width each Remove button stays one whole word.
    const roomy = page.viewportSize()!;
    await page.setViewportSize({ width: 375, height: 812 });
    await expectReadableAtNarrowWidth(page, "/operator/roles");
    await page.setViewportSize(roomy);
    await page.screenshot({
      path: test.info().outputPath("roles.png"),
      fullPage: true,
    });

    // DEFCOACH-03/04: Ada starts with the default coaches; move her to the new coach.
    await page.goto(`${owner.origin}/operator?ownerId=${adaId}`);
    const coaches = page.getByRole("group", {
      name: "Coaches for this learner",
    });
    await expect(coaches.getByLabel("Invented Owner")).toBeChecked();
    await expect(coaches.getByLabel("Invented Coach")).not.toBeChecked();
    // ROLE-LABEL-02: the unlinked default coach carries the same hint.
    await expect(
      coaches.getByLabel("to…@deepnative.io (not signed up yet)"),
    ).toBeChecked();
    await coaches.getByLabel("Invented Owner").uncheck();
    await coaches.getByLabel("Invented Coach").check();
    await page.getByRole("button", { name: "Save coaches" }).click();
    await expect(page).toHaveURL(
      `${owner.origin}/operator?ownerId=${adaId}#learner-coach`,
    );
    await expect(coaches.getByLabel("Invented Coach")).toBeChecked();
    await expect(coaches.getByLabel("Invented Owner")).not.toBeChecked();
    await fits();

    // COACHLINK-02: the coach sees Ada; the owner, no longer her coach, sees nobody.
    await coachPage.goto(coach.origin + "/coach");
    await expect(
      coachPage.getByRole("row", { name: "Invented Ada 1h 30m Draft" }),
    ).toBeVisible();
    await page.goto(owner.origin + "/coach");
    await expect(
      page.getByText("No coaching hours saved for this month."),
    ).toBeVisible();

    // ROLEADMIN-03 / COACHLINK-03: removing the role ends the coach's access.
    await page.goto(owner.origin + "/operator/roles");
    await page
      .getByRole("button", { name: "Remove coach role from Invented Coach" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Remove coach role from Invented Coach",
      }),
    ).toHaveCount(0);
    expect((await coachPage.goto(coach.origin + "/coach"))?.status()).toBe(403);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM coach_assignments WHERE coach_email_hash=$1",
          [hash("coach@example.test")],
        )
      ).rowCount,
    ).toBe(0);
    // ROLEADMIN-05 / COACHLINK-04: every change is audited.
    expect(
      (
        await pool.query<{ action: string }>(
          "SELECT action FROM account_role_events ORDER BY id",
        )
      ).rows.map((r) => r.action),
    ).toEqual(["granted", "cleared", "assigned", "removed"]);
  } finally {
    await closeLoopback(owner.server);
    await closeLoopback(coach.server);
    await coachContext.close();
  }
});
test("[L282] required names identify learners while legacy work and administrator boundaries stay intact", async ({
  page,
  browser,
}) => {
  const f = await fixture(page);
  const other = await browser.newContext();
  try {
    await page.goto(f.origin + "/account");
    await expect(
      page.getByRole("link", { name: "Add your display name" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Display name", { exact: true }),
    ).toHaveAttribute("required", "");
    await page.getByLabel("Display name", { exact: true }).fill("李明 <Sam>");
    await page
      .getByRole("button", { name: "Save my profile", exact: true })
      .click();
    await expect(page).toHaveURL(/\/learn$/);
    await page.goto(f.origin + "/account");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "李明 <Sam>",
    );
    await expect(
      page.getByRole("link", { name: "Add your display name" }),
    ).toHaveCount(0);
    const retained = await f.members.progress(f.id);
    expect(retained?.instruction).toBe("Invented retained learning draft");
    const fresh = await other.newPage();
    await fresh.goto(f.origin + "/");
    await fresh.getByLabel("Your starting point").selectOption("professional");
    await fresh
      .getByRole("radio", { name: "Make everyday work clearer", exact: true })
      .check();
    await fresh.getByRole("button", { name: "Start my learning path" }).click();
    await expect(fresh).not.toHaveURL(/\/learn$/);
    await expect(
      fresh.getByLabel("Display name", { exact: true }),
    ).toBeFocused();
    await fresh.getByLabel("Display name", { exact: true }).fill("李明 <Sam>");
    await fresh.getByRole("button", { name: "Start my learning path" }).click();
    await expect(fresh).toHaveURL(/\/learn$/);
    const exported = await fresh.request.get(f.origin + "/api/member/export");
    expect(exported.status()).toBe(200);
    expect((await exported.json()).profile.displayName).toBe("李明 <Sam>");
    expect((await fresh.goto(f.origin + "/operator"))?.status()).toBe(403);
    const legacy = randomBytes(32).toString("hex");
    await f.members.create(legacy, { background: "technical", goal: "build" });
    await f.verify();
    await page.goto(f.origin + "/admin");
    await page.getByRole("button", { name: "Enter administration" }).click();
    const directory = page.locator(".member-table");
    await expect(
      directory.getByRole("link", { name: "李明 <Sam>", exact: true }),
    ).toHaveCount(2);
    await expect(
      directory.getByRole("link", { name: "Name needed", exact: true }),
    ).toBeVisible();
    await expect(directory).not.toContainText(
      "Invented retained learning draft",
    );
    await expect(directory).not.toContainText("shi@deepnative.io");
    await expect(directory.locator("code").first()).toHaveText(
      /^[a-f0-9-]{36}$/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("named-learner-directory.png"),
      fullPage: true,
    });
  } finally {
    await other.close();
    await closeLoopback(f.server);
  }
});
