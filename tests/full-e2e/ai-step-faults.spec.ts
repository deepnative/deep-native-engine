import { expect, test, type Page } from "@playwright/test";
import { TEST_AI_FAULT_MARKERS } from "../../src/adapters.ts";
import { testPool } from "../support/database.ts";
import {
  aiMember,
  grantStudyRequests,
  permitSample,
  signIn,
} from "../support/local-ai-journey.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

const DID_NOT_FINISH =
  "This attempt did not finish normally and will not retry automatically.";

// The member's held test request: its job, unit and any settlement.
async function heldRequest(memberId: string) {
  return (
    await pool.query(
      `SELECT j.status,j.safe_error,j.attempt_count,
        (SELECT string_agg(c.state,',') FROM ai_spending_commitments c WHERE c.job_id=j.id) AS commitments,
        (SELECT count(*)::int FROM ai_usage_settlements s WHERE s.job_id=j.id) AS settlements
       FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id WHERE j.member_id=$1`,
      [memberId],
    )
  ).rows;
}

async function runMetered(page: Page, text: string) {
  const sample = await permitSample(pool, page, text);
  await sample.item.getByLabel("Hold one existing local test request").check();
  await sample.item
    .getByRole("button", { name: "Use one local test request" })
    .click();
  await sample.item
    .getByRole("button", { name: "Run local test request" })
    .click();
  await expect(page.getByText(DID_NOT_FINISH, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto("/evidence/local-ai");
  return sample;
}

test("[F-BUILD-06-D] a timed-out or malformed AI step keeps its reservation held once and the page reports it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await requiredCheck(1, async () => {
    const member = await aiMember(pool);
    await grantStudyRequests(pool, member.id, 1);
    await signIn(page, member.token);
    const slow = await runMetered(
      page,
      `Invented source that never gets an answer ${TEST_AI_FAULT_MARKERS.timeout}`,
    );
    await expect(
      slow.item.getByText(
        "The AI step did not answer within 5 seconds, so it timed out.",
      ),
    ).toBeVisible();
    await expect(
      slow.item.getByText("One local test request: held."),
    ).toBeVisible();
    await expect(
      slow.item.getByRole("button", { name: /Run|Try/ }),
    ).toHaveCount(0);
    expect(await heldRequest(member.id)).toEqual([
      {
        status: "needs_reconciliation",
        safe_error: "provider_timeout",
        attempt_count: 1,
        commitments: "committed",
        settlements: 0,
      },
    ]);
  });
  await requiredCheck(2, async () => {
    const member = await aiMember(pool);
    await grantStudyRequests(pool, member.id, 1);
    await signIn(page, member.token);
    const garbled = await runMetered(
      page,
      `Invented source with an unexpected metered answer ${TEST_AI_FAULT_MARKERS.malformed}`,
    );
    await expect(
      garbled.item.getByText("its outcome is unknown and it stays held", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      garbled.item.getByText("One local test request: held."),
    ).toBeVisible();
    await expect(
      garbled.item.getByRole("button", { name: /Run|Try/ }),
    ).toHaveCount(0);
    expect(await heldRequest(member.id)).toEqual([
      {
        status: "needs_reconciliation",
        safe_error: "provider_outcome_unknown",
        attempt_count: 1,
        commitments: "committed",
        settlements: 0,
      },
    ]);
    // An unmetered simulation holds nothing, so its malformed answer is named.
    const free = await permitSample(
      pool,
      page,
      `Invented source with an unexpected free answer ${TEST_AI_FAULT_MARKERS.malformed}`,
    );
    await free.item
      .getByRole("button", { name: "Queue local simulation" })
      .click();
    await free.item
      .getByRole("button", { name: "Run local simulation" })
      .click();
    await page.goto("/evidence/local-ai");
    await expect(
      free.item.getByText(
        "The AI step answered, but not in the expected form, so nothing was shown or saved. Nothing was charged.",
        { exact: false },
      ),
    ).toBeVisible();
    const output = await pool.query(
      `SELECT count(*)::int AS saved FROM adapter_jobs j
       WHERE j.member_id=$1 AND j.id NOT IN (SELECT job_id FROM local_ai_test_unit_jobs)
         AND (j.status<>'failed' OR j.provider_operation_reference IS NOT NULL)`,
      [member.id],
    );
    expect(output.rows[0].saved).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
