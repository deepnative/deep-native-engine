import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "@playwright/test";

type Check = { action: string; expected: string };
type Scenario = { cases: { id: string; requiredChecks: Check[] }[] };
const register = JSON.parse(
  readFileSync(new URL("../e2e/scenarios.json", import.meta.url), "utf8"),
) as { fullMvp: Scenario[] };
const checks = new Map(
  register.fullMvp.flatMap((family) =>
    family.cases.map((item) => [item.id, item.requiredChecks] as const),
  ),
);

// A completion marker is emitted only after the browser action and assertions
// inside this step finish. Reviewers still inspect assertions and trace content:
// a reporter marker alone cannot prove that a product outcome was observed.
export async function requiredCheck(
  index: number,
  actionAndAssertions: () => Promise<void>,
) {
  const info = test.info();
  const id = /^\[([A-Z0-9-]+)\]/.exec(info.title)?.[1];
  const check = id && checks.get(id)?.[index - 1];
  if (!id || !Number.isInteger(index) || !check)
    throw new Error("Unknown required full-MVP check");
  const digest = createHash("sha256")
    .update(JSON.stringify(check))
    .digest("hex");
  const description = `${id}:${index}:${digest}`;
  if (
    info.annotations.some(
      (entry) =>
        entry.type === "required-check" && entry.description === description,
    )
  )
    throw new Error("Duplicate required full-MVP check");
  await test.step(`[${id}:${index}] ${check.action}`, actionAndAssertions);
  info.annotations.push({ type: "required-check", description });
}
