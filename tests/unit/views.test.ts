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
  expertRegistryPage,
  proposalListPage,
  proposalPreviewPage,
  moderationPage,
  milestonesPage,
  careerPage,
} from "../../src/views.ts";
import type { Milestone } from "../../src/store.ts";
import type { CareerSnapshot } from "../../src/career.ts";
import type { ExpertRecord } from "../../src/track-readiness.ts";
import type { Proposal } from "../../src/proposals.ts";
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
it("keeps optional planning gated and renders escaped, unsent per-version drafts", () => {
  const off = careerPage({ enabled: false, entries: [], drafts: [] }, "csrf");
  expect(off).toContain("records are off");
  expect(off).not.toContain('name="self_reported_outcome"');
  const snapshot: CareerSnapshot = {
    enabled: true,
    entries: [
      {
        id: "entry-id",
        kind: "opportunity",
        title: "Sample <role>",
        note: "<script>private</script>",
        nextAction: "Review sample",
        selfReportedOutcome: "Maybe later",
        version: 2,
      },
    ],
    drafts: [
      {
        id: "draft-id",
        kind: "proposal",
        title: "Sample proposal",
        body: "<script>unsent</script>",
        approved: false,
        version: 3,
      },
    ],
  };
  const html = careerPage(snapshot, "csrf", ["Fix <draft>"], {
    entry: { ...snapshot.entries[0]!, title: "Edited <role>" },
    professional: { ...snapshot.drafts[0]!, body: "Revised <sample>" },
    editEntryId: "entry-id",
    editDraftId: "draft-id",
  });
  expect(html).toContain("Fix &lt;draft&gt;");
  expect(html).toContain("Sample &lt;role&gt;");
  expect(html).toContain("&lt;script&gt;private&lt;/script&gt;");
  expect(html).toContain("&lt;script&gt;unsent&lt;/script&gt;");
  expect(html).toContain("Revised &lt;sample&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Maybe later · self-reported, not verified");
  expect(html).toContain("unapproved · unsent");
  expect(html).toContain('name="version" value="3"');
  expect(
    careerPage(
      {
        ...snapshot,
        entries: [
          { ...snapshot.entries[0]!, note: "", selfReportedOutcome: "" },
        ],
        drafts: [{ ...snapshot.drafts[0]!, approved: true }],
      },
      "csrf",
    ),
  ).toContain("member approved · unsent");
  expect(
    careerPage({ enabled: true, entries: [], drafts: [] }, "csrf"),
  ).toContain("No optional planning records yet");
});
it("renders private goals, unsent reminders and escaped editable milestone notes", () => {
  expect(milestonesPage(learner, [], "token")).toContain("No milestones yet");
  expect(milestonesPage(learner, [], "token")).toContain("Not set");
  const item: Milestone = {
    id: "a4ff1471-0226-4d5b-8677-99c0a94cdf40",
    goalTitle: "Learn <AI>",
    milestoneTitle: "Test invented answers",
    evidenceNote: "<script>private</script>",
    nextAction: "Compare sources",
    reminderDate: "2028-02-29",
    reminderTime: "14:30",
    reminderTimezone: "America/Toronto",
    selfReportedComplete: true,
    version: 2,
    createdAt: new Date("2026-09-23"),
    updatedAt: new Date("2026-09-23"),
  };
  const html = milestonesPage(
    { ...learner, timezone: "America/Toronto" },
    [item],
    "token",
    ["Fix <note>"],
    { ...item, nextAction: "Try <again>" },
    item.id,
  );
  expect(html).toContain("Fix &lt;note&gt;");
  expect(html).toContain("Learn &lt;AI&gt;");
  expect(html).toContain("&lt;script&gt;private&lt;/script&gt;");
  expect(html).not.toContain("<script>private</script>");
  expect(html).toContain("Try &lt;again&gt;");
  expect(html).toContain("complete · self-reported");
  expect(html).toContain("shown here only");
  expect(html).toContain('name="version" value="2"');
  expect(html).toContain('href="/learn"');
  const planned = milestonesPage(
    learner,
    [
      {
        ...item,
        evidenceNote: "",
        reminderDate: null,
        reminderTime: null,
        reminderTimezone: null,
        selfReportedComplete: false,
      },
    ],
    "token",
  );
  expect(planned).toContain("planned or in progress");
  expect(planned).toContain("Evidence note: None yet");
  expect(planned).not.toContain("Local reminder: ");
  expect(
    milestonesPage(learner, [item], "token", [], undefined, item.id),
  ).toContain("Edit this milestone");
});
it("escapes private proposal text and never renders a publish action", () => {
  const item: Proposal = {
    id: "test-id",
    title: "<sample>",
    body: "<script>unsafe</script>",
    sources: "Original & invented",
    state: "draft",
    createdAt: new Date("2026-09-23"),
    submittedAt: null,
  };
  expect(proposalListPage([], "csrf")).toContain("No sample proposals yet");
  expect(proposalListPage([item], "csrf")).toContain("&lt;sample&gt;");
  expect(
    proposalListPage([{ ...item, title: null, state: "withdrawn" }], "csrf"),
  ).toContain("Redacted proposal");
  const preview = proposalPreviewPage(item, "csrf");
  expect(preview).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
  expect(preview).toContain("Original &amp; invented");
  expect(preview).toContain("Submit to private moderation");
  expect(preview).toContain("Withdraw and redact");
  expect(preview).not.toContain("Publish proposal");
  expect(
    proposalPreviewPage({ ...item, state: "submitted" }, "csrf"),
  ).not.toContain("Submit to private moderation");
  expect(
    proposalPreviewPage(
      { ...item, state: "withdrawn", title: null, body: null, sources: null },
      "csrf",
    ),
  ).toContain("The proposal text has been removed");
  expect(moderationPage([], "csrf")).toContain("No submitted proposals");
  expect(moderationPage([{ ...item, state: "submitted" }], "csrf")).toContain(
    "Quarantine for review",
  );
  expect(
    moderationPage([{ ...item, state: "quarantined" }], "csrf"),
  ).not.toContain("Quarantine for review");
});
it("shows a private plan for known time and time zone without a paid action", () => {
  const html = dashboard(
    {
      ...learner,
      goal: "work",
      experience: "some",
      weeklyMinutes: 60,
      timezone: "America/Toronto",
      exploratory: true,
    },
    undefined,
    "token",
  );
  expect(html).toContain("Your starter plan");
  expect(html).toContain("About 1 hour");
  expect(html).toContain("America/Toronto");
  expect(html).toContain("Turn meeting notes into next steps");
  expect(html).toContain("another direction later");
  expect(html).not.toContain("Next session: try");
});
it("shows evidence state without exposing registry details to the public track page", () => {
  const record: ExpertRecord = {
    id: "synthetic",
    staffId: "reviewer",
    staffRole: "reviewer",
    domain: "education",
    serviceType: "formal-review",
    startsAt: new Date("2026-09-01"),
    endsAt: new Date("2026-10-01"),
    loadedCostCents: 12345,
    capacityMinutes: 90,
    committedMinutes: 30,
    backupStaffId: null,
    qualificationRef: "sample",
    agreementRef: "sample",
    conflictReviewRef: "sample",
    verifiedBy: null,
    verifiedAt: null,
    retiredAt: null,
  };
  const html = expertRegistryPage([
    record,
    {
      ...record,
      backupStaffId: "backup",
      verifiedAt: new Date("2026-09-20"),
      retiredAt: new Date("2026-09-21"),
    },
  ]);
  expect(html).toContain("CAD 123.45");
  expect(html).toContain("backup missing");
  expect(html).toContain("backup recorded");
  expect(html).toContain("verification pending");
  expect(html).toContain("verification recorded");
  expect(html).toContain("retired");
});
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
  expect(html).toContain("Suggested experience");
});
it("shows only current assignment choices, escapes titles and gives stale-choice recovery", () => {
  const item = {
    id: "SYN-920",
    version: 1,
    kind: "assignment" as const,
    origin: "curated" as const,
    title: "Invented <event>",
    body: "Sample",
    owner: "Editor",
    sources: "Original",
    rights: "Owned",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new" as const,
    rubric: null,
    rubricVersion: null,
    state: "published" as const,
    requiresQualifiedSignoff: false,
    reviewedAt: new Date("2026-09-23"),
    publishedAt: new Date("2026-09-23"),
  };
  expect(dashboard(learner, undefined, "token")).toContain(
    "No published assignment currently fits",
  );
  const available = dashboard(learner, undefined, "token", [], [item], {
    contentId: item.id,
    contentVersion: 1,
  });
  expect(available).toContain("Your chosen sample");
  expect(available).toContain("Choose Invented &lt;event&gt;");
  expect(available).not.toContain("Invented <event>");
  const defaults = dashboard(
    learner,
    undefined,
    "token",
    [],
    [{ ...item, minimumExperience: undefined, prerequisites: "" }],
  );
  expect(defaults).toContain("No prerequisite");
  expect(defaults).toContain("Just starting");
  const stale = dashboard(learner, undefined, "token", [], [], {
    contentId: item.id,
    contentVersion: 1,
  });
  expect(stale).toContain("no longer available");
  expect(stale).not.toContain(item.title);
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
  expect(dashboard(learner, undefined, "token")).toContain(
    'href="/contribute"',
  );
  expect(dashboard(learner, draft, "token")).toContain("Draft saved");
  const completed = { ...draft, completed_at: new Date() };
  expect(dashboard(learner, completed, "token")).toContain(
    "Completed · self-assessed",
  );
  expect(lesson(learner, undefined, "token")).not.toContain(
    "Your draft is saved",
  );
  expect(lesson(learner, draft, "token")).toContain("Your draft is saved");
  expect(
    lesson(learner, draft, "token", [{ field: null, message: "Invalid" }]),
  ).not.toContain("Your draft is saved");
  expect(lesson(learner, completed, "token")).toContain(
    "No AI or qualified reviewer",
  );
  expect(lesson(learner, completed, "token")).not.toContain(
    'name="instruction"',
  );
});
it("links each exercise error to only its affected field and clears error state after correction", () => {
  const invalid = lesson(learner, draft, "token", [
    {
      field: "verification",
      message: "How will you check the result? Write at least 20 characters.",
    },
  ]);
  expect(invalid).toContain("<title>Error in your exercise");
  expect(invalid).toContain('href="#verification"');
  expect(invalid).toContain('id="verification" name="verification"');
  expect(invalid).toContain('aria-invalid="true"');
  expect(invalid).toContain(
    'aria-describedby="verification-help verification-error"',
  );
  expect(invalid).toContain('id="verification-error"');
  expect(invalid).toContain('id="verification-help"');
  expect(invalid).not.toContain('href="#instruction"');
  expect(invalid).not.toContain('id="instruction-error"');
  expect(invalid).toContain('aria-describedby="answer-help"');
  const corrected = lesson(learner, draft, "token");
  expect(corrected).not.toContain('aria-invalid="true"');
  expect(corrected).not.toContain('id="verification-error"');
  expect(corrected).not.toContain("<title>Error in your exercise");
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
