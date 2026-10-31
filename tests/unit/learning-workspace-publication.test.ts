import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { learningWorkspacePack } from "../../src/learning-workspace-pack.ts";
import { learningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "../../src/practice-session-lifetime.ts";

vi.mock("../../src/practice-session-lifetime.ts", async (original) => ({
  ...(await original<object>()),
  practiceTransaction: vi.fn(),
}));
const pack = await learningWorkspacePack();
const expires = new Date(Date.now() + 60000);
let role = "editor",
  principal = true;
let rows: Array<Record<string, unknown>> = [];
const observe = vi.fn(async () => {});
const query = vi.fn(async (sql: string) => ({
  rows: sql.includes("FROM principals")
    ? principal
      ? [{ id: "editor-id", expires }]
      : []
    : sql.includes("FROM staff_profiles")
      ? role
        ? [{ role }]
        : []
      : sql.includes("FROM content_versions")
        ? rows
        : [],
}));
const load = vi.fn(async () => pack);
const tx = { query, observe, bounded: async <T>(f: () => Promise<T>) => f() };
const store = learningWorkspacePublicationStore({} as Pool, load);
beforeEach(() => {
  vi.clearAllMocks();
  role = "editor";
  principal = true;
  rows = [];
  observe.mockReset().mockResolvedValue(undefined);
  load.mockReset().mockResolvedValue(pack);
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use(tx as never),
  );
});
function saved(state = "draft") {
  const item = pack.publication;
  return {
    ...item,
    structured_prerequisites: item.structuredPrerequisites,
    minimum_experience: item.minimumExperience,
    rubric_version: item.rubricVersion,
    requires_qualified_signoff: false,
    state,
  };
}
it("LWORK-05 imports only a draft and preserves existing editorial state without republishing", async () => {
  expect(await store.import("editor-token")).toEqual({ kind: "imported" });
  const insert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT"));
  expect(insert?.[0]).not.toContain("published_at");
  expect(insert?.[0]).not.toContain("reviewed_at");
  expect(observe).toHaveBeenCalledTimes(2);
  for (const state of [
    "draft",
    "in_review",
    "approved",
    "published",
    "retired",
  ]) {
    rows = [saved(state)];
    query.mockClear();
    expect(await store.import("editor-token")).toEqual({ kind: "existing" });
    expect(
      query.mock.calls.some(
        ([sql]) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"),
      ),
    ).toBe(false);
  }
});
it("LWORK-05 gives current editors/reviewers the complete bundle, not member draft access", async () => {
  for (const currentRole of ["editor", "reviewer"]) {
    role = currentRole;
    expect(await store.preview("staff-token")).toEqual({
      kind: "ready",
      pack,
      state: "not-imported",
    });
    rows = [saved("in_review")];
    expect(await store.preview("staff-token")).toEqual({
      kind: "ready",
      pack,
      state: "in_review",
    });
    rows = [];
  }
  expect(await store.import("reviewer-token")).toEqual({ kind: "denied" });
  role = "operator";
  expect(await store.preview("operator-token")).toEqual({ kind: "denied" });
  role = "";
  expect(await store.preview("no-profile")).toEqual({ kind: "denied" });
  principal = false;
  expect(await store.preview("member-token")).toEqual({ kind: "denied" });
  expect(await store.preview("")).toEqual({ kind: "denied" });
  expect(await store.preview(null as never)).toEqual({ kind: "denied" });
});
it("LWORK-05 refuses mismatched registered metadata without overwriting catalog work", async () => {
  for (const change of [
    { version: 2 },
    { body: "Another draft" },
    { requires_qualified_signoff: true },
  ]) {
    rows = [{ ...saved(), ...change }];
    query.mockClear();
    expect(await store.import("editor-token")).toEqual({ kind: "conflict" });
    expect(await store.preview("editor-token")).toEqual({ kind: "conflict" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  }
});
it("LWORK-05/06 contains missing assets, lost authority and uncertain database outcomes", async () => {
  load.mockRejectedValueOnce(Error("private filesystem detail"));
  expect(await store.import("editor-token")).toEqual({ kind: "unavailable" });
  observe.mockRejectedValueOnce(new PracticeLifetimeFailure("denied"));
  expect(await store.import("expired-token")).toEqual({ kind: "denied" });
  vi.mocked(practiceTransaction).mockRejectedValueOnce(
    Error("private SQL detail"),
  );
  expect(await store.import("editor-token")).toEqual({ kind: "unavailable" });
  vi.mocked(practiceTransaction).mockRejectedValueOnce(
    new PracticeLifetimeFailure("unavailable"),
  );
  expect(await store.preview("editor-token")).toEqual({ kind: "unavailable" });
  const defaultStore = learningWorkspacePublicationStore({} as Pool);
  expect((await defaultStore.preview("editor-token")).kind).toBe("ready");
});
