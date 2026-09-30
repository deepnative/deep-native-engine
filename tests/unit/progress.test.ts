import { expect, it } from "vitest";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import { activityItems } from "../../src/progress.ts";
import type { LessonActivity } from "../../src/store.ts";
import { privateProgressPage } from "../../src/views.ts";

const now = new Date("2026-09-25T12:00:00Z");
const lesson = (changes: Partial<LessonActivity> = {}): LessonActivity => ({
  contentId: "synthetic-lesson",
  contentVersion: 2,
  title: "A useful invented lesson",
  openedAt: now,
  startedAt: null,
  selfAssessedAt: null,
  available: true,
  ...changes,
});
const attempt = (
  changes: Partial<AssignmentAttempt> = {},
): AssignmentAttempt => ({
  id: "8f43dd18-6f38-4894-b348-ac0288dc15e3",
  contentId: "sample-assignment",
  contentVersion: 3,
  title: "An invented project",
  rubric: null,
  rubricVersion: null,
  goalAtStart: "work",
  response: "",
  revision: 0,
  startedAt: now,
  savedAt: null,
  submittedAt: null,
  currentPublished: true,
  currentEligible: true,
  ...changes,
});

it("keeps an empty member's next action useful without inventing completion", () => {
  const items = activityItems(undefined, [], []);
  expect(items).toEqual([]);
  const html = privateProgressPage(items);
  expect(html).toContain("No learning activity has been saved");
  expect(html).toContain('href="/learn"');
  expect(html).not.toContain("Self-reported complete");
});

it("distinguishes a starter draft and observed lesson opening from completion", () => {
  const items = activityItems(
    { instruction: "invented", verification: "check", completed_at: null },
    [lesson()],
    [attempt()],
  );
  expect(items.map((item) => item.state)).toEqual([
    "Draft saved",
    "Opened in reader",
    "Started",
  ]);
  expect(items.map((item) => item.version)).toEqual([1, 2, 3]);
  expect(items[1]?.href).toBe("/library/synthetic-lesson");
  expect(items[2]?.href).toContain("/assignments/attempts/");
});

it("shows each retained starter completion at its recorded version without withdrawn text", () => {
  const items = activityItems(
    {
      instruction: null,
      verification: null,
      completed_at: now,
      withdrawn_at: now,
    },
    [],
    [],
    [
      {
        lessonId: "clear-instructions",
        version: 1,
        instruction: null,
        verification: null,
        completedAt: now,
        withdrawnAt: now,
        goalAtStart: "everyday",
      },
      {
        lessonId: "clear-instructions",
        version: 2,
        instruction: "Earlier invented instruction",
        verification: "Earlier invented check",
        completedAt: now,
        withdrawnAt: null,
        goalAtStart: "work",
      },
      {
        lessonId: "clear-instructions",
        version: 3,
        instruction: null,
        verification: null,
        completedAt: now,
        withdrawnAt: now,
        goalAtStart: "build",
      },
      {
        lessonId: "other-lesson",
        version: 4,
        instruction: "Unrelated invented words",
        verification: null,
        completedAt: now,
        withdrawnAt: null,
        goalAtStart: "work",
      },
      {
        lessonId: "clear-instructions",
        version: 5,
        instruction: "Unfinished draft",
        verification: null,
        completedAt: null,
        withdrawnAt: null,
        goalAtStart: "work",
      },
    ],
  );
  expect(items.map((item) => item.version)).toEqual([1, 2, 3, 5]);
  expect(items[0]?.state).toContain("text withdrawn");
  expect(items[1]?.href).toBe(
    "/lesson?version=2&goal=work#starter-version-2-work",
  );
  expect(items[2]?.state).toContain("text withdrawn");
  const html = privateProgressPage(items);
  expect(html).not.toContain("Earlier invented instruction");
  expect(html).not.toContain("Earlier invented check");
});

it("retains self-reported and submitted states on historical exact versions", () => {
  const items = activityItems(
    { instruction: "invented", verification: "check", completed_at: now },
    [
      lesson({
        contentVersion: 1,
        title: undefined,
        startedAt: now,
        selfAssessedAt: now,
        available: false,
      }),
      lesson({ contentId: "started-only", startedAt: now }),
    ],
    [
      attempt({
        contentVersion: 1,
        savedAt: now,
        submittedAt: now,
        currentPublished: false,
        currentEligible: false,
      }),
      attempt({
        id: "68708ecc-6f9b-471b-8dd4-f4819df094af",
        savedAt: now,
        currentEligible: false,
      }),
    ],
  );
  expect(items.map((item) => item.state)).toEqual([
    "Self-reported complete",
    "Self-reported complete",
    "Started",
    "Submitted locally; no qualified review",
    "Draft saved",
  ]);
  expect(items[1]).toMatchObject({
    title: "synthetic-lesson",
    version: 1,
    href: null,
    availability: "Historical version unavailable; activity retained",
  });
  expect(items[3]?.availability).toContain("Historical assignment version");
  expect(items[4]?.availability).toContain("current direction");
  expect(items[4]?.href).toContain("/assignments/attempts/");
  const html = privateProgressPage(items);
  expect(html).toContain("No current content link for this version.");
  expect(html).toContain("None is a qualified assessment");
});

it("shows each immutable assignment submission separately from a later draft without response text", () => {
  const first = "Private first synthetic response must stay off progress";
  const second = "Private second synthetic response must stay off progress";
  const items = activityItems(
    undefined,
    [],
    [
      attempt({
        contentVersion: 2,
        response: "Private current draft must stay off progress",
        savedAt: now,
        submissionCount: 2,
        submissionHistory: [
          { sequence: 1, submittedAt: "2026-09-23T10:00:00Z" },
          { sequence: 2, submittedAt: "2026-09-24T10:00:00Z" },
        ],
        submissions: [
          { sequence: 1, submittedAt: "2026-09-23T10:00:00Z", response: first },
          {
            sequence: 2,
            submittedAt: "2026-09-24T10:00:00Z",
            response: second,
          },
        ],
      }),
    ],
  );
  expect(items).toHaveLength(3);
  expect(items.map((item) => item.state)).toEqual([
    "Submission 1 · submitted locally; no qualified review",
    "Submission 2 · submitted locally; no qualified review",
    "Current revision draft saved",
  ]);
  expect(items.map((item) => item.href)).toEqual([
    "/assignments/attempts/8f43dd18-6f38-4894-b348-ac0288dc15e3?version=2&submission=1#submission-1",
    "/assignments/attempts/8f43dd18-6f38-4894-b348-ac0288dc15e3?version=2&submission=2#submission-2",
    "/assignments/attempts/8f43dd18-6f38-4894-b348-ac0288dc15e3",
  ]);
  const html = privateProgressPage(items);
  expect(html).toContain("2026-09-23T10:00:00Z");
  expect(html).toContain("2026-09-24T10:00:00Z");
  expect(html).not.toContain(first);
  expect(html).not.toContain(second);
  expect(html).not.toContain("Private current draft");
});

it("shows a newly started revision separately and avoids a duplicate current submission", () => {
  const previous = [{ sequence: 1, submittedAt: "2026-09-23T10:00:00Z" }];
  const started = activityItems(
    undefined,
    [],
    [attempt({ submissionHistory: previous, submissionCount: 1 })],
  );
  expect(started.map((item) => item.state)).toEqual([
    "Submission 1 · submitted locally; no qualified review",
    "Current revision started",
  ]);
  const submitted = activityItems(
    undefined,
    [],
    [
      attempt({
        submissionHistory: previous,
        submissionCount: 1,
        submittedAt: now,
      }),
    ],
  );
  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.state).toBe(
    "Submission 1 · submitted locally; no qualified review",
  );
});

it("escapes a synthetic content title before displaying private activity", () => {
  const html = privateProgressPage(
    activityItems(undefined, [lesson({ title: "<script>bad</script>" })], []),
  );
  expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(html).not.toContain("<script>bad</script>");
});
