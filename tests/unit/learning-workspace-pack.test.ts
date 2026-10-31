import { beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { validDraft } from "../../src/catalog.ts";
import {
  LEARNING_WORKSPACE_CONTENT,
  learningWorkspacePack,
  resolveLearningWorkspaceBundle,
} from "../../src/learning-workspace-pack.ts";
import type { LearningIdentity } from "../../src/learning-workspace-values.ts";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
const original =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const bytes = await original.readFile(
  new URL(
    "../../assets/docs/content/learning-workspace/v1/course.json",
    import.meta.url,
  ),
);
beforeEach(() => vi.mocked(readFile).mockReset().mockResolvedValue(bytes));
const identity: LearningIdentity = {
  contentId: "LRN-001",
  contentVersion: 1,
  contentHash: LEARNING_WORKSPACE_CONTENT.contentHash,
  variant: "work",
};

it("LWORK-02/05 retains all authored lessons, examples and separate source identities", async () => {
  const pack = await learningWorkspacePack();
  expect(validDraft(pack.publication)).toBe(true);
  expect(pack.publication).toMatchObject({
    id: "LRN-001",
    version: 1,
    kind: "lesson",
    origin: "curated",
    minimumExperience: "new",
    structuredPrerequisites: { schemaVersion: 1, all: [] },
  });
  expect(pack.course.lessons.map((x) => x.title)).toEqual([
    "Choose a task you can check",
    "Write a useful request",
    "Check an answer against its source",
    "Choose what to use and share",
    "Build a small repeatable workflow",
    "Give feedback someone can use",
  ]);
  expect(pack.course.sources).toHaveLength(12);
  expect(Object.keys(pack.routes)).toEqual(["everyday", "work", "technical"]);
  for (const route of Object.values(pack.routes)) {
    expect(route.questionChoices.map((x) => x.length)).toEqual([
      1, 1, 3, 1, 1, 1,
    ]);
    expect(route.questionChoices[0]).toEqual([["A", "B", "C"]]);
    expect(route.reviewCriteria).toBe(6);
  }
  expect(pack.routes.work.feedback).toEqual({
    caseId: "L6-W-X",
    commentVersion: 1,
    initial: {
      id: 2,
      text: "Noor is the agenda owner; Lee invites participants.",
    },
  });
  expect(pack.routes.technical.feedback.initial).toEqual({
    id: 1,
    text: "3 MB PDF rejection test: passed.",
  });
  expect(pack.publication.body).toContain("does not replace FND v2");
  expect(pack.publication.body).toContain(
    "Saving neither submits an assignment nor shares",
  );
  expect(pack.publication.sources).toContain(
    LEARNING_WORKSPACE_CONTENT.fileHash,
  );
  expect(
    JSON.parse(pack.module.slice("export const course = ".length, -2)),
  ).toEqual(pack.course);
});

it("LWORK-05 resolves only the registered exact instructional version and variant", async () => {
  expect(await resolveLearningWorkspaceBundle(identity)).toMatchObject({
    contentHash: identity.contentHash,
  });
  for (const change of [
    { contentId: "FND-002" },
    { contentVersion: 2 },
    { contentHash: "a".repeat(64) },
    { variant: "build" },
  ]) {
    vi.mocked(readFile).mockClear();
    expect(
      await resolveLearningWorkspaceBundle({
        ...identity,
        ...change,
      } as LearningIdentity),
    ).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  }
});

it("LWORK-05 refuses missing or modified bundle bytes before publishing content", async () => {
  vi.mocked(readFile).mockRejectedValueOnce(Error("private path detail"));
  await expect(learningWorkspacePack()).rejects.toThrow(
    "Learning workspace content unavailable",
  );
  vi.mocked(readFile).mockResolvedValueOnce(
    Buffer.from(bytes.toString("utf8").replace("Noor", "Changed")),
  );
  await expect(learningWorkspacePack()).rejects.toThrow(
    "Learning workspace content unavailable",
  );
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("not json"));
  await expect(learningWorkspacePack()).rejects.toThrow(
    "Learning workspace content unavailable",
  );
});
