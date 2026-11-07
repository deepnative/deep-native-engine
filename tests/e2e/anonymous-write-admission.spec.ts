import { test, expect, request as apiRequest } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  ANONYMOUS_WRITE_LIMITS,
  anonymousWriteAdmissionStore,
} from "../../src/anonymous-write-admission.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { store } from "../../src/store.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { chooseLearningGoal } from "../support/choose-learning-goal.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
// Desktop and mobile each fill and clear the visitor counts; one at a time, so
// clearing the counts can't change the other's result.
const JOURNEY_LOCK = 728_300;
test.afterAll(async () => {
  await pool.end();
});

test("[L300] ANON-01/07 a visitor past the signup allowance keeps their answers and starts after waiting", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock($1)", [JOURNEY_LOCK]);
  try {
    // A documentation-range address of its own, as the hosted ingress reports it.
    const address = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    const headers = { "X-Forwarded-For": address, Origin: baseURL! };
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": address });

    // Earlier starts from the same address use the whole allowance.
    for (let i = 0; i < ANONYMOUS_WRITE_LIMITS.signup.perVisitor; i++) {
      const earlier = await apiRequest.newContext({
        baseURL: baseURL!,
        extraHTTPHeaders: headers,
      });
      const form = await (await earlier.get("/")).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)![1]!;
      const started = await earlier.post("/start", {
        form: {
          csrf,
          display_name: `Earlier learner ${i}`,
          background: "explorer",
          goal: "everyday",
        },
        maxRedirects: 0,
      });
      expect(started.status()).toBe(303);
      await earlier.dispose();
    }

    await page.goto("/");
    await page.getByLabel("Display name").fill("Invented Learner");
    await page.getByLabel("Your starting point").selectOption("explorer");
    await chooseLearningGoal(page, "everyday");
    const submit = page.getByRole("button", { name: "Start my learning path" });
    const [refused] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/start")),
      submit.click(),
    ]);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toContainText(
      "Too many new accounts have been started from this network.",
    );
    await expect(page.getByLabel("Display name")).toHaveValue(
      "Invented Learner",
    );
    await expect(page.getByLabel("Your starting point")).toHaveValue(
      "explorer",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    // The window ends; the same page's form now starts normally.
    await lock.query(
      "DELETE FROM anonymous_write_windows WHERE kind='signup' AND subject<>'service'",
    );
    await submit.click();
    await expect(page).toHaveURL(/\/learn$/);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [JOURNEY_LOCK]);
    lock.release();
  }
});

test("[L307] OUTWARD-03/08 a visitor past the email-link allowance keeps the address and gets a link after waiting", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock($1)", [JOURNEY_LOCK]);
  // Email sign-in is only on where a sender is configured, so this journey runs
  // its own server with an invented sender. A small allowance keeps it short.
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(store(pool), {
      get origin() {
        return origin;
      },
      secret: "synthetic-browser-outward-secret",
      memberEmail: memberEmailAccess(
        pool,
        { send: async () => undefined },
        origin,
      ),
      memberPassword: memberPasswordAccess(pool),
      anonymousWrites: anonymousWriteAdmissionStore(
        pool,
        { secret: "synthetic-browser-outward-secret", publicOnly: false },
        {
          ...ANONYMOUS_WRITE_LIMITS,
          email_sign_in: { windowSeconds: 3600, perVisitor: 2, service: 100 },
        },
      ),
    }),
  );
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw Error("Loopback address unavailable");
  origin = `http://127.0.0.1:${bound.port}`;
  try {
    const address = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": address });
    const email = page.locator('form[action="/email/sign-in"] #email');
    const send = page.getByRole("button", { name: "Send sign-in link" });

    // Earlier requests from the same address use the whole allowance.
    for (const earlier of ["first", "second"]) {
      await page.goto(`${origin}/email/sign-in`);
      await email.fill(`${earlier}@example.invalid`);
      await send.click();
      await expect(
        page.getByRole("heading", { name: "Check your email" }),
      ).toBeVisible();
    }

    await page.goto(`${origin}/email/sign-in`);
    await email.fill("typed-kept@example.invalid");
    const [refused] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/email/sign-in"),
      ),
      send.click(),
    ]);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toContainText(
      "Too many email links have been requested from this network.",
    );
    await expect(email).toHaveValue("typed-kept@example.invalid");
    await expect(
      page.locator('form[action="/password/sign-in"]'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    // The window ends; the same page's form now gets the ordinary reply.
    await lock.query(
      "DELETE FROM anonymous_write_windows WHERE kind='email_sign_in'",
    );
    await send.click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
  } finally {
    await closeLoopback(server);
    await lock.query("SELECT pg_advisory_unlock($1)", [JOURNEY_LOCK]);
    lock.release();
  }
});

test("[L313] RECORD-01/05 a member past the new-record allowance keeps the typed milestone and saves it after waiting", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock($1)", [JOURNEY_LOCK]);
  // Its own server with a one-record allowance keeps this journey short.
  const secret = "synthetic-browser-record-secret";
  const members = store(pool);
  let origin = "http://127.0.0.1:0";
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret,
      anonymousWrites: anonymousWriteAdmissionStore(
        pool,
        { secret, publicOnly: false },
        {
          ...ANONYMOUS_WRITE_LIMITS,
          member_record: { windowSeconds: 3600, perVisitor: 1, service: 100 },
        },
      ),
    }),
  );
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw Error("Loopback address unavailable");
  origin = `http://127.0.0.1:${bound.port}`;
  try {
    const token = randomBytes(32).toString("hex");
    await members.create(token, { background: "explorer", goal: "everyday" });
    await page
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
    const address = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    await page.setExtraHTTPHeaders({
      "X-Forwarded-For": address,
      Origin: origin,
    });
    const form = page.locator('form[action="/milestones"]');
    const fill = async (marker: string) => {
      await form.locator('[name="goal_title"]').fill(`Invented goal ${marker}`);
      await form
        .locator('[name="milestone_title"]')
        .fill(`Invented milestone ${marker}`);
      await form
        .locator('[name="evidence_note"]')
        .fill(`Invented evidence ${marker}`);
      await form
        .locator('[name="next_action"]')
        .fill(`Invented next ${marker}`);
      await form.locator('[name="sample_only"]').check();
    };
    const save = form.getByRole("button", { name: "Save private milestone" });

    // The first new record from this address uses the whole allowance.
    await page.goto(`${origin}/milestones`);
    await fill("first");
    await save.click();
    await expect(page.getByText("Invented milestone first")).toBeVisible();

    await fill("kept");
    const [refused] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/milestones"),
      ),
      save.click(),
    ]);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toContainText(
      "Too many new records have been saved from this network.",
    );
    await expect(form.locator('[name="milestone_title"]')).toHaveValue(
      "Invented milestone kept",
    );
    expect(await members.milestones(token).then((rows) => rows?.length)).toBe(
      1,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    // The window ends; the same kept form now saves.
    await lock.query(
      "DELETE FROM anonymous_write_windows WHERE kind='member_record'",
    );
    await form.locator('[name="sample_only"]').check();
    await save.click();
    await expect(
      page.getByText("Invented milestone kept", { exact: true }),
    ).toBeVisible();
    expect(await members.milestones(token).then((rows) => rows?.length)).toBe(
      2,
    );
  } finally {
    await closeLoopback(server);
    await lock.query("SELECT pg_advisory_unlock($1)", [JOURNEY_LOCK]);
    lock.release();
  }
});
