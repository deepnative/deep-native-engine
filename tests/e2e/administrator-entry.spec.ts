import { catalogStore } from "../../src/catalog.ts";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { testPool } from "../support/database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
const pool = testPool();
let courseVersion = 0;
test.beforeAll(() => migrate(pool));
test.beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
test.afterAll(() => pool.end());
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
      staffEntry: staffEntryStore(pool),
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
        .getByRole("link", { name: "Administration", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Enter administration" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Enter administration" }).click();
      await expect(
        page.getByRole("heading", { name: "Course billing administration" }),
      ).toBeVisible();
      await page.getByLabel("Student account reference").selectOption(f.id);
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
      page.getByRole("heading", { name: "Course billing administration" }),
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
      page.getByRole("heading", { name: "Course billing administration" }),
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
      page.getByRole("heading", { name: "Course billing administration" }),
    ).toBeVisible();
  } finally {
    await closeLoopback(f.server);
  }
});
