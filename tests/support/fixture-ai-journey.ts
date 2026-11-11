import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";
import type { reviewedContentFixture } from "./reviewed-content-browser.ts";

type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

// The local AI journey of tests/support/local-ai-journey.ts, for a case that
// runs on its own reviewedContentFixture listener and database. The member
// saves an invented text sample and permits it for the local simulation; the
// malware scan result is stood in for by marking the sample clean.
export async function permitFixtureSample(
  f: Fixture,
  page: Page,
  text: string,
) {
  const title = `Invented-${randomUUID()}.txt`;
  await page.goto(f.origin + "/evidence");
  await page.getByLabel("Sample title").fill(title);
  await page.getByLabel("Invented text sample").fill(text);
  await page.getByLabel("I created this invented sample").check();
  await page.getByLabel("I explicitly allow this sample").check();
  await page.getByRole("button", { name: "Save private text sample" }).click();
  const id = (
    await f.pool.query<{ id: string }>(
      "SELECT id FROM evidence_objects WHERE original_name=$1",
      [title],
    )
  ).rows[0]!.id;
  await evidenceStore(
    f.pool,
    fileObjectStorage(f.storageRoot),
    "browser-secret",
  ).transitionQuarantine(id, "clean");
  await page.goto(f.origin + "/evidence/local-ai");
  const item = page
    .locator("li")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await item.getByLabel("I permit this exact invented sample version").check();
  await item
    .getByRole("button", { name: "Grant local simulation permission" })
    .click();
  await expect(
    item.getByRole("button", { name: "Withdraw permission" }),
  ).toBeVisible();
  return { id, item };
}

/** The member's metered form for one sample, as it could be sent again. */
export async function meteredForm(item: ReturnType<Page["locator"]>) {
  const form = item.locator('form[action$="/queue-metered"]');
  return {
    action: (await form.getAttribute("action"))!,
    fields: {
      csrf: await form.locator('[name="csrf"]').inputValue(),
      key: await form.locator('[name="key"]').inputValue(),
      confirm: "yes",
    },
  };
}

/** The member holds one test request for the sample through the page. */
export async function holdMeteredRequest(item: ReturnType<Page["locator"]>) {
  await item.getByLabel("Hold one existing local test request").check();
  await item
    .getByRole("button", { name: "Use one local test request" })
    .click();
}

/** Every metered AI request of one member, with its unit and cost records. */
export async function meteredRequests(f: Fixture, memberId: string) {
  return (
    await f.pool.query<{
      status: string;
      safe_error: string | null;
      attempt_count: number;
      commitments: string | null;
      estimates: number;
      settlements: number;
    }>(
      `SELECT j.status,j.safe_error,j.attempt_count,
        (SELECT string_agg(c.state,',' ORDER BY c.attempt) FROM ai_spending_commitments c WHERE c.job_id=j.id) AS commitments,
        (SELECT count(*)::int FROM ai_usage_estimates e WHERE e.job_id=j.id) AS estimates,
        (SELECT count(*)::int FROM ai_usage_settlements s WHERE s.job_id=j.id) AS settlements
       FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id
       WHERE j.member_id=$1 ORDER BY j.created_at,j.id`,
      [memberId],
    )
  ).rows;
}

/** The member's AI request units: totals across grants, and events by kind. */
export async function aiUnits(f: Fixture, memberId: string) {
  const row = (
    await f.pool.query<{
      available: number;
      reserved: number;
      consumed: number;
      events: string | null;
    }>(
      `SELECT COALESCE(sum(g.available),0)::int AS available,COALESCE(sum(g.reserved),0)::int AS reserved,
        COALESCE(sum(g.consumed),0)::int AS consumed,
        (SELECT string_agg(o.operation||':'||o.units,',' ORDER BY o.operation)
           FROM (SELECT e.operation,sum(e.quantity) AS units FROM synthetic_entitlement_events e
                 JOIN synthetic_entitlement_grants x ON x.id=e.grant_id
                 WHERE x.member_id=$1 AND x.category='study_requests' GROUP BY e.operation) o) AS events
       FROM synthetic_entitlement_grants g WHERE g.member_id=$1 AND g.category='study_requests'`,
      [memberId],
    )
  ).rows[0]!;
  return row;
}
