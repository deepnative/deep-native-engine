import request from "supertest";
import { app } from "../../src/app.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  secret = "invented-private-workflow-recovery-secret",
  options = { enabled: true, mode: "test" as const };
const members = workflowReviewStore(pool, options, secret),
  staff = workflowReviewStaffStore(pool, options, secret);
const fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
async function fixture() {
  const member = fresh(),
    admin = fresh(),
    moderator = fresh();
  await store(pool).create(member, {
    background: "explorer",
    goal: "everyday",
  });
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const moderatorId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  expect(
    await workflowFeedbackStore(pool).save(
      member,
      "WF-001",
      1,
      "Invented private source for recovery",
      0,
    ),
  ).toBe(true);
  const preview = await members.preview(member, "WF-001");
  if (preview.kind !== "ready") throw Error("Private request preview required");
  const instruction = {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  };
  return { member, admin, moderator, moderatorId, instruction };
}
function loseActualCommit() {
  const statements: string[] = [];
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql === "COMMIT")
            throw Error(
              "Invented lost acknowledgement after actual PostgreSQL commit",
            );
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return { scoped, statements };
}
it.each(["request", "withdraw", "assign", "revoke"] as const)(
  "WFREV-06 actual committed %s remains inspectable and exactly replayable after its acknowledgement is lost",
  async (kind) => {
    const f = await fixture(),
      loss = loseActualCommit();
    const lostMember = workflowReviewStore(loss.scoped, options, secret),
      lostStaff = workflowReviewStaffStore(loss.scoped, options, secret);
    if (kind === "request") {
      expect(await lostMember.request(f.member, f.instruction)).toEqual({
        kind: "unavailable",
      });
      const recovered = await members.inspect(
        f.member,
        f.instruction.operationId,
      );
      expect(recovered.kind).toBe("ready");
      if (recovered.kind !== "ready" || !recovered.receipt)
        throw Error("Original request receipt required");
      expect(await members.request(f.member, f.instruction)).toMatchObject({
        kind: "replayed",
        receipt: recovered.receipt,
      });
    } else {
      const intent = await members.request(f.member, f.instruction);
      if (intent.kind !== "applied") throw Error("Member permission required");
      const requestId = intent.receipt.requestId,
        operationId = randomUUID();
      if (kind === "withdraw") {
        expect(
          await lostMember.withdraw(f.member, requestId, operationId, "yes"),
        ).toEqual({ kind: "unavailable" });
        const inspected = await members.inspect(f.member, operationId);
        expect(inspected.kind).toBe("ready");
        if (inspected.kind !== "ready" || !inspected.receipt)
          throw Error("Withdrawal receipt required");
        expect(inspected.receipt.state).toBe("withdrawn");
        expect(
          await members.withdraw(f.member, requestId, operationId, "yes"),
        ).toMatchObject({ kind: "replayed", receipt: inspected.receipt });
      } else {
        const checked = await staff.check(f.admin, requestId, f.moderatorId);
        if (checked.kind !== "ready")
          throw Error("Checked assignment required");
        if (kind === "assign") {
          expect(
            await lostStaff.assign(
              f.admin,
              checked.checked,
              operationId,
              "yes",
            ),
          ).toEqual({ kind: "unavailable" });
          const recovered = await staff.inspect(f.admin, operationId);
          expect(recovered.kind).toBe("ready");
          if (recovered.kind !== "ready" || !recovered.grant)
            throw Error("Committed assignment receipt required");
          const replay = await staff.assign(
            f.admin,
            checked.checked,
            operationId,
            "yes",
          );
          expect(replay.kind).toBe("replayed");
          if (replay.kind !== "replayed")
            throw Error("Exact assignment replay required");
          expect(replay.grant.grantId).toBe(recovered.grant.grantId);
          expect(
            await staff.read(f.moderator, recovered.grant.grantId),
          ).toMatchObject({
            kind: "ready",
            note: "Invented private source for recovery",
          });
        } else {
          const assigned = await staff.assign(
            f.admin,
            checked.checked,
            randomUUID(),
            "yes",
          );
          if (assigned.kind !== "applied") throw Error("Grant required");
          const grantId = assigned.grant.grantId;
          expect(
            await lostStaff.revoke(f.admin, grantId, operationId, "yes"),
          ).toEqual({ kind: "unavailable" });
          const recovered = await staff.inspect(f.admin, operationId);
          expect(recovered.kind).toBe("ready");
          if (recovered.kind !== "ready" || !recovered.grant)
            throw Error("Committed revocation receipt required");
          expect(recovered.grant.state).toBe("revoked");
          expect(
            await staff.revoke(f.admin, grantId, operationId, "yes"),
          ).toMatchObject({
            kind: "replayed",
            grant: { grantId, revokedAt: recovered.grant.revokedAt },
          });
          expect(await staff.read(f.moderator, grantId)).toEqual({
            kind: "denied",
          });
        }
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM workflow_review_grants",
            )
          ).rows[0].n,
        ).toBe(1);
      }
    }
    expect(loss.statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(loss.statements).not.toContain("ROLLBACK");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow_review_requests",
        )
      ).rows[0].n,
    ).toBe(1);
  },
);

it("WFREV-06 HTTP response after actual committed assignment retains the exact key and requires manual inspection/repeat", async () => {
  const f = await fixture();
  const intent = await members.request(f.member, f.instruction);
  if (intent.kind !== "applied") throw Error("Member permission required");
  const checked = await staff.check(
    f.admin,
    intent.receipt.requestId,
    f.moderatorId,
  );
  if (checked.kind !== "ready")
    throw Error("Checked exact assignment required");
  const observation = {
    committedWrites: 0,
    lostReplies: 0,
    rollbacksAfterCommit: 0,
  };
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      let granting = false,
        committed = false;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO workflow_review_grants"))
            granting = true;
          if (sql === "ROLLBACK" && committed)
            observation.rollbacksAfterCommit++;
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && granting) {
            committed = true;
            observation.committedWrites++;
            if (observation.lostReplies === 0) {
              observation.lostReplies++;
              throw Error("Invented lost assignment commit response");
            }
          }
          return result;
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const local = {
    origin: "http://localhost",
    secret,
    mode: "test" as const,
    localStaffEntry: true,
    workflowReviewStaff: workflowReviewStaffStore(scoped, options, secret),
  };
  await withLoopback(app(store(pool), local), async (server) => {
    const get = (path: string) =>
      request(server)
        .get(path)
        .set("Host", "localhost")
        .set("Cookie", `dne_staff=${f.admin}`);
    const post = (path: string, body: Record<string, string>) =>
      request(server)
        .post(path)
        .set("Host", "localhost")
        .set("Origin", "http://localhost")
        .set("Cookie", `dne_staff=${f.admin}`)
        .type("form")
        .send(body);
    const field = (html: string, name: string) =>
      html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1]!;
    const entry = await get("/operator/workflow-reviews").expect(200);
    const instruction = {
      csrf: field(entry.text, "csrf"),
      checked: checked.checked,
      operationId: randomUUID(),
      confirm: "yes",
    };
    const uncertain = await post(
      "/operator/workflow-reviews/assign",
      instruction,
    ).expect(503);
    expect(uncertain.text).toContain("A write may have committed");
    expect(field(uncertain.text, "operationId")).toBe(instruction.operationId);
    expect(field(uncertain.text, "checked")).toBe(instruction.checked);
    expect(uncertain.text).toContain(
      'action="/operator/workflow-reviews/inspect"',
    );
    expect(uncertain.text).toContain(
      'action="/operator/workflow-reviews/assign"',
    );
    expect(uncertain.text).toContain(
      "Deliberately repeat this exact original assignment",
    );
    expect(uncertain.text).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(uncertain.text).not.toContain(
      "Invented private source for recovery",
    );
    expect(observation).toEqual({
      committedWrites: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow_review_grants",
        )
      ).rows[0].n,
    ).toBe(1);
    const inspected = await post("/operator/workflow-reviews/inspect", {
      csrf: instruction.csrf,
      operationId: instruction.operationId,
    }).expect(200);
    const grantId = inspected.text.match(/data-grant-id="([^"]+)"/)![1]!;
    const repeated = await post(
      "/operator/workflow-reviews/assign",
      instruction,
    ).expect(200);
    expect(repeated.text).toContain(grantId);
    await get(`/operator/workflow-reviews/receipts/${grantId}`).expect(200);
    expect(observation).toEqual({
      committedWrites: 1,
      lostReplies: 1,
      rollbacksAfterCommit: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow_review_grants",
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
