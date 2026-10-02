import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  members = store(pool),
  origin = "http://127.0.0.1:4317";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
test.afterAll(async () => pool.end());
async function staff(
  browser: Browser,
  role: "moderator" | "platform_admin" | "reviewer" = "moderator",
) {
  const token = randomBytes(32).toString("hex"),
    id = await auth.provisionStaff(token, role, new Date(Date.now() + 3600000)),
    context = await browser.newContext({ baseURL: origin });
  await context.addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  return { id, context, page: await context.newPage() };
}
async function member(browser: Browser, background: string, goal: string) {
  const context = await browser.newContext({ baseURL: origin }),
    page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
  const token = (await context.cookies()).find((c) => c.name === COOKIE)!.value,
    state = await members.session(token);
  if (state.kind !== "active")
    throw Error("Synthetic member fixture unavailable");
  return { id: state.learner.id, context, page };
}
async function closeStaff(actor: Awaited<ReturnType<typeof staff>>) {
  await actor.context.close();
  await pool.query("DELETE FROM principals WHERE id=$1", [actor.id]);
}
async function closeMember(actor: Awaited<ReturnType<typeof member>>) {
  await actor.context.close();
  await members.remove(actor.id);
}
async function csrf(page: Page) {
  return page.locator('[name="csrf"]').first().inputValue();
}
async function post(
  context: BrowserContext,
  path: string,
  form: Record<string, string>,
) {
  return context.request.post(path, {
    headers: { Origin: origin },
    form,
    maxRedirects: 0,
  });
}
async function draft(page: Page, suffix: string, workflow = false) {
  await page.goto(workflow ? "/contribute?workflow=WF-001" : "/contribute");
  await page.getByLabel("Title", { exact: true }).fill(`Invented ${suffix}`);
  await page
    .getByLabel("Original sample", { exact: true })
    .fill(`Original ${suffix} sample`);
  await page
    .getByLabel("Sources and rights notes", { exact: true })
    .fill("Original invented source");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(
    page.getByText("Saved revision 1.", { exact: false }),
  ).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}
async function submit(page: Page, resubmit = false) {
  const checkbox = page.getByLabel("I created this sample or have the rights");
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page
    .getByRole("button", {
      name: resubmit
        ? "Resubmit to private moderation"
        : "Submit to private moderation",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("PRIVATE SAMPLE · SUBMITTED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save corrections" }),
  ).toHaveCount(0);
}
async function queue(page: Page, id: string) {
  await page.goto("/moderate/proposals");
  const row = page.locator(`[data-proposal-id="${id}"]`);
  await expect(row).toBeVisible();
  return row;
}
async function change(page: Page, id: string, feedback: string) {
  const row = await queue(page, id),
    form = row.locator(`form[action$="/request-changes"]`),
    fields = {
      csrf: await form.locator('[name="csrf"]').inputValue(),
      revision: await form.locator('[name="revision"]').inputValue(),
      feedback,
      confirm: "yes",
    };
  await form
    .getByLabel("Member-visible requested changes", { exact: false })
    .fill(feedback);
  await form.getByRole("checkbox").check();
  await form
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private proposal moderation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(`[data-proposal-id="${id}"]`)).toHaveCount(0);
  return fields;
}
async function corrected(page: Page, revision: number, text: string) {
  await page.getByLabel("Original sample", { exact: true }).fill(text);
  await page
    .getByRole("button", { name: "Save corrections", exact: true })
    .click();
  await expect(
    page.getByText(`Saved revision ${revision}.`, { exact: false }),
  ).toBeVisible();
  await expect(page.locator("[data-proposal-body]")).toHaveText(text);
}
async function exported(context: BrowserContext, id: string) {
  const response = await context.request.get("/api/member/export");
  expect(response.status()).toBe(200);
  const value = await response.json();
  return value.records.proposals.find((p: { id: string }) => p.id === id);
}
async function state(id: string) {
  return (
    await pool.query(
      "SELECT state,revision,rights_attested_revision,rights_attested_at,change_feedback,change_feedback_revision,changes_requested_at,submitted_at FROM member_proposals WHERE id=$1",
      [id],
    )
  ).rows[0];
}
async function changeAudits(id: string) {
  return +(
    await pool.query(
      "SELECT count(*) AS count FROM proposal_audit WHERE proposal_id=$1 AND action='proposal_changes_requested'",
      [id],
    )
  ).rows[0].count;
}
async function returned(page: Page, feedback: string) {
  await page.reload();
  await expect(
    page.getByText("PRIVATE SAMPLE · CHANGES REQUESTED", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-proposal-feedback]")).toHaveText(feedback);
}
async function withdraw(page: Page) {
  await page.getByLabel("Remove the proposal text and stop moderation").check();
  await page.getByRole("button", { name: "Withdraw and redact" }).click();
  await expect(
    page.getByText("The proposal text has been removed.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-proposal-feedback]")).toHaveCount(0);
}
async function failingCommit(id: string) {
  // The URL came from the real saved UUID. Quote only after validating its exact
  // fixture shape; no user-supplied text is interpolated into this test trigger.
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid synthetic fixture id");
  await pool.query(
    `CREATE FUNCTION dne431_browser_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic deferred proposal failure'; END $$`,
  );
  await pool.query(
    `CREATE CONSTRAINT TRIGGER dne431_browser_commit_failure AFTER UPDATE ON member_proposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id='${id}'::uuid AND NEW.state IN ('submitted','changes_requested') AND OLD.state<>NEW.state) EXECUTE FUNCTION dne431_browser_commit_failure()`,
  );
}
async function restoreCommit() {
  await pool.query(
    "DROP TRIGGER IF EXISTS dne431_browser_commit_failure ON member_proposals",
  );
  await pool.query("DROP FUNCTION IF EXISTS dne431_browser_commit_failure()");
  expect(
    (
      await pool.query(
        "SELECT count(*) AS count FROM pg_trigger WHERE tgname='dne431_browser_commit_failure'",
      )
    ).rows[0].count,
  ).toBe("0");
  expect(
    (
      await pool.query(
        "SELECT to_regprocedure('dne431_browser_commit_failure()') AS fn",
      )
    ).rows[0].fn,
  ).toBeNull();
}
// #431 v74 adds L113-L115 after all 112 v73 journeys. Each critical case
// exercises all three audiences in its own first-attempt desktop/mobile run.
// No publication, qualified approval or full-MVP acceptance is implied.
test("[L113] all audiences revise the same private proposal with replaced feedback and freshly attested exact rights", async ({
  browser,
}, info) => {
  const moderator = await staff(browser),
    admin = await staff(browser, "platform_admin");
  try {
    for (const [background, goal] of audiences)
      await test.step(background, async () => {
        const owner = await member(browser, background, goal);
        try {
          const page = owner.page,
            id = await draft(page, `${background}-${info.project.name}`, true);
          await submit(page);
          const first = await state(id);
          const feedback = `Private ${background} <first> changes`;
          await change(moderator.page, id, feedback);
          await returned(page, feedback);
          await expect(
            page.getByRole("button", {
              name: "Resubmit to private moderation",
            }),
          ).toHaveCount(0);
          await expect(
            page.getByText("feedback on revision 1", { exact: false }),
          ).toBeVisible();
          expect(await exported(owner.context, id)).toMatchObject({
            state: "changes_requested",
            feedback: { text: feedback, reviewedRevision: 1 },
            rightsAttestedRevision: null,
            rightsAttestedAt: null,
          });
          await corrected(page, 2, `Corrected ${background} invented sample`);
          await submit(page, true);
          const resubmitted = await state(id);
          expect(resubmitted.rights_attested_revision).toBe(2);
          expect(resubmitted.rights_attested_at.getTime()).toBeGreaterThan(
            first.rights_attested_at.getTime(),
          );
          expect(resubmitted.submitted_at.getTime()).toBeGreaterThan(
            first.submitted_at.getTime(),
          );
          await expect(
            page.getByRole("heading", {
              name: "Prior-cycle requested changes",
              exact: true,
            }),
          ).toBeVisible();
          const row = await queue(moderator.page, id);
          await expect(row).toContainText(
            `Corrected ${background} invented sample`,
          );
          await expect(row).not.toContainText(feedback);
          expect(await moderator.page.content()).not.toContain(feedback);
          const second = `Private ${background} <second> changes`;
          await change(admin.page, id, second);
          await returned(page, second);
          expect(await page.content()).not.toContain(feedback);
          const retained = await exported(owner.context, id);
          expect(retained.feedback).toMatchObject({
            text: second,
            reviewedRevision: 2,
          });
          expect(JSON.stringify(retained)).not.toContain(feedback);
          expect(retained).not.toHaveProperty("moderatedBy");
          await corrected(page, 3, `Final ${background} private sample`);
          await submit(page, true);
          await page.reload();
          await expect(
            page.getByText("Rights confirmed for revision 3", { exact: false }),
          ).toBeVisible();
          expect(await changeAudits(id)).toBe(2);
          await page.goto("/contribute");
          await expect(
            page.getByText(`Invented ${background}-${info.project.name}`, {
              exact: true,
            }),
          ).toBeVisible();
          expect(await page.content()).not.toContain(second);
          await page.goto("/library");
          expect(await page.content()).not.toContain(
            `Final ${background} private sample`,
          );
          expect(await page.content()).not.toContain(second);
        } finally {
          await closeMember(owner);
        }
      });
  } finally {
    await closeStaff(moderator);
    await closeStaff(admin);
  }
});
test("[L114] all audiences recover uncertain decisions, reject stale revisions and replay only exact fresh-rights results", async ({
  browser,
}, info) => {
  const moderator = await staff(browser);
  try {
    for (const [background, goal] of audiences)
      await test.step(background, async () => {
        const owner = await member(browser, background, goal);
        try {
          const page = owner.page,
            id = await draft(
              page,
              `recovery-${background}-${info.project.name}`,
            );
          await submit(page);
          const original = await state(id),
            feedback = `  ${background} <requested> changes  `;
          const row = await queue(moderator.page, id),
            form = row.locator('form[action$="/request-changes"]'),
            fields = {
              csrf: await form.locator('[name="csrf"]').inputValue(),
              revision: "1",
              feedback,
              confirm: "yes",
            };
          await form
            .getByLabel("Member-visible requested changes", { exact: false })
            .fill(feedback);
          await form.getByRole("checkbox").check();
          await failingCommit(id);
          try {
            await form
              .getByRole("button", { name: "Request changes", exact: true })
              .click();
            await expect(
              moderator.page.getByRole("heading", {
                name: "Change request outcome unknown",
              }),
            ).toBeVisible();
            await expect(
              moderator.page.getByLabel("Attempted member-visible feedback"),
            ).toHaveValue(feedback);
            expect(await moderator.page.content()).not.toContain("<requested>");
            expect(await state(id)).toEqual(original);
            expect(await changeAudits(id)).toBe(0);
          } finally {
            await restoreCommit();
          }
          await moderator.page
            .getByRole("link", { name: "Open the current moderation queue" })
            .click();
          await expect(
            moderator.page.locator(`[data-proposal-id="${id}"]`),
          ).toBeVisible();
          await change(moderator.page, id, feedback);
          const requested = await state(id);
          expect(
            (
              await post(
                moderator.context,
                `/moderate/proposals/${id}/request-changes`,
                fields,
              )
            ).status(),
          ).toBe(303);
          expect(await state(id)).toEqual(requested);
          expect(await changeAudits(id)).toBe(1);
          expect(
            (
              await post(
                moderator.context,
                `/moderate/proposals/${id}/request-changes`,
                { ...fields, feedback: "Different attempted feedback" },
              )
            ).status(),
          ).toBe(409);
          await returned(page, feedback);
          const ownerCsrf = await csrf(page);
          expect(
            (
              await post(owner.context, `/contribute/${id}/submit`, {
                csrf: ownerCsrf,
                revision: "1",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(409);
          const stale = await owner.context.newPage();
          await stale.goto(`/contribute/${id}`);
          // Valid maximum-size Chinese corrections exceed the former 16KiB parser.
          await page
            .getByLabel("Title", { exact: true })
            .fill("汉".repeat(160));
          await page
            .getByLabel("Sources and rights notes", { exact: true })
            .fill("汉".repeat(1000));
          await corrected(page, 2, "汉".repeat(4000));
          await stale
            .getByLabel("Original sample", { exact: true })
            .fill("Stale tab attempted text");
          await stale.getByRole("button", { name: "Save corrections" }).click();
          await expect(
            stale.getByRole("heading", {
              name: "Proposal corrections not saved",
            }),
          ).toBeVisible();
          await expect(stale.getByLabel("Attempted sample")).toHaveValue(
            "Stale tab attempted text",
          );
          await stale.close();
          expect(
            (
              await post(owner.context, `/contribute/${id}/submit`, {
                csrf: ownerCsrf,
                revision: "1",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(409);
          expect(
            (
              await post(owner.context, `/contribute/${id}/submit`, {
                csrf: ownerCsrf,
                revision: "2",
              })
            ).status(),
          ).toBe(409);
          const edited = await state(id);
          expect(edited.rights_attested_at).toBeNull();
          expect(edited.rights_attested_revision).toBeNull();
          await page
            .getByLabel("I created this sample or have the rights")
            .check();
          await failingCommit(id);
          try {
            await page
              .getByRole("button", { name: "Resubmit to private moderation" })
              .click();
            await expect(
              page.getByRole("heading", {
                name: "Proposal submission outcome unknown",
              }),
            ).toBeVisible();
            await expect(page.locator("form")).toHaveCount(0);
            expect(await state(id)).toEqual(edited);
            expect(await changeAudits(id)).toBe(1);
          } finally {
            await restoreCommit();
          }
          await page
            .getByRole("link", { name: "Open the current private preview" })
            .click();
          await expect(page.locator("[data-proposal-body]")).toHaveText(
            "汉".repeat(4000),
          );
          await submit(page, true);
          const saved = await state(id);
          expect(
            (
              await post(owner.context, `/contribute/${id}/submit`, {
                csrf: ownerCsrf,
                revision: "2",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(303);
          expect(await state(id)).toEqual(saved);
          expect(await changeAudits(id)).toBe(1);
          expect(
            (
              await post(owner.context, `/contribute/${id}/submit`, {
                csrf: ownerCsrf,
                revision: "2",
                rights_confirmed: "no",
              })
            ).status(),
          ).toBe(409);
        } finally {
          await restoreCommit();
          await closeMember(owner);
        }
      });
  } finally {
    await closeStaff(moderator);
  }
});
test("[L115] all audiences retain feedback privately through quarantine, redact terminal records and obey stale-source and deletion boundaries", async ({
  browser,
}, info) => {
  const moderator = await staff(browser),
    reviewer = await staff(browser, "reviewer"),
    expired = await staff(browser);
  try {
    await reviewer.page.goto("/");
    await expired.page.goto("/");
    const reviewerCsrf = await csrf(reviewer.page),
      expiredCsrf = await csrf(expired.page);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    for (const [background, goal] of audiences)
      await test.step(background, async () => {
        const owner = await member(browser, background, goal),
          other = await member(browser, "explorer", "everyday");
        try {
          const page = owner.page,
            feedback = `Private retained ${background} feedback`,
            id = await draft(
              page,
              `privacy-${background}-${info.project.name}`,
            );
          await submit(page);
          const ownerCsrf = await csrf(page);
          for (const [context, token] of [
            [owner.context, ownerCsrf],
            [reviewer.context, reviewerCsrf],
            [expired.context, expiredCsrf],
          ] as const)
            expect(
              (
                await post(
                  context,
                  `/moderate/proposals/${id}/request-changes`,
                  {
                    csrf: token,
                    revision: "1",
                    feedback: "Forged role feedback",
                    confirm: "yes",
                  },
                )
              ).status(),
            ).toBe(403);
          const decisionFields = await change(moderator.page, id, feedback);
          await returned(page, feedback);
          const foreign = await other.page.goto(`/contribute/${id}`);
          expect(foreign!.status()).toBe(404);
          expect(await other.page.content()).not.toContain(feedback);
          const staffRead = await moderator.context.request.get(
            `/contribute/${id}`,
            { maxRedirects: 0 },
          );
          expect(staffRead.status()).toBe(303);
          expect(await staffRead.text()).not.toContain(feedback);
          const otherExport =
            await other.context.request.get("/api/member/export");
          expect(await otherExport.text()).not.toContain(feedback);
          await other.page.goto("/contribute");
          const otherCsrf = await csrf(other.page);
          expect(
            (
              await post(other.context, `/contribute/${id}/edit`, {
                csrf: otherCsrf,
                revision: "1",
                title: "forged",
                body: "forged",
                sources: "forged",
              })
            ).status(),
          ).toBe(404);
          expect(
            (
              await post(other.context, `/contribute/${id}/submit`, {
                csrf: otherCsrf,
                revision: "1",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(409);
          await withdraw(page);
          expect(await exported(owner.context, id)).toMatchObject({
            state: "withdrawn",
            title: null,
            body: null,
            sources: null,
            feedback: null,
          });
          expect(
            (
              await post(
                moderator.context,
                `/moderate/proposals/${id}/request-changes`,
                {
                  csrf: decisionFields.csrf,
                  revision: "1",
                  feedback,
                  confirm: "yes",
                },
              )
            ).status(),
          ).toBe(409);
          const quarantine = await draft(page, `quarantine-${background}`);
          await submit(page);
          await change(moderator.page, quarantine, feedback);
          await returned(page, feedback);
          await corrected(page, 2, "Corrected quarantine sample");
          await submit(page, true);
          const row = await queue(moderator.page, quarantine);
          await row
            .getByRole("button", { name: "Quarantine for review" })
            .click();
          await expect(
            moderator.page.locator(`[data-proposal-id="${quarantine}"]`),
          ).toContainText("quarantined");
          await page.reload();
          await expect(
            page.getByRole("heading", {
              name: "Prior-cycle requested changes",
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Save corrections" }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "Resubmit to private moderation",
            }),
          ).toHaveCount(0);
          const qcsrf = await csrf(page);
          expect(
            (
              await post(owner.context, `/contribute/${quarantine}/edit`, {
                csrf: qcsrf,
                revision: "2",
                title: "blocked",
                body: "blocked",
                sources: "blocked",
              })
            ).status(),
          ).toBe(404);
          expect(
            (
              await post(owner.context, `/contribute/${quarantine}/submit`, {
                csrf: qcsrf,
                revision: "2",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(409);
          expect(
            (
              await post(
                moderator.context,
                `/moderate/proposals/${quarantine}/request-changes`,
                {
                  csrf: await csrf(moderator.page),
                  revision: "2",
                  feedback,
                  confirm: "yes",
                },
              )
            ).status(),
          ).toBe(409);
          await moderator.page
            .locator(`[data-proposal-id="${quarantine}"]`)
            .getByRole("button", { name: "Reject and redact" })
            .click();
          await expect(
            moderator.page.locator(`[data-proposal-id="${quarantine}"]`),
          ).toHaveCount(0);
          await page.reload();
          await expect(
            page.getByText("The proposal text has been removed.", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.locator("[data-proposal-feedback]")).toHaveCount(0);
          expect(await exported(owner.context, quarantine)).toMatchObject({
            state: "rejected",
            feedback: null,
            title: null,
            body: null,
            sources: null,
          });
          const stale = await draft(page, `stale-${background}`, true);
          await submit(page);
          await change(moderator.page, stale, feedback);
          await returned(page, feedback);
          await pool.query(
            "UPDATE member_proposals SET workflow_version=workflow_version+1 WHERE id=$1",
            [stale],
          );
          await page.reload();
          await expect(page.getByRole("status")).toContainText(
            "no longer current",
          );
          await expect(page.locator("[data-proposal-feedback]")).toHaveText(
            feedback,
          );
          await expect(
            page.getByRole("button", { name: "Save corrections" }),
          ).toHaveCount(0);
          const scsrf = await csrf(page);
          expect(
            (
              await post(owner.context, `/contribute/${stale}/edit`, {
                csrf: scsrf,
                revision: "1",
                title: "blocked",
                body: "blocked",
                sources: "blocked",
              })
            ).status(),
          ).toBe(404);
          expect(
            (
              await post(owner.context, `/contribute/${stale}/submit`, {
                csrf: scsrf,
                revision: "1",
                rights_confirmed: "yes",
              })
            ).status(),
          ).toBe(409);
          await withdraw(page);
          expect(await exported(owner.context, stale)).toMatchObject({
            feedback: null,
            workflowId: null,
            workflowVersion: null,
          });
          const deleting = await draft(page, `delete-${background}`);
          await submit(page);
          await change(moderator.page, deleting, feedback);
          await returned(page, feedback);
          await page.goto("/learn");
          await page
            .getByLabel("Delete my local preview and all its saved work")
            .check();
          await page
            .getByRole("button", { name: "Delete this preview", exact: true })
            .click();
          await expect(page).toHaveURL(/\/$/);
          expect(
            (
              await pool.query(
                "SELECT count(*) AS count FROM member_proposals WHERE member_id=$1",
                [owner.id],
              )
            ).rows[0].count,
          ).toBe("0");
          expect(
            (
              await pool.query(
                "SELECT count(*) AS count FROM proposal_audit WHERE proposal_id=ANY($1::uuid[])",
                [[id, quarantine, stale, deleting]],
              )
            ).rows[0].count,
          ).toBe("0");
        } finally {
          await closeMember(other);
          await closeMember(owner);
        }
      });
  } finally {
    await closeStaff(moderator);
    await closeStaff(reviewer);
    await closeStaff(expired);
  }
});
