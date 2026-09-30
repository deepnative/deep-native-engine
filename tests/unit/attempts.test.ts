import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  attemptStore,
  disabledAttemptStore,
  validReflectionInput,
} from "../../src/attempts.ts";
import { hash } from "../../src/store.ts";

it("keeps attempts disabled unless a real store is wired", async () => {
  const disabled = disabledAttemptStore();
  expect(await disabled.list("token")).toEqual([]);
  expect(await disabled.detail("token", "id")).toBeNull();
  expect(await disabled.start("token")).toBeNull();
  expect(await disabled.save("token", "id", 1, "draft")).toBe(false);
  expect(await disabled.submit("token", "id", 1)).toBe(false);
  expect(await disabled.revise("token", "id")).toBe(false);
  expect(await disabled.remove("token", "id")).toBe(false);
  expect(
    await disabled.saveReflection("token", "id", 1, 0, {
      evidence: "Synthetic evidence",
      gaps: "",
      intention: "",
    }),
  ).toBe(false);
  expect(await disabled.deleteReflection("token", "id", 1, 1)).toBe(false);
});

it("reads only the hashed owner session and preserves missing results", async () => {
  let listed: { id: string }[] = [];
  const detailQuery = vi.fn(async (statement: string, params?: unknown[]) => {
    if (statement.includes("FROM principals"))
      return {
        rows: [{ id: "member", expiresAt: new Date("2030-01-01") }],
      };
    if (statement.includes("FROM workspaces"))
      return { rows: [{ id: "workspace" }] };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: true }] };
    if (statement.includes("FROM assignment_attempts a"))
      return {
        rows: statement.includes('AS "submissionHistory"')
          ? listed
          : params?.[1] === "owned"
            ? [{ id: "owned", revision: 2 }]
            : [],
      };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query: detailQuery, release: vi.fn() }));
  const attempts = attemptStore({ connect } as unknown as Pool);
  const credential = "a".repeat(64);
  expect(await attempts.list(credential)).toEqual([]);
  expect(await attempts.detail(credential, "attempt-id")).toBeNull();
  expect(
    detailQuery.mock.calls.find(([sql]) =>
      sql.includes("FROM principals"),
    )?.[1],
  ).toEqual([hash(credential)]);
  expect(await attempts.detail(credential, "owned")).toMatchObject({
    id: "owned",
    revision: 2,
  });
  listed = [{ id: "owned" }];
  expect(await attempts.list(credential)).toEqual([{ id: "owned" }]);
});

it("rejects invalid reflection fields before storage", () => {
  expect(validReflectionInput({ evidence: " ", gaps: "", intention: "" })).toBe(
    false,
  );
  expect(
    validReflectionInput({
      evidence: "x".repeat(1001),
      gaps: "",
      intention: "",
    }),
  ).toBe(false);
  expect(
    validReflectionInput({ evidence: "", gaps: "uncertain", intention: "" }),
  ).toBe(true);
  expect(validReflectionInput(null as never)).toBe(false);
});

function detailPool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    attempt?: boolean;
    current?: boolean;
    rollbackFails?: boolean;
    rejectOn?: string;
  } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (statement: string) => {
    if (options.rejectOn && statement.includes(options.rejectOn))
      throw Error("Synthetic read failure");
    if (options.rollbackFails && statement === "ROLLBACK")
      throw Error("Synthetic rollback failure");
    if (statement.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "member", expiresAt: new Date("2030-01-01") }],
      };
    if (statement.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (statement.includes("FROM assignment_attempts a"))
      return {
        rows:
          options.attempt === false
            ? []
            : [{ id: "owned", rubric: "Versioned rubric" }],
      };
    if (statement.includes("FROM assignment_submission_snapshots s"))
      return {
        rows: [
          {
            sequence: 1,
            submittedAt: new Date("2026-09-30T00:01:00Z"),
            reflection: null,
            reflectionRevision: 0,
          },
        ],
      };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: options.current !== false }] };
    return { rows: [] };
  });
  return {
    pool: { connect: async () => ({ query, release }) } as unknown as Pool,
    query,
    release,
  };
}

it.each([
  ["revoked principal", { principal: false }],
  ["deleted workspace", { workspace: false }],
  ["foreign attempt", { attempt: false }],
  ["expired after text lock", { current: false }],
] as const)("withholds private detail for %s", async (_reason, options) => {
  const db = detailPool(options);
  expect(await attemptStore(db.pool).detail("owner", "attempt")).toBeNull();
  expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it("reads locked submission text only after current session check and commit", async () => {
  const db = detailPool();
  expect(await attemptStore(db.pool).detail("owner", "attempt")).toMatchObject({
    id: "owned",
    rubric: "Versioned rubric",
    submissions: [
      {
        sequence: 1,
        submittedAt: "2026-09-30T00:01:00.000Z",
        reflection: null,
        reflectionRevision: 0,
      },
    ],
  });
  const sql = db.query.mock.calls.map(([statement]) => statement);
  expect(
    sql.findIndex((statement) =>
      statement.includes("FROM assignment_submission_reflections"),
    ),
  ).toBeLessThan(
    sql.findIndex((statement) =>
      statement.includes("FROM assignment_submission_snapshots s"),
    ),
  );
  expect(sql.at(-1)).toBe("COMMIT");
});

it("drops an unsafe connection if private-detail rollback fails", async () => {
  const db = detailPool({ principal: false, rollbackFails: true });
  expect(await attemptStore(db.pool).detail("owner", "attempt")).toBeNull();
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("never returns private detail after a database read failure", async () => {
  const db = detailPool({ rejectOn: "FROM assignment_submission_snapshots s" });
  await expect(
    attemptStore(db.pool).detail("owner", "attempt"),
  ).rejects.toThrow("Synthetic read failure");
  expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
});

function transactionPool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    deleted?: boolean;
    current?: boolean;
    mutation?: boolean;
    rejectOn?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (statement: string, _params?: unknown[]) => {
    if (options.rejectOn && statement.startsWith(options.rejectOn))
      throw new Error("Simulated database failure");
    if (options.rollbackFails && statement === "ROLLBACK")
      throw new Error("Simulated rollback failure");
    if (
      statement.startsWith("INSERT INTO assignment_attempts") ||
      statement.startsWith("UPDATE assignment_attempts") ||
      statement.startsWith("WITH submitted") ||
      statement.startsWith("WITH owned")
    )
      return options.mutation === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "owned" }], rowCount: 1 };
    if (statement.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "member", expiresAt: new Date("2030-01-01") }],
      };
    if (statement.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (statement.startsWith("DELETE FROM assignment_attempts"))
      return { rowCount: options.deleted === false ? 0 : 1 };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: options.current !== false }] };
    return { rows: [], rowCount: 0 };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, connect, query, release };
}

it("confirms deletion only after the owning member's transaction commits", async () => {
  const db = transactionPool();
  const token = "a".repeat(64);
  expect(await attemptStore(db.pool).remove(token, "owned-attempt")).toBe(true);
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "COMMIT",
  );
  expect(db.query.mock.calls.map(([statement]) => statement)).not.toContain(
    "ROLLBACK",
  );
  expect(db.query.mock.calls[2]![1]).toEqual([hash(token)]);
  expect(db.query.mock.calls[4]![1]).toEqual(["member", "owned-attempt"]);
  expect(db.release).toHaveBeenCalledOnce();
  expect(db.release).toHaveBeenCalledWith(undefined);
});

const reflectionInput = {
  evidence: "Invented evidence",
  gaps: "",
  intention: "Invented next step",
};

it.each([
  [0, 0],
  [11, 0],
  [1.5, 0],
  [1, -1],
  [1, 1.5],
  [1, 2147483647],
])(
  "rejects invalid reflection CAS target %s/%s before database access",
  async (sequence, revision) => {
    const db = transactionPool();
    const attempts = attemptStore(db.pool);
    expect(
      await attempts.saveReflection(
        "owner",
        "attempt",
        sequence,
        revision,
        reflectionInput,
      ),
    ).toBe(false);
    expect(
      await attempts.deleteReflection("owner", "attempt", sequence, revision),
    ).toBe(false);
    expect(db.connect).not.toHaveBeenCalled();
  },
);

it("rejects empty, oversize and malformed reflection payloads before database access", async () => {
  const db = transactionPool();
  const attempts = attemptStore(db.pool);
  for (const input of [
    { evidence: " ", gaps: "", intention: "" },
    { evidence: "x".repeat(1001), gaps: "", intention: "" },
    { evidence: "valid", gaps: 3, intention: "" },
    null,
  ])
    expect(
      await attempts.saveReflection("owner", "attempt", 1, 0, input as never),
    ).toBe(false);
  expect(db.connect).not.toHaveBeenCalled();
});

it.each([0, 1])(
  "confirms reflection save revision %i only after commit",
  async (revision) => {
    const db = transactionPool();
    const originalQuery = db.query.getMockImplementation()!;
    let acknowledge!: () => void;
    const commit = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    db.query.mockImplementation(async (statement, params) => {
      if (statement === "COMMIT") await commit;
      return originalQuery(statement, params);
    });
    const complete = vi.fn();
    const pending = attemptStore(db.pool)
      .saveReflection("owner", "attempt", 1, revision, reflectionInput)
      .then(complete);
    await vi.waitFor(() =>
      expect(db.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT"),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(
      db.query.mock.calls.find(([sql]) => sql.startsWith("WITH owned"))?.[1],
    ).toEqual(
      revision === 0
        ? [hash("owner"), "attempt", 1, ...Object.values(reflectionInput)]
        : [
            hash("owner"),
            "attempt",
            1,
            ...Object.values(reflectionInput),
            revision,
          ],
    );
    acknowledge();
    await pending;
    expect(complete).toHaveBeenCalledWith(true);
  },
);

it("confirms reflection deletion after commit and never accepts first-save token", async () => {
  const db = transactionPool();
  const attempts = attemptStore(db.pool);
  expect(await attempts.deleteReflection("owner", "attempt", 1, 0)).toBe(false);
  expect(await attempts.deleteReflection("owner", "attempt", 1, 1)).toBe(true);
  expect(
    db.query.mock.calls.find(([sql]) => sql.startsWith("WITH owned"))?.[1],
  ).toEqual([hash("owner"), "attempt", 1, 1]);
  expect(db.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
});

it.each([
  ["missing principal", { principal: false }],
  ["missing workspace", { workspace: false }],
  ["foreign or stale row", { mutation: false }],
  ["expired after wait", { current: false }],
] as const)(
  "keeps reflection writes unconfirmed for %s",
  async (_reason, options) => {
    for (const operation of ["save", "delete"] as const) {
      const db = transactionPool(options);
      const attempts = attemptStore(db.pool);
      const result =
        operation === "save"
          ? await attempts.saveReflection(
              "owner",
              "attempt",
              1,
              0,
              reflectionInput,
            )
          : await attempts.deleteReflection("owner", "attempt", 1, 1);
      expect(result).toBe(false);
      expect(db.query.mock.calls.map(([sql]) => sql)).toContain(
        "mutation" in options ? "COMMIT" : "ROLLBACK",
      );
    }
  },
);

it.each(["WITH owned", "COMMIT"])(
  "does not claim a reflection save after %s fails",
  async (rejectOn) => {
    const db = transactionPool({ rejectOn });
    await expect(
      attemptStore(db.pool).saveReflection(
        "owner",
        "attempt",
        1,
        0,
        reflectionInput,
      ),
    ).rejects.toThrow();
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  },
);

it("keeps deletion unconfirmed while the commit acknowledgement is pending", async () => {
  const db = transactionPool();
  const originalQuery = db.query.getMockImplementation()!;
  let acknowledgeCommit!: () => void;
  const commit = new Promise<void>((resolve) => {
    acknowledgeCommit = resolve;
  });
  db.query.mockImplementation(async (statement, params) => {
    if (statement === "COMMIT") await commit;
    return originalQuery(statement, params);
  });
  const completed = vi.fn();
  const operation = attemptStore(db.pool)
    .remove("owner", "attempt")
    .then(completed);
  await vi.waitFor(() =>
    expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
      "COMMIT",
    ),
  );
  expect(completed).not.toHaveBeenCalled();
  acknowledgeCommit();
  await operation;
  expect(completed).toHaveBeenCalledWith(true);
});

it.each([
  ["revoked or missing member", { principal: false }],
  ["unavailable workspace", { workspace: false }],
  ["foreign or missing attempt", { deleted: false }],
  ["expired session after the row wait", { current: false }],
] as const)("does not delete an attempt for %s", async (_reason, options) => {
  const db = transactionPool(options);
  expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
  expect(db.query.mock.calls.map(([statement]) => statement)).not.toContain(
    "COMMIT",
  );
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "ROLLBACK",
  );
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it.each(["DELETE FROM assignment_attempts", "COMMIT"])(
  "does not confirm deletion after %s fails",
  async (statement) => {
    const db = transactionPool({ rejectOn: statement });
    expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a connection when failed deletion cannot be rolled back", async () => {
  const db = transactionPool({ deleted: false, rollbackFails: true });
  expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("fails closed when an attempt database connection is unavailable", async () => {
  const connect = vi
    .fn()
    .mockRejectedValue(new Error("Connection unavailable"));
  expect(
    await attemptStore({ connect } as unknown as Pool).remove(
      "owner",
      "attempt",
    ),
  ).toBe(false);
});

const mutations = ["start", "save", "submit", "revise"] as const;
function mutate(
  store: ReturnType<typeof attemptStore>,
  operation: (typeof mutations)[number],
) {
  if (operation === "start") return store.start("owner");
  if (operation === "save")
    return store.save("owner", "attempt", 2, "An invented replacement answer.");
  if (operation === "submit") return store.submit("owner", "attempt", 2);
  return store.revise("owner", "attempt");
}

it.each(mutations)(
  "confirms %s only after its transaction commits",
  async (operation) => {
    const db = transactionPool();
    const originalQuery = db.query.getMockImplementation()!;
    let acknowledgeCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      acknowledgeCommit = resolve;
    });
    db.query.mockImplementation(async (statement, params) => {
      if (statement === "COMMIT") await commit;
      return originalQuery(statement, params);
    });
    const completed = vi.fn();
    const pending = mutate(attemptStore(db.pool), operation).then(completed);
    await vi.waitFor(() =>
      expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
        "COMMIT",
      ),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(db.query.mock.calls[2]![1]).toEqual([hash("owner")]);
    acknowledgeCommit();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      operation === "start" ? "owned" : true,
    );
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it.each(mutations)(
  "does not confirm %s for denied, stale or expired state",
  async (operation) => {
    for (const options of [
      { principal: false },
      { workspace: false },
      { mutation: false },
      { current: false },
    ]) {
      const db = transactionPool(options);
      expect(await mutate(attemptStore(db.pool), operation)).toBe(
        operation === "start" ? null : false,
      );
      if (!("mutation" in options)) {
        expect(
          db.query.mock.calls.map(([statement]) => statement),
        ).not.toContain("COMMIT");
        expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
          "ROLLBACK",
        );
      }
      expect(db.release).toHaveBeenCalledWith(undefined);
    }
  },
);

it.each(["UPDATE assignment_attempts", "COMMIT"])(
  "preserves an unknown save outcome when %s fails",
  async (rejectOn) => {
    const db = transactionPool({ rejectOn });
    await expect(mutate(attemptStore(db.pool), "save")).rejects.toThrow(
      "Simulated database failure",
    );
    expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
      "ROLLBACK",
    );
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a connection when an expired mutation cannot roll back", async () => {
  const db = transactionPool({ current: false, rollbackFails: true });
  expect(await mutate(attemptStore(db.pool), "save")).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("keeps a connection failure as an unconfirmed write error", async () => {
  const pool = {
    connect: vi.fn().mockRejectedValue(new Error("Connection unavailable")),
  } as unknown as Pool;
  await expect(mutate(attemptStore(pool), "save")).rejects.toThrow(
    "Connection unavailable",
  );
});

it.each([
  ["revoked principal", { principal: false }],
  ["deleting workspace", { workspace: false }],
  ["expired after read", { current: false }],
] as const)(
  "distinguishes denied history from an empty history for %s",
  async (_reason, options) => {
    const db = detailPool(options);
    expect(await attemptStore(db.pool).list("owner")).toBeNull();
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);
