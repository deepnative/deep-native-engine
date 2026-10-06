import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { testPool } from "../support/database.ts";
import { store } from "../../src/store.ts";
import { authorizationStore, STAFF_ROLES } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import { app } from "../../src/app.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  ledger = syntheticLedger(pool),
  origin = process.env.DNE_STAFF_BROWSER_ORIGIN ?? "http://127.0.0.1:4317";
test.afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
async function signin(page: Page, credential: string) {
  await page.goto("/staff/sign-in");
  await expect(
    page.getByLabel("Trusted local staff credential"),
  ).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Trusted local staff credential")).toHaveValue(
    "",
  );
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(page).toHaveURL(origin + "/staff");
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries())
  test(`[L${169 + index}] STAFF-01-COEXIST STAFF-02-SUPPORT STAFF-02-REVIEW STAFF-04-SIGNOUT ${background} uses granted staff work beside retained learner progress`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60000);
    const ids: string[] = [],
      logs: string[] = [];
    page.on("console", (m) => logs.push(m.text()));
    const foreignContext = await browser.newContext({ baseURL: origin }),
      foreignPage = await foreignContext.newPage();
    const admin = fresh(),
      operator = fresh(),
      reviewer = fresh(),
      foreign = fresh(),
      expires = new Date(Date.now() + 3600000),
      starts = new Date(Date.now() - 60000);
    try {
      await page.goto("/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page.getByLabel("I'll use invented or sample information").check();
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      await page.getByRole("link", { name: "Open lesson" }).click();
      await page
        .getByLabel("Your instruction to AI")
        .fill(
          "Use the invented details to make a short plan and flag any gaps.",
        );
      await page
        .getByLabel("How will you check the result?")
        .fill(
          "Check every action against the invented source and remove unsupported claims.",
        );
      await page.getByLabel("I checked the context").check();
      await page.getByRole("button", { name: "Complete exercise" }).click();
      await page.getByRole("link", { name: "See your progress" }).click();
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      const learnerCookie = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!;
      const owner = learnerCookie.value;
      const member = await members.session(owner);
      if (member.kind !== "active") throw Error("Missing invented owner");
      ids.push(member.learner.id);
      const adminId = await auth.provisionStaff(
          admin,
          "platform_admin",
          expires,
        ),
        staffId = await auth.provisionStaff(operator, "operator", expires),
        reviewerId = await auth.provisionStaff(reviewer, "reviewer", expires),
        foreignId = await auth.provisionStaff(foreign, "operator", expires);
      ids.push(staffId, reviewerId, foreignId, adminId);
      const created = await support.create(owner, {
        idempotencyKey: randomUUID(),
        subject: "Invented staff-entry request",
        body: "An invented team asks about its sample plan.",
      });
      if (!("receipt" in created)) throw Error("Missing request");
      const requestId = created.receipt.requestId;
      const granted = await support.grant(admin, {
        requestId,
        staffId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: starts,
        expiresAt: expires,
      });
      if (!("grantId" in granted)) throw Error("Missing request grant");
      await ledger.grant(
        member.learner.id,
        "support_minutes",
        20,
        randomUUID(),
        { startsAt: starts.toISOString(), expiresAt: expires.toISOString() },
      );
      const allocation = await support.time!.allocate(
        owner,
        requestId,
        randomUUID(),
        20,
      );
      if (!("receipt" in allocation)) throw Error("Missing allocation");
      const timeGrant = await support.time!.grant(admin, {
        requestId,
        allocationId: allocation.receipt.allocationId,
        staffId,
        role: "operator",
        idempotencyKey: randomUUID(),
        startsAt: starts,
        expiresAt: expires,
      });
      if (!("grantId" in timeGrant)) throw Error("Missing effort grant");
      const counts = async () =>
        (
          await pool.query(
            "SELECT (SELECT count(*)::int FROM support_time_events WHERE allocation_id=$1 AND action NOT IN ('detail-read','worklist-read')) events,(SELECT count(*)::int FROM support_time_allocations WHERE id=$1) allocations,(SELECT count(*)::int FROM support_time_entries WHERE allocation_id=$1) entries",
            [allocation.receipt.allocationId],
          )
        ).rows;
      const before = await counts();
      await signin(page, operator);
      await expect(
        page.getByText("Current role: Local operator.", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", {
          name: "Your granted support requests",
          exact: true,
        })
        .click();
      await page
        .getByRole("link", {
          name: `Invented staff-entry request · ${requestId}`,
          exact: true,
        })
        .click();
      await expect(
        page.getByText("An invented team asks about its sample plan.", {
          exact: true,
        }),
      ).toBeVisible();
      const detail = page.url();
      await page
        .getByRole("link", {
          name: `Open separately authorized test effort receipt · ${allocation.receipt.allocationId}`,
          exact: true,
        })
        .click();
      await expect(
        page.getByText("State: allocated", { exact: false }),
      ).toBeVisible();
      expect(await counts()).toEqual(before);
      await page.goto(detail);
      await page
        .getByLabel("Internal note (up to 2,000 characters)")
        .fill("Invented staff-only note");
      await page
        .getByLabel(
          "Save this invented information as an internal staff-only note.",
        )
        .check();
      await page
        .getByRole("button", { name: "Save internal note", exact: true })
        .click();
      await expect(
        page.locator('[data-support-message="internal-note"]'),
      ).toHaveText("Invented staff-only note");
      await page.goto(`/support/${requestId}`);
      await expect(
        page.getByText("Invented staff-only note", { exact: true }),
      ).toHaveCount(0);
      await signin(foreignPage, foreign);
      expect((await foreignPage.goto(detail))!.status()).toBe(403);
      await page.goto("/learn");
      await page.reload();
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      await page.goto("/evidence");
      const name = `Staff entry invented sample ${randomUUID()}`;
      await page.getByLabel("Sample title").fill(name);
      await page
        .getByLabel("Invented text sample")
        .fill("An invented team checks claims against the supplied source.");
      await page.getByLabel("I created this invented sample").check();
      await page.getByLabel("I explicitly allow this sample").check();
      await page
        .getByRole("button", { name: "Save private text sample" })
        .click();
      const source = (
        await pool.query<{ id: string }>(
          "SELECT id FROM evidence_objects WHERE original_name=$1 AND owner_principal_id=$2",
          [name, member.learner.id],
        )
      ).rows[0]!;
      const evidence = evidenceStore(
        pool,
        fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
        "staff-browser-test",
      );
      expect(await evidence.transitionQuarantine(source.id, "clean")).toBe(
        true,
      );
      await page.reload();
      await page
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await page
        .getByRole("button", { name: "Queue for local review consideration" })
        .click();
      const submission = (
        await pool.query(
          "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
          [source.id],
        )
      ).rows[0].id as string;
      const assignment = await auth.grantAssignment(
        adminId,
        reviewerId,
        member.learner.id,
        "reviewer",
        "Invented sample entry",
        expires,
      );
      const exact = await auth.grantEvidenceReview(
        adminId,
        reviewerId,
        assignment,
        submission,
        "private_sample_feedback_v1",
        expires,
      );
      const reviewPath = `/review/evidence/${source.id}/feedback`;
      await pool.query(
        "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
        [foreignId],
      );
      await signin(foreignPage, foreign);
      expect((await foreignPage.goto("/REVIEW/worklist/"))!.status()).toBe(200);
      await expect(
        foreignPage.getByRole("link", { name, exact: true }),
      ).toHaveCount(0);
      expect((await foreignPage.goto(reviewPath))!.status()).toBe(403);
      await page.goto("/staff");
      await page
        .getByRole("button", { name: "Sign out of staff tools" })
        .click();
      expect((await page.goto("/operator/support"))!.status()).toBe(403);
      expect(
        (await page.context().cookies()).find((c) => c.name === COOKIE)?.value,
      ).toBe(owner);
      await signin(page, reviewer);
      await page
        .getByRole("link", {
          name: "Your sample feedback worklist",
          exact: true,
        })
        .click();
      await page.getByRole("link", { name, exact: true }).click();
      await page
        .getByLabel("Criterion 1 label", { exact: true })
        .fill("Source checks");
      await page
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill("Explain how the sample claim was checked.");
      await page
        .getByLabel("Criterion 1 exact source quote", { exact: true })
        .fill("An invented");
      await page
        .getByRole("button", { name: "Save private feedback draft" })
        .click();
      await expect(
        page.getByText("Your private feedback draft", { exact: false }).first(),
      ).toBeVisible();
      await auth.revokeEvidenceReview(adminId, exact);
      expect((await page.goto(reviewPath))!.status()).toBe(403);
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [reviewerId],
      );
      expect((await page.goto("/staff"))!.status()).toBe(403);
      await page.goto("/staff/sign-in");
      await page
        .getByRole("button", { name: "Sign out of staff tools" })
        .click();
      await signin(page, operator);
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [staffId],
      );
      expect((await page.goto("/staff"))!.status()).toBe(403);
      expect((await page.goto(detail))!.status()).toBe(403);
      await page.goto("/staff/sign-in");
      await page
        .getByRole("button", { name: "Sign out of staff tools" })
        .click();
      await page.goto("/learn");
      await page.reload();
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "1");
      await page.goto("/member/export");
      await expect(
        page.getByRole("heading", {
          name: "Download private preview records",
          exact: true,
        }),
      ).toBeVisible();
      const storage = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }));
      for (const value of [operator, reviewer, foreign]) {
        expect(page.url()).not.toContain(value);
        expect(JSON.stringify(storage)).not.toContain(value);
        expect(logs.join(" ")).not.toContain(value);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await foreignContext.close();
      for (const id of ids)
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
test("[L172] STAFF-01-ROLES STAFF-03-CREDENTIAL six roles have truthful tools and credential admission never creates a learner", async ({
  page,
}) => {
  const ids: string[] = [];
  const count = async () =>
    (await pool.query("SELECT count(*)::int n FROM learners")).rows[0]
      .n as number;
  const before = await count();
  try {
    await page.goto("/staff/sign-in");
    expect(
      (await page.context().cookies()).some((c) => c.name === COOKIE),
    ).toBe(false);
    for (const role of STAFF_ROLES) {
      const credential = fresh();
      ids.push(
        await auth.provisionStaff(
          credential,
          role,
          new Date(Date.now() + 60000),
        ),
      );
      await signin(page, credential);
      if (role === "coach")
        await expect(
          page.getByText("No browser tools are available", { exact: false }),
        ).toBeVisible();
      if (role === "editor" || role === "reviewer")
        await expect(
          page.getByRole("link", { name: "Content workflow", exact: true }),
        ).toBeVisible();
      else
        await expect(
          page.getByRole("link", { name: "Content workflow", exact: true }),
        ).toHaveCount(0);
      if (role !== "operator")
        await expect(
          page.getByRole("link", {
            name: "Your assigned local request holds",
            exact: true,
          }),
        ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Sign out of staff tools" })
        .click();
      expect((await page.goto("/EDITOR/library/"))!.status()).toBe(403);
    }
    await page.goto("/staff/sign-in");
    await page.getByLabel("Trusted local staff credential").fill(fresh());
    await page
      .getByRole("button", { name: "Sign in to staff tools", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Staff access unavailable",
        exact: true,
      }),
    ).toBeVisible();
    expect(await count()).toBe(before);
  } finally {
    await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [ids]);
  }
});
test("[L173] STAFF-05-INTEGRITY STAFF-05-OFF forged forms preserve staff access and disabled/live entry is unavailable", async ({
  page,
  browser,
}) => {
  const credential = fresh(),
    id = await auth.provisionStaff(
      credential,
      "operator",
      new Date(Date.now() + 60000),
    );
  try {
    await signin(page, credential);
    const before = (await page.context().cookies()).find(
      (c) => c.name === "dne_staff",
    )!;
    const csrf = await page.locator('input[name="csrf"]').inputValue();
    for (const [source, value] of [
      ["https://forged.invalid", csrf],
      [origin, "forged"],
    ]) {
      const r = await page.request.post("/staff/sign-out", {
        headers: { Origin: source! },
        form: { csrf: value! },
      });
      expect(r.status()).toBe(403);
      expect(
        (await page.context().cookies()).find((c) => c.name === "dne_staff")
          ?.value,
      ).toBe(before.value);
    }
    expect((await page.goto("/staff"))!.status()).toBe(200);
    for (const mode of ["test", "live"] as const) {
      const options = {
        origin: "http://127.0.0.1:1",
        secret: "disabled-browser-fixture",
        mode,
        localStaffEntry: mode === "live",
      };
      const server = await listenLoopback(app(members, options)),
        address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing local listener");
      options.origin = `http://127.0.0.1:${address.port}`;
      const context = await browser.newContext(),
        closed = await context.newPage();
      try {
        for (const path of ["/staff/sign-in", "/staff"]) {
          expect((await closed.goto(options.origin + path))!.status()).toBe(
            404,
          );
          await expect(
            closed.getByRole("heading", {
              name: "Staff access unavailable",
              exact: true,
            }),
          ).toBeVisible();
        }
        expect(
          (await context.cookies()).some(
            (c) => c.name === COOKIE || c.name === "dne_staff",
          ),
        ).toBe(false);
      } finally {
        await context.close();
        await closeLoopback(server);
      }
    }
  } finally {
    await pool.query("DELETE FROM principals WHERE id=$1", [id]);
  }
});
