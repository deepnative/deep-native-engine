import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import * as catalog from "../../src/catalog.ts";
import {
  FOUNDATION_PACK,
  isReviewedFoundation,
  reviewedFoundation,
} from "../../src/foundation-pack.ts";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  readFile: vi.fn((...args: Parameters<typeof readFile>) =>
    vi
      .importActual<typeof import("node:fs/promises")>("node:fs/promises")
      .then((m) => m.readFile(...args)),
  ),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readFile).mockClear();
});
it("FOUND-01 loads exactly the six reviewed immutable lessons with inclusive ordinary metadata", async () => {
  const pack = await reviewedFoundation();
  expect(pack.map((x) => x.id)).toEqual(FOUNDATION_PACK.map((x) => x[0]));
  for (const item of pack) {
    expect(item.version).toBe(2);
    expect(item.kind).toBe("lesson");
    expect(item.backgrounds).toEqual(["explorer", "professional", "technical"]);
    expect(item.structuredPrerequisites).toEqual({ schemaVersion: 1, all: [] });
    expect(item.body).toContain(
      "Suggested preparation (guidance, not an access requirement)",
    );
    expect(item.sources).toContain("SHA-256");
    expect(catalog.validDraft(item)).toBe(true);
    expect(isReviewedFoundation(item)).toBe(true);
  }
  const lesson = pack[0]!;
  for (const change of [
    { id: "FND-099" },
    { version: 1 },
    { origin: "member-proposal" as const },
    { sources: "Unreviewed" },
  ])
    expect(isReviewedFoundation({ ...lesson, ...change })).toBe(false);
});
it("FOUND-01 refuses changed or missing asset bytes before any catalog work", async () => {
  vi.mocked(readFile).mockResolvedValueOnce("tampered content");
  await expect(reviewedFoundation()).rejects.toThrow(
    "Reviewed foundation bytes unavailable",
  );
  vi.mocked(readFile).mockRejectedValueOnce(Error("Missing file"));
  await expect(reviewedFoundation()).rejects.toThrow("Missing file");
});
it("FOUND-01 checks parsed identity, version and valid catalog metadata", async () => {
  const parse = catalog.parseDraftFile;
  for (const change of [
    { id: "FND-099" },
    { version: "1" },
    { rights: "" },
  ] as Array<Record<string, string>>) {
    const spy = vi
      .spyOn(catalog, "parseDraftFile")
      .mockImplementation((text, path) => {
        const result = parse(text, path);
        return { ...result, meta: { ...result.meta, ...change } };
      });
    await expect(reviewedFoundation()).rejects.toThrow(
      "Reviewed foundation metadata unavailable",
    );
    spy.mockRestore();
  }
});
