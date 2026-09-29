import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { attemptStore } from "../../src/attempts.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-attempt-portfolio-secret";
const first = "Invented <private> first line\nKeep this line\r\n";
const second = "Invented <private> second line\nKeep this line\r\n";

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member setup failed");
  return { token, id: session.learner.id };
}

async function fixture(retire = true) {
  const owner = await member();
  const outsider = await member();
  const auth = authorizationStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id: "SYN-988",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented comparison assignment",
    body: "Only invented answers.",
    owner: "Synthetic editor",
    sources: "Original invented brief",
    rights: "Owned sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: "Compare against the invented brief.",
    rubricVersion: 1,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, draft.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, draft.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, draft.id, 1)).toBe(true);
  expect(await db.chooseAssignment(owner.id, draft.id, 1)).toBe(true);
  const attempts = attemptStore(pool);
  const id = (await attempts.start(owner.token))!;
  expect(await attempts.save(owner.token, id, 1, first)).toBe(true);
  expect(await attempts.submit(owner.token, id, 2)).toBe(true);
  expect(await attempts.revise(owner.token, id)).toBe(true);
  const revision = (await attempts.detail(owner.token, id))!.revision;
  expect(await attempts.save(owner.token, id, revision, second)).toBe(true);
  expect(await attempts.submit(owner.token, id, revision + 1)).toBe(true);
  if (retire) expect(await catalog.retire(editor, draft.id)).toBe(true);
  return { owner, outsider, reviewer, attempts, id, catalog, editor };
}

function get(token: string, id: string, query: string) {
  return request(app(db, { origin, secret, attempts: attemptStore(pool) }))
    .get(`/assignments/attempts/${id}/portfolio/${query}`)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${token}`);
}

it("downloads exact retained owner submissions after revision and retirement, with isolation and no writes", async () => {
  const { owner, outsider, reviewer, attempts, id, catalog, editor } =
    await fixture(false);
  expect(await attempts.revise(owner.token, id)).toBe(true);
  const revision = (await attempts.detail(owner.token, id))!.revision;
  expect(
    await attempts.save(
      owner.token,
      id,
      revision,
      "This is an unsubmitted private draft that must stay out of exports.",
    ),
  ).toBe(true);
  expect(await catalog.retire(editor, "SYN-988")).toBe(true);
  const before = await attempts.detail(owner.token, id);
  for (const [sequence, own, other] of [
    ["1", "first", "second"],
    ["2", "second", "first"],
  ]) {
    const result = await get(owner.token, id, sequence!);
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.text).toContain("SIMULATED · SELF-AUTHORED · UNREVIEWED");
    expect(result.text).toContain(`Invented &lt;private&gt; ${own} line`);
    expect(result.text).not.toContain(`Invented &lt;private&gt; ${other} line`);
    expect(result.text).toContain("&#13;\n");
    expect(result.text).not.toContain("unsubmitted private draft");
    expect(result.headers["content-disposition"]).toBe(
      `attachment; filename="simulated-portfolio-submission-${sequence}.html"`,
    );
  }
  expect(await attempts.detail(owner.token, id)).toEqual(before);
  for (const [token, target, sequence] of [
    [outsider.token, id, "1"],
    [reviewer, id, "1"],
    [owner.token, randomUUID(), "1"],
    [owner.token, id, "3"],
    [owner.token, id, "01"],
    [owner.token, id, "11"],
  ]) {
    const result = await get(token!, target!, sequence!);
    expect(result.status).not.toBe(200);
    expect(result.text).not.toContain("Invented &lt;private&gt;");
    expect(result.headers["content-disposition"]).toBeUndefined();
  }
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
    [owner.id],
  );
  expect((await get(owner.token, id, "1")).status).not.toBe(200);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP+interval '1 day' WHERE id=$1",
    [owner.id],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [owner.id],
  );
  const revoked = await get(owner.token, id, "1");
  expect(revoked.status).not.toBe(200);
  expect(revoked.text).not.toContain("Invented &lt;private&gt;");
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    owner.id,
  ]);
  expect(await attempts.remove(owner.token, id)).toBe(true);
  const gone = await get(owner.token, id, "1");
  expect(gone.status).toBe(404);
  expect(gone.text).not.toContain("Invented &lt;private&gt;");
});

it("does not fall back to attempt text for a missing snapshot or leak database failures", async () => {
  const { owner, id, attempts } = await fixture();
  await pool.query(
    "DELETE FROM assignment_submission_snapshots WHERE attempt_id=$1",
    [id],
  );
  const missing = await get(owner.token, id, "1");
  expect(missing.status).toBe(404);
  expect(missing.text).not.toContain("Invented &lt;private&gt;");
  const failing = await request(
    app(db, {
      origin,
      secret,
      attempts: {
        ...attempts,
        detail: async () => {
          throw new Error("private database detail");
        },
      },
    }),
  )
    .get(`/assignments/attempts/${id}/portfolio/1`)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner.token}`);
  expect(failing.status).toBe(503);
  expect(failing.text).not.toContain("private database detail");
  expect(failing.headers["content-disposition"]).toBeUndefined();
});

it("concurrent downloads and source deletion yield one complete snapshot or no attachment", async () => {
  const { owner, attempts, id } = await fixture();
  const baseline = await get(owner.token, id, "1");
  expect(baseline.status).toBe(200);
  expect((await get(owner.token, id, "1")).text).toBe(baseline.text);
  const [responses, removed] = await Promise.all([
    Promise.all(Array.from({ length: 4 }, () => get(owner.token, id, "1"))),
    attempts.remove(owner.token, id),
  ]);
  expect(removed).toBe(true);
  for (const response of responses) {
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) expect(response.text).toBe(baseline.text);
    else {
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.text).not.toContain("Invented &lt;private&gt;");
    }
  }
  const after = await get(owner.token, id, "1");
  expect(after.status).toBe(404);
  expect(after.text).not.toContain("Invented &lt;private&gt;");
});
