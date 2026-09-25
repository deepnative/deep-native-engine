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
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        if (failAt && sql.includes(failAt))
          throw new Error("private database details");
        if (sql.includes("FROM principals p JOIN learners l"))
          return { rows: owner ? [owner] : [] };
        return { rows: rows(sql) };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as Pool;
  return { pool, statements, wasReleased: () => released };
}

it("fails closed without configured export storage or an active owner", async () => {
  expect(await disabledMemberExportStore().exportOwned("x")).toEqual({
    kind: "denied",
  });
  const fake = fakePool(null);
  expect(await memberExportStore(fake.pool).exportOwned("x")).toEqual({
    kind: "denied",
  });
  expect(fake.statements[0]).toBe(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  expect(fake.wasReleased()).toBe(true);
});

it("returns a versioned all-section snapshot after a read-only commit", async () => {
  const fake = fakePool({ id: "member-1", goal: "everyday" }, (sql) =>
    sql.includes("FROM learning_milestones")
      ? [{ milestoneTitle: "Invented milestone" }]
      : [],
  );
  const result = await memberExportStore(fake.pool).exportOwned("x");
  expect(result).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v1",
      profile: { id: "member-1" },
      records: { milestones: [{ milestoneTitle: "Invented milestone" }] },
    },
  });
  expect(fake.statements).toContain("COMMIT");
  expect(fake.wasReleased()).toBe(true);
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
});
