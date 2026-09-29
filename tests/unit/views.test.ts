import { it, expect } from "vitest";
import {
  escape,
  page,
  notice,
  welcome,
  dashboard,
  lesson,
  exerciseWriteRecoveryPage,
  errorPage,
  contentPreview,
  libraryPage,
  expertRegistryPage,
  proposalListPage,
  proposalPreviewPage,
  moderationPage,
  milestonesPage,
  careerPage,
  assignmentAttemptsPage,
  assignmentAttemptPage,
  assignmentComparisonPage,
  assignmentReadinessPage,
  evidencePage,
  localAiConsentPage,
  localAiControlPage,
  availabilityPage,
  privateProgressPage,
  privatePracticePage,
  privatePracticeHistoryPage,
  manualObservationPage,
  eventDiscoveryPage,
  eventDetailPage,
} from "../../src/views.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import type { ManualObservation } from "../../src/manual-observations.ts";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import { compareResponses } from "../../src/attempt-compare.ts";
import type { AssignmentReadiness } from "../../src/assignment-readiness.ts";
import type { ContentVersion } from "../../src/catalog.ts";
import type { Milestone } from "../../src/store.ts";
import type { CareerSnapshot } from "../../src/career.ts";
import type { ExpertRecord } from "../../src/track-readiness.ts";
import type { Proposal } from "../../src/proposals.ts";
import { workflowBundle } from "../../src/workflow-registry.ts";
import { profileEdit } from "../../src/validation.ts";
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
it("offers exact-version withdrawal and preserves a text-free completion state", () => {
  const saved = {
    instruction: "Invented <private> instruction",
    verification: "Invented <private> verification",
    completed_at: new Date("2026-09-29T00:00:00Z"),
    withdrawn_at: null,
  };
  const active = lesson(learner, saved, "csrf");
  expect(active).toContain('action="/exercise/clear-instructions/1/withdraw"');
  expect(active).toContain("Withdraw both saved text fields for version 1");
  expect(active).toContain("Invented &lt;private&gt; instruction");
  expect(active).not.toContain("Invented <private> instruction");
  const withdrawn = lesson(
    learner,
    {
      ...saved,
      instruction: null,
      verification: null,
      withdrawn_at: new Date("2026-09-29T01:00:00Z"),
    },
    "csrf",
  );
  expect(withdrawn).toContain("Saved exercise text withdrawn");
  expect(withdrawn).toContain(
    "self-reported completion, date and version remain",
  );
  expect(withdrawn).not.toContain("Invented &lt;private&gt;");
  expect(withdrawn).not.toContain("Withdraw completed exercise text");
});
it("keeps older completed exercise versions withdrawable after a source change", () => {
  const html = lesson(
    learner,
    undefined,
    "csrf",
    [],
    [
      {
        lessonId: "clear-instructions",
        version: 2,
        instruction: "Older invented instruction",
        verification: "Older invented check",
        completedAt: new Date("2026-09-29T00:00:00Z"),
        withdrawnAt: null,
        goalAtStart: "work",
      },
    ],
  );
  expect(html).toContain("Earlier starter exercise · version 2");
  expect(html).toContain('action="/exercise/clear-instructions/2/withdraw"');
  expect(html).toContain("Older invented instruction");
  const withdrawn = lesson(
    learner,
    undefined,
    "csrf",
    [],
    [
      {
        lessonId: "clear-instructions",
        version: 2,
        instruction: null,
        verification: null,
        completedAt: new Date("2026-09-29T00:00:00Z"),
        withdrawnAt: new Date("2026-09-29T01:00:00Z"),
        goalAtStart: "work",
      },
    ],
  );
  expect(withdrawn).toContain("Earlier starter exercise · version 2");
  expect(withdrawn).toContain("Your self-reported completion remains");
  expect(withdrawn).not.toContain("Older invented instruction");
  expect(withdrawn).not.toContain(
    'action="/exercise/clear-instructions/2/withdraw"',
  );
});
it("keeps blocked synthetic assignments separate from selectable choices and escapes their titles", () => {
  const blocked: AssignmentReadiness = {
    contentId: "SYN-831",
    contentVersion: 2,
    title: "Invented <practice>",
    eligible: false,
    requirements: [],
  };
  const html = dashboard(
    learner,
    undefined,
    "token",
    [],
    [],
    null,
    null,
    undefined,
    [blocked],
  );
  expect(html).toContain("Prepare a future assignment");
  expect(html).toContain("Prepare Invented &lt;practice&gt;");
  expect(html).toContain("/assignments/readiness/SYN-831?version=2");
  expect(html).not.toContain("Invented <practice>");
  expect(
    dashboard(learner, undefined, "token", [], [], null, null, undefined, [
      { ...blocked, eligible: true },
    ]),
  ).not.toContain("Prepare a future assignment");
});

it("shows exact observed prerequisite states and only safe next actions", () => {
  const item: AssignmentReadiness = {
    contentId: "SYN-831",
    contentVersion: 1,
    title: "Invented <assignment>",
    eligible: false,
    requirements: [
      {
        kind: "lesson",
        contentId: "SYN-830",
        contentVersion: 3,
        title: "Invented <lesson>",
        required: "started",
        observed: "not-started",
        satisfied: false,
        action: { kind: "lesson", contentId: "SYN-830", contentVersion: 3 },
        requirements: [
          {
            kind: "exercise",
            contentId: "clear-instructions",
            contentVersion: 1,
            required: "completed",
            observed: "not-started",
            satisfied: false,
            action: {
              kind: "exercise",
              contentId: "clear-instructions",
              contentVersion: 1,
            },
            requirements: [],
          },
          {
            kind: "unavailable",
            observed: "unavailable",
            satisfied: false,
            requirements: [],
          },
        ],
      },
    ],
  };
  const html = assignmentReadinessPage(item, "token");
  expect(html).toContain("Prepare Invented &lt;assignment&gt;");
  expect(html).toContain("Not started");
  expect(html).toContain("Unavailable");
  expect(html).toContain("/library/SYN-830?version=3");
  expect(html).toContain('href="/lesson"');
  expect(html).not.toContain("Invented <lesson>");
  expect(html).not.toContain("Start or return to this private attempt");
  const ready = assignmentReadinessPage(
    {
      ...item,
      eligible: true,
      requirements: [
        {
          kind: "lesson",
          contentId: "SYN-830",
          contentVersion: 3,
          title: "Invented lesson",
          required: "self-assessed",
          observed: "self-assessed",
          satisfied: true,
          detailsLimited: true,
          requirements: [],
        },
      ],
    },
    "token",
  );
  expect(ready).toContain("Choose this sample assignment");
  expect(ready).toContain("Self-assessed");
  expect(ready).toContain("Additional prerequisite details are summarized");
  expect(ready).not.toContain("Open prerequisite lesson");
  expect(
    assignmentReadinessPage(
      { ...item, eligible: true, requirements: [] },
      "token",
    ),
  ).toContain("No additional local prerequisites");
  const incomplete = assignmentReadinessPage(
    {
      ...item,
      requirements: [
        {
          kind: "lesson",
          observed: "started",
          satisfied: false,
          requirements: [],
        },
      ],
    },
    "token",
  );
  expect(incomplete).toContain("Sample lesson");
  expect(incomplete).toContain("version unavailable");
  expect(incomplete).toContain("Check this prerequisite");
  expect(incomplete).not.toContain("Open prerequisite lesson");
});
it("shows versioned synthetic event discovery and truthful local time without fixture seats", () => {
  const event = EVENT_PREVIEWS.find(
    (item) => item.id === "everyday-ai-preview" && item.version === 2,
  )!;
  const matched = eventDiscoveryPage([event], "America/Toronto");
  expect(matched).toContain("Events matched to your saved goal or interests");
  expect(matched).toContain("/events/everyday-ai-preview/2");
  expect(matched).toContain("GMT-04:00");
  expect(matched).toContain(`UTC ${event.startsAt}`);
  expect(matched).toContain("Synthetic preview; enrollment unavailable");
  expect(matched).toContain("Access and cost: unresolved");
  expect(matched).toContain("Expert coverage: unresolved");
  expect(matched).toContain("Recording: unresolved");
  expect(matched).not.toContain(`of ${event.fixtureCapacity} seats`);
  const all = eventDiscoveryPage([event], "Mars/Olympus", true);
  expect(all).toContain("Exploring all topics");
  expect(all).toContain("Set your time zone");
  expect(all).not.toContain("Mars/Olympus:");
  const empty = eventDiscoveryPage([]);
  expect(empty).toContain("No upcoming synthetic event previews match");
  expect(empty).toContain("Explore other topics");
  expect(eventDiscoveryPage([], undefined, true)).toContain(
    "No upcoming synthetic event previews are available",
  );
  const safe = {
    ...event,
    title: "<script>Event</script>",
    description: "<unsafe> description",
    agenda: ["<unsafe> agenda"],
  };
  const detail = eventDetailPage(
    { status: "current", event: safe },
    "America/Toronto",
  );
  expect(detail).toContain("&lt;script&gt;Event&lt;/script&gt;");
  expect(detail).toContain("&lt;unsafe&gt; agenda");
  expect(detail).not.toContain("<script>Event</script>");
  expect(detail).toContain("Access and cost: unresolved");
  expect(detail).toContain("Expert coverage: unresolved");
  expect(detail).toContain("Recording: unresolved");
  expect(eventDetailPage({ status: "current", event })).toContain(
    'href="/learn#timezone"',
  );
  for (const [status, message] of [
    ["past", "This event has already started"],
    ["retired", "This event version was retired"],
    ["replaced", "This event version was replaced"],
  ] as const) {
    const unavailable = eventDetailPage({ status, event });
    expect(unavailable).toContain(message);
    expect(unavailable).not.toContain("Sample agenda");
    expect(unavailable).not.toContain("Sample schedule:");
    expect(unavailable).toContain("enrollment unavailable");
  }
});
it("offers confirmed exact-version practice withdrawal and redacts the retained marker", () => {
  const saved = {
    id: "SYN-131",
    version: 2,
    title: "Invented lesson",
    response: "<private invented response>",
    savedAt: new Date("2026-09-28T11:00:00Z"),
    available: false,
    withdrawnAt: null,
  };
  const active = privatePracticeHistoryPage([saved], "csrf");
  expect(active).toContain("&lt;private invented response&gt;");
  expect(active).toContain('action="/practice/SYN-131/2/withdraw"');
  expect(active).toContain('name="confirm" value="yes" required');
  expect(active).toContain("Source unavailable; saved private note only");
  const withdrawn = privatePracticeHistoryPage(
    [
      {
        ...saved,
        response: null,
        withdrawnAt: new Date("2026-09-28T12:00:00Z"),
      },
    ],
    "csrf",
  );
  expect(withdrawn).toContain("Withdrawn 2026-09-28T12:00:00.000Z");
  expect(withdrawn).toContain("Source unavailable");
  expect(withdrawn).not.toContain("private invented response");
  expect(withdrawn).not.toContain("Your saved words");
  expect(withdrawn).not.toContain("Withdraw private note");
  expect(withdrawn).not.toContain("Current source and saved comparison");
  const source = {
    id: saved.id,
    version: saved.version,
    title: saved.title,
    body: "<synthetic source>",
    goal: "everyday" as const,
    response: null,
    withdrawnAt: new Date("2026-09-28T12:00:00Z"),
  };
  const current = privatePracticePage(source, "csrf");
  expect(current).toContain("note was withdrawn");
  expect(current).not.toContain("Save private practice");
  expect(current).not.toContain("Your saved sample and source comparison");
  expect(current).not.toContain("private invented response");
});
it("shows a private workflow improvement with an exact version and a stale-safe draft", async () => {
  const workflow = await workflowBundle("WF-001");
  expect(workflow).not.toBeNull();
  const form = proposalListPage([], "csrf", workflow);
  expect(form).toContain('name="workflow_id" value="WF-001"');
  expect(form).toContain('name="workflow_version" value="1"');
  expect(form).toContain("no public reuse rights are granted");
  const proposal: Proposal = {
    id: "sample",
    revision: 1,
    title: "Invented improvement",
    body: "Add an invented check",
    sources: "Original sample",
    workflowId: "WF-001",
    workflowVersion: 1,
    state: "draft",
    createdAt: new Date("2026-09-28T12:00:00Z"),
    submittedAt: null,
  };
  expect(proposalPreviewPage(proposal, "csrf")).toContain(
    "Workflow reference: WF-001 version 1",
  );
  const stale = proposalPreviewPage(proposal, "csrf", false);
  expect(stale).toContain("no longer current");
  expect(stale).not.toContain("Submit to private moderation");
  expect(stale).not.toContain("Save corrections");
  expect(stale).toContain("Withdraw and redact");
  expect(
    moderationPage(
      [
        {
          ...proposal,
          state: "submitted",
          submittedAt: new Date("2026-09-28T12:01:00Z"),
        },
      ],
      "csrf",
      new Date("2026-09-28T12:02:00Z"),
    ),
  ).toContain("Workflow reference: WF-001 version 1");
});
it("labels a capped internal synthetic register without rendering forged markup", () => {
  const record: ManualObservation = {
    id: "11111111-1111-4111-8111-111111111111",
    memberId: "22222222-2222-4222-8222-222222222222",
    actorId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
    evidenceReference: "SYN-<script>",
    amountCents: 1234,
    status: "unverified_manual",
    createdAt: new Date("2026-09-27T12:00:00Z"),
  };
  const html = manualObservationPage(
    Array(100).fill(record),
    "csrf",
    record.id,
  );
  expect(html).toContain("newest 100");
  expect(html).toContain("SYN-&lt;script&gt;");
  expect(html).not.toContain("SYN-<script>");
  expect(html).toContain("not provider verification");
});
it("shows private usefulness choices only for self-assessed exact lesson versions", () => {
  const sample = {
    kind: "sample lesson" as const,
    title: "Invented <reading>",
    version: 1,
    state: "Self-reported complete",
    availability: "Current published sample",
    href: "/library/SYN-971",
    contentId: "SYN-971",
    reportable: true,
  };
  const empty = privateProgressPage([sample], [], "csrf");
  expect(empty).toContain("Save my usefulness answer");
  expect(empty).toContain("not a skill test");
  expect(empty).toContain("Invented &lt;reading&gt;");
  expect(empty).not.toContain("Your current answer");
  const saved = privateProgressPage(
    [sample],
    [
      {
        contentId: "SYN-971",
        contentVersion: 1,
        choice: "not_yet",
        revision: 2,
        reportedAt: new Date("2026-09-27T10:00:00Z"),
        updatedAt: new Date("2026-09-27T12:00:00Z"),
      },
    ],
    "csrf",
  );
  expect(saved).toContain("Not helpful yet");
  expect(saved).toContain("Correct my usefulness answer");
  expect(saved).toContain("Withdraw my usefulness answer");
  expect(saved).toContain('name="revision" value="2"');
  const historical = privateProgressPage(
    [{ ...sample, href: null, reportable: false }],
    [
      {
        contentId: "SYN-971",
        contentVersion: 1,
        choice: "helpful",
        revision: 1,
        reportedAt: new Date("2026-09-27T10:00:00Z"),
        updatedAt: new Date("2026-09-27T10:00:00Z"),
      },
    ],
    "csrf",
  );
  expect(historical).toContain("historical version cannot receive");
  expect(historical).not.toContain("Correct my usefulness answer");
  expect(historical).toContain("Withdraw my usefulness answer");
  const currentHelpful = privateProgressPage(
    [sample],
    [
      {
        contentId: "SYN-971",
        contentVersion: 1,
        choice: "helpful",
        revision: 1,
        reportedAt: new Date("2026-09-27T10:00:00Z"),
        updatedAt: new Date("2026-09-27T10:00:00Z"),
      },
    ],
    "csrf",
  );
  expect(currentHelpful).toContain('<option value="helpful" selected>');
  expect(saved).toContain('<option value="not_yet" selected>');
  expect(privateProgressPage([{ ...sample, reportable: false }])).not.toContain(
    "Private lesson usefulness",
  );
});
it("keeps optional availability labelled, escaped and timezone-explicit", () => {
  const slot = {
    id: "slot",
    domain: "<script>",
    serviceType: "coaching" as const,
    startsAt: new Date("2026-11-01T05:30:00.000Z"),
    endsAt: new Date("2026-11-01T06:30:00.000Z"),
  };
  const shown = availabilityPage([slot], "America/Toronto");
  expect(shown).toContain("GMT-04:00");
  expect(shown).toContain("GMT-05:00");
  expect(shown).toContain("UTC 2026-11-01T05:30:00.000Z");
  expect(shown).toContain("&lt;script&gt;");
  expect(shown).not.toContain("<script>");
  expect(shown).not.toContain("Book now");
  expect(availabilityPage([], "America/Toronto")).toContain(
    "No sample windows can be shown",
  );
  expect(availabilityPage([slot], "invalid/zone")).toContain(
    "Choose a valid time zone",
  );
  expect(availabilityPage([slot], undefined, "Private <failure>")).toContain(
    "Private &lt;failure&gt;",
  );
});
it("does not call a surviving second evidence version an original", () => {
  const parentId = "11111111-1111-4111-8111-111111111111";
  const revised = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "revised.txt",
    mediaType: "text/plain" as const,
    quarantineState: "pending" as const,
    privateReviewAllowed: true,
    privateReviewRevokedAt: null,
    submissionStatus: null,
    createdAt: new Date(),
    revisionParentId: parentId,
    revisionParentStatus: "current" as const,
    revisionNumber: 2,
    hasRevision: false,
  };
  const active = evidencePage([revised], "csrf");
  expect(active).toContain(`version 2 · revises ${parentId}`);
  expect(active).not.toContain("prior version deleted");
  const deleted = evidencePage(
    [{ ...revised, revisionParentStatus: "deleted" }],
    "csrf",
  );
  expect(deleted).toContain(
    `version 2 · prior version deleted · revises ${parentId}`,
  );
  expect(deleted).not.toContain("version 2 · original");
  const pending = evidencePage(
    [{ ...revised, revisionParentStatus: "deleting" }],
    "csrf",
  );
  expect(pending).toContain(
    `version 2 · prior version deletion pending · revises ${parentId}`,
  );
  expect(pending).not.toContain("prior version deleted");
  const legacy = evidencePage(
    [{ ...revised, revisionParentId: null, revisionParentStatus: "deleted" }],
    "csrf",
  );
  expect(legacy).toContain(
    "version 2 · prior version deleted · parent ID unavailable",
  );
});
it("describes local AI permission and every job state without leaking sample text", () => {
  const empty = localAiConsentPage([], "csrf");
  expect(empty).toContain("No clean current invented text sample is available");
  const grant = localAiConsentPage(
    [
      {
        evidenceId: "sample-id",
        name: "Invented <draft>.txt",
        revisionNumber: 2,
        receiptId: null,
        grantedAt: null,
        withdrawnAt: null,
        jobs: [],
      },
    ],
    "csrf",
    ["Sample <unavailable>"],
  );
  expect(grant).toContain("Invented &lt;draft&gt;.txt");
  expect(grant).toContain("Sample &lt;unavailable&gt;");
  expect(grant).toContain("Grant local simulation permission");
  expect(grant).not.toContain("Withdraw permission");
  const active = localAiConsentPage(
    [
      {
        evidenceId: "sample-id",
        name: "Invented sample.txt",
        revisionNumber: 2,
        receiptId: "receipt-id",
        grantedAt: new Date(),
        withdrawnAt: null,
        jobs: [
          { id: "pending", status: "pending" },
          { id: "done", status: "succeeded" },
          { id: "running", status: "running" },
          { id: "held", status: "needs_reconciliation" },
          { id: "failed", status: "failed" },
        ],
      },
    ],
    "csrf",
  );
  expect(active).toContain("Queue local simulation");
  expect(active).toContain("Withdraw permission");
  expect(active).toContain("Run local simulation");
  expect(active).toContain("Simulated locally. No provider request");
  expect(active).toContain("Outcome needs local reconciliation");
  expect(active).toContain("Local simulation unavailable or failed");
  const paused = localAiConsentPage(
    [
      {
        evidenceId: "sample-id",
        name: "Invented sample.txt",
        revisionNumber: 2,
        receiptId: "receipt-id",
        grantedAt: new Date(),
        withdrawnAt: null,
        jobs: [{ id: "pending", status: "pending" }],
      },
    ],
    "csrf",
    [],
    "paused",
  );
  expect(paused).toContain("Local simulations are paused");
  expect(paused).not.toContain("Queue local simulation</button>");
  expect(paused).not.toContain("Run local simulation</button>");
  expect(paused).toContain("Withdraw permission");
  expect(localAiConsentPage([], "csrf", [], "unavailable")).toContain(
    "Local simulations are unavailable",
  );
  expect(localAiControlPage(false, "csrf")).toContain("Pause local simulation");
  expect(localAiControlPage(true, "csrf")).toContain("Resume local simulation");
});
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
    revision: 3,
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
  expect(preview).toContain("Saved revision 3");
  expect(preview).toContain('name="revision" value="3"');
  expect(preview).toContain("Save corrections");
  expect(preview).not.toContain('name="rights_confirmed" value="yes" checked');
  expect(preview).not.toContain("<script>unsafe</script>");
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
  expect(
    moderationPage([], "csrf", new Date("2026-09-25T12:00:00Z")),
  ).toContain("No submitted proposals");
  expect(
    moderationPage(
      [
        {
          ...item,
          state: "submitted",
          submittedAt: new Date("2026-09-25T11:00:00Z"),
        },
      ],
      "csrf",
      new Date("2026-09-25T12:00:00Z"),
    ),
  ).toContain("Quarantine for review");
  const worklist = moderationPage(
    [
      {
        ...item,
        state: "submitted",
        submittedAt: new Date("2026-09-25T11:00:00Z"),
      },
    ],
    "csrf",
    new Date("2026-09-25T12:00:00Z"),
  );
  expect(worklist).toContain('datetime="2026-09-25T11:00:00.000Z"');
  expect(worklist).toContain("60 minutes");
  expect(worklist).toContain("as of page load");
  expect(worklist).toContain("no response-time promise");
  expect(worklist).not.toContain("expert availability");
  expect(
    moderationPage(
      [
        {
          ...item,
          state: "submitted",
          submittedAt: new Date("2026-09-25T13:00:00Z"),
        },
      ],
      "csrf",
      new Date("2026-09-25T12:00:00Z"),
    ),
  ).toContain("0 minutes");
  expect(
    moderationPage(
      Array.from({ length: 100 }, () => ({
        ...item,
        state: "submitted",
        submittedAt: new Date("2026-09-25T11:00:00Z"),
      })),
      "csrf",
      new Date("2026-09-25T12:00:00Z"),
    ),
  ).toContain("More proposals may be waiting");
  expect(
    moderationPage(
      [
        {
          ...item,
          state: "quarantined",
          submittedAt: new Date("2026-09-25T11:00:00Z"),
        },
      ],
      "csrf",
      new Date("2026-09-25T12:00:00Z"),
    ),
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
it("explains versioned synthetic lesson and local exercise requirements to staff", () => {
  const item: ContentVersion = {
    id: "SYN-806",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented sample",
    body: "Check a sample result.",
    owner: "Editor",
    sources: "Original synthetic task",
    rights: "Owned synthetic text",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "",
    structuredPrerequisites: {
      schemaVersion: 1,
      all: [
        {
          kind: "lesson",
          id: "SYN-805",
          version: 2,
          activity: "self-assessed",
        },
        {
          kind: "exercise",
          id: "clear-instructions",
          version: 1,
          activity: "completed",
        },
      ],
    },
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
    state: "draft",
    requiresQualifiedSignoff: false,
    reviewedAt: null,
    publishedAt: null,
  };
  const staff = contentPreview(item, true, "csrf");
  expect(staff).toContain("Lesson SYN-805 version 2: self-assessed");
  expect(staff).toContain(
    "Local exercise clear-instructions version 1: completed",
  );
  expect(
    contentPreview(
      { ...item, structuredPrerequisites: { schemaVersion: 1, all: [] } },
      true,
    ),
  ).toContain("<dt>Prerequisites</dt><dd>None</dd>");
  expect(
    contentPreview(
      {
        ...item,
        structuredPrerequisites: {
          schemaVersion: 2,
        } as unknown as ContentVersion["structuredPrerequisites"],
      },
      true,
    ),
  ).toContain("Prerequisite unavailable");
  expect(
    contentPreview(
      { ...item, structuredPrerequisites: null, prerequisites: "Legacy note" },
      true,
    ),
  ).toContain("Legacy note");
});
it("labels exact private lesson activity without turning a page opening into achievement", () => {
  const item = {
    id: "SYN-105",
    version: 2,
    kind: "lesson" as const,
    origin: "curated" as const,
    title: "Invented sample",
    body: "Read this sample.",
    owner: "Editor",
    sources: "Invented",
    rights: "Owned",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "",
    rubric: null,
    rubricVersion: null,
    state: "published" as const,
    requiresQualifiedSignoff: false,
    reviewedAt: new Date(),
    publishedAt: new Date(),
  };
  const opened = {
    contentId: item.id,
    contentVersion: 2,
    openedAt: new Date(),
    startedAt: null,
    selfAssessedAt: null,
    available: true,
  };
  const reader = contentPreview(item, false, "csrf", opened);
  expect(reader).toContain("Opened in reader · version 2");
  expect(reader).toContain("Start this lesson");
  expect(reader).not.toContain("Mark self-assessed complete");
  expect(
    contentPreview(item, false, "csrf", { ...opened, startedAt: new Date() }),
  ).toContain("Mark self-assessed complete");
  expect(
    contentPreview(item, false, "csrf", {
      ...opened,
      startedAt: new Date(),
      selfAssessedAt: new Date(),
    }),
  ).toContain("Self-assessed complete");
  expect(contentPreview(item, true, "csrf")).not.toContain(
    "Your private reading activity",
  );
  const history = libraryPage([item], { q: "" }, [
    opened,
    { ...opened, contentVersion: 1, available: false, startedAt: new Date() },
  ]);
  expect(history).toContain("Current lesson available");
  expect(history).toContain(
    "This version is unavailable; your history remains saved",
  );
  expect(history).toContain("Started");
  expect(libraryPage([], { q: "" })).toContain(
    "No sample lesson has been opened",
  );
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
it("shows a labelled optional sample lesson without inventing a duration or assessment", () => {
  const lesson: ContentVersion = {
    id: "SYN-996",
    version: 2,
    kind: "lesson",
    origin: "curated",
    title: "Invented <lesson>",
    body: "Sample",
    owner: "Editor",
    sources: "Original",
    rights: "Owned",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
    state: "published",
    requiresQualifiedSignoff: false,
    reviewedAt: new Date("2026-09-23"),
    publishedAt: new Date("2026-09-23"),
  };
  const empty = dashboard(learner, undefined, "token");
  expect(empty).toContain("No additional published sample lesson");
  const html = dashboard(learner, undefined, "token", [], [], null, lesson);
  expect(html).toContain("Invented &lt;lesson&gt; · version 2");
  expect(html).not.toContain("Invented <lesson>");
  expect(html).toContain('href="/library/SYN-996"');
  expect(html).toContain(
    "no scheduled duration or qualified curriculum sign-off",
  );
});
it("renders all accessible entry choices and actionable validation", () => {
  expect(welcome("token")).toContain("Working in another field");
  expect(welcome("token", ["Fix <field>"])).toContain("Fix &lt;field&gt;");
  expect(notice([])).toBe("");
  expect(errorPage("Oops", "Try <again>")).toContain("Try &lt;again&gt;");
});
it("keeps uncertain exercise text copyable and private without claiming a save", () => {
  const html = exerciseWriteRecoveryPage(
    "<script>window.leak=true</script> sample task",
    "Compare the invented notes\nwith the original.",
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("may or may not have been saved");
  expect(html).toContain('for="attempted-instruction"');
  expect(html).toContain('for="attempted-verification"');
  expect(html).toContain("readonly");
  expect(html).toContain("&lt;script&gt;window.leak=true&lt;/script&gt;");
  expect(html).not.toContain("<script>window.leak=true</script>");
  expect(html).toContain(
    'href="/lesson" target="_blank" rel="noopener noreferrer"',
  );
  expect(html).not.toContain("Your draft is saved");
  expect(html).not.toContain('<form method="post"');
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
it("renders unsaved profile edits with an actionable field error while keeping the saved plan", () => {
  const saved = {
    ...learner,
    backgroundTags: ["explorer" as const],
    domainTags: ["education" as const],
    experience: "new" as const,
    timezone: "UTC",
    weeklyMinutes: 15,
  };
  const edit = profileEdit({
    background: "professional",
    goal: "work",
    domain_tags: "finance",
    exploratory: "yes",
    timezone: "Mars/Olympus",
    weekly_minutes: "60",
  });
  const html = dashboard(saved, undefined, "token", [], [], null, null, edit);
  expect(html).toContain("<title>Error in your profile");
  expect(html).toContain("Your changes were not saved");
  expect(html).toContain('href="#timezone"');
  expect(html).toContain('id="timezone" name="timezone" value="Mars/Olympus"');
  expect(html).toContain('aria-describedby="timezone-help timezone-error"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('id="timezone-error"');
  expect(html).toContain('<option value="work" selected>');
  expect(html).toContain('<option value="professional" selected>');
  expect(html).toContain('name="domain_tags" value="finance" checked');
  expect(html).toContain('name="exploratory" value="yes" checked');
  expect(html).not.toContain('name="domain_tags" value="education" checked');
  expect(html).toContain('<option value="60" selected>');
  expect(html).toContain('<option value="" selected>Not specified</option>');
  expect(html).toContain("Understand AI and try something useful");
  expect(html).toContain("Weekly time: About 15 minutes · Time zone: UTC");
  expect(html.indexOf('href="/api/member/export"')).toBeLessThan(
    html.indexOf('href="#timezone"'),
  );
});
it("links multiple profile errors and escapes attempted text without reflecting forged options", () => {
  const edit = profileEdit({
    background: "technical",
    goal: "admin",
    domain_tags: ["finance", "finance"],
    timezone: '<img src=x onerror="alert(1)">',
    weekly_minutes: ["15", "60"],
    exploratory: "no",
  });
  const html = dashboard(learner, undefined, "token", [], [], null, null, edit);
  expect(html).toContain('href="#goal"');
  expect(html).toContain('href="#domain_tags"');
  expect(html).toContain('href="#timezone"');
  expect(html).toContain('href="#weekly_minutes"');
  expect(html).toContain('href="#exploratory"');
  expect(html).toContain('id="domain_tags" tabindex="-1" aria-invalid="true"');
  expect(html).toContain('id="domain_tags-error"');
  expect(html).toContain(
    'value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"',
  );
  expect(html).not.toContain('<img src=x onerror="alert(1)">');
  expect(html).not.toContain('<option value="admin"');
  expect(html).toContain('name="domain_tags" value="finance" checked');
  expect(html).toContain('id="weekly_minutes" name="weekly_minutes"');
  expect(html).toContain('id="exploratory" type="checkbox"');
  expect(html).toContain('aria-describedby="exploratory-error"');
});
it("renders a failed onboarding attempt for correction without a saved member", () => {
  const edit = profileEdit({
    background: "technical",
    goal: "build",
    it_roles: "security",
    timezone: "Mars/Olympus",
    weekly_minutes: "30",
  });
  const html = welcome("token", [], {
    ...edit,
    syntheticAcknowledged: true,
  });
  expect(html).toContain("<title>Error in your onboarding");
  expect(html).toContain("Your changes were not saved");
  expect(html).toContain('href="#timezone"');
  expect(html).toContain('<option value="technical" selected>');
  expect(html).toContain('<option value="build" selected>');
  expect(html).toContain('name="it_roles" value="security" checked');
  expect(html).toContain('<option value="30" selected>');
  expect(html).toContain('name="synthetic" value="yes" required checked');
  expect(html).toContain('id="timezone-error"');
  expect(html).toContain('aria-describedby="timezone-help timezone-error"');
});

it("renders private attempt states without treating a local submission as reviewed work", () => {
  const item: AssignmentAttempt = {
    id: "11111111-1111-4111-8111-111111111111",
    contentId: "SYN-960",
    contentVersion: 1,
    title: "Invented <private> assignment",
    goalAtStart: "everyday",
    response: "Safe <sample> text",
    revision: 1,
    startedAt: new Date("2026-09-24T00:00:00Z"),
    savedAt: null,
    submittedAt: null,
    currentPublished: true,
    currentEligible: true,
  };
  expect(assignmentAttemptsPage([])).toContain(
    "No private assignment attempts yet",
  );
  expect(assignmentAttemptsPage([item])).toContain("started only");
  expect(assignmentAttemptsPage([item])).toContain(
    "Invented &lt;private&gt; assignment",
  );
  expect(assignmentAttemptPage(item, "csrf")).toContain("Save private draft");
  expect(assignmentAttemptPage(item, "csrf")).not.toContain(
    "Submit saved version locally",
  );
  const saved = { ...item, savedAt: new Date("2026-09-24T00:01:00Z") };
  expect(assignmentAttemptsPage([saved])).toContain("private draft saved");
  expect(assignmentAttemptPage(saved, "csrf")).toContain(
    "Submit saved version locally",
  );
  expect(
    assignmentAttemptPage(saved, "csrf", "Invalid <draft>", "Unsaved <text>"),
  ).toContain("Unsaved &lt;text&gt;");
  const conflict = assignmentAttemptPage(
    saved,
    "csrf",
    "Changed",
    "Unsaved text",
    true,
  );
  expect(conflict).toContain("Copy your unsaved text");
  expect(conflict).not.toContain("Save private draft");
  const unavailable = {
    ...saved,
    currentPublished: false,
    currentEligible: false,
  };
  expect(assignmentAttemptsPage([unavailable])).toContain(
    "no longer available for editing",
  );
  expect(assignmentAttemptPage(unavailable, "csrf")).toContain(
    "cannot be edited",
  );
  expect(assignmentAttemptPage(unavailable, "csrf")).not.toContain(
    "Save private draft",
  );
  const submitted = { ...saved, submittedAt: new Date("2026-09-24T00:02:00Z") };
  expect(assignmentAttemptsPage([submitted])).toContain(
    "submitted locally · awaiting future review path",
  );
  expect(assignmentAttemptPage(submitted, "csrf")).toContain(
    "submitted locally",
  );
  expect(assignmentAttemptPage(submitted, "csrf")).not.toContain(
    "Save private draft",
  );
  const withHistory = {
    ...submitted,
    submissionCount: 1,
    submissions: [
      {
        sequence: 1,
        response: "Invented <first> answer",
        submittedAt: "2026-09-24T00:02:00Z",
      },
    ],
  };
  const history = assignmentAttemptPage(withHistory, "csrf");
  expect(history).toContain("Submission 1");
  expect(history).toContain("Invented &lt;first&gt; answer");
  expect(history).not.toContain("Invented <first> answer");
  expect(history).toContain("Revise privately");
  expect(history).not.toContain("Compare private submissions");
  const twoVersions = {
    ...withHistory,
    submissions: [
      ...withHistory.submissions,
      {
        sequence: 2,
        response: "Invented <second> answer",
        submittedAt: "2026-09-24T00:03:00Z",
      },
    ],
  };
  expect(assignmentAttemptPage(twoVersions, "csrf")).toContain(
    `/assignments/attempts/${item.id}/compare?from=1&amp;to=2`,
  );
  const compared = assignmentComparisonPage(
    twoVersions,
    1,
    2,
    compareResponses(
      twoVersions.submissions[0]!.response,
      twoVersions.submissions[1]!.response,
    ),
  );
  expect(compared).toContain("Compare private submissions");
  expect(compared).toContain("From submission 1");
  expect(compared).toContain("To submission 2");
  expect(compared).toContain("Invented &lt;first&gt; answer");
  expect(compared).toContain("Invented &lt;second&gt; answer");
  expect(compared).not.toContain("Invented <first> answer");
  expect(compared).not.toContain("Saved private draft");
  const multiline = {
    ...twoVersions,
    submissions: [
      { ...twoVersions.submissions[0]!, response: "Shared line\nOld line\n" },
      { ...twoVersions.submissions[1]!, response: "Shared line\nNew line\n" },
    ],
  };
  const lines = assignmentComparisonPage(
    multiline,
    1,
    2,
    compareResponses(
      multiline.submissions[0]!.response,
      multiline.submissions[1]!.response,
    ),
  );
  expect(lines).toContain("Line comparison");
  expect(lines).toContain("Unchanged");
  expect(lines).toContain("Removed");
  expect(lines).toContain("Added");
  const same = {
    ...multiline,
    submissions: [
      multiline.submissions[0]!,
      {
        ...multiline.submissions[1]!,
        response: multiline.submissions[0]!.response,
      },
    ],
  };
  expect(
    assignmentComparisonPage(
      same,
      1,
      2,
      compareResponses(
        same.submissions[0]!.response,
        same.submissions[1]!.response,
      ),
    ),
  ).toContain("No text changed");
  const long = {
    ...multiline,
    submissions: [
      {
        ...multiline.submissions[0]!,
        response: "Shared\n" + "Old\n".repeat(501),
      },
      {
        ...multiline.submissions[1]!,
        response: "Shared\n" + "New\n".repeat(501),
      },
    ],
  };
  expect(
    assignmentComparisonPage(
      long,
      1,
      2,
      compareResponses(
        long.submissions[0]!.response,
        long.submissions[1]!.response,
      ),
    ),
  ).toContain("Section comparison");
  const mixed = {
    ...multiline,
    submissions: [
      { ...multiline.submissions[0]!, response: "A\rB\r\nC" },
      { ...multiline.submissions[1]!, response: "A\rB\r\nD" },
    ],
  };
  const mixedHtml = assignmentComparisonPage(
    mixed,
    1,
    2,
    compareResponses(
      mixed.submissions[0]!.response,
      mixed.submissions[1]!.response,
    ),
  );
  expect(mixedHtml).toContain("A&#13;B&#13;\nC");
  expect(mixedHtml).not.toContain("A\rB");
  expect(assignmentAttemptsPage([withHistory])).toContain(
    "1 private local submission",
  );
  expect(
    assignmentAttemptsPage([{ ...withHistory, submissionCount: 2 }]),
  ).toContain("2 private local submissions");
  const newDraft = {
    ...withHistory,
    response: "",
    savedAt: null,
    submittedAt: null,
  };
  expect(assignmentAttemptsPage([newDraft])).toContain(
    "private revision started",
  );
  expect(assignmentAttemptPage(newDraft, "csrf")).toContain(
    "Private sample response",
  );
  const savedRevision = { ...newDraft, savedAt: new Date() };
  expect(assignmentAttemptsPage([savedRevision])).toContain(
    "private revision draft saved",
  );
  expect(assignmentAttemptPage(savedRevision, "csrf")).toContain(
    "private revision draft saved",
  );
  const limit = assignmentAttemptPage(
    { ...withHistory, submissionCount: 10 },
    "csrf",
  );
  expect(limit).toContain("ten-submission local preview limit");
  expect(limit).not.toContain("Revise privately");
  expect(
    assignmentAttemptPage({ ...withHistory, currentEligible: false }, "csrf"),
  ).not.toContain("Revise privately");
});
