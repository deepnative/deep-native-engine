import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
import { hash } from "../../src/store.ts";
import {
  sampleAssignmentActors,
  sampleAssignmentExecute,
  type SampleAssignmentPrincipal,
} from "../../src/sample-assignment-transaction.ts";

beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }),
);
afterEach(() => vi.useRealTimers());
const token = "a".repeat(64);
function fixture() {
  const expires = new Date("2040-01-01T00:00:00.000Z");
  const principals = new Map<string, SampleAssignmentPrincipal>([
    ["a", { id: "a", kind: "staff", expires, revoked: null }],
    ["b", { id: "b", kind: "staff", expires, revoked: null }],
    ["c", { id: "c", kind: "member", expires, revoked: null }],
  ]);
  const profiles = new Map([
    ["a", "reviewer"],
    ["b", "platform_admin"],
  ]);
  const credentialHashes = new Map([["b", hash(token)]]);
  const state = {
    identity: true,
    remaining: "8000",
    projection: "8000" as unknown,
    missingProjection: false,
    releaseDelay: 0,
    commitDelay: 0,
    releaseError: false,
    queryError: "",
  };
  const queries: { sql: string; values?: unknown[] }[] = [];
  const release = vi.fn(() => {
    if (state.releaseDelay) vi.advanceTimersByTime(state.releaseDelay);
    if (state.releaseError) throw Error("PRIVATE native failure");
  });
  const client = {
    query: (async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql === state.queryError) throw Error("PRIVATE database failure");
      if (sql === "COMMIT" && state.commitDelay)
        await new Promise((resolve) => setTimeout(resolve, state.commitDelay));
      let rows: object[] = [];
      if (sql.includes("token_hash=$1"))
        rows = state.identity ? [{ id: "b", expires }] : [];
      else if (sql.includes("WITH instant"))
        rows = [
          {
            remaining: state.remaining,
            valid: Number(state.remaining) > 0,
            observed: new Date(),
          },
        ];
      else if (sql.startsWith("SELECT EXTRACT"))
        rows = state.missingProjection ? [] : [{ remaining: state.projection }];
      else if (sql.includes("FROM principals WHERE id=$1")) {
        const found = principals.get(values?.[0] as string);
        rows =
          found &&
          (values?.[1] == null || credentialHashes.get(found.id) === values[1])
            ? [found]
            : [];
      } else if (sql.includes("FROM staff_profiles"))
        rows = (values?.[0] as string[]).flatMap((id) =>
          profiles.has(id) ? [{ id, role: profiles.get(id)! }] : [],
        );
      return { rows };
    }) as PoolClient["query"],
    release,
  };
  const connect = vi.fn(async () => client);
  return {
    state,
    queries,
    principals,
    profiles,
    credentialHashes,
    release,
    connect,
    pool: { connect } as unknown as Pool,
  };
}

it("REVADM-07 returns only database-fenced metadata after commit and native handback", async () => {
  const f = fixture();
  const result = await sampleAssignmentExecute(
    f.pool,
    token,
    false,
    async () => ({ kind: "ready", receipt: "invented structural reference" }),
  );
  expect(result).toMatchObject({
    kind: "ready",
    receipt: "invented structural reference",
    deadline: 8000,
  });
  expect(f.queries.at(-1)?.sql).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
  const identity = f.queries.find((q) => q.sql.includes("token_hash=$1"));
  expect(identity?.values?.[0]).not.toBe(token);
});

it("REVADM-06 revalidates the current credential after identity discovery and actor-lock wait", async () => {
  const f = fixture();
  const current = "b".repeat(64);
  const old = await sampleAssignmentExecute(
    f.pool,
    token,
    false,
    async (context) => {
      f.credentialHashes.set("b", hash(current));
      await sampleAssignmentActors(context, []);
      return { kind: "ready", private: "must not disclose" };
    },
  );
  expect(old).toEqual({ kind: "denied" });
  expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
  const next = await sampleAssignmentExecute(
    f.pool,
    current,
    false,
    async (context) => {
      await sampleAssignmentActors(context, []);
      return { kind: "ready" };
    },
  );
  expect(next).toMatchObject({ kind: "ready" });
});

it.each([false, true])(
  "REVADM-07 acquires every unique principal in sorted order before profiles, exclusive actor=%s",
  async (exclusive) => {
    const f = fixture();
    const result = await sampleAssignmentExecute(
      f.pool,
      token,
      exclusive,
      async (context) => {
        const actors = await sampleAssignmentActors(
          context,
          ["c", "a", "c", "b"],
          exclusive,
        );
        expect([...actors.principals.keys()]).toEqual(["a", "b", "c"]);
        return { kind: "ready" };
      },
    );
    expect(result).toMatchObject({ kind: "ready" });
    const locks = f.queries.filter((q) =>
      q.sql.includes("FROM principals WHERE id=$1"),
    );
    expect(locks.map((q) => q.values?.[0])).toEqual(["a", "b", "c"]);
    expect(locks[1]!.sql).toContain(exclusive ? "FOR UPDATE" : "FOR SHARE");
    expect(locks[0]!.sql).toContain("FOR SHARE");
    expect(locks[2]!.sql).toContain("FOR SHARE");
    expect(
      f.queries.findIndex((q) => q.sql.includes("FROM staff_profiles")),
    ).toBeGreaterThan(f.queries.indexOf(locks[2]!));
  },
);

it("REVADM-07 never renews the returned HTTP authority deadline when a later database clock observation allows more time", async () => {
  const f = fixture();
  f.state.remaining = "1000";
  const result = await sampleAssignmentExecute(
    f.pool,
    token,
    false,
    async () => {
      f.state.remaining = "3000";
      f.state.projection = "3000";
      return { kind: "ready" };
    },
  );
  expect(result).toMatchObject({ kind: "ready" });
  expect("deadline" in result && result.deadline).toBeLessThanOrEqual(1000);
});

it("REVADM-06 rejects malformed credentials without acquiring a connection", async () => {
  const f = fixture();
  const use = vi.fn(async () => ({ kind: "ready" }));
  expect(
    await sampleAssignmentExecute(f.pool, "not-a-token", true, use),
  ).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
  expect(use).not.toHaveBeenCalled();
});

it("REVADM-06 denies a missing current staff identity before invoking private work", async () => {
  const f = fixture();
  f.state.identity = false;
  const use = vi.fn(async () => ({ kind: "ready" }));
  expect(await sampleAssignmentExecute(f.pool, token, true, use)).toEqual({
    kind: "denied",
  });
  expect(use).not.toHaveBeenCalled();
  expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
});

it.each(["missing", "member", "revoked", "wrong-role"])(
  "REVADM-06 revalidates the locked actor: %s",
  async (change) => {
    const f = fixture();
    if (change === "missing") f.principals.delete("b");
    if (change === "member") f.principals.get("b")!.kind = "member";
    if (change === "revoked") f.principals.get("b")!.revoked = new Date();
    if (change === "wrong-role") f.profiles.set("b", "reviewer");
    const result = await sampleAssignmentExecute(
      f.pool,
      token,
      true,
      async (context) => {
        await sampleAssignmentActors(context, ["c"], true);
        return { kind: "ready", private: "must not disclose" };
      },
    );
    expect(result).toEqual({ kind: "denied" });
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
  },
);

it("REVADM-02 accepts a current reviewer only for the reviewer reference role", async () => {
  const f = fixture();
  f.profiles.set("b", "reviewer");
  const result = await sampleAssignmentExecute(
    f.pool,
    token,
    false,
    async (context) => {
      await sampleAssignmentActors(context, [], false, "reviewer");
      return { kind: "ready" };
    },
  );
  expect(result).toMatchObject({ kind: "ready" });
  expect(f.queries.some((q) => q.sql.includes("FOR UPDATE"))).toBe(false);
});

it.each([undefined, "", "NaN", "Infinity", 8000, null])(
  "REVADM-07 withholds malformed final DB projection %j",
  async (projection) => {
    const f = fixture();
    f.state.projection = projection;
    f.state.missingProjection = projection === undefined;
    const result = await sampleAssignmentExecute(
      f.pool,
      token,
      true,
      async () => ({ kind: "ready", private: "must not disclose" }),
    );
    expect(result).toEqual({ kind: "unavailable" });
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
  },
);

it.each(["0", "-1"])(
  "REVADM-07 denies an exhausted final authority projection %s",
  async (projection) => {
    const f = fixture();
    f.state.projection = projection;
    expect(
      await sampleAssignmentExecute(f.pool, token, true, async () => ({
        kind: "ready",
      })),
    ).toEqual({ kind: "denied" });
    expect(f.queries.some((q) => q.sql === "COMMIT")).toBe(false);
  },
);

it("REVADM-07 caps returned HTTP authority at the whole-operation bound", async () => {
  const f = fixture();
  f.state.remaining = "60000";
  f.state.projection = "60000";
  const result = await sampleAssignmentExecute(
    f.pool,
    token,
    false,
    async () => ({ kind: "ready" }),
  );
  expect(result).toMatchObject({ kind: "ready", deadline: 10000 });
});

it.each(["known", "unknown"])(
  "REVADM-08 preserves safe failure classification without leaking raw errors: %s",
  async (kind) => {
    const f = fixture();
    const result = await sampleAssignmentExecute(
      f.pool,
      token,
      true,
      async () => {
        throw kind === "known"
          ? new SampleFeedbackFailure("conflict")
          : Error("PRIVATE raw source and credential");
      },
    );
    expect(result).toEqual({
      kind: kind === "known" ? "conflict" : "unavailable",
    });
    expect(f.queries.at(-1)?.sql).toBe("ROLLBACK");
  },
);

it.each([false, true])(
  "REVADM-08 withholds a late actual COMMIT reply, writing=%s",
  async (writing) => {
    const f = fixture();
    f.state.remaining = "1000";
    f.state.projection = "1000";
    f.state.commitDelay = 1500;
    const operation = sampleAssignmentExecute(
      f.pool,
      token,
      writing,
      async () => ({ kind: "ready", private: "must not disclose" }),
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(await operation).toEqual({
      kind: writing ? "unavailable" : "denied",
    });
    expect(f.queries.filter((q) => q.sql === "COMMIT")).toHaveLength(1);
    expect(f.queries.some((q) => q.sql === "ROLLBACK")).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
  },
);

it.each([false, true])(
  "REVADM-08 withholds native handback past authority, writing=%s",
  async (writing) => {
    const f = fixture();
    f.state.remaining = "1000";
    f.state.projection = "1000";
    f.state.releaseDelay = 1001;
    expect(
      await sampleAssignmentExecute(f.pool, token, writing, async () => ({
        kind: "ready",
      })),
    ).toEqual({ kind: writing ? "unavailable" : "denied" });
    expect(f.queries.some((q) => q.sql === "ROLLBACK")).toBe(false);
  },
);

it("REVADM-08 withholds success after failed native handback", async () => {
  const f = fixture();
  f.state.releaseError = true;
  expect(
    await sampleAssignmentExecute(f.pool, token, true, async () => ({
      kind: "ready",
    })),
  ).toEqual({ kind: "unavailable" });
});
