import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger, type LedgerCategory } from "../../src/ledger.ts";
import { store } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool),
  origin = "http://127.0.0.1:4317",
  reportPath = "/operator/ledger-reconciliation";
const audiences = [
  ["explorer", "everyday"],
  ["professional", "work"],
  ["technical", "build"],
] as const;
const categories: readonly LedgerCategory[] = [
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
  "study_requests",
];
test.afterAll(async () => pool.end());
function validityWindow() {
  return {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}
async function staff(role: "operator" | "platform_admin" | "reviewer") {
  const token = randomBytes(32).toString("hex");
  const id = await auth.provisionStaff(
    token,
    role,
    new Date(Date.now() + 3600000),
  );
  return { id, token };
}
async function member(
  background: (typeof audiences)[number][0],
  goal: (typeof audiences)[number][1],
) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background, goal });
  const state = await members.session(token);
  if (state.kind !== "active")
    throw new Error("Synthetic member fixture unavailable");
  return { id: state.learner.id, token };
}
async function session(page: Page, token: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
function category(page: Page, name: LedgerCategory) {
  return page.locator(`[data-ledger-category="${name}"]`);
}
async function expand(row: Locator) {
  if ((await row.getAttribute("open")) === null) {
    await row.locator("summary").focus();
    await row.page().keyboard.press("Enter");
    await expect(row).toHaveAttribute("open", "");
  }
}
async function numbers(row: Locator) {
  return row
    .locator("[data-field]")
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => [
          node.getAttribute("data-field")!,
          Number(node.textContent),
        ]),
      ),
    ) as Promise<Record<string, number>>;
}
async function read(page: Page) {
  const response = await page.goto(reportPath);
  expect(response!.status()).toBe(200);
  await expect(
    page.getByRole("heading", {
      name: "Synthetic ledger reconciliation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-ledger-category]")).toHaveCount(5);
}
async function fresh(
  page: Page,
  name: LedgerCategory,
  field: string,
  value: number,
) {
  await page
    .getByRole("link", { name: "Read a fresh snapshot", exact: true })
    .click();
  await expect(
    category(page, name).locator(`[data-field="${field}"]`),
  ).toHaveText(String(value));
}
async function assertPrivate(page: Page, privateValues: readonly string[]) {
  const html = await page.content();
  for (const value of privateValues) expect(html).not.toContain(value);
  await expect(page.locator("form")).toHaveCount(0);
}
// Approved #429 scope: v73 adds the two critical local journeys L111/L112
// (110 -> 112). L111 uses all three member backgrounds on desktop and mobile;
// L112 covers every required unauthorized class and actual SQL failure recovery.
// This extends only the accepted synthetic local slice, not full-MVP acceptance.
test("[L111] operators inspect separate exact ledger categories for all three audiences with attachments, reload and deletion", async ({
  page,
}, testInfo) => {
  const operator = await staff("operator"),
    admin = await staff("platform_admin");
  const retainedMembers: string[] = [];
  try {
    await session(page, operator.token);
    await page.goto("/operator/experts");
    const link = page.getByRole("link", {
      name: "Inspect synthetic ledger reconciliation",
      exact: true,
    });
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", {
        name: "Synthetic ledger reconciliation",
        exact: true,
      }),
    ).toBeVisible();
    for (const [background, goal] of audiences)
      await test.step(background, async () => {
        const baseline: Partial<
          Record<LedgerCategory, Record<string, number>>
        > = {};
        for (const name of categories)
          baseline[name] = await numbers(category(page, name));
        const learner = await member(background, goal);
        retainedMembers.push(learner.id);
        const privateValues = [
          learner.id,
          learner.token,
          operator.id,
          operator.token,
          admin.id,
          admin.token,
        ];
        for (const name of categories) {
          const minute = name.endsWith("_minutes"),
            quantity = minute ? 60 : 1,
            granted = minute ? 100 : 3;
          const grant = await ledger.grant(
            learner.id,
            name,
            granted,
            randomUUID(),
            validityWindow(),
          );
          const reserved = await ledger.reserve(
            learner.id,
            grant,
            quantity,
            randomUUID(),
          );
          privateValues.push(grant, reserved);
          if (
            name === "review_minutes" ||
            name === "support_minutes" ||
            name === "study_requests"
          ) {
            const reference = `synthetic:${randomUUID()}`;
            const attachment = await ledger.settleCompletion(
              learner.id,
              reserved,
              randomUUID(),
              name === "study_requests"
                ? { category: name, reference, quantity: 1 }
                : {
                    category: name,
                    reference,
                    deliveredMinutes: 45,
                    preparationMinutes: 15,
                  },
            );
            privateValues.push(reference, attachment);
          } else await ledger.consume(learner.id, reserved, randomUUID());
          const released = await ledger.reserve(
            learner.id,
            grant,
            1,
            randomUUID(),
          );
          await ledger.release(learner.id, released, randomUUID());
          await ledger.adjust(learner.id, grant, 1, randomUUID());
        }
        await fresh(
          page,
          "coach_minutes",
          "observed.grants",
          baseline.coach_minutes!["observed.grants"]! + 1,
        );
        for (const name of categories) {
          const row = category(page, name),
            before = baseline[name]!,
            minute = name.endsWith("_minutes"),
            quantity = minute ? 60 : 1,
            granted = minute ? 100 : 3,
            attached =
              name === "review_minutes" ||
              name === "support_minutes" ||
              name === "study_requests";
          await expand(row);
          const deltas: Record<string, number> = {
            "observed.grants": 1,
            "observed.reservations": 2,
            "observed.events": 6,
            "observed.completions": attached ? 1 : 0,
            "observed.granted": granted,
            "observed.available": granted - quantity - 1,
            "observed.reserved": 0,
            "observed.consumed": quantity,
            "observed.expired": 0,
            "observed.adjusted": 1,
            "events.grant": 1,
            "events.reserve": 2,
            "events.consume": 1,
            "events.release": 1,
            "events.expire": 0,
            "events.adjust": 1,
            "completion.attachedQuantity": attached ? quantity : 0,
            "completion.consumedWithoutAttachment": attached ? 0 : 1,
            "reconciliation.grants": 0,
            "reconciliation.reservations": 0,
            "reconciliation.events": 0,
            "reconciliation.completions": 0,
          };
          if (minute && attached) {
            deltas["completion.deliveredMinutes"] = 45;
            deltas["completion.preparationMinutes"] = 15;
          }
          for (const [field, delta] of Object.entries(deltas))
            await expect(row.locator(`[data-field="${field}"]`)).toHaveText(
              String(before[field]! + delta),
            );
          await expect(
            row.getByRole("heading", {
              name: "Structural reconciliation",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            row.getByText("not itself a discrepancy", { exact: false }),
          ).toBeVisible();
          await expect(
            row.getByText("not bookable or qualified capacity", {
              exact: false,
            }),
          ).toBeVisible();
        }
        await assertPrivate(page, privateValues);
        await expect(
          page.getByText(
            "Categories use different units and are never added together",
            { exact: false },
          ),
        ).toBeVisible();
        await expect(
          page.getByText(
            "Invoice, collected cash, provider, job and manual-source reconciliation are unavailable",
            { exact: false },
          ),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        if (background === "explorer")
          await page.screenshot({
            path: testInfo.outputPath("populated-report.png"),
            fullPage: true,
          });
        await page.reload();
        await expect(
          category(page, "review_minutes").locator(
            '[data-field="completion.attachedQuantity"]',
          ),
        ).toHaveText(
          String(baseline.review_minutes!["completion.attachedQuantity"]! + 60),
        );
        await members.remove(learner.id);
        await fresh(
          page,
          "coach_minutes",
          "observed.grants",
          baseline.coach_minutes!["observed.grants"]!,
        );
        for (const name of categories)
          expect(await numbers(category(page, name))).toEqual(baseline[name]);
      });
    await session(page, admin.token);
    await read(page);
    await assertPrivate(page, [admin.id, admin.token]);
  } finally {
    for (const id of retainedMembers) await members.remove(id);
    await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
      [operator.id, admin.id],
    ]);
  }
});
test("[L112] visible non-cancelling discrepancies survive denied sessions and database failure until explicit recovery", async ({
  page,
}) => {
  const operator = await staff("operator"),
    reviewer = await staff("reviewer"),
    revoked = await staff("operator"),
    expired = await staff("operator"),
    changed = await staff("operator"),
    learner = await member("professional", "work");
  const staffIds = [
      operator.id,
      reviewer.id,
      revoked.id,
      expired.id,
      changed.id,
    ],
    grants: string[] = [];
  let renamed = false;
  try {
    for (let i = 0; i < 2; i++) {
      const grant = await ledger.grant(
        learner.id,
        "review_minutes",
        100,
        randomUUID(),
        validityWindow(),
      );
      grants.push(grant);
      const consumed = await ledger.reserve(
        learner.id,
        grant,
        10,
        randomUUID(),
      );
      await ledger.consume(learner.id, consumed, randomUUID());
      await ledger.reserve(learner.id, grant, 10, randomUUID());
    }
    await session(page, operator.token);
    await read(page);
    const before = await numbers(category(page, "review_minutes"));
    // Controlled fixture corruption preserves category totals and DB conservation;
    // opposite grant-level reserved/consumed mismatches must not cancel out.
    await pool.query(
      "UPDATE synthetic_entitlement_grants SET reserved=reserved+CASE WHEN id=$1 THEN -1 ELSE 1 END, consumed=consumed+CASE WHEN id=$1 THEN 1 ELSE -1 END WHERE id=ANY($2::uuid[])",
      [grants[0], grants],
    );
    await fresh(
      page,
      "review_minutes",
      "reconciliation.grants",
      before["reconciliation.grants"]! + 2,
    );
    const row = category(page, "review_minutes");
    await expect(row).toHaveAttribute("open", "");
    await expect(row.locator("summary")).toContainText(
      "Structural discrepancies detected",
    );
    await expect(
      row.getByText("This report makes no correction", { exact: false }),
    ).toBeVisible();
    for (const field of ["observed.reserved", "observed.consumed"])
      await expect(row.locator(`[data-field="${field}"]`)).toHaveText(
        String(before[field]),
      );
    await session(page, changed.token);
    await read(page);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [revoked.id],
    );
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    await pool.query(
      "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
      [changed.id],
    );
    for (const [name, token] of [
      ["member", learner.token],
      ["reviewer", reviewer.token],
      ["revoked", revoked.token],
      ["expired", expired.token],
      ["changed profile", changed.token],
    ])
      await test.step(name!, async () => {
        await session(page, token!);
        const response = await page.goto(reportPath);
        expect(response!.status()).toBe(403);
        expect(response!.headers()["cache-control"]).toBe("no-store");
        await expect(page.getByRole("alert")).toContainText(
          "not available to this session",
        );
        await expect(page.locator("[data-field], time")).toHaveCount(0);
        await assertPrivate(page, [learner.id, ...grants, ...staffIds, token!]);
      });
    await session(page, operator.token);
    await read(page);
    await expect(
      category(page, "review_minutes").locator(
        '[data-field="reconciliation.grants"]',
      ),
    ).toHaveText(String(before["reconciliation.grants"]! + 2));
    // The generated test database and single browser worker isolate this actual
    // SQL failure. Restore the schema even if the 503 assertions fail.
    try {
      await pool.query(
        "ALTER TABLE synthetic_entitlement_grants RENAME COLUMN available TO dne429_unavailable_fixture",
      );
      renamed = true;
      const response = await page.goto(reportPath);
      expect(response!.status()).toBe(503);
      expect(response!.headers()["cache-control"]).toBe("no-store");
      await expect(page.getByRole("alert")).toContainText(
        "No report results are shown",
      );
      await expect(page.getByRole("alert")).toContainText(
        "Nothing is retried automatically",
      );
      await expect(page.locator("[data-field], time")).toHaveCount(0);
      await assertPrivate(page, [
        learner.id,
        ...grants,
        ...staffIds,
        "dne429_unavailable_fixture",
        "synthetic_entitlement_grants",
      ]);
    } finally {
      if (renamed) {
        await pool.query(
          "ALTER TABLE synthetic_entitlement_grants RENAME COLUMN dne429_unavailable_fixture TO available",
        );
        renamed = false;
      }
    }
    const restored = await page.reload();
    expect(restored!.status()).toBe(200);
    await expect(
      category(page, "review_minutes").locator(
        '[data-field="reconciliation.grants"]',
      ),
    ).toHaveText(String(before["reconciliation.grants"]! + 2));
    await pool.query(
      "UPDATE synthetic_entitlement_grants SET reserved=10,consumed=10 WHERE id=ANY($1::uuid[])",
      [grants],
    );
    await fresh(
      page,
      "review_minutes",
      "reconciliation.grants",
      before["reconciliation.grants"]!,
    );
    await expect(
      category(page, "review_minutes").locator("summary"),
    ).toContainText("Structural checks consistent");
  } finally {
    if (renamed)
      await pool.query(
        "ALTER TABLE synthetic_entitlement_grants RENAME COLUMN dne429_unavailable_fixture TO available",
      );
    await members.remove(learner.id);
    await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
      staffIds,
    ]);
  }
});
