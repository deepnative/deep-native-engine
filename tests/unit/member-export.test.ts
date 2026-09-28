import { expect, it } from "vitest";
import type { Pool } from "pg";
import {
  disabledMemberExportStore,
  memberExportStore,
  MAX_MEMBER_EXPORT_RECORDS,
} from "../../src/member-export.ts";

function fakePool(
  owner: Record<string, unknown> | null,
  rows: (sql: string) => Record<string, unknown>[] = () => [],
  failAt?: string,
) {
  const statements: string[] = [];
  let released = false;
  let destroyed = false;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        if (failAt && sql.includes(failAt))
          throw new Error("private database details");
        if (
          sql.includes("FROM principals p JOIN learners l") ||
          sql.startsWith("SELECT id FROM principals")
        )
          return { rows: owner ? [owner] : [] };
        return { rows: rows(sql) };
      },
      release: (error?: Error) => {
        released = true;
        destroyed = error instanceof Error;
      },
    }),
  } as unknown as Pool;
  return {
    pool,
    statements,
    wasReleased: () => released,
    wasDestroyed: () => destroyed,
  };
}

it("fails closed without configured export storage or an active owner", async () => {
  expect(await disabledMemberExportStore().exportOwned("x")).toEqual({
    kind: "denied",
  });
  const fake = fakePool(null);
  expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(fake.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(fake.wasReleased()).toBe(true);
});

it("returns a versioned all-section snapshot after its authorized transaction commits", async () => {
  const fake = fakePool({ id: "member-1", goal: "everyday" }, (sql) =>
    sql.includes("FROM learning_milestones")
      ? [{ milestoneTitle: "Invented milestone" }]
      : [],
  );
  const result = await memberExportStore(fake.pool).exportOwned("x");
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v5",
      profile: { id: "member-1" },
      records: { milestones: [{ milestoneTitle: "Invented milestone" }] },
    },
  });
  expect(fake.statements).toContain("COMMIT");
  expect(fake.wasReleased()).toBe(true);
  expect(fake.wasDestroyed()).toBe(false);
});

it("rejects excessive records and bytes without returning a partial export", async () => {
  const many = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM exercises")
      ? Array.from({ length: MAX_MEMBER_EXPORT_RECORDS + 1 }, () => ({}))
      : [],
  );
  expect(await memberExportStore(many.pool).exportOwned("x")).toEqual({
    kind: "limit",
  });
  expect(many.statements).not.toContain("COMMIT");
  const huge = fakePool({ id: "member-1" }, (sql) =>
    sql.includes("FROM exercises")
      ? [{ instruction: "x".repeat(256 * 1024) }]
      : [],
  );
  expect(await memberExportStore(huge.pool).exportOwned("x")).toEqual({
    kind: "limit",
  });
  expect(huge.statements).not.toContain("COMMIT");
});

it("returns a generic unavailable result and releases a failed connection", async () => {
  const unavailable = memberExportStore({
    connect: async () => {
      throw new Error("private connection details");
    },
  } as unknown as Pool);
  expect(await unavailable.exportOwned("x")).toEqual({ kind: "unavailable" });
  const broken = fakePool({ id: "member-1" }, () => [], "FROM exercises");
  expect(await memberExportStore(broken.pool).exportOwned("x")).toEqual({
    kind: "unavailable",
  });
  expect(broken.wasReleased()).toBe(true);
  const rollbackFails = fakePool(null, () => [], "ROLLBACK");
  expect(await memberExportStore(rollbackFails.pool).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(rollbackFails.wasReleased()).toBe(true);
  expect(rollbackFails.wasDestroyed()).toBe(true);
});

it("withholds a snapshot if the member expires before commit", async () => {
  const statements: string[] = [];
  const fake = {
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: sql.includes("FROM principals p JOIN learners l")
            ? [{ id: "member-1" }]
            : [],
        };
      },
      release() {},
    }),
  } as unknown as Pool;
  expect(await memberExportStore(fake).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(statements).not.toContain("COMMIT");
  expect(statements.at(-1)).toBe("ROLLBACK");
});

it("withholds private records when commit fails", async () => {
  const fake = fakePool({ id: "member-1" }, () => [], "COMMIT");
  expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
    kind: "unavailable",
  });
  expect(fake.wasReleased()).toBe(true);
  expect(fake.statements.at(-1)).toBe("ROLLBACK");
});
