import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreparedSampleRecoveryServer } from "../support/prepared-sample-recovery-server.ts";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { store } from "../../src/store.ts";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
} from "../../src/prepared-sample-values.ts";
import { COOKIE } from "../../src/session.ts";
const pool = testPool();
const origin =
  process.env.DNE_PREPARED_BROWSER_ORIGIN ?? "http://127.0.0.1:4317";
// Staff credentials belong only in password fields, never retained network traces.
test.use({ trace: "off" });
test.afterAll(() => pool.end());
async function signIn(page: Page, credential: string) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Trusted local staff credential").fill(credential);
  await page
    .getByRole("button", { name: "Sign in to staff tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your local staff tools", exact: true }),
  ).toBeVisible();
}
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
for (const [index, [background, goal]] of audiences.entries()) {
  test(`[L${204 + index}] PREPARED-01-03-04-06-07 ${background} creates a provided example and exchanges private feedback entirely through normal browsers`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60000);
    const staffContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const reviewerContext = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize(),
    });
    const admin = await staffContext.newPage(),
      reviewer = await reviewerContext.newPage();
    const auth = authorizationStore(pool),
      expires = new Date(Date.now() + 3600000);
    const adminCredential = randomBytes(32).toString("hex"),
      reviewerCredential = randomBytes(32).toString("hex");
    const ids: string[] = [];
    const example = PREPARED_SAMPLES[index]!;
    const feedback =
      "Check the invented example against its stated information and flag unknowns.";
    try {
      // The only setup fixtures are finite staff identities. No source, clean
      // transition, review queue, grant, feedback or allowance is seeded.
      ids.push(
        await auth.provisionStaff(adminCredential, "platform_admin", expires),
      );
      ids.push(
        await auth.provisionStaff(reviewerCredential, "reviewer", expires),
      );
      await page.goto(origin + "/");
      await page.getByLabel("Your starting point").selectOption(background);
      await page.getByLabel("What would you like to do?").selectOption(goal);
      await page
        .getByRole("button", { name: "Start my learning path" })
        .click();
      const token = (await page.context().cookies()).find(
        (c) => c.name === COOKIE,
      )!.value;
      const member = await store(pool).session(token);
      if (member.kind !== "active")
        throw Error("Invented browser member missing");
      ids.push(member.learner.id);
      await page.goto(origin + "/evidence");
      await page
        .getByRole("link", {
          name: "Use a prepared invented sample",
          exact: true,
        })
        .click();
      const chosen = page.locator(`[data-prepared-template="${example.id}"]`);
      await expect(page.locator("[data-prepared-template]")).toHaveCount(3);
      await expect(chosen.locator("pre")).toHaveText(example.text, {
        useInnerText: false,
      });
      expect(await chosen.locator("pre").textContent()).toBe(example.text);
      await expect(
        chosen.getByText("Suggested for your current direction", {
          exact: false,
        }),
      ).toBeVisible();
      const provided = chosen.getByLabel(
        "I understand this is a provided invented example",
        { exact: false },
      );
      const consent = chosen.getByLabel(
        "I separately permit private review of my copy",
        { exact: false },
      );
      await expect(provided).not.toBeChecked();
      await expect(consent).not.toBeChecked();
      await provided.check();
      await consent.check();
      await chosen
        .getByRole("button", {
          name: "Create my private provided copy",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Your provided-copy receipt",
          exact: true,
        }),
      ).toBeVisible();
      const evidenceId = await page
        .locator("[data-prepared-evidence]")
        .getAttribute("data-prepared-evidence");
      expect(evidenceId).toMatch(/^[a-f0-9-]{36}$/);
      await page
        .getByRole("link", {
          name: "Manage my private samples and separately queue for review",
          exact: true,
        })
        .click();
      const source = page.locator("li").filter({
        has: page.getByRole("heading", { name: example.name, exact: true }),
      });
      await expect(source).toContainText(PROVIDED_SAMPLE_LABEL);
      await expect(source).toContainText(example.digest);
      await expect(source).toContainText("Not submitted for review");
      await source
        .getByLabel("No qualified reviewer is assigned", { exact: false })
        .check();
      await source
        .getByRole("button", {
          name: "Queue for local review consideration",
          exact: true,
        })
        .click();
      await expect(source).toContainText("Submitted locally");
      await signIn(reviewer, reviewerCredential);
      await reviewer
        .getByRole("link", { name: "My reviewer reference", exact: true })
        .click();
      const reviewerId = (
        await reviewer.locator("[data-reviewer-reference]").innerText()
      ).trim();
      await signIn(admin, adminCredential);
      await admin
        .getByRole("link", { name: "Private sample assignments", exact: true })
        .click();
      await admin
        .getByLabel("Exact sample ID", { exact: true })
        .fill(evidenceId!);
      await admin.getByLabel("Exact source version", { exact: true }).fill("1");
      await admin
        .getByLabel("Reviewer reference", { exact: true })
        .fill(reviewerId);
      await admin
        .getByRole("button", {
          name: "Check exact sample references",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Confirm private sample assignment",
          exact: true,
        }),
      ).toBeVisible();
      await expect(admin.locator("body")).not.toContainText(
        example.text.trim(),
      );
      await admin
        .getByLabel("Starts at (UTC)", { exact: true })
        .fill(new Date(Date.now() - 60000).toISOString());
      await admin
        .getByLabel("Expires at (UTC)", { exact: true })
        .fill(new Date(+expires - 1000).toISOString());
      await admin
        .getByLabel(
          "I confirm this exact sample, reviewer and finite UTC window.",
          { exact: true },
        )
        .check();
      await admin
        .getByRole("button", {
          name: "Assign private sample feedback",
          exact: true,
        })
        .click();
      await expect(
        admin.getByRole("heading", {
          name: "Private sample assignment receipt",
          exact: true,
        }),
      ).toBeVisible();
      await reviewer.goto(origin + "/staff");
      await reviewer
        .getByRole("link", {
          name: "Your sample feedback worklist",
          exact: true,
        })
        .click();
      await reviewer
        .getByRole("link", { name: example.name, exact: true })
        .click();
      await expect(reviewer.locator("details pre")).toHaveText(example.text, {
        useInnerText: false,
      });
      await expect(reviewer.locator("body")).toContainText(
        PROVIDED_SAMPLE_LABEL,
      );
      await reviewer
        .getByLabel("Criterion 1 label", { exact: true })
        .fill("Information checks");
      await reviewer
        .getByLabel("Criterion 1 comment", { exact: true })
        .fill(feedback);
      await reviewer
        .getByLabel("Criterion 1 exact source quote", { exact: true })
        .fill("An invented");
      await reviewer
        .getByRole("button", {
          name: "Save private feedback draft",
          exact: true,
        })
        .click();
      await reviewer
        .getByLabel("Publish saved draft version", { exact: false })
        .check();
      await reviewer
        .getByRole("button", { name: "Publish saved feedback", exact: true })
        .click();
      await expect(
        reviewer.getByRole("heading", {
          name: "Published sample feedback",
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(origin + `/evidence/${evidenceId}/feedback`);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await expect(page.locator("body")).toContainText(PROVIDED_SAMPLE_LABEL);
      await page
        .getByLabel("One clarification", { exact: true })
        .fill("Which missing information should I check first?");
      await page
        .getByRole("button", { name: "Send clarification", exact: true })
        .click();
      await reviewer.reload();
      await reviewer
        .getByLabel("One reviewer answer", { exact: true })
        .fill("Start with the information explicitly identified as missing.");
      await reviewer
        .getByRole("button", { name: "Send answer", exact: true })
        .click();
      await page.reload();
      await expect(
        page.getByText(
          "Start with the information explicitly identified as missing.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        await page
          .getByRole("button", { name: "Send clarification", exact: true })
          .count(),
      ).toBe(0);
      for (const current of [page, reviewer]) {
        const width = await current.evaluate(() => ({
          document: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        }));
        expect(width.document).toBeLessThanOrEqual(width.viewport);
      }
      const exported = await page.request.get(origin + "/api/evidence/export", {
        timeout: 5000,
      });
      expect(exported.status()).toBe(200);
      const records = await exported.json();
      expect(records.items[0].origin.templateDigest).toBe(example.digest);
      expect(
        Buffer.from(records.items[0].sourceBase64, "base64").toString(),
      ).toBe(example.text);
      await page.goto(origin + "/evidence/export");
      const downloaded = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download page 1", exact: true })
        .click();
      const file = await downloaded;
      expect(file.suggestedFilename()).toBe("deep-native-evidence-page-1.json");
      const saved = JSON.parse(await readFile((await file.path())!, "utf8"));
      expect(saved.version).toBe("local-evidence-v3");
      expect(saved.items[0].origin.templateDigest).toBe(example.digest);
      expect(
        Buffer.from(saved.items[0].sourceBase64, "base64").toString(),
      ).toBe(example.text);
      await expect(page.getByRole("status")).toContainText(
        "End of this live traversal",
      );
      await page.goto(origin + "/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "0");
      // PREPARED-06: a changed learning goal does not relabel the original
      // provided source. Editing creates pending member text, not another
      // trusted fixture or a transfer of the old reviewer's access/feedback.
      await page
        .getByLabel("What would you like to do?")
        .selectOption(audiences[(index + 1) % audiences.length]![1]);
      await page.getByRole("button", { name: "Save my direction" }).click();
      await page.goto(origin + "/evidence");
      await expect(source).toContainText(PROVIDED_SAMPLE_LABEL);
      await expect(source).toContainText(example.digest);
      await source
        .getByRole("link", {
          name: `Create a new private revision of ${example.name}`,
          exact: true,
        })
        .click();
      const revisedName = example.name + " revised";
      // TITLE-01/02: correct an unsupported title without losing the response.
      await page
        .getByLabel("Revised sample title")
        .fill(example.name + ", revised");
      await page
        .getByLabel("New invented text", { exact: true })
        .fill("A member-edited invented example with separately changed text.");
      await page.getByLabel("I created this new invented text").check();
      await page.getByLabel("I separately allow this revision").check();
      await page
        .getByRole("button", { name: "Save new private revision" })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Check the sample title.",
      );
      await expect(page.getByRole("alert")).not.toContainText(
        "eligibility may have changed",
      );
      await expect(page.getByLabel("Revised sample title")).toHaveValue(
        example.name + ", revised",
      );
      await expect(
        page.getByLabel("New invented text", { exact: true }),
      ).toHaveValue(
        "A member-edited invented example with separately changed text.",
      );
      await expect(
        page.getByLabel("I created this new invented text"),
      ).not.toBeChecked();
      await expect(
        page.getByLabel("I separately allow this revision"),
      ).not.toBeChecked();
      await page.getByLabel("Revised sample title").fill(revisedName);
      await page
        .getByLabel("New invented text", { exact: true })
        .fill("A member-edited invented example with separately changed text.");
      await page.getByLabel("I created this new invented text").check();
      await page.getByLabel("I separately allow this revision").check();
      await page
        .getByRole("button", { name: "Save new private revision" })
        .click();
      const revision = page.locator("li").filter({
        has: page.getByRole("heading", { name: revisedName, exact: true }),
      });
      await expect(revision).toContainText("Pending safety check");
      await expect(revision).not.toContainText(PROVIDED_SAMPLE_LABEL);
      await expect(
        revision.getByRole("button", {
          name: "Queue for local review consideration",
          exact: true,
        }),
      ).toHaveCount(0);
      const afterEdit = await page.request.get(
        origin + "/api/evidence/export",
        {
          timeout: 5000,
        },
      );
      expect(afterEdit.status()).toBe(200);
      const editedRecords = await afterEdit.json();
      const edited = editedRecords.items.find(
        (item: { name: string }) => item.name === revisedName,
      );
      expect(edited).toBeDefined();
      expect(edited.origin).toBeUndefined();
      expect(
        (await reviewer.goto(
          origin + `/review/evidence/${edited.id}/feedback`,
        ))!.status(),
      ).toBe(403);
      await page.goto(origin + `/evidence/${evidenceId}/feedback`);
      await expect(page.getByText(feedback, { exact: true })).toBeVisible();
      await expect(page.locator("body")).toContainText(example.digest);
      await page.goto(origin + "/learn");
      await expect(
        page.getByRole("progressbar", { name: "Exercises completed" }),
      ).toHaveAttribute("value", "0");
      console.log(`PREPARED ${background}: goal/revision assertions completed`);
      // Mandatory recovery variant on the same approved audience journey. The
      // only injected failure occurs after an actual successful PostgreSQL COMMIT.
      const root = await mkdtemp(join(tmpdir(), "dne503-recovery-browser-"));
      const recovery = await startPreparedSampleRecoveryServer(pool, root);
      const recovering = await browser.newContext({
        baseURL: recovery.origin,
        viewport: page.viewportSize(),
      });
      try {
        const original = await recovering.newPage();
        await original.goto(recovery.origin + "/");
        await original
          .getByLabel("Your starting point")
          .selectOption(background);
        await original
          .getByLabel("What would you like to do?")
          .selectOption(goal);
        await original
          .getByRole("button", { name: "Start my learning path" })
          .click();
        const recoveryToken = (await recovering.cookies()).find(
          (c) => c.name === COOKIE,
        )!.value;
        const recoveryMember = await store(pool).session(recoveryToken);
        if (recoveryMember.kind !== "active")
          throw Error("Invented recovery member missing");
        ids.push(recoveryMember.learner.id);
        await original.goto(recovery.origin + "/evidence/prepared");
        const choice = original.locator(
          `[data-prepared-template="${example.id}"]`,
        );
        const originalInstruction = await choice
          .locator('input[name="operationId"]')
          .inputValue();
        await choice
          .getByLabel("I understand this is a provided invented example", {
            exact: false,
          })
          .check();
        await choice
          .getByLabel("I separately permit private review of my copy", {
            exact: false,
          })
          .check();
        await choice
          .getByRole("button", {
            name: "Create my private provided copy",
            exact: true,
          })
          .click();
        await expect(
          original.getByRole("heading", {
            name: "Provided copy needs attention",
            exact: true,
          }),
        ).toBeVisible();
        expect(recovery.observed).toEqual({
          commits: 1,
          lostReplies: 1,
          rollbacksAfterCommit: 0,
        });
        await expect(
          original.locator(
            'form[action="/evidence/prepared"] input[name="operationId"]',
          ),
        ).toHaveValue(originalInstruction);
        const inspection = recovering.waitForEvent("page", { timeout: 5000 });
        const inspectionResponse = recovering.waitForEvent("response", {
          predicate: (r) =>
            r.url() === recovery.origin + "/evidence/prepared/inspect" &&
            r.request().method() === "POST",
          timeout: 5000,
        });
        await original
          .getByRole("button", {
            name: "Inspect my original copy instruction",
            exact: true,
          })
          .click();
        const inspected = await inspection;
        expect((await inspectionResponse).status()).toBe(200);
        await expect(
          inspected.getByRole("heading", {
            name: "Your provided-copy receipt",
            exact: true,
          }),
        ).toBeVisible();
        const retainedId = await inspected
          .locator("[data-prepared-evidence]")
          .getAttribute("data-prepared-evidence");
        await expect(
          original.getByRole("heading", {
            name: "Provided copy needs attention",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          original.getByLabel(
            "I understand this is a provided invented example",
            { exact: false },
          ),
        ).not.toBeChecked();
        await expect(
          original.getByLabel("I separately permit private review of my copy", {
            exact: false,
          }),
        ).not.toBeChecked();
        await original
          .getByLabel("I understand this is a provided invented example", {
            exact: false,
          })
          .check();
        await original
          .getByLabel("I separately permit private review of my copy", {
            exact: false,
          })
          .check();
        await original
          .getByRole("button", {
            name: "Repeat this original copy instruction",
            exact: true,
          })
          .click();
        await expect(
          original.locator("[data-prepared-evidence]"),
        ).toHaveAttribute("data-prepared-evidence", retainedId!);
        await expect(original.getByRole("status")).toContainText(
          "no new copy or permission",
        );
        expect(recovery.observed.commits).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM evidence_objects WHERE owner_principal_id=$1",
              [recoveryMember.learner.id],
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        console.log(`PREPARED ${background}: closing recovery browser`);
        await recovering.close();
        console.log(`PREPARED ${background}: closing recovery server`);
        await recovery.close();
        await rm(root, { recursive: true, force: true });
      }
    } finally {
      console.log(`PREPARED ${background}: closing reviewer browser`);
      await reviewerContext.close();
      console.log(`PREPARED ${background}: closing administrator browser`);
      await staffContext.close();
      for (const id of [...ids].reverse())
        await pool.query("DELETE FROM principals WHERE id=$1", [id]);
    }
  });
}
