import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import {
  test,
  expect,
  devices,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { coachingTermsStore } from "../../src/coaching-terms.ts";
import { availabilityStore } from "../../src/availability.ts";
import { catalogStore } from "../../src/catalog.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { dropAttendanceBrowserDatabase } from "../support/attendance-browser-database.ts";

// #823 owner decision of 11 Nov 2026: an administrator sets each student's
// session length and practice-conversation limit. Synthetic staff credentials
// stay out of traces; every person, amount and lesson is invented.
test.use({ trace: "off" });
async function fixture(browser: Browser, info: TestInfo) {
  const base = process.env.DNE_TEST_DATABASE_URL;
  if (!base || !/^\/dne_test_[a-f0-9]{32}$/.test(new URL(base).pathname))
    throw Error("Generated browser database required");
  const name = "dne_test_" + randomBytes(16).toString("hex"),
    marker = "limits823-" + randomBytes(16).toString("hex"),
    control = new Pool({ connectionString: base }),
    url = new URL(base);
  url.pathname = "/" + name;
  await control.query(`CREATE DATABASE "${name}"`);
  await control.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  const oid = (
    await control.query<{ oid: number }>(
      "SELECT oid FROM pg_database WHERE datname=$1",
      [name],
    )
  ).rows[0]!.oid;
  const pool = new Pool({ connectionString: url.href });
  await migrate(pool);
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(store(pool), {
      get origin() {
        return origin;
      },
      secret: "invented-session-limits-browser",
      mode: "test",
      localStaffEntry: true,
      staffEntry: staffEntryStore(pool),
      simpleInvoices: simpleInvoiceStore(pool, {
        sample: true,
        issuer: "Invented coaching issuer",
        instructions: "Sample only; do not pay.",
      }),
      coachingTerms: coachingTermsStore(pool),
      catalog: catalogStore(pool),
      practiceSessions: practiceSessionStore(pool),
      availability: availabilityStore(pool),
      memberSlotHolds: memberSlotHolds(pool),
    }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  origin = `http://127.0.0.1:${address.port}`;
  const contexts: Awaited<ReturnType<Browser["newContext"]>>[] = [];
  async function page() {
    const c = await browser.newContext(
      info.project.name === "mobile-chromium"
        ? devices["Pixel 7"]
        : devices["Desktop Chrome"],
    );
    contexts.push(c);
    return c.newPage();
  }
  await info.attach("session-limits-owned-resource", {
    body: JSON.stringify({ name, marker, oid, origin }),
    contentType: "application/json",
  });
  return {
    origin,
    page,
    /** One published invented lesson to practise against. */
    async lesson(id: string) {
      const auth = authorizationStore(pool),
        catalog = catalogStore(pool);
      const editor = randomBytes(32).toString("hex"),
        reviewer = randomBytes(32).toString("hex");
      const until = new Date(Date.now() + 3600000);
      await auth.provisionStaff(editor, "editor", until);
      await auth.provisionStaff(reviewer, "reviewer", until);
      expect(
        await catalog.createDraft(editor, {
          id,
          version: 1,
          kind: "lesson",
          origin: "curated",
          title: `Invented practice source ${id}`,
          body: "Use only invented details. Check every suggestion against this sample.",
          owner: "Invented editor",
          sources: "Original invented sample",
          rights: "Owned sample",
          goals: [],
          backgrounds: [],
          domains: [],
          prerequisites: "None",
          rubric: null,
          rubricVersion: null,
        }),
      ).toBe(true);
      expect(await catalog.submit(editor, id, 1)).toBe(true);
      expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
      expect(await catalog.publish(editor, id, 1)).toBe(true);
    },
    async admin() {
      const token = randomBytes(32).toString("hex");
      await authorizationStore(pool).provisionStaff(
        token,
        "platform_admin",
        new Date(Date.now() + 3600000),
      );
      const p = await page();
      await p.goto(origin + "/staff/sign-in");
      await p.getByLabel("Trusted local staff credential").fill(token);
      await p
        .getByRole("button", { name: "Sign in to staff tools", exact: true })
        .click();
      return p;
    },
    async close() {
      await Promise.all(contexts.map((c) => c.close()));
      await closeLoopback(server);
      await pool.end();
      try {
        const actual = (
          await control.query(
            "SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
            [name],
          )
        ).rows[0];
        expect(actual).toEqual({ oid, marker });
        await dropAttendanceBrowserDatabase(control, name);
      } finally {
        await control.end();
      }
    },
  };
}

async function startPractice(s: Page, origin: string, id: string) {
  await s.goto(`${origin}/library/${id}`);
  await s.getByRole("link", { name: "Try a private practice session" }).click();
  await expect(
    s.getByRole("heading", { name: "Start private practice session" }),
  ).toBeVisible();
}
async function respond(s: Page, response: string) {
  await s.getByLabel("Your next sample response").fill(response);
  await s
    .getByLabel(
      "I used only invented or sample information and want to save this response.",
    )
    .check();
  await s.getByRole("button", { name: "Save response and compare" }).click();
}

test("[L337] LIMITS823-01/02/06 an administrator sets a student's session length and practice-conversation limit; the student sees both, and a new conversation ends at their limit", async ({
  browser,
}, info) => {
  const f = await fixture(browser, info);
  try {
    await f.lesson("SYN-823");
    await f.lesson("SYN-824");
    // 1. The student registers; their reference is on My account.
    const s = await f.page();
    await s.goto(f.origin);
    await s.getByLabel("Display name").fill("Invented limits student");
    await s.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(s, "everyday");
    await s.getByRole("button", { name: "Start my learning path" }).click();
    await s.goto(f.origin + "/account");
    const id = await s.locator("code").first().innerText();

    // 2. With no terms, the student has the standard 60 minutes and 15 exchanges.
    await s.goto(f.origin + "/availability");
    await expect(
      s.getByText("A sample hold reserves 60 explicitly seeded test minutes", {
        exact: false,
      }),
    ).toBeVisible();
    await startPractice(s, f.origin, "SYN-823");
    await expect(
      s.getByText("up to 15 response/comparison pairs, or 30 visible turns", {
        exact: false,
      }),
    ).toBeVisible();

    // 3. The administrator's form starts from 60 and 15 and explains the bounds.
    const a = await f.admin();
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    const terms = a.getByRole("region", {
      name: "Coaching terms",
      exact: true,
    });
    await expect(a.getByLabel("Session length (minutes)")).toHaveValue("60");
    await expect(
      a.getByLabel("Practice conversation limit (exchanges)"),
    ).toHaveValue("15");
    await expect(terms).toContainText(
      "Session length is 15 to 60 minutes, because an expert's time slot is one hour. A practice conversation can have 1 to 50 exchanges.",
    );
    await a.getByLabel("Price (CAD)").fill("1200.00");
    await a.getByLabel("Start date").fill("2026-12-01");
    await a.getByLabel("End date").fill("2027-05-31");
    await a.getByLabel("Renewal date").fill("2027-06-01");
    await a.getByLabel("Expert review minutes").fill("0");
    await a.getByLabel("Coaching sessions").fill("6");
    await a.getByLabel("AI requests").fill("0");
    await a.getByLabel("Session length (minutes)").fill("45");
    await a.getByLabel("Practice conversation limit (exchanges)").fill("2");
    await a.getByRole("button", { name: "Save coaching terms" }).click();
    await expect(terms).toContainText("Current terms, version 1:");
    await expect(terms.locator("dl.coaching-terms")).toContainText(
      "Session length45 minutes",
    );
    await expect(terms.locator("dl.coaching-terms")).toContainText(
      "Practice conversation limit2 exchanges",
    );

    // 4. The student sees their own values on their coaching terms, on
    //    session availability and before starting a practice conversation.
    await s.goto(f.origin + "/account/coaching");
    // NEXTSTEP-04: the terms are folded below the hours form.
    await s.getByText("Coaching terms and agreed changes").click();
    const own = s.getByRole("region", {
      name: "Your coaching terms",
      exact: true,
    });
    await expect(own.locator("dl.coaching-terms")).toContainText(
      "Session length45 minutes",
    );
    await expect(own.locator("dl.coaching-terms")).toContainText(
      "Practice conversation limit2 exchanges",
    );
    await expect(own).toContainText(
      "a change applies to new holds and new conversations only.",
    );
    await s.goto(f.origin + "/availability");
    await expect(
      s.getByText("A sample hold reserves 45 explicitly seeded test minutes", {
        exact: false,
      }),
    ).toBeVisible();

    // 5. A new conversation ends at the student's two exchanges.
    await startPractice(s, f.origin, "SYN-823");
    await expect(
      s.getByText("up to 2 response/comparison pairs, or 4 visible turns", {
        exact: false,
      }),
    ).toBeVisible();
    await s.getByLabel("I want to start private sample practice").check();
    await s
      .getByRole("button", { name: "Start or return to private session" })
      .click();
    const first = s.url();
    await respond(s, "Invented response one.");
    await expect(
      s.getByText("1 of 2 saved pairs · 2 of 4 visible turns", {
        exact: false,
      }),
    ).toBeVisible();
    await respond(s, "Invented response two.");
    await expect(
      s.getByText(
        "Session complete: 2 pairs / 4 visible turns. This session cannot accept another response.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      s.getByRole("button", { name: "Save response and compare" }),
    ).toHaveCount(0);

    // 6. The administrator raises the limit; the finished conversation keeps
    //    its two exchanges and a new one gets three.
    await a.getByLabel("Practice conversation limit (exchanges)").fill("3");
    await a.getByRole("button", { name: "Save coaching terms" }).click();
    await expect(terms).toContainText("Current terms, version 2:");
    await s.goto(first);
    await expect(
      s.getByText("Session complete: 2 pairs / 4 visible turns.", {
        exact: false,
      }),
    ).toBeVisible();
    await startPractice(s, f.origin, "SYN-824");
    await expect(
      s.getByText("up to 3 response/comparison pairs, or 6 visible turns", {
        exact: false,
      }),
    ).toBeVisible();

    // 7. A value out of bounds is refused with the bounds, and nothing is saved.
    await a
      .getByLabel("Session length (minutes)")
      .evaluate((input: HTMLInputElement) => {
        input.removeAttribute("max");
        input.value = "90";
      });
    await a.getByRole("button", { name: "Save coaching terms" }).click();
    await expect(
      a.getByText(
        "session length (15 to 60 minutes) and practice-conversation limit (1 to 50 exchanges) are within their bounds.",
        { exact: false },
      ),
    ).toBeVisible();
    await a.goto(`${f.origin}/operator/coaching/${id}`);
    await expect(terms).toContainText("Current terms, version 2:");
    await expect(a.getByLabel("Session length (minutes)")).toHaveValue("45");
  } finally {
    await f.close();
  }
});
