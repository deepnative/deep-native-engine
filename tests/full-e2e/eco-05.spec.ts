import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";

// Member contributions are off by default, so each case runs on its own listener
// and database with them on, as on the hosted site (#40, #115). Staff credentials
// stay out of traces. Every contribution is invented.
test.use({ trace: "off" });
type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;
const original =
  "An invented club compares three weekend activities and checks each detail against its own notes.";
const sources =
  "Original invented example by the member; platform display only.";

async function actors(f: Fixture) {
  const owner = await f.member(),
    peer = await f.member(),
    moderator = (await f.staff("moderator")).page;
  return { owner, peer, moderator };
}
// The owner saves a private draft and returns its proposal ID.
async function draft(owner: Page, f: Fixture, title: string, body = original) {
  await owner.goto(f.origin + "/contribute");
  await owner.getByLabel("Title", { exact: true }).fill(title);
  await owner.getByLabel("Original contribution", { exact: true }).fill(body);
  await owner
    .getByLabel("Sources and rights notes", { exact: true })
    .fill(sources);
  await owner
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  return new URL(owner.url()).pathname.split("/").at(-1)!;
}
async function submit(owner: Page) {
  await owner
    .getByLabel("I created this contribution or have the rights")
    .check();
  await owner
    .getByRole("button", { name: /submit to private moderation/i })
    .click();
}
const queueItem = (moderator: Page, id: string) =>
  moderator.locator(`[data-proposal-id="${id}"]`);
async function accept(moderator: Page, f: Fixture, id: string) {
  await moderator.goto(f.origin + "/moderate/proposals");
  const item = queueItem(moderator, id);
  await item.getByLabel("I reviewed this exact revision").check();
  await item
    .getByRole("button", {
      name: "Accept this revision privately",
      exact: true,
    })
    .click();
  await expect(
    moderator.locator('[data-publication-state="accepted"]'),
  ).toBeVisible();
}
async function fillShare(owner: Page, f: Fixture, id: string) {
  await owner.goto(f.origin + `/contribute/${id}/publication`);
  await owner
    .getByLabel("Display attribution", { exact: true })
    .fill("Invented club contributor");
  await owner
    .getByLabel("Sharing audience", { exact: true })
    .selectOption("members");
}
async function share(owner: Page, f: Fixture, id: string) {
  await fillShare(owner, f, id);
  await owner
    .getByLabel(
      "I permit this platform to display this exact accepted revision",
    )
    .check();
  await owner
    .getByRole("button", { name: "Share this accepted revision", exact: true })
    .click();
  await expect(
    owner.locator('[data-publication-state="published"]'),
  ).toBeVisible();
}
async function listed(page: Page, f: Fixture, title: string) {
  await page.goto(f.origin + "/contributions");
  return page.getByRole("link", { name: title, exact: true }).count();
}
async function publication(f: Fixture, id: string) {
  return (
    await f.pool.query<{
      state: string;
      revision: number;
      attribution: string | null;
      published: boolean;
      withdrawn: boolean;
    }>(
      `SELECT state,revision,attribution,published_at IS NOT NULL AS published,
              withdrawn_at IS NOT NULL AS withdrawn
       FROM proposal_publications WHERE proposal_id=$1 ORDER BY revision`,
      [id],
    )
  ).rows;
}
async function events(f: Fixture, id: string) {
  return (
    await f.pool.query<{ event: string }>(
      `SELECT kind||':'||revision||COALESCE(':'||outcome,'')||COALESCE(':'||cause,'') AS event
       FROM contribution_events WHERE proposal_id=$1 ORDER BY occurred_at,id`,
      [id],
    )
  ).rows.map((row) => row.event);
}

test("[F-ECO-05-A] a proposed resource records its rights and stays private until approved", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    memberContributions: true,
  });
  try {
    const { owner, peer } = await actors(f);
    const title = "Invented club activity comparison";
    const id = await draft(owner, f, title);
    await requiredCheck(1, async () => {
      await submit(owner);
      await expect(owner.locator("[data-proposal-body]")).toContainText(
        "An invented club",
      );
      await expect(owner.getByText(sources, { exact: true })).toBeVisible();
      await expect(
        owner.getByText(/Rights confirmed for revision 1 at/),
      ).toBeVisible();
      expect(
        (
          await f.pool.query(
            `SELECT state,sources,rights_attested_revision FROM member_proposals WHERE id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ state: "submitted", sources, rights_attested_revision: 1 }]);
      // Not curated: it is not shared with members and not in the library.
      expect(await publication(f, id)).toEqual([]);
      expect(await listed(peer, f, title)).toBe(0);
      await peer.goto(f.origin + "/library");
      await expect(peer.getByText(title)).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      // Before acceptance there is no sharing choice, and choosing the member
      // audience directly is refused.
      await owner.goto(f.origin + `/contribute/${id}/publication`);
      await expect(
        owner.getByText("Editorial acceptance is needed before sharing."),
      ).toBeVisible();
      await expect(owner.getByLabel("Sharing audience")).toHaveCount(0);
      // The page has no form yet, so take the session's form token elsewhere.
      await owner.goto(f.origin + "/contribute");
      const csrf = await owner
        .locator('input[name="csrf"]')
        .first()
        .getAttribute("value");
      const early = await owner.request.post(
        f.origin + `/contribute/${id}/publish`,
        {
          form: {
            csrf: csrf!,
            operationId: randomUUID(),
            revision: "1",
            attribution: "Invented club contributor",
            audience: "members",
            permissionVersion: "member-display-v1",
            confirmed: "yes",
          },
        },
      );
      expect([403, 409]).toContain(early.status());
      expect(await publication(f, id)).toEqual([]);
      expect(await listed(peer, f, title)).toBe(0);
      await owner.goto(f.origin + `/contribute/${id}`);
      await expect(
        owner.getByText("PRIVATE CONTRIBUTION · SUBMITTED"),
      ).toBeVisible();
    });
  } finally {
    await f.close();
  }
});

test("[F-ECO-05-B] only an editor's accepted revision is shared, and only with the member's consent", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info, {
    memberContributions: true,
  });
  try {
    const { owner, peer, moderator } = await actors(f);
    const title = "Invented club revised comparison";
    const corrected =
      "An invented club compares three weekend activities, now with a cost column, and checks each detail against its own notes.";
    const id = await draft(owner, f, title);
    await submit(owner);
    await requiredCheck(1, async () => {
      // The editor asks for changes on revision 1; revision 2 is accepted.
      await moderator.goto(f.origin + "/moderate/proposals");
      const item = queueItem(moderator, id);
      await item
        .getByLabel(/Member-visible requested changes/)
        .fill("Add the invented cost of each activity.");
      await item.getByLabel(/Send these requested changes privately/).check();
      await item
        .getByRole("button", { name: "Request changes", exact: true })
        .click();
      await owner.goto(f.origin + `/contribute/${id}`);
      await owner.locator("#edit-proposal-body").fill(corrected);
      await owner
        .getByRole("button", { name: "Save corrections", exact: true })
        .click();
      await submit(owner);
      await accept(moderator, f, id);
      await share(owner, f, id);
      expect(await publication(f, id)).toEqual([
        {
          state: "published",
          revision: 2,
          attribution: "Invented club contributor",
          published: true,
          withdrawn: false,
        },
      ]);
      await peer.goto(f.origin + "/contributions");
      await peer.getByRole("link", { name: title, exact: true }).click();
      const shared = peer.url();
      await expect(peer.locator("[data-contribution-body]")).toHaveText(
        corrected,
      );
      await expect(
        peer.getByText(
          "Member contribution · editorially reviewed · revision 2",
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      await expect(peer.getByText(/signed-in members only/)).toBeVisible();
      // Its agreed scope is signed-in members, so a visitor reads nothing.
      const visitor = await f.page();
      const response = await visitor.goto(shared);
      // A visitor is refused or sent home; either way the page is not shown.
      expect(response?.status() !== 200 || visitor.url() !== shared).toBe(true);
      await expect(visitor.getByText(corrected)).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      const rejected = "Invented rejected contribution";
      const other = await draft(owner, f, rejected);
      await submit(owner);
      await moderator.goto(f.origin + "/moderate/proposals");
      await queueItem(moderator, other)
        .getByRole("button", { name: "Reject and redact", exact: true })
        .click();
      await owner.goto(f.origin + `/contribute/${other}`);
      await expect(
        owner.getByText("PRIVATE CONTRIBUTION · REJECTED"),
      ).toBeVisible();
      await expect(owner.getByText(/qualified/i)).toHaveCount(0);
      await owner.goto(f.origin + `/contribute/${other}/publication`);
      await expect(
        owner.getByText("Editorial acceptance is needed before sharing."),
      ).toBeVisible();
      await expect(owner.getByLabel("Sharing audience")).toHaveCount(0);
      expect(await publication(f, other)).toEqual([]);
      expect(await listed(peer, f, rejected)).toBe(0);
    });
    await requiredCheck(3, async () => {
      const unconsented = "Invented accepted but unshared contribution";
      const third = await draft(owner, f, unconsented);
      await submit(owner);
      await accept(moderator, f, third);
      // The owner fills in the form but sends it without ticking consent.
      await fillShare(owner, f, third);
      const consent = owner.getByLabel(
        "I permit this platform to display this exact accepted revision",
      );
      await expect(consent).not.toBeChecked();
      await consent.evaluate((box) => box.removeAttribute("required"));
      const [refused] = await Promise.all([
        owner.waitForResponse((r) =>
          r.url().endsWith(`/contribute/${third}/publish`),
        ),
        owner
          .getByRole("button", {
            name: "Share this accepted revision",
            exact: true,
          })
          .click(),
      ]);
      expect(refused.status()).toBe(422);
      expect(await publication(f, third)).toEqual([
        {
          state: "accepted",
          revision: 1,
          attribution: null,
          published: false,
          withdrawn: false,
        },
      ]);
      expect(await listed(peer, f, unconsented)).toBe(0);
    });
  } finally {
    await f.close();
  }
});

test("[F-ECO-05-C] withdrawn sharing removes the contribution and keeps its history", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const f = await reviewedContentFixture(browser, info, {
    memberContributions: true,
  });
  try {
    const { owner, peer, moderator } = await actors(f);
    const title = "Invented club shared then withdrawn";
    const id = await draft(owner, f, title);
    await submit(owner);
    await accept(moderator, f, id);
    await share(owner, f, id);
    const reference = await owner
      .locator("[data-publication-request-reference]")
      .textContent();
    await peer.goto(f.origin + "/contributions");
    await peer.getByRole("link", { name: title, exact: true }).click();
    const shared = peer.url();
    await expect(peer.locator("[data-contribution-body]")).toHaveText(original);
    await requiredCheck(1, async () => {
      await owner.goto(f.origin + `/contribute/${id}/publication`);
      await owner
        .getByLabel("Withdraw display permission for this revision")
        .check();
      await owner
        .getByRole("button", { name: "Withdraw sharing", exact: true })
        .click();
      await expect(
        owner.locator('[data-publication-state="withdrawn"]'),
      ).toBeVisible();
      expect(await listed(peer, f, title)).toBe(0);
      expect((await peer.goto(shared))?.status()).toBe(403);
      await expect(peer.getByText(original)).toHaveCount(0);
    });
    await requiredCheck(2, async () => {
      await owner.goto(f.origin + `/contribute/${id}/publication`);
      await expect(
        owner.locator('[data-publication-state="withdrawn"]'),
      ).toHaveText("Status: withdrawn · revision 1");
      await expect(
        owner.getByText(/Editorial acceptance for revision 1 recorded/),
      ).toBeVisible();
      await expect(
        owner.locator("[data-publication-request-reference]"),
      ).toHaveText(reference!);
      await expect(owner.getByText("Invented club contributor")).toHaveCount(0);
      // The owner keeps the private source.
      await owner.goto(f.origin + `/contribute/${id}`);
      await expect(owner.locator("[data-proposal-body]")).toContainText(
        "An invented club",
      );
      expect(await publication(f, id)).toEqual([
        {
          state: "withdrawn",
          revision: 1,
          attribution: null,
          published: true,
          withdrawn: true,
        },
      ]);
      expect(await events(f, id)).toEqual([
        "submitted:1",
        "reviewed:1:accepted",
        "accepted:1",
        "published:1",
        "sharing_withdrawn:1:owner",
      ]);
    });
  } finally {
    await f.close();
  }
});
