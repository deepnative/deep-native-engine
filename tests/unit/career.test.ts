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
  expect(await disabled.enable("member")).toBe(false);
  expect(await disabled.disable("member")).toBe(false);
  expect(await disabled.createEntry("member", entry)).toBe(false);
  expect(await disabled.updateEntry("member", id, 1, entry)).toBe(false);
  expect(await disabled.deleteEntry("member", id, 1)).toBe(false);
  expect(await disabled.createDraft("member", draft)).toBe(false);
  expect(await disabled.updateDraft("member", id, 1, draft)).toBe(false);
  expect(await disabled.approveDraft("member", id, 1)).toBe(false);
  expect(await disabled.revokeDraft("member", id, 1)).toBe(false);
  expect(await disabled.deleteDraft("member", id, 1)).toBe(false);
});

it("binds owner IDs and content in private, versioned career queries", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
  const db = careerStore({ query } as unknown as Pool);
  expect(await db.snapshot("member")).toEqual({
    enabled: false,
    entries: [],
    drafts: [],
  });
  query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
  query.mockResolvedValueOnce({
    rowCount: 1,
    rows: [{ id, ...entry, version: 1 }],
  });
  query.mockResolvedValueOnce({
    rowCount: 1,
    rows: [{ id, ...draft, approved: false, version: 1 }],
  });
  expect(await db.snapshot("member")).toMatchObject({
    enabled: true,
    entries: [{ id }],
    drafts: [{ id }],
  });
  query.mockResolvedValue({ rowCount: 1, rows: [] });
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
  const calls = query.mock.calls as [string, unknown[]][];
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
  query.mockResolvedValue({ rowCount: 0, rows: [] });
  expect(await db.approveDraft("member", id, 4)).toBe(false);
});
