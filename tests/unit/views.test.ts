import { it, expect } from "vitest";
import {
  escape,
  page,
  notice,
  welcome,
  dashboard,
  lesson,
  errorPage,
  contentPreview,
} from "../../src/views.ts";
const learner = {
  id: "a",
  background: "explorer" as const,
  goal: "everyday" as const,
};
const draft = {
  instruction: "<script>\"x\" & 'y'</script>",
  verification: "Check original notes",
  completed_at: null,
};
it("escapes every HTML-sensitive character in submitted content and page titles", () => {
  expect(escape("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  expect(page("<unsafe>", "safe")).toContain("&lt;unsafe&gt;");
  expect(lesson(learner, draft, "token")).not.toContain(draft.instruction);
  expect(
    lesson(learner, { ...draft, completed_at: new Date() }, "token"),
  ).toContain("&lt;script&gt;");
});
it("renders an accessible plain-text content preview when filters and prerequisites are universal", () => {
  const html = contentPreview(
    {
      id: "SYN-001",
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: "Sample",
      body: "Text",
      owner: "Editor",
      sources: "Original",
      rights: "Owned",
      goals: [],
      backgrounds: [],
      domains: [],
      prerequisites: "",
      rubric: null,
      rubricVersion: null,
      state: "published",
      requiresQualifiedSignoff: false,
      reviewedAt: new Date("2026-09-23"),
      publishedAt: new Date("2026-09-23"),
    },
    false,
  );
  expect(html).toContain("<dt>Goals</dt><dd>All</dd>");
  expect(html).toContain("<dt>Backgrounds</dt><dd>All</dd>");
  expect(html).toContain("<dt>Prerequisites</dt><dd>None</dd>");
});
it("renders all accessible entry choices and actionable validation", () => {
  expect(welcome("token")).toContain("Working in another field");
  expect(welcome("token", ["Fix <field>"])).toContain("Fix &lt;field&gt;");
  expect(notice([])).toBe("");
  expect(errorPage("Oops", "Try <again>")).toContain("Try &lt;again&gt;");
});
it("distinguishes unsaved, draft and self-assessed completion without inventing progress", () => {
  expect(dashboard(learner, undefined, "token")).toContain(
    "Ready when you are",
  );
  expect(dashboard(learner, undefined, "token")).toContain('href="/library"');
  expect(dashboard(learner, draft, "token")).toContain("Draft saved");
  const completed = { ...draft, completed_at: new Date() };
  expect(dashboard(learner, completed, "token")).toContain(
    "Completed · self-assessed",
  );
  expect(lesson(learner, undefined, "token")).not.toContain(
    "Your draft is saved",
  );
  expect(lesson(learner, draft, "token")).toContain("Your draft is saved");
  expect(lesson(learner, draft, "token", ["Invalid"])).not.toContain(
    "Your draft is saved",
  );
  expect(lesson(learner, completed, "token")).toContain(
    "No AI or qualified reviewer",
  );
  expect(lesson(learner, completed, "token")).not.toContain(
    'name="instruction"',
  );
});
it("shows optional profile choices and retains the exercise context after a goal change", () => {
  const profile = {
    ...learner,
    goal: "build" as const,
    backgroundTags: ["technical" as const],
    domainTags: ["education" as const],
    itRoles: ["security" as const],
    experience: "some" as const,
    exploratory: true,
  };
  const path = dashboard(profile, undefined, "token", ["Invalid choice"]);
  expect(path).toContain("Invalid choice");
  expect(path).toContain('value="security" checked');
  expect(path).toContain('name="exploratory" value="yes" checked');
  const previous = lesson(
    profile,
    { ...draft, goal_at_start: "everyday" },
    "token",
  );
  expect(previous).toContain("Plan a small community event");
  expect(previous).toContain(
    "saved practice remains tied to your earlier goal",
  );
});
