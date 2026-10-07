import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  secret = "invented-workflow-history-secret",
  db = store(pool),
  feedback = workflowFeedbackStore(pool);
const options = { enabled: true, mode: "test" as const },
  reviews = workflowReviewStore(pool, options, secret);
const fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
it("WFREV-07 owned bounded history spans pages without duplicates and preserves withdrawn receipts during creation pause", async () => {
  const member = fresh(),
    other = fresh();
  await db.create(member, { background: "technical", goal: "work" });
  await db.create(other, { background: "professional", goal: "work" });
  expect(
    await feedback.save(
      member,
      "WF-001",
      1,
      "Invented private history source",
      0,
    ),
  ).toBe(true);
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    const preview = await reviews.preview(member, "WF-001");
    if (preview.kind !== "ready") throw Error("Private exact preview required");
    const intent = await reviews.request(member, {
      checked: preview.preview.checked,
      operationId: randomUUID(),
      confirm: "yes",
    });
    if (intent.kind !== "applied") throw Error("New finite request required");
    ids.push(intent.receipt.requestId);
    expect(
      await reviews.withdraw(
        member,
        intent.receipt.requestId,
        randomUUID(),
        "yes",
      ),
    ).toMatchObject({ kind: "applied", receipt: { state: "withdrawn" } });
  }
  const paused = workflowReviewStore(
    pool,
    { enabled: false, mode: "test" },
    secret,
  );
  expect(await paused.preview(member, "WF-001")).toEqual({
    kind: "unavailable",
  });
  const first = await paused.history(member);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready" || !first.next)
    throw Error("First bounded page required");
  expect(first.receipts).toHaveLength(20);
  expect(first.receipts.every((r) => r.state === "withdrawn")).toBe(true);
  const second = await paused.history(member, first.next);
  expect(second.kind).toBe("ready");
  if (second.kind !== "ready") throw Error("Second bounded page required");
  expect(second.receipts).toHaveLength(3);
  expect(second.next).toBeNull();
  const actual = [...first.receipts, ...second.receipts].map(
    (r) => r.requestId,
  );
  expect(new Set(actual).size).toBe(23);
  expect(actual).toEqual(ids);
  expect(JSON.stringify(first)).not.toContain(
    "Invented private history source",
  );
  expect(await reviews.history(other, first.next)).toEqual({ kind: "denied" });
  expect(await reviews.history(member, first.next.slice(0, -1) + "!")).toEqual({
    kind: "invalid",
  });
  expect(
    await workflowReviewStaffStore(pool, options, secret).list(
      member,
      first.next,
    ),
  ).toEqual({ kind: "invalid" });
  expect(await reviews.receipt(other, ids[0]!)).toEqual({ kind: "denied" });
  const own = await paused.receipt(member, ids[0]!);
  expect(own.kind).toBe("ready");
  if (own.kind !== "ready") throw Error("Retained own receipt required");
  expect(own.receipt.state).toBe("withdrawn");
  expect(
    (await feedback.list(member))?.find(
      (r) => r.workflowId === "WF-001" && r.workflowVersion === 1,
    )?.note,
  ).toBe("Invented private history source");
});
it("WFREV-04 exact receipt cannot treat identical-text recreation as the original permitted source", async () => {
  const member = fresh();
  await db.create(member, { background: "explorer", goal: "everyday" });
  const note = "Invented identical source through receipt reload";
  expect(await feedback.save(member, "WF-001", 1, note, 0)).toBe(true);
  const preview = await reviews.preview(member, "WF-001");
  if (preview.kind !== "ready") throw Error("Source preview required");
  const original = {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  };
  const intent = await reviews.request(member, original);
  if (intent.kind !== "applied") throw Error("Original permission required");
  expect(await feedback.withdraw(member, "WF-001", 1, 1)).toBe(true);
  expect(await feedback.save(member, "WF-001", 1, note, 0)).toBe(true);
  const receipt = await reviews.receipt(member, intent.receipt.requestId);
  expect(receipt.kind).toBe("ready");
  if (receipt.kind !== "ready")
    throw Error("Retained metadata receipt required");
  expect(receipt.receipt.state).toBe("superseded");
  expect(receipt.receipt.instanceId).toBe(intent.receipt.instanceId);
  expect(await reviews.request(member, original)).toMatchObject({
    kind: "replayed",
    receipt: { state: "superseded", instanceId: intent.receipt.instanceId },
  });
  expect(
    await reviews.request(member, { ...original, operationId: randomUUID() }),
  ).toEqual({ kind: "denied" });
  expect(
    (await feedback.list(member))?.find(
      (r) => r.workflowId === "WF-001" && r.workflowVersion === 1,
    )?.note,
  ).toBe(note);
});
