import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "../../src/practice-session-lifetime.ts";
vi.mock("../../src/practice-session-lifetime.ts", async (original) => ({
  ...(await original<object>()),
  practiceTransaction: vi.fn(),
}));
const query = vi.fn(),
  observe = vi.fn(),
  expires = new Date(Date.now() + 3600000);
const store = foundationImportStore({} as Pool);
let rows: Array<Record<string, unknown>>;
beforeEach(() => {
  vi.resetAllMocks();
  rows = Array.from({ length: 6 }, (_, i) => ({
    id: `FND-00${i + 1}`,
    version: 1,
    state: "draft",
  }));
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM principals")
      ? [{ id: "editor", expires }]
      : sql.includes("FROM authorized_staff_profiles")
        ? [{ principal_id: "editor" }]
        : sql.includes("FROM content_versions")
          ? rows
          : [],
  }));
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe, bounded: (work) => work() }),
  );
});
it("FOUND-01 imports six drafts atomically and recognizes the same immutable pack without another write", async () => {
  expect(await store.import("editor-token")).toBe("imported");
  const writes = query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"));
  expect(writes).toHaveLength(1);
  const payload = JSON.parse(writes[0]![1][0]);
  expect(payload).toHaveLength(6);
  expect(
    payload.every(
      (x: Record<string, unknown>) =>
        x.requires_qualified_signoff === false && !Object.hasOwn(x, "state"),
    ),
  ).toBe(true);
  rows.push(
    ...payload.map((x: Record<string, unknown>) => ({
      ...x,
      state: "published",
      structured_prerequisites: { all: [], schemaVersion: 1 },
    })),
  );
  query.mockClear();
  expect(await store.import("another-current-editor")).toBe("existing");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it("FOUND-01 refuses missing originals, partial packs, changed versions and retirement without writes", async () => {
  const pack = await reviewedFoundation();
  const originals = [...rows];
  for (const conflict of [
    [],
    originals.slice(0, 5),
    [...originals, { id: "FND-001", version: 2, state: "draft" }],
    originals.map((x) => ({ ...x, state: "retired" })),
    [...originals, ...pack.map((x) => ({ ...x, id: "OTHER", state: "draft" }))],
    [...originals, ...pack.map((x) => ({ ...x, state: "draft" }))],
  ]) {
    rows = conflict;
    query.mockClear();
    expect(await store.import("editor")).toBe("conflict");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  }
});
it("FOUND-02 denies missing or wrong-role authority and contains uncertain failures", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  expect(await store.import("member")).toBe("denied");
  query
    .mockImplementationOnce(async () => ({ rows: [{ id: "editor", expires }] }))
    .mockResolvedValueOnce({ rows: [] });
  expect(await store.import("reviewer")).toBe("denied");
  observe.mockRejectedValueOnce(new PracticeLifetimeFailure("denied"));
  expect(await store.import("expired")).toBe("denied");
  vi.mocked(practiceTransaction).mockRejectedValueOnce(
    Error("private database error"),
  );
  expect(await store.import("editor")).toBe("unavailable");
  vi.mocked(practiceTransaction).mockRejectedValueOnce(
    new PracticeLifetimeFailure("unavailable"),
  );
  expect(await store.import("editor")).toBe("unavailable");
});
