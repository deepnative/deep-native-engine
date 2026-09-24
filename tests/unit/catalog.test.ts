import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  catalogStore,
  disabledCatalogStore,
  seedDraftPack,
  parseDraftFile,
  validDraft,
  type DraftContent,
} from "../../src/catalog.ts";

const sample: DraftContent = {
  id: "SYN-001",
  version: 1,
  kind: "assignment",
  origin: "curated",
  title: "Synthetic exercise",
  body: "Use invented examples only.",
  owner: "Test editor",
  sources: "Original synthetic text",
  rights: "Owned synthetic sample",
  goals: ["everyday", "work"],
  backgrounds: ["explorer", "professional"],
  domains: ["education"],
  prerequisites: "None",
  rubric: "Check evidence and uncertainty.",
  rubricVersion: 1,
};
const query = vi.fn();
const pool = { query } as unknown as Pool;
const catalog = catalogStore(pool);
beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rowCount: 1, rows: [] });
});
it("validates versioned metadata and audience tags before creating a draft", async () => {
  expect(validDraft(sample)).toBe(true);
  expect(validDraft({ ...sample, minimumExperience: "some" })).toBe(true);
  expect(
    validDraft({
      ...sample,
      minimumExperience: "unknown",
    } as unknown as DraftContent),
  ).toBe(false);
  for (const change of [
    { id: "bad" },
    { version: 0 },
    { kind: "course" },
    { origin: "outside" },
    { title: " " },
    { body: " " },
    { owner: " " },
    { sources: " " },
    { rights: " " },
    { goals: ["invalid"] },
    { goals: ["work", "work"] },
    { backgrounds: ["invalid"] },
    { domains: ["invalid"] },
    { rubric: null },
    { rubricVersion: null },
  ]) {
    expect(validDraft({ ...sample, ...change } as DraftContent)).toBe(false);
  }
  for (const change of [
    { title: "a".repeat(161) },
    { body: "a".repeat(20001) },
    { owner: "a".repeat(161) },
    { sources: "a".repeat(2001) },
    { rights: "a".repeat(2001) },
    { prerequisites: "a".repeat(2001) },
    { rubric: "a".repeat(10001) },
    { rubricVersion: -1 },
  ])
    expect(validDraft({ ...sample, ...change })).toBe(false);
  expect(validDraft({ ...sample, rubric: null, rubricVersion: null })).toBe(
    true,
  );
  expect(await catalog.createDraft("token", { ...sample, id: "bad" })).toBe(
    false,
  );
  expect(query).not.toHaveBeenCalled();
  expect(await catalog.createDraft("token", sample)).toBe(true);
  expect(query.mock.calls[0]![1]).toContain("SYN-001");
  query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  expect(await catalog.createDraft("token", sample)).toBe(false);
});
it("requires each content transition to update exactly one eligible row", async () => {
  expect(await catalog.approve("reviewer", "SYN-001", 1, false)).toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(await catalog.submit("editor", "SYN-001", 1)).toBe(true);
  expect(await catalog.approve("reviewer", "SYN-001", 1, true)).toBe(true);
  expect(await catalog.publish("editor", "SYN-001", 1)).toBe(true);
  expect(await catalog.retire("editor", "SYN-001")).toBe(true);
  expect(query.mock.calls.map((call) => call[0])).toEqual([
    expect.stringContaining("state='in_review'"),
    expect.stringContaining("state='approved'"),
    expect.stringContaining("state='published'"),
    expect.stringContaining("state='retired'"),
  ]);
  query.mockResolvedValue({ rowCount: 0, rows: [] });
  expect(await catalog.submit("editor", "SYN-001", 1)).toBe(false);
  expect(await catalog.approve("reviewer", "SYN-001", 1, true)).toBe(false);
  expect(await catalog.publish("editor", "SYN-001", 1)).toBe(false);
  expect(await catalog.retire("editor", "SYN-001")).toBe(false);
  query.mockResolvedValueOnce({ rowCount: null, rows: [] });
  expect(await catalog.retire("editor", "SYN-001")).toBe(false);
});
it("keeps staff drafts separate from eligible published member search", async () => {
  query.mockResolvedValueOnce({ rows: [sample] });
  expect(await catalog.preview("editor", "SYN-001", 1)).toEqual(sample);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await catalog.preview("other", "SYN-001", 1)).toBeNull();
  query.mockResolvedValueOnce({ rows: [sample] });
  expect(await catalog.staffList("editor")).toEqual([sample]);
  query.mockResolvedValueOnce({ rows: [{ id: null }] });
  expect(await catalog.staffList("editor")).toEqual([]);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await catalog.staffList("member")).toBeNull();
  query.mockResolvedValueOnce({ rows: [sample] });
  expect(await catalog.published("SYN-001")).toEqual(sample);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await catalog.published("missing")).toBeNull();
  query.mockResolvedValueOnce({ rows: [sample] });
  expect(
    await catalog.search({
      q: "sample",
      goal: "work",
      background: "professional",
      domain: "education",
    }),
  ).toEqual([sample]);
  expect(query.mock.calls.at(-1)![1]).toEqual([
    "sample",
    "work",
    "professional",
    "education",
  ]);
  expect(await catalog.search({ goal: "admin" })).toEqual([]);
  expect(await catalog.search({ background: "admin" })).toEqual([]);
  expect(await catalog.search({ domain: "admin" })).toEqual([]);
  expect(query).toHaveBeenCalledTimes(8);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await catalog.search({})).toEqual([]);
});
it("records only a reviewer-assigned simulated assessment against exact content and rubric versions", async () => {
  expect(
    await catalog.assess("reviewer", "member", "SYN-001", 1, " "),
  ).toBeNull();
  expect(
    await catalog.assess("reviewer", "member", "SYN-001", 1, "x".repeat(4001)),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [{ id: "assessment-1" }] });
  expect(
    await catalog.assess(
      "reviewer",
      "member",
      "SYN-001",
      1,
      "Needs a source check",
    ),
  ).toBe("assessment-1");
  expect(query.mock.calls[0]![0]).toContain("g.staff_role='reviewer'");
  expect(query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    "member",
    expect.any(String),
    "SYN-001",
    1,
    "Needs a source check",
  ]);
  query.mockResolvedValueOnce({ rows: [] });
  expect(
    await catalog.assess("other", "member", "SYN-001", 1, "Result"),
  ).toBeNull();
});
it("imports all twelve real PLAN-004 assets only as sign-off-blocked drafts", async () => {
  expect(() => parseDraftFile("broken", "bad.md")).toThrow(
    "Invalid draft content file",
  );
  expect(
    parseDraftFile("---\nid: SYN-001\n---\nA body", "ok.md"),
  ).toMatchObject({
    meta: { id: "SYN-001" },
    body: "A body",
    prerequisites: "",
  });
  expect(await seedDraftPack(pool)).toBe(12);
  expect(query).toHaveBeenCalledTimes(12);
  expect(query.mock.calls[0]![1][0]).toBe("FND-001");
  expect(query.mock.calls[0]![0]).toContain("requires_qualified_signoff");
  expect(query.mock.calls[6]![1][0]).toBe("ASN-001");
  expect(query.mock.calls[6]![1][12]).toContain("Draft rubric");
  query.mockResolvedValue({ rowCount: null, rows: [] });
  expect(await seedDraftPack(pool)).toBe(0);
});
it("has a safe disabled catalog when the app is not connected to one", async () => {
  const disabled = disabledCatalogStore();
  expect(await disabled.createDraft("x", sample)).toBe(false);
  expect(await disabled.submit("x", "SYN-001", 1)).toBe(false);
  expect(await disabled.approve("x", "SYN-001", 1, true)).toBe(false);
  expect(await disabled.publish("x", "SYN-001", 1)).toBe(false);
  expect(await disabled.retire("x", "SYN-001")).toBe(false);
  expect(await disabled.preview("x", "SYN-001", 1)).toBeNull();
  expect(await disabled.staffList("x")).toBeNull();
  expect(await disabled.published("SYN-001")).toBeNull();
  expect(await disabled.search({})).toEqual([]);
  expect(
    await disabled.assess("x", "member", "SYN-001", 1, "Result"),
  ).toBeNull();
});
