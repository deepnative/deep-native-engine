import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledProposalStore,
  proposalStore,
  validProposal,
  type Proposal,
} from "../../src/proposals.ts";

const value = {
  title: "Original sample",
  body: "Invented community event plan",
  sources: "Original invented details",
};
const draft: Proposal = {
  id: "synthetic",
  title: value.title,
  body: value.body,
  sources: value.sources,
  state: "draft",
  createdAt: new Date("2026-09-23"),
  submittedAt: null,
};
it("accepts only bounded nonblank sample fields", () => {
  expect(validProposal(value)).toBe(true);
  for (const invalid of [
    { title: " " },
    { title: "x".repeat(161) },
    { body: " " },
    { body: "x".repeat(4001) },
    { sources: " " },
    { sources: "x".repeat(1001) },
  ])
    expect(validProposal({ ...value, ...invalid })).toBe(false);
});
it("fails closed when proposal storage is unavailable", async () => {
  const disabled = disabledProposalStore();
  expect(await disabled.createDraft("member", value, true)).toBeNull();
  expect(await disabled.owned("member")).toEqual([]);
  expect(await disabled.preview("member", draft.id)).toBeNull();
  expect(await disabled.submit("member", draft.id, true)).toBe(false);
  expect(await disabled.withdraw("member", draft.id)).toBe(false);
  expect(await disabled.moderationQueue("moderator")).toBeNull();
  expect(await disabled.moderate("moderator", draft.id, "reject")).toBe(false);
});
it("keeps invalid consent and rights submissions out of storage", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const store = proposalStore({ query } as unknown as Pool);
  expect(await store.createDraft("member", value, false)).toBeNull();
  expect(
    await store.createDraft("member", { ...value, title: " " }, true),
  ).toBeNull();
  expect(await store.submit("member", draft.id, false)).toBe(false);
  expect(await store.moderate("staff", draft.id, "approve" as "reject")).toBe(
    false,
  );
  expect(query).not.toHaveBeenCalled();
});
it("bounds member operations and binds moderation reads to fresh role authorization", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ id: draft.id }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ allowed: false, id: null }] })
    .mockResolvedValueOnce({ rows: [{ allowed: true, id: null }] })
    .mockResolvedValueOnce({ rows: [{ allowed: true, ...draft }] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 });
  const store = proposalStore({ query } as unknown as Pool);
  expect(await store.createDraft("member", value, true)).toBe(draft.id);
  expect(await store.createDraft("unknown", value, true)).toBeNull();
  expect(await store.owned("member")).toEqual([draft]);
  expect(await store.preview("member", draft.id)).toEqual(draft);
  expect(await store.preview("other", draft.id)).toBeNull();
  expect(await store.submit("member", draft.id, true)).toBe(true);
  expect(await store.submit("other", draft.id, true)).toBe(false);
  expect(await store.withdraw("member", draft.id)).toBe(true);
  expect(await store.withdraw("other", draft.id)).toBe(false);
  expect(await store.moderationQueue("member")).toBeNull();
  expect(await store.moderationQueue("moderator")).toEqual([]);
  expect(await store.moderationQueue("moderator")).toEqual([draft]);
  expect(await store.moderate("moderator", draft.id, "quarantine")).toBe(true);
  expect(await store.moderate("moderator", draft.id, "reject")).toBe(false);
  expect(query.mock.calls[9]?.[0]).toContain("LEFT JOIN LATERAL");
  expect(query.mock.calls[12]?.[0]).toContain(
    "title=CASE WHEN $3='rejected' THEN NULL",
  );
});
