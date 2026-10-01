import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  careerStore,
  disabledCareerStore,
  parseCareerEntry,
  parseCareerDraft,
  validCareerId,
  type CareerEntryInput,
  type CareerDraftInput,
} from "../../src/career.ts";

const entry: CareerEntryInput = {
  kind: "opportunity",
  title: "Explore a sample role",
  note: "Invented details only",
  nextAction: "Compare sample requirements",
  selfReportedOutcome: "I found an invented fit",
};
const draft: CareerDraftInput = {
  kind: "proposal",
  title: "Sample proposal",
  body: "This is an invented proposal with enough useful detail.",
};
const id = "a4ff1471-0226-4d5b-8677-99c0a94cdf40";

it("validates synthetic optional plans and unsent drafts before persistence", () => {
  expect(validCareerId(id)).toBe(true);
  expect(validCareerId("../other")).toBe(false);
  const parsed = parseCareerEntry({
    kind: "opportunity",
    title: `  ${entry.title}  `,
    note: entry.note,
    next_action: entry.nextAction,
    self_reported_outcome: entry.selfReportedOutcome,
    sample_only: "yes",
  });
  expect(parsed).toEqual({ input: entry, errors: [] });
  const errors = parseCareerEntry({
    kind: "client",
    title: "x",
    note: "a".repeat(1001),
    next_action: "x",
    self_reported_outcome: "b".repeat(501),
  }).errors;
  expect(errors).toHaveLength(6);
  expect(parseCareerEntry({ kind: ["opportunity"], title: "a" })).toMatchObject(
    {
      input: { kind: "", title: "a" },
    },
  );
  expect(
    parseCareerEntry({
      ...parsed.input,
      kind: "career",
      next_action: entry.nextAction,
      sample_only: "yes",
    }).errors,
  ).toEqual([]);
  expect(
    parseCareerEntry({
      ...parsed.input,
      kind: "contract",
      next_action: entry.nextAction,
      sample_only: "yes",
    }).errors,
  ).toEqual([]);
  expect(
    parseCareerEntry({
      kind: "career",
      title: "x".repeat(161),
      next_action: "y".repeat(501),
      sample_only: "yes",
    }).errors,
  ).toHaveLength(2);
  expect(
    parseCareerDraft({
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      sample_only: "yes",
    }),
  ).toEqual({ input: draft, errors: [] });
  expect(
    parseCareerDraft({
      kind: "renewal",
      title: "Renew sample",
      body: "a".repeat(20),
      sample_only: "yes",
    }).errors,
  ).toEqual([]);
  expect(
    parseCareerDraft({
      kind: "professional",
      title: "Sample note",
      body: "a".repeat(20),
      sample_only: "yes",
    }).errors,
  ).toEqual([]);
  expect(
    parseCareerDraft({ kind: "unknown", title: "x", body: "short" }).errors,
  ).toHaveLength(4);
  expect(
    parseCareerDraft({
      kind: "proposal",
      title: "x".repeat(161),
      body: "a".repeat(4001),
      sample_only: "yes",
    }).errors,
  ).toHaveLength(2);
});

it("fails closed when optional career storage is not configured", async () => {
  const disabled = disabledCareerStore();
  expect(await disabled.snapshot("member")).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
  expect(await disabled.enable("member")).toBeNull();
  expect(await disabled.disable("member")).toBeNull();
  expect(await disabled.createEntry("member", entry)).toBeNull();
  expect(await disabled.updateEntry("member", id, 1, entry)).toBeNull();
  expect(await disabled.deleteEntry("member", id, 1)).toBeNull();
  expect(await disabled.createDraft("member", draft)).toBeNull();
  expect(await disabled.updateDraft("member", id, 1, draft)).toBeNull();
  expect(await disabled.approveDraft("member", id, 1)).toBeNull();
  expect(await disabled.revokeDraft("member", id, 1)).toBeNull();
  expect(await disabled.deleteDraft("member", id, 1)).toBeNull();
});

it("binds owner IDs and content in private, versioned career queries", async () => {
  const { db, query, options } = mutationFixture();
  expect(await db.enable("member")).toBe(true);
  expect(await db.createEntry("member", entry)).toBe(true);
  expect(await db.updateEntry("member", id, 1, entry)).toBe(true);
  expect(await db.deleteEntry("member", id, 1)).toBe(true);
  expect(await db.createDraft("member", draft)).toBe(true);
  expect(await db.updateDraft("member", id, 1, draft)).toBe(true);
  expect(await db.approveDraft("member", id, 1)).toBe(true);
  expect(await db.revokeDraft("member", id, 2)).toBe(true);
  expect(await db.deleteDraft("member", id, 3)).toBe(true);
  expect(await db.disable("member")).toBe(true);
  const calls = query.mock.calls as unknown as [string, unknown[]][];
  expect(
    calls.filter(([sql]) => sql.includes("UPDATE career_drafts")),
  ).toHaveLength(3);
  expect(
    calls.filter(([sql]) =>
      sql.includes("DELETE FROM career_preferences"),
    )[0]?.[1],
  ).toEqual(["member"]);
  expect(calls.some(([sql]) => sql.includes(entry.note))).toBe(false);
  expect(
    calls.some(
      ([sql, values]) =>
        sql.includes("career_entries") && values?.includes(entry.note),
    ),
  ).toBe(true);
  options.changed = false;
  expect(await db.approveDraft("member", id, 4)).toBe(false);
});

function snapshotFixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    enabled?: boolean;
    current?: boolean;
    missingCurrent?: boolean;
    failRead?: boolean;
    failRollback?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.failRollback)
      throw new Error("synthetic rollback failure");
    if (sql.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ expiresAt: new Date(2000000000000) }],
      };
    if (sql.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (sql.includes("FROM career_preferences"))
      return { rowCount: options.enabled === false ? 0 : 1, rows: [] };
    if (sql.includes("FROM career_entries")) {
      if (options.failRead) throw new Error("synthetic read failure");
      return { rows: [{ id, ...entry, version: 1 }] };
    }
    if (sql.includes("FROM career_drafts"))
      return { rows: [{ id, ...draft, approved: false, version: 1 }] };
    if (sql.includes("AS valid"))
      return {
        rows: options.missingCurrent
          ? []
          : [{ valid: options.current !== false }],
      };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { db: careerStore(pool), query, release };
}
it("returns complete private career snapshots or a valid opted-out state", async () => {
  const active = snapshotFixture();
  expect(await active.db.snapshot("member")).toEqual({
    enabled: true,
    entries: [{ id, ...entry, version: 1 }],
    drafts: [{ id, ...draft, approved: false, version: 1 }],
  });
  expect(active.release).toHaveBeenCalledWith(undefined);
  const disabled = snapshotFixture({ enabled: false });
  expect(await disabled.db.snapshot("member")).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
});
it.each([
  { principal: false },
  { workspace: false },
  { current: false },
  { enabled: false, current: false },
  { missingCurrent: true },
])(
  "denies unavailable career authorization without a partial snapshot: %j",
  async (options) => {
    const fixture = snapshotFixture(options);
    expect(await fixture.db.snapshot("member")).toBeNull();
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixture.release).toHaveBeenCalledWith(undefined);
  },
);
it.each([false, true])(
  "does not return partial private career data after a read fault (rollback fault: %s)",
  async (failRollback) => {
    const fixture = snapshotFixture({ failRead: true, failRollback });
    await expect(fixture.db.snapshot("member")).rejects.toThrow(
      "synthetic read failure",
    );
    expect(fixture.release).toHaveBeenCalledWith(
      failRollback ? expect.any(Error) : undefined,
    );
  },
);

function mutationFixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    current?: boolean;
    missingCurrent?: boolean;
    changed?: boolean;
    fault?: string;
    rollbackFault?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.rollbackFault)
      throw new Error("synthetic rollback fault");
    if (
      options.fault &&
      (options.fault === "COMMIT"
        ? sql === "COMMIT"
        : sql.includes(options.fault))
    )
      throw new Error("synthetic database fault");
    if (sql.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ expiresAt: new Date(2000000000000) }],
      };
    if (sql.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (sql.includes("AS valid"))
      return {
        rows: options.missingCurrent
          ? []
          : [{ valid: options.current !== false }],
      };
    return { rowCount: options.changed === false ? 0 : 1, rows: [] };
  });
  const release = vi.fn();
  return {
    options,
    query,
    release,
    db: careerStore({
      connect: async () => ({ query, release }),
    } as unknown as Pool),
  };
}
it.each([
  { principal: false },
  { workspace: false },
  { current: false },
  { missingCurrent: true },
])(
  "rolls back denied career mutations instead of reporting an authorized conflict: %j",
  async (options) => {
    const fixture = mutationFixture(options);
    expect(await fixture.db.approveDraft("member", id, 1)).toBeNull();
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixture.query).not.toHaveBeenCalledWith("COMMIT");
    expect(fixture.release).toHaveBeenCalledWith(undefined);
    if (options.principal === false || options.workspace === false)
      expect(
        fixture.query.mock.calls.some(([sql]) =>
          sql.startsWith("UPDATE career_drafts"),
        ),
      ).toBe(false);
  },
);
it.each([
  "BEGIN",
  "SET LOCAL",
  "FROM principals",
  "FROM workspaces",
  "UPDATE career_drafts",
  "AS valid",
  "COMMIT",
])(
  "propagates %s failure without blind mutation retry and releases the connection",
  async (fault) => {
    const fixture = mutationFixture({ fault });
    await expect(fixture.db.approveDraft("member", id, 1)).rejects.toThrow(
      "synthetic database fault",
    );
    expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      fixture.query.mock.calls.filter(([sql]) =>
        fault === "COMMIT" ? sql === "COMMIT" : sql.includes(fault),
      ),
    ).toHaveLength(1);
    expect(fixture.release).toHaveBeenCalledWith(
      fault === "COMMIT" ? expect.any(Error) : undefined,
    );
  },
);
it.each([{ principal: false }, { fault: "UPDATE career_drafts" }])(
  "discards a connection whose career rollback fails: %j",
  async (options) => {
    const fixture = mutationFixture({ ...options, rollbackFault: true });
    await expect(fixture.db.approveDraft("member", id, 1)).rejects.toThrow(
      "Career mutation rollback failed",
    );
    expect(fixture.release).toHaveBeenCalledWith(expect.any(Error));
  },
);
