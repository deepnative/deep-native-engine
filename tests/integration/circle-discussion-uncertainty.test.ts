import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import {
  circleDiscussionStore,
  CIRCLE_DISCUSSION_POLICY,
} from "../../src/circle-discussion.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circle = "everyday-ai",
  secret = "invented-uncertainty-secret";
const discussion = circleDiscussionStore(pool, secret);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
for (const stage of ["before-commit", "after-commit", "release"] as const)
  it(`reconciles one original contribution key after ${stage} uncertainty without automatic replay or text resurrection`, async () => {
    const token = randomBytes(32).toString("hex"),
      key = randomUUID();
    await members.create(token, { background: "professional", goal: "work" });
    const session = await members.session(token);
    if (session.kind !== "active")
      throw Error("Invented uncertainty member unavailable");
    expect(await circleStore(pool).join(token, circle)).toBe("joined");
    expect(
      (
        await discussion.choose(
          token,
          circle,
          randomUUID(),
          "1",
          CIRCLE_DISCUSSION_POLICY,
          true,
        )
      ).kind,
    ).toBe("ready");
    let commits = 0,
      connections = 0;
    const faulted = {
      connect: async () => {
        connections++;
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (sql: string, values: unknown[] = []) => {
                if (sql === "COMMIT") {
                  commits++;
                  if (stage === "before-commit")
                    throw Error(
                      "Invented lost acknowledgement: no private details permitted",
                    );
                }
                const result = await target.query(sql, values);
                if (sql === "COMMIT" && stage === "after-commit")
                  throw Error("Invented lost acknowledgement");
                return result;
              };
            if (property === "release")
              return (error?: Error) => {
                target.release(error);
                if (stage === "release")
                  throw Error("Invented connection handback failure");
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    await expect(
      circleDiscussionStore(faulted, secret).post(
        token,
        circle,
        key,
        "Invented original question",
        true,
      ),
    ).rejects.toThrow("Circle outcome unconfirmed");
    expect({ commits, connections }).toEqual({ commits: 1, connections: 1 });
    const before = (
      await pool.query(
        "SELECT id,body FROM preview_circle_posts WHERE member_id=$1",
        [session.learner.id],
      )
    ).rows;
    expect(before).toHaveLength(stage === "before-commit" ? 0 : 1);
    const receipt = await discussion.post(
      token,
      circle,
      key,
      "Invented original question",
      true,
    );
    if (receipt.kind !== "ready")
      throw Error("Original-key reconciliation unavailable");
    if (before[0]) expect(receipt.value.id).toBe(before[0].id);
    expect(
      (
        await discussion.post(
          token,
          circle,
          key,
          "Different invented question",
          true,
        )
      ).kind,
    ).toBe("conflict");
    expect(
      (
        await pool.query(
          "SELECT body FROM preview_circle_posts WHERE member_id=$1",
          [session.learner.id],
        )
      ).rows,
    ).toEqual([{ body: "Invented original question" }]);
    expect(
      (await discussion.withdraw(token, circle, receipt.value.id, true)).kind,
    ).toBe("ready");
    expect(
      await discussion.post(
        token,
        circle,
        key,
        "Invented original question",
        true,
      ),
    ).toEqual(receipt);
    expect(
      (
        await pool.query(
          "SELECT body,fingerprint,state FROM preview_circle_posts WHERE member_id=$1",
          [session.learner.id],
        )
      ).rows,
    ).toEqual([{ body: null, fingerprint: null, state: "withdrawn" }]);
  });
