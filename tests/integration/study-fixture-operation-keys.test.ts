import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { studyUnitFixtureStore } from "../../src/study-unit-fixtures.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// SFKEY-01..05 (#42): a study fixture operation key is unique only within the
// actor who used it, so another actor's key inspects and acts exactly like an
// unused one, and can never block an actor's own write.
const pool = testPool(),
  members = store(pool),
  authority = authorizationStore(pool),
  fixtures = studyUnitFixtureStore(pool, { mode: "test", enabled: true });
const token = () => randomBytes(32).toString("hex");
function value<T>(result: { kind: string; value?: T }): T {
  if (result.kind !== "ready")
    throw Error(`Expected ready, got ${result.kind}`);
  return result.value!;
}
/** What an actor learns from an answer, without its timing fields. */
const answer = (result: { kind: string; value?: unknown }) => ({
  kind: result.kind,
  value: result.value,
});
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());

async function administrator() {
  const admin = token();
  const id = await authority.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3_600_000),
  );
  return { admin, id };
}
async function member(administratorId: string) {
  const owner = token();
  await members.create(owner, { background: "explorer", goal: "everyday" });
  const session = await members.session(owner);
  if (session.kind !== "active") throw Error("Invented member missing");
  const checked = value(await fixtures.checkRequest(owner, administratorId));
  return { owner, checked, id: session.learner.id };
}

it("SFKEY-01 another member's request key neither blocks nor answers for your own request", async () => {
  const { id } = await administrator();
  const [a, b] = [await member(id), await member(id)];
  const key = randomUUID();
  const mine = value(await fixtures.request(a.owner, key, a.checked));
  const unused = answer(
    await fixtures.inspect(b.owner, randomUUID(), "request", b.checked),
  );
  expect(
    answer(await fixtures.inspect(b.owner, key, "request", b.checked)),
  ).toEqual(unused);
  const theirs = value(await fixtures.request(b.owner, key, b.checked));
  expect(theirs.id).not.toBe(mine.id);
  // Each member's own replay still answers with their own request.
  expect(value(await fixtures.request(a.owner, key, a.checked)).id).toBe(
    mine.id,
  );
  expect(
    value(await fixtures.inspect(b.owner, key, "request", b.checked)),
  ).toMatchObject({ id: theirs.id });
});

it("SFKEY-02 another administrator's issue key neither blocks nor answers for your own issue", async () => {
  const [first, second] = [await administrator(), await administrator()];
  const [a, b] = [await member(first.id), await member(second.id)];
  const ra = value(await fixtures.request(a.owner, randomUUID(), a.checked)),
    rb = value(await fixtures.request(b.owner, randomUUID(), b.checked));
  const ia = value(await fixtures.checkIssue(first.admin, ra.id)),
    ib = value(await fixtures.checkIssue(second.admin, rb.id));
  const key = randomUUID();
  value(await fixtures.issue(first.admin, key, ia));
  const unused = answer(
    await fixtures.inspect(second.admin, randomUUID(), "issue", ib),
  );
  expect(
    answer(await fixtures.inspect(second.admin, key, "issue", ib)),
  ).toEqual(unused);
  expect(
    value(await fixtures.issue(second.admin, key, ib)).grantId,
  ).toBeTruthy();
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM synthetic_entitlement_grants",
      )
    ).rows[0].n,
  ).toBe(2);
});

it("SFKEY-03 another member's withdrawal key neither blocks nor answers for your own withdrawal", async () => {
  const { id } = await administrator();
  const [a, b] = [await member(id), await member(id)];
  const ra = value(await fixtures.request(a.owner, randomUUID(), a.checked)),
    rb = value(await fixtures.request(b.owner, randomUUID(), b.checked));
  const key = randomUUID();
  value(await fixtures.withdraw(a.owner, key, ra.id));
  const unused = answer(
    await fixtures.inspect(b.owner, randomUUID(), "withdraw", rb.id),
  );
  expect(
    answer(await fixtures.inspect(b.owner, key, "withdraw", rb.id)),
  ).toEqual(unused);
  expect(
    value(await fixtures.withdraw(b.owner, key, rb.id)).withdrawnAt,
  ).toBeTruthy();
});

it("SFKEY-04 a member's own key keeps its meaning: a different request under it is a conflict", async () => {
  const { id } = await administrator();
  const a = await member(id);
  const key = randomUUID();
  const mine = value(await fixtures.request(a.owner, key, a.checked));
  expect(await fixtures.withdraw(a.owner, key, mine.id)).toMatchObject({
    kind: "conflict",
  });
});

it("SFKEY-05 erased members' keys reserve nothing, so two erased receipts can share a key", async () => {
  const { id } = await administrator();
  const [a, c] = [await member(id), await member(id)];
  const key = randomUUID();
  value(await fixtures.request(a.owner, key, a.checked));
  value(await fixtures.request(c.owner, key, c.checked));
  await pool.query("DELETE FROM principals WHERE id=ANY($1::uuid[])", [
    [a.id, c.id],
  ]);
  const left = await pool.query<{ actor: string | null }>(
    "SELECT actor_id AS actor FROM browser_study_fixture_operations WHERE operation_id=$1",
    [key],
  );
  expect(left.rows).toEqual([{ actor: null }, { actor: null }]);
});
