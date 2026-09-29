import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { proposalStore } from "../../src/proposals.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";

test.afterAll(async () => {
  await pool.end();
});

test("[L87] moderator reaches a newer private proposal beyond 100 quarantined items", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const memberContext = await browser.newContext({ baseURL: origin });
  const memberPage = await memberContext.newPage();
  await onboard(memberPage);
  const memberCookie = (await memberContext.cookies()).find(
    (cookie) => cookie.name === "dne_preview",
  )!;
  const memberId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM learners WHERE token_hash=$1",
      [createHash("sha256").update(memberCookie.value).digest("hex")],
    )
  ).rows[0]!.id;
  const moderatorToken = randomBytes(32).toString("hex");
  const moderatorId = await authorizationStore(pool).provisionStaff(
    moderatorToken,
    "moderator",
    new Date(Date.now() + 3_600_000),
  );
  const olderIds = Array.from({ length: 100 }, () => randomUUID());
  const runId = `${testInfo.project.name} ${randomUUID()}`;
  const olderTitle = `Retained invented quarantine ${runId}`;
  const newerTitle = `Newer invented submission ${runId}`;
  const outsiderContext = await browser.newContext({ baseURL: origin });
  try {
    await pool.query(
      `INSERT INTO member_proposals
         (id,member_id,title,body,sources,state,sample_attested_at,
          rights_attested_at,submitted_at,moderated_by,moderated_at)
       SELECT id,$2,$3,'Invented private sample','Invented source',
         'quarantined',$4,$4,$4,$5,$4
       FROM unnest($1::uuid[]) id`,
      [olderIds, memberId, olderTitle, "2020-01-01T00:00:00Z", moderatorId],
    );
    const proposals = proposalStore(pool);
    const newerId = await proposals.createDraft(
      memberCookie.value,
      {
        title: newerTitle,
        body: "Invented later private sample",
        sources: "Invented later source",
      },
      true,
    );
    expect(newerId).toBeTruthy();
    expect(await proposals.submit(memberCookie.value, newerId!, true, 1)).toBe(
      "submitted",
    );
    await pool.query(
      "UPDATE member_proposals SET submitted_at=$2 WHERE id=$1",
      [newerId, "2020-01-02T00:00:00Z"],
    );

    if (testInfo.project.name === "mobile-chromium") {
      expect(page.viewportSize()?.width).toBeLessThan(500);
      expect(
        await page.evaluate(
          () => window.matchMedia("(pointer: coarse)").matches,
        ),
      ).toBe(true);
    } else {
      expect(page.viewportSize()?.width).toBeGreaterThan(1000);
    }
    await page.context().addCookies([
      {
        name: "dne_preview",
        value: moderatorToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const worklist = page;
    await worklist.goto("/moderate/proposals");
    await expect(
      worklist.getByRole("heading", { name: "Private proposal moderation" }),
    ).toBeVisible();
    await expect(
      worklist.locator("main li").filter({ hasText: olderTitle }),
    ).toHaveCount(100);
    await expect(worklist.getByText(newerTitle)).toHaveCount(0);
    const navigation = worklist.getByRole("navigation", {
      name: "Moderation pages",
    });
    const next = navigation.getByRole("link", { name: "Next page" });
    await expect(next).toBeVisible();
    const nextUrl = await next.getAttribute("href");
    expect(nextUrl).toBeTruthy();

    const outsider = await outsiderContext.newPage();
    await outsider.goto(nextUrl!);
    await expect(
      outsider.getByRole("heading", { name: "Moderation unavailable" }),
    ).toBeVisible();
    await expect(outsider.getByText(olderTitle)).toHaveCount(0);
    await expect(outsider.getByText(newerTitle)).toHaveCount(0);

    await next.focus();
    await worklist.keyboard.press("Enter");
    await expect(worklist.getByText(newerTitle)).toBeVisible();
    await expect(worklist.getByText(olderTitle)).toHaveCount(0);
    await expect(
      navigation.getByRole("link", { name: "Next page" }),
    ).toHaveCount(0);
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM proposal_audit WHERE actor_id=$1 AND proposal_id=$2 AND action='proposal_read'",
          [moderatorId, newerId],
        )
      ).rows[0]!.count,
    ).toBe("1");

    await navigation.getByRole("link", { name: "Return to start" }).click();
    await expect(
      worklist.locator("main li").filter({ hasText: olderTitle }),
    ).toHaveCount(100);
    await expect(worklist.getByText(newerTitle)).toHaveCount(0);
    const states = await pool.query<{ state: string; count: string }>(
      `SELECT state,COUNT(*)::text AS count FROM member_proposals
       WHERE id=ANY($1::uuid[]) OR id=$2 GROUP BY state`,
      [olderIds, newerId],
    );
    expect(
      Object.fromEntries(states.rows.map((row) => [row.state, +row.count])),
    ).toEqual({
      quarantined: 100,
      submitted: 1,
    });
  } finally {
    await outsiderContext.close();
    await memberContext.close();
    await pool.query("DELETE FROM principals WHERE id=$1", [memberId]);
    await pool.query("DELETE FROM principals WHERE id=$1", [moderatorId]);
  }
});

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}
