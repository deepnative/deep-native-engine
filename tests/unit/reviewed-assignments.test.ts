import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import * as catalog from "../../src/catalog.ts";
import {
  ASSIGNMENT_PACK,
  isReviewedAssignment,
  reviewedAssignments,
} from "../../src/reviewed-assignments.ts";
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
it("ASN103-01 loads exactly the two reviewed immutable assignments with inclusive ordinary metadata", async () => {
  const pack = await reviewedAssignments();
  expect(pack.map((x) => x.id)).toEqual(ASSIGNMENT_PACK.map((x) => x[0]));
  for (const item of pack) {
    expect(item.version).toBe(2);
    expect(item.kind).toBe("assignment");
    expect(item.rubricVersion).toBe(1);
    expect(item.rubric).toContain("Practice rubric v1");
    expect(item.backgrounds).toEqual(["explorer", "professional", "technical"]);
    expect(item.structuredPrerequisites).toEqual({
      schemaVersion: 1,
      all: [
        {
          kind: "lesson",
          id: "FND-002",
          version: 2,
          activity: "self-assessed",
        },
        {
          kind: "lesson",
          id: "FND-003",
          version: 2,
          activity: "self-assessed",
        },
      ],
    });
    expect(item.body).toContain(
      "an equivalent habit is guidance, not an automatically verified completion",
    );
    expect(item.sources).toContain("SHA-256");
    expect(catalog.validDraft(item)).toBe(true);
    expect(isReviewedAssignment(item)).toBe(true);
  }
  expect(pack[0]!.goals).toEqual(["build"]);
  expect(pack[1]!.goals).toEqual(["everyday", "work", "build"]);
  const lesson = pack[0]!;
  for (const change of [
    { id: "ASN-099" },
    { version: 1 },
    { origin: "member-proposal" as const },
    { sources: "Unreviewed" },
  ])
    expect(isReviewedAssignment({ ...lesson, ...change })).toBe(false);
});
it("ASN103-01 refuses changed or missing asset bytes before any catalog work", async () => {
  vi.mocked(readFile).mockResolvedValueOnce("tampered content");
  await expect(reviewedAssignments()).rejects.toThrow(
    "Reviewed assignment bytes unavailable",
  );
  vi.mocked(readFile).mockRejectedValueOnce(Error("Missing file"));
  await expect(reviewedAssignments()).rejects.toThrow("Missing file");
});
it("ASN103-01 checks parsed identity, version and valid catalog metadata", async () => {
  const parse = catalog.parseDraftFile;
  for (const change of [
    { id: "ASN-099" },
    { version: "1" },
    { rights: "" },
    { rubric_version: "2" },
  ] as Array<Record<string, string>>) {
    const spy = vi
      .spyOn(catalog, "parseDraftFile")
      .mockImplementation((text, path) => {
        const result = parse(text, path);
        return { ...result, meta: { ...result.meta, ...change } };
      });
    await expect(reviewedAssignments()).rejects.toThrow(
      "Reviewed assignment metadata unavailable",
    );
    spy.mockRestore();
  }
});
