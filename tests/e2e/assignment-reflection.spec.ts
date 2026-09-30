import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.afterAll(async () => pool.end());

async function publishers() {
  const auth = authorizationStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  return { catalog: catalogStore(pool), editor, reviewer };
}

async function publish(
  actors: Awaited<ReturnType<typeof publishers>>,
  draft: DraftContent,
) {
  expect(await actors.catalog.createDraft(actors.editor, draft)).toBe(true);
  expect(
    await actors.catalog.submit(actors.editor, draft.id, draft.version),
  ).toBe(true);
  expect(
    await actors.catalog.approve(
      actors.reviewer,
      draft.id,
      draft.version,
      true,
    ),
  ).toBe(true);
  expect(
    await actors.catalog.publish(actors.editor, draft.id, draft.version),
  ).toBe(true);
}

function sample(id: string, version: number, rubric: string): DraftContent {
  return {
    id,
    version,
    kind: "assignment",
    origin: "curated",
    title: `Invented reflection assignment ${id}`,
    body: "Use only invented details and check your draft against the source.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric,
    rubricVersion: version,
  };
}

async function onboard(page: Page, background: string, goal: string) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption(background);
  await page.getByLabel("What would you like to do?").selectOption(goal);
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
}

async function start(page: Page, title: string) {
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await choices.getByRole("button", { name: `Choose ${title}` }).click();
  await choices
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return page.url().split("/").at(-1)!;
}

async function submit(page: Page, response: string) {
  await page.getByLabel("Private sample response").fill(response);
  await page
    .getByLabel("I used only invented or sample information.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();
}

test("[L97] three backgrounds reflect on an exact rubric, revise, compare, export and delete privately", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const id = info.project.name === "desktop-chromium" ? "RFL-970" : "RFL-971";
  const title = `Invented reflection assignment ${id}`;
  const actors = await publishers();
  await publish(
    actors,
    sample(id, 1, "Original rubric: point to a source <line>."),
  );
  const learners = [
    { background: "explorer", goal: "everyday" },
    { background: "professional", goal: "work" },
    { background: "technical", goal: "build" },
  ];
  for (const [index, learner] of learners.entries()) {
    const context =
      index === 0
        ? page.context()
        : await browser.newContext({ baseURL: origin });
    const memberPage = index === 0 ? page : await context.newPage();
    try {
      await onboard(memberPage, learner.background, learner.goal);
      const attemptId = await start(memberPage, title);
      await expect(
        memberPage.getByText("Original rubric version 1"),
      ).toBeVisible();
      await expect(
        memberPage.getByText("Original rubric: point to a source <line>."),
      ).toBeVisible();
      await submit(
        memberPage,
        `Invented answer ${index}: compare this exact source with my example.`,
      );
      const reflection = memberPage.getByRole("region", {
        name: "Reflection for submission 1",
      });
      await reflection
        .getByLabel("Evidence I can point to")
        .fill(`Evidence for ${learner.background}`);
      await reflection
        .getByLabel("Gaps or uncertainty")
        .fill("The sample lacks one observation.");
      await reflection
        .getByLabel("What I will change")
        .fill("Add an invented verification step.");
      await reflection
        .getByLabel(
          "This self-reflection contains only invented or sample information.",
        )
        .check();
      await reflection
        .getByRole("button", {
          name: "Save private reflection for submission 1",
        })
        .click();
      await expect(
        reflection.getByRole("button", { name: "Delete reflection 1" }),
      ).toBeVisible();
      await memberPage.reload();
      await expect(
        reflection.getByLabel("Evidence I can point to"),
      ).toHaveValue(`Evidence for ${learner.background}`);
      await expect(
        reflection.getByText("SELF-REPORTED · SIMULATED · UNREVIEWED", {
          exact: false,
        }),
      ).toBeVisible();
      await memberPage
        .getByLabel(
          "Start a new private revision; keep my earlier submitted response unchanged.",
        )
        .check();
      await memberPage
        .getByRole("button", { name: "Revise privately" })
        .click();
      await expect(
        memberPage.getByText("Earlier revision intention beside this draft", {
          exact: false,
        }),
      ).toBeVisible();
      await submit(
        memberPage,
        `Improved invented answer ${index}: now I verify the source before reuse.`,
      );
      await memberPage
        .getByRole("link", { name: "Compare private submissions" })
        .click();
      await expect(
        memberPage
          .getByText(`Invented answer ${index}: compare this exact source`, {
            exact: false,
          })
          .first(),
      ).toBeVisible();
      await expect(
        memberPage
          .getByText(`Improved invented answer ${index}: now I verify`, {
            exact: false,
          })
          .first(),
      ).toBeVisible();
      await memberPage.goto(`/assignments/attempts/${attemptId}`);
      const exported = await memberPage.request.get("/api/member/export");
      expect(exported.status()).toBe(200);
      const records = (await exported.json()).records;
      expect(records.assignmentReflections).toMatchObject([
        {
          attemptId,
          sequence: 1,
          contentId: id,
          contentVersion: 1,
          evidence: `Evidence for ${learner.background}`,
          label: "SELF-REPORTED · SIMULATED · UNREVIEWED",
        },
      ]);
      if (index === 2) {
        await publish(
          actors,
          sample(id, 2, "New rubric that must not replace version one."),
        );
        await memberPage.reload();
        await expect(
          memberPage.getByText("Original rubric version 1"),
        ).toBeVisible();
        await expect(
          memberPage.getByText("New rubric that must not replace version one."),
        ).toHaveCount(0);
      }
      const oldReflection = memberPage.getByRole("region", {
        name: "Reflection for submission 1",
      });
      await oldReflection
        .getByLabel("Delete this reflection without deleting submission 1")
        .check();
      await oldReflection
        .getByRole("button", { name: "Delete reflection 1" })
        .click();
      await expect(
        oldReflection.getByText("This private reflection was deleted.", {
          exact: false,
        }),
      ).toBeVisible();
      expect(
        (await (await memberPage.request.get("/api/member/export")).json())
          .records.assignmentReflections,
      ).toEqual([]);
      await expect(
        memberPage
          .getByText(`Invented answer ${index}: compare this exact source`, {
            exact: false,
          })
          .first(),
      ).toBeVisible();
      await memberPage
        .getByLabel("Delete this private attempt and all its submissions")
        .check();
      await memberPage.getByRole("button", { name: "Delete attempt" }).click();
      await expect(
        memberPage.getByText("No private assignment attempts yet"),
      ).toBeVisible();
    } finally {
      if (index !== 0) await context.close();
    }
  }
});

test("[L98] stale, forged, outsider and expired reflection writes preserve private text without a false save", async ({
  page,
  context,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "RFL-980" : "RFL-981";
  const title = `Invented reflection assignment ${id}`;
  const actors = await publishers();
  await publish(
    actors,
    sample(id, 1, "Original private rubric for conflict recovery."),
  );
  await onboard(page, "professional", "work");
  const attemptId = await start(page, title);
  await submit(
    page,
    "An invented response with enough words to submit locally.",
  );
  const stale = await context.newPage();
  await stale.goto(page.url());
  try {
    const ownerReflection = page.getByRole("region", {
      name: "Reflection for submission 1",
    });
    await ownerReflection
      .getByLabel("Evidence I can point to")
      .fill("Current private evidence");
    await ownerReflection
      .getByLabel(
        "This self-reflection contains only invented or sample information.",
      )
      .check();
    await ownerReflection
      .getByRole("button", { name: "Save private reflection for submission 1" })
      .click();
    const staleReflection = stale.getByRole("region", {
      name: "Reflection for submission 1",
    });
    await staleReflection
      .getByLabel("Evidence I can point to")
      .fill("Unsaved competing evidence <copy>");
    await staleReflection
      .getByLabel(
        "This self-reflection contains only invented or sample information.",
      )
      .check();
    await staleReflection
      .getByRole("button", { name: "Save private reflection for submission 1" })
      .click();
    await expect(
      stale.getByText("This reflection changed in another tab", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      staleReflection.getByLabel("Evidence I can point to"),
    ).toHaveValue("Unsaved competing evidence <copy>");
    await page.reload();
    await expect(
      ownerReflection.getByLabel("Evidence I can point to"),
    ).toHaveValue("Current private evidence");
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const forged = await page.request.post(
      `/assignments/attempts/${attemptId}/reflections/1/save`,
      {
        form: {
          evidence: "Forged text",
          gaps: "",
          intention: "",
          reflection_revision: "1",
          sample_confirmed: "yes",
        },
        headers: { Origin: origin },
      },
    );
    expect(forged.status()).toBe(403);
    expect(await forged.text()).toContain("Forged text");
    const otherContext = await browser.newContext({ baseURL: origin });
    const staffContext = await browser.newContext({ baseURL: origin });
    try {
      const other = await otherContext.newPage();
      await onboard(other, "explorer", "everyday");
      await other.goto(`/assignments/attempts/${attemptId}`);
      await expect(
        other.getByRole("heading", { name: "Attempt unavailable" }),
      ).toBeVisible();
      await expect(other.getByText("Current private evidence")).toHaveCount(0);
      const staffToken = randomBytes(32).toString("hex");
      await authorizationStore(pool).provisionStaff(
        staffToken,
        "reviewer",
        new Date(Date.now() + 86_400_000),
      );
      await staffContext.addCookies([
        { name: "dne_preview", value: staffToken, url: origin },
      ]);
      const staff = await staffContext.newPage();
      await staff.goto(`/assignments/attempts/${attemptId}`);
      await expect(staff.getByText("Current private evidence")).toHaveCount(0);
    } finally {
      await otherContext.close();
      await staffContext.close();
    }
    const token = (await context.cookies()).find(
      (cookie) => cookie.name === "dne_preview",
    )!.value;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [tokenHash],
    );
    const expired = await page.request.post(
      `/assignments/attempts/${attemptId}/reflections/1/save`,
      {
        form: {
          csrf,
          evidence: "Expired unsaved note",
          gaps: "",
          intention: "",
          reflection_revision: "1",
          sample_confirmed: "yes",
        },
        headers: { Origin: origin },
      },
    );
    expect(expired.status()).toBe(401);
    expect(await expired.text()).toContain("Expired unsaved note");
  } finally {
    await stale.close();
  }
});
