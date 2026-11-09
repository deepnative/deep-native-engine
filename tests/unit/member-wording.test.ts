import express, { type Express } from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { withLoopback } from "../support/loopback-server.ts";
import { adapterReadiness } from "../../src/adapters.ts";
import { app } from "../../src/app.ts";
import { disabledCatalogStore } from "../../src/catalog.ts";
import type { Store } from "../../src/store.ts";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
import { mountCircleGrantRoutes } from "../../src/circle-grant-routes.ts";
import {
  circleGrantHistoryPage,
  circleGrantNoticePage,
  circleGrantReferencePage,
} from "../../src/circle-grant-views.ts";
import { mountEventAttendanceRoutes } from "../../src/event-attendance-routes.ts";
import {
  attendanceHistoryPage,
  attendanceMemberPage,
  attendanceObservationConfirm,
  attendanceSavedPage,
  attendanceStaffHome,
} from "../../src/event-attendance-views.ts";
import { mountEventCancellationRoutes } from "../../src/event-cancellation-routes.ts";
import {
  eventCancellationConfirm,
  eventCancellationHome,
} from "../../src/event-cancellation-views.ts";
import { mountEventRehearsalRoutes } from "../../src/event-rehearsal-routes.ts";
import {
  eventRehearsalHome,
  eventRehearsalNotice,
} from "../../src/event-rehearsal-views.ts";
import {
  localAiHoldDetailPage,
  localAiHoldListPage,
  localAiHoldUnavailablePage,
} from "../../src/local-ai-hold-inspection-views.ts";
import { reviewerSampleReference } from "../../src/sample-assignment-views.ts";
import { mountStudyUnitFixtureRoutes } from "../../src/study-unit-fixture-routes.ts";
import { STUDY_STAFF_PATH } from "../../src/study-unit-fixture-views.ts";
import { mountSupportAssignmentRoutes } from "../../src/support-assignment-routes.ts";
import { assignmentReferencePage } from "../../src/support-assignment-views.ts";
import {
  eventEnrollmentHistoryPage,
  eventEnrollmentPage,
  eventEnrollmentReceiptPage,
} from "../../src/event-enrollment-views.ts";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import type { OwnedEvidence } from "../../src/evidence.ts";
import type { ContentVersion } from "../../src/catalog.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import { LESSON } from "../../src/content.ts";
import { contributionMetrics } from "../../src/contribution-metrics.ts";
import {
  practiceComparison,
  withHosting,
} from "../../src/hosting-presentation.ts";
import {
  learningCohorts,
  learningDisclosure,
  learningSegments,
} from "../../src/learning-metrics.ts";
import {
  metricDefinitions,
  usefulnessDisclosure,
  type PreviewMetrics,
} from "../../src/metrics.ts";
import { activityItems } from "../../src/progress.ts";
import { workflowBundle } from "../../src/workflow-registry.ts";
import { metricsReportPage } from "../../src/metrics-report-views.ts";
import { preparedSamplesPage } from "../../src/prepared-sample-views.ts";
import { PROVIDED_SAMPLE_LABEL } from "../../src/prepared-sample-values.ts";
import { reviewGrantForm } from "../../src/review-time-grant-views.ts";
import { mountReviewTimeRoutes } from "../../src/review-time-routes.ts";
import { supportMinuteForm } from "../../src/support-time-grant-views.ts";
import { workflowReviewPreviewPage } from "../../src/workflow-review-views.ts";
import type { LocalAiChoice } from "../../src/local-ai-consent.ts";
import {
  memberTestUnitsPage,
  memberTestUnitsUnavailablePage,
} from "../../src/member-test-units-views.ts";
import { registerMemberTestUnitsRoutes } from "../../src/member-test-units-routes.ts";
import type { MemberTestUnitSnapshot } from "../../src/member-test-units.ts";
import { COACHING_OFFERS, FOUNDATION_ACCESS } from "../../src/offers.ts";
import {
  myCoursesPage,
  programAccountPage,
  programAdminPage,
  programConfirmPage,
  programOverviewPage,
  programProblemPage,
} from "../../src/program-views.ts";
import {
  PROGRAM_DIGEST,
  PROGRAM_MANIFEST,
  type ProgramOverview,
  type ProgramReceipt,
} from "../../src/program-values.ts";
import {
  studyFixtureConfirmation,
  studyFixtureMemberPage,
  studyFixtureNotice,
  studyFixtureReceiptPage,
  studyFixtureStaffPage,
} from "../../src/study-unit-fixture-views.ts";
import type { StudyFixtureReceipt } from "../../src/study-unit-fixture-values.ts";
import {
  supportIntakePage,
  supportOwnerHistoryPage,
} from "../../src/support-request-views.ts";
import type { SupportRequestSummary } from "../../src/support-requests.ts";
import type { TrackSnapshot } from "../../src/track-readiness.ts";
import {
  assignmentAttemptPage,
  assignmentPortfolioStatement,
  assignmentReadinessPage,
  availabilityPage,
  circlesPage,
  dashboard,
  eventDetailPage,
  eventDiscoveryPage,
  evidencePage,
  contentPreview,
  libraryPage,
  localAiConsentPage,
  localAiControlPage,
  manualObservationPage,
  offerHypothesesPage,
  practiceSessionPage,
  practiceSessionStartPage,
  privatePracticePage,
  proposalPreviewPage,
  readinessPage,
  staffLibraryPage,
  studyReflectionPage,
  tailoredReviewUnavailablePage,
  withPrerequisiteTitles,
  trackReadinessPage,
  welcome,
  workflowDetailPage,
  workflowFeedbackPage,
} from "../../src/views.ts";

const hosted = <T>(render: () => T) => withHosting(true, render);
const INTERNAL_ON_HOSTED =
  /local preview|local registry|local circle|local event|local foundation|local participation|local preparation|local recovery|synthetic|(?<!azure-)hosted service|hosted learning|hosted tools/i;

const learner = {
  id: "a",
  background: "explorer" as const,
  goal: "everyday" as const,
};
const tracks = {
  foundation: [{ goal: "everyday", state: "in preparation" }],
  itSpecialties: [{ role: "qa", state: "in preparation" }],
  specialties: [
    {
      domain: "education",
      serviceType: "formal-review",
      state: "in preparation",
      gaps: ["Reviewed content not verified"],
    },
  ],
} as unknown as TrackSnapshot;
const circle = {
  id: "invented-circle",
  title: "Invented circle",
  description: "An invented space.",
  goal: "everyday",
  capacity: 5,
  seatsRemaining: 4,
  joined: true,
} as unknown as Parameters<typeof circlesPage>[0][number];
const parentId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const evidence: OwnedEvidence = {
  id: evidenceId,
  name: "revised.txt",
  mediaType: "text/plain",
  quarantineState: "pending",
  privateReviewAllowed: true,
  privateReviewRevokedAt: null,
  submissionStatus: null,
  createdAt: new Date("2026-09-24T00:00:00Z"),
  revisionParentId: parentId,
  revisionParentStatus: "current",
  revisionNumber: 2,
  hasRevision: false,
};
const attempt: AssignmentAttempt = {
  id: "33333333-3333-4333-8333-333333333333",
  contentId: "SYN-960",
  contentVersion: 3,
  title: "Invented assignment",
  rubric: null,
  rubricVersion: null,
  goalAtStart: "everyday",
  response: "",
  revision: 1,
  startedAt: new Date("2026-09-24T00:00:00Z"),
  savedAt: null,
  submittedAt: null,
  currentPublished: false,
  currentEligible: true,
};
const event = EVENT_PREVIEWS.find(
  (item) => item.id === "everyday-ai-preview" && item.version === 2,
)!;

function statusPage() {
  return readinessPage("demo", adapterReadiness({}, "demo"));
}

it("READABLE-01 the service status page names services plainly", () => {
  const html = statusPage();
  expect(html).toContain("<h1>Service status</h1>");
  expect(html).toContain("<title>Service status · Deep Native Engine</title>");
  for (const name of [
    "AI",
    "Payments",
    "File storage",
    "Calendar",
    "Email",
    "Sign-in",
    "Analytics",
  ])
    expect(html).toContain(`<strong>${name}</strong>`);
  expect(html).not.toMatch(/adapter|deterministic|side effect|integration/i);
  expect(html).not.toContain("<strong>ai</strong>");
  expect(html).toContain("DEMO SITE");
  expect(html).not.toContain("ENVIRONMENT");
});

it("READABLE-02 simulated services still say that nothing real happens", () => {
  const html = statusPage();
  expect(html).toContain(
    "A simulated result never means a message was sent, a payment was taken, a file was uploaded or an outside provider was contacted.",
  );
  for (const statement of [
    "Simulated. No request goes to an AI provider.",
    "Simulated. No payment is taken.",
    "Simulated. No file goes to an outside storage service.",
    "Simulated. No calendar booking is made.",
    "Simulated. No outside sign-in provider is contacted.",
    "Simulated. No analytics data goes to an outside service.",
  ])
    expect(html).toContain(statement);
});

it("READABLE-02 services that are off or unverified say so without settings names", () => {
  const html = readinessPage("live", adapterReadiness({}, "live"));
  expect(html).toContain("LIVE SITE");
  expect(html).toContain("Turned off. This service is not connected here.");
  expect(html).not.toMatch(/DNE_|Configure /);
  const configured = readinessPage("live", [
    {
      kind: "email",
      requestedMode: "live",
      state: "configured",
      message: "internal",
      missing: [],
    },
  ]);
  expect(configured).toContain(
    "Settings are in place. The provider connection has not been verified.",
  );
  expect(configured).not.toContain("internal");
});

it("READABLE-03 the email row tells the truth on each kind of site", () => {
  expect(statusPage()).toContain("Simulated. No email is sent.");
  const html = hosted(statusPage);
  expect(html).not.toContain("No email is sent");
  expect(html).toContain(
    "This test connection sends nothing. Sign-in and invoice emails use a separate email service when it is turned on for this site.",
  );
});

it("READABLE-04 the same action has the same name on the home page", () => {
  for (const html of [
    welcome("csrf"),
    welcome("csrf", [], undefined, true, { email: "" }),
  ]) {
    expect(html).toContain(
      '<a class="button landing-start" href="#your-path">Start my learning path</a>',
    );
    expect(html).not.toContain("Create account and start");
  }
});

it("READABLE-05 hosted pages do not use local-preview wording", () => {
  const render = {
    tracks: () => trackReadinessPage(tracks),
    home: () => welcome("csrf"),
    learn: () => dashboard(learner, undefined, "token"),
    library: () => libraryPage([], { q: "" }, []),
    events: () => eventDiscoveryPage([event], "UTC"),
    noEvents: () => eventDiscoveryPage([], "UTC", true),
    circles: () => circlesPage([circle], "everyday", "csrf"),
  };
  for (const [name, renderPage] of Object.entries(render)) {
    const html = hosted(renderPage);
    expect(html, name).not.toMatch(INTERNAL_ON_HOSTED);
    expect(html, name).not.toContain(">Local circles<");
    expect(html, name).toContain(">Service status</a>");
  }
});

it("READABLE-05 hosted link names match the page they open", () => {
  const detail = hosted(() =>
    eventDetailPage({ status: "current", event } as never, "UTC"),
  );
  expect(detail).toContain("INVENTED, UNREVIEWED SAMPLE");
  expect(detail).not.toContain("LOCAL PREVIEW");
  const html = hosted(() => dashboard(learner, undefined, "token"));
  expect(html).toContain('href="/circles">Explore learning circles</a>');
  expect(html).toContain('href="/events">Explore sample events</a>');
  expect(html).toContain('aria-label="Private participation"');
  const list = hosted(() => eventDiscoveryPage([event], "UTC"));
  // Keeping the promise: these are invented, unreviewed and not bookable.
  expect(list).toContain("INVENTED, UNREVIEWED SAMPLES");
  expect(list).toContain("Invented sample; enrollment unavailable");
  expect(list).toContain(
    "No real clinic, qualified expert, recording or live community is available here.",
  );
  const empty = hosted(() => eventDiscoveryPage([], "UTC", true));
  expect(empty).toContain("No upcoming sample events are available.");
  expect(empty).toContain("Nothing has been booked or reserved.");
  const tracksHtml = hosted(() => trackReadinessPage(tracks));
  expect(tracksHtml).toContain('<p class="eyebrow">NO SERVICE BOOKINGS</p>');
  expect(tracksHtml).toContain("formal review");
  expect(tracksHtml).not.toContain("formal-review");
});

it("READABLE-06 hosted private pages use names and versions instead of record IDs", () => {
  const evidenceHtml = hosted(() => evidencePage([evidence], "csrf"));
  const row = /<li><h3>[\s\S]*?<\/p>/.exec(evidenceHtml)![0];
  expect(row).toContain("revised.txt");
  expect(row).toContain("Private evidence version 2 · revises version 1");
  expect(row).not.toContain(parentId);
  expect(row).not.toContain(evidenceId);
  const attemptHtml = hosted(() => assignmentAttemptPage(attempt, "csrf"));
  expect(attemptHtml).toContain("<p>Assignment version 3 · goal when started");
  expect(attemptHtml).not.toContain("SYN-960");
});

it("READABLE-07 the local preview keeps saying it is a local preview with invented data", () => {
  const learn = dashboard(learner, undefined, "token");
  expect(learn).toContain('aria-label="Private local participation"');
  expect(learn).toContain('href="/circles">Explore local circles</a>');
  const list = eventDiscoveryPage([event], "UTC");
  expect(list).toContain("SYNTHETIC, UNREVIEWED LOCAL PREVIEWS");
  expect(list).toContain("Synthetic preview; enrollment unavailable");
  expect(trackReadinessPage(tracks)).toContain("LOCAL PREVIEW");
  expect(evidencePage([evidence], "csrf")).toContain(`revises ${parentId}`);
  expect(assignmentAttemptPage(attempt, "csrf")).toContain(
    "Assignment SYN-960 · Assignment version 3",
  );
  expect(circlesPage([circle], "everyday", "csrf")).toContain(
    ">Local circles<",
  );
});

// #716: the remaining member pages follow the same rule as READABLE-05 to 07.
const LOCAL_ON_HOSTED =
  /\blocal\b(?! times)|rehearsal|sandbox|\bfixture\b|synthetic|deterministic/i;
const visibleText = (html: string) =>
  html
    .replace(/<(head|script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ");
const firstLesson = PROGRAM_MANIFEST.lessons[0]!;
const program = {
  manifest: PROGRAM_MANIFEST,
  digest: PROGRAM_DIGEST,
  revision: 1,
  state: "open",
  availability: "ready",
  remaining: 20,
  lessons: PROGRAM_MANIFEST.lessons.map((lesson, index) => ({
    id: lesson.id,
    version: lesson.version,
    title: `Foundation title ${index + 1}`,
  })),
} as unknown as ProgramOverview;
const programReceipt = {
  id: "44444444-4444-4444-8444-444444444444",
  enrolledAt: "2026-09-24T00:00:00Z",
  manifest: PROGRAM_MANIFEST,
  digest: PROGRAM_DIGEST,
  activity: [],
} as unknown as ProgramReceipt;
const preview = {
  event: { ...event, fixtureCapacity: 5 },
  canEnroll: true,
  remaining: 3,
  activeReceiptId: null,
  cancelledAt: null,
} as never;
const registration = {
  id: "55555555-5555-4555-8555-555555555555",
  eventId: event.id,
  eventVersion: event.version,
  title: event.title,
  startsAt: new Date("2026-12-01T00:00:00Z"),
  endsAt: new Date("2026-12-01T01:00:00Z"),
  createdAt: new Date("2026-09-24T00:00:00Z"),
  withdrawnAt: null,
  cancelledAt: null,
};
const units = {
  scope: "synthetic-local-preview",
  asOf: new Date("2026-09-24T00:00:00Z"),
  categories: [
    {
      category: "study_requests",
      unit: "requests",
      grants: 0,
      usable: 0,
      held: 0,
      future: 0,
      awaitingExpiry: 0,
      consumed: 0,
      expired: 0,
      adjusted: 0,
      nextExpiry: null,
      nextStart: null,
    },
  ],
} as unknown as MemberTestUnitSnapshot;
const fixtureReceipt = {
  id: "66666666-6666-4666-8666-666666666666",
  policy: "invented",
  administratorId: null,
  createdAt: new Date("2026-09-24T00:00:00Z"),
  expiresAt: new Date("2026-09-24T00:30:00Z"),
  grantId: null,
  issuedAt: null,
  grantExpiresAt: null,
  withdrawnAt: null,
} as unknown as StudyFixtureReceipt;
const supportRequest = {
  requestId: "77777777-7777-4777-8777-777777777777",
  subject: "Invented question",
  receivedAt: new Date("2026-09-24T00:00:00Z"),
  acknowledgedAt: null,
  resolvedAt: null,
  withdrawnAt: null,
} as unknown as SupportRequestSummary;
const aiEvidenceId = "88888888-8888-4888-8888-888888888888";
const aiChoices = (jobStatus: string): LocalAiChoice[] => [
  {
    evidenceId: aiEvidenceId,
    name: "invented.txt",
    revisionNumber: 1,
    receiptId: "99999999-9999-4999-8999-999999999999",
    grantedAt: new Date("2026-09-24T00:00:00Z"),
    withdrawnAt: null,
    estimate: {
      inputTokens: 11,
      outputTokens: 256,
      costPoints: 157,
      modelVersion: "simulated-model-v1",
      rateVersion: "simulated-rates-v1",
    },
    jobs: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: jobStatus,
        testUnitState: "reserved",
      },
    ],
  },
];
const invented: ContentVersion = {
  id: "SYN-960",
  version: 3,
  kind: "assignment",
  origin: "curated",
  title: "Invented assignment",
  body: "Invented body.",
  owner: "Invented owner",
  sources: "Invented source",
  rights: "Invented rights",
  goals: [],
  backgrounds: [],
  domains: [],
  prerequisites: "",
  rubric: null,
  rubricVersion: null,
  state: "published",
  requiresQualifiedSignoff: false,
  reviewedAt: null,
  publishedAt: null,
};
const prerequisiteLesson: ContentVersion = {
  ...invented,
  id: "SYN-805",
  version: 2,
  kind: "lesson",
  title: "Check an invented claim",
};
const assignmentWithPrerequisite: ContentVersion = {
  ...invented,
  structuredPrerequisites: {
    schemaVersion: 1,
    all: [{ kind: "lesson", id: "SYN-805", version: 2, activity: "started" }],
  },
};
const lessonActivity = {
  contentId: "SYN-131",
  contentVersion: 2,
  title: "Invented lesson title",
  openedAt: new Date("2026-09-24T00:00:00Z"),
  startedAt: null,
  selfAssessedAt: null,
  available: true,
} as never;

it("READABLE-08 hosted program pages say simulation without local wording or lesson IDs", () => {
  const pages = {
    overview: () => programOverviewPage(program, "csrf", true),
    confirm: () => programConfirmPage(program, "csrf"),
    account: () => programAccountPage(true),
    problem: () => programProblemPage("Invented problem"),
    courses: () => myCoursesPage(programReceipt, program),
    noCourses: () => myCoursesPage(null, program),
    lostLesson: () => myCoursesPage(programReceipt, null),
  };
  for (const [name, render] of Object.entries(pages)) {
    const text = visibleText(hosted(render));
    expect(text, name).not.toMatch(LOCAL_ON_HOSTED);
    expect(text, name).not.toContain(firstLesson.id);
  }
  const overview = hosted(pages.overview);
  expect(overview).toContain("ENROLLMENT SIMULATION");
  expect(overview).toContain("<strong>Foundation title 1</strong> · version 2");
  expect(overview).toContain(
    "Enrollment creates no payment, paid entitlement, qualification, calendar commitment or staffed teaching promise.",
  );
  expect(hosted(pages.confirm)).toContain(
    "No charge, teaching service or qualification is created.",
  );
  expect(hosted(pages.courses)).toContain(
    "<strong>Foundation title 1 · version 2</strong>",
  );
  expect(hosted(pages.lostLesson)).toContain(
    "<strong>Foundation lesson 1 · version 2</strong>",
  );
});

it("READABLE-09 hosted event registration stays a practice with invented data only", () => {
  const pages = {
    enroll: () => eventEnrollmentPage(preview, "csrf", "operation"),
    full: () =>
      eventEnrollmentPage(
        { ...(preview as object), remaining: 0 } as never,
        "csrf",
        "operation",
      ),
    closed: () =>
      eventEnrollmentPage(
        { ...(preview as object), canEnroll: false } as never,
        "csrf",
        "operation",
      ),
    receipt: () => eventEnrollmentReceiptPage(registration, "csrf"),
    history: () =>
      eventEnrollmentHistoryPage({ items: [registration], nextCursor: null }),
  };
  for (const [name, render] of Object.entries(pages)) {
    const html = hosted(render);
    expect(visibleText(html), name).not.toMatch(LOCAL_ON_HOSTED);
    expect(html, name).toContain(
      "PRIVATE PRACTICE REGISTRATION · INVENTED DATA ONLY",
    );
    expect(html, name).toContain(
      "No expert, paid service, notification, recording or live clinic is provided.",
    );
  }
  expect(hosted(pages.enroll)).toContain("Save practice registration");
  // The notice follows each render, so a local page never shows hosted wording.
  expect(pages.enroll()).toContain("PRIVATE LOCAL REHEARSAL");
  expect(pages.enroll()).toContain("Enroll in local rehearsal");
  expect(hosted(pages.enroll)).not.toContain("PRIVATE LOCAL REHEARSAL");
});

it("READABLE-10 hosted test and study units drop local wording and keep their limits", () => {
  const pages = {
    units: () => memberTestUnitsPage(units, true),
    live: () => memberTestUnitsUnavailablePage("live"),
    request: () =>
      studyFixtureMemberPage("csrf", null, true, new Date("2026-09-24")),
    paused: () =>
      studyFixtureMemberPage("csrf", null, false, new Date("2026-09-24")),
    saved: () =>
      studyFixtureReceiptPage(fixtureReceipt, new Date("2026-09-24"), false),
    confirm: () =>
      studyFixtureConfirmation("csrf", {
        kind: "withdraw",
        key: "key",
        checked: { requestId: fixtureReceipt.id },
      }),
    notice: () => studyFixtureNotice("csrf", "Invented message"),
  };
  for (const [name, render] of Object.entries(pages))
    expect(visibleText(hosted(render)), name).not.toMatch(LOCAL_ON_HOSTED);
  expect(hosted(pages.units)).toContain("<h1>Your test units</h1>");
  expect(hosted(pages.units)).toContain(
    "Reading this page creates no allowance, purchase or booking.",
  );
  expect(hosted(pages.request)).toContain(
    "It is not money, a purchased plan, live AI access or a qualified service.",
  );
  expect(pages.units()).toContain("<h1>Your local test units</h1>");
  expect(pages.request()).toContain("<h1>Request three local study units</h1>");
});

it("READABLE-11 hosted circle discussion keeps invented examples only", async () => {
  const application = express();
  application.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    withHosting(true, next);
  });
  const store = Object.fromEntries(
    Object.keys(disabledCircleDiscussionStore()).map((name) => [
      name,
      vi.fn().mockResolvedValue({
        kind: "ready",
        value: { active: false, generation: "12345", items: [] },
      }),
    ]),
  ) as unknown as CircleDiscussionStore;
  registerCircleDiscussion(application, store);
  const { text } = await withLoopback(application, (listener) =>
    request(listener).get("/circles/everyday-ai/discussion/choice"),
  );
  expect(visibleText(text)).not.toMatch(LOCAL_ON_HOSTED);
  expect(text).toContain('<a href="/circles">Learning circles</a>');
  expect(text).toContain("INVENTED SAMPLE CIRCLE · UNREVIEWED");
  expect(text).toContain("Share invented examples only.");
  expect(text).toContain("Use invented information only.");
  expect(text).toContain(
    "no staffed moderation, response-time promise, qualified review, AI provider or payment service",
  );
  expect(visibleText(text)).not.toContain("12345");
});

it("READABLE-12 hosted support stays a sample request without record IDs in the list", () => {
  const list = hosted(() =>
    supportOwnerHistoryPage({ items: [supportRequest], nextCursor: null }),
  );
  expect(list).toContain(">Invented question</a>");
  expect(list).not.toMatch(/Invented question · /);
  expect(list).toContain("no guaranteed response time");
  // DNE_PRIVATE_SUPPORT_INTAKE stays off on the hosted site, so this remains true.
  const intake = hosted(() => supportIntakePage("csrf", "key"));
  expect(intake).toContain(
    "I used only invented or sample information and want to send this private request.",
  );
  expect(
    supportOwnerHistoryPage({ items: [supportRequest], nextCursor: null }),
  ).toContain(`Invented question · ${supportRequest.requestId}`);
});

it("READABLE-13 hosted AI simulation pages keep every limit without local wording", () => {
  const statuses = ["succeeded", "pending", "running", "failed"];
  for (const status of statuses)
    for (const state of ["enabled", "paused", "unavailable"] as const) {
      const html = hosted(() =>
        localAiConsentPage(aiChoices(status), "csrf", [], state),
      );
      expect(visibleText(html), status + state).not.toMatch(LOCAL_ON_HOSTED);
      expect(html).toContain("<title>AI simulation permission");
      expect(html).toContain("PRIVATE SIMULATION · INVENTED TEXT ONLY");
      expect(html).not.toContain(aiEvidenceId);
      for (const limit of [
        "no network request to an AI provider",
        "gives no qualified feedback",
        "does not establish production consent",
        "Do not put personal, client or confidential information here.",
        "Token and cost figures are estimates or simulated test amounts in points. No money is charged.",
      ])
        expect(html).toContain(limit);
    }
  const empty = hosted(() => localAiConsentPage([], "csrf"));
  expect(visibleText(empty)).not.toMatch(LOCAL_ON_HOSTED);
  const pending = hosted(() =>
    localAiConsentPage(aiChoices("pending"), "csrf"),
  );
  expect(pending).toContain("Queued only on this site");
  const local = localAiConsentPage(aiChoices("pending"), "csrf");
  expect(local).toContain("PRIVATE LOCAL SIMULATION");
  expect(local).toContain("Queued only in this local preview");
  expect(local).toContain(aiEvidenceId);
});

it("READABLE-14 hosted lesson history and prerequisites show titles instead of lesson IDs", () => {
  const history = hosted(() => libraryPage([], { q: "" }, [lessonActivity]));
  expect(history).toContain("<li>Invented lesson title · version 2 ·");
  expect(history).not.toContain("SYN-131 ·");
  const unnamed = hosted(() =>
    libraryPage([], { q: "" }, [
      { ...(lessonActivity as object), title: undefined } as never,
    ]),
  );
  expect(unnamed).toContain("<li>Earlier lesson · version 2 ·");
  const [titled] = withPrerequisiteTitles(
    [assignmentWithPrerequisite],
    [prerequisiteLesson],
  );
  const member = hosted(() => contentPreview(titled!, false));
  expect(member).toContain(
    "Lesson “Check an invented claim” version 2: started",
  );
  expect(member).not.toContain("SYN-805");
  const noTitle = hosted(() =>
    contentPreview(assignmentWithPrerequisite, false),
  );
  expect(noTitle).toContain("A published lesson version 2: started");
  // Staff tools stay out of this sweep and keep the record ID.
  expect(hosted(() => contentPreview(titled!, true))).toContain(
    "Lesson SYN-805 version 2: started",
  );
  expect(contentPreview(titled!, false)).toContain(
    "Lesson SYN-805 version 2: started",
  );
  expect(libraryPage([], { q: "" }, [lessonActivity])).toContain(
    "<li>SYN-131 · version 2 ·",
  );
});

// #717: what #716 left. Versioned content and machine values stay as they are.
const practiceEvent = EVENT_PREVIEWS.find(
  (item) => item.id === "local-registration-rehearsal",
)!;
const PRACTICE_TITLE = "Event registration practice";

it("READABLE-15 hosted foundation access page uses plan names instead of policy and terms IDs", () => {
  const html = hosted(offerHypothesesPage);
  const text = visibleText(html);
  expect(html).not.toContain(FOUNDATION_ACCESS.policyVersion);
  expect(text).not.toContain("Access policy");
  expect(text).not.toMatch(LOCAL_ON_HOSTED);
  expect(html).toContain("CAD 0.00 for initial foundation access.");
  for (const offer of COACHING_OFFERS) {
    expect(html).not.toContain(offer.termsVersion);
    expect(html).not.toContain(`<strong>${offer.id}</strong>`);
    expect(html).toContain(
      `CAD ${(offer.priceCents / 100).toLocaleString("en-CA")} · ${offer.months} monthly periods`,
    );
  }
  expect(html).toContain("<strong>Professional plan</strong>");
  expect(html).not.toContain(" · hypothesis</li>");
  expect(html.match(/ · Not available<\/li>/g)).toHaveLength(
    COACHING_OFFERS.length,
  );
  // Keeping the promise: none of these plans can be bought, and no price is permanent.
  expect(html).toContain(
    "These historical prices and allowances are hypotheses, not available offers.",
  );
  expect(html).toContain("cannot be bought on this page");
  expect(html).toContain("not a promise of a permanent price or term");
  const local = offerHypothesesPage();
  expect(local).toContain(`Access policy: ${FOUNDATION_ACCESS.policyVersion}`);
  expect(local).toContain("<strong>professional</strong>");
  expect(local).toContain("2026-09-15-hypothesis-v1 · hypothesis</li>");
});

it("READABLE-16 hosted event agenda and practice title read plainly while the content stays versioned", () => {
  const detail = hosted(() =>
    eventDetailPage(
      { status: "current", event: practiceEvent } as never,
      "UTC",
    ),
  );
  expect(visibleText(detail)).not.toMatch(LOCAL_ON_HOSTED);
  expect(detail).toContain("<li>Read an invented example</li>");
  expect(detail).toContain(`<h1>${PRACTICE_TITLE}</h1>`);
  expect(detail).toContain(`<title>${PRACTICE_TITLE}`);
  const list = hosted(() => eventDiscoveryPage([practiceEvent], "UTC"));
  expect(list).toContain(`>${PRACTICE_TITLE}</a>`);
  expect(visibleText(list)).not.toMatch(LOCAL_ON_HOSTED);
  const saved = { ...registration, title: practiceEvent.title };
  for (const html of [
    hosted(() => eventEnrollmentReceiptPage(saved, "csrf")),
    hosted(() =>
      eventEnrollmentHistoryPage({ items: [saved], nextCursor: null }),
    ),
    hosted(() =>
      eventEnrollmentPage(
        {
          ...(preview as object),
          event: { ...practiceEvent, fixtureCapacity: 5 },
        } as never,
        "csrf",
        "operation",
      ),
    ),
  ]) {
    expect(html).toContain(PRACTICE_TITLE);
    expect(visibleText(html)).not.toMatch(LOCAL_ON_HOSTED);
  }
  const attendance = hosted(() =>
    attendanceHistoryPage(
      {
        items: [
          {
            registrationId: registration.id,
            title: practiceEvent.title,
            eventVersion: practiceEvent.version,
          } as never,
        ],
        nextCursor: null,
      },
      new Date("2026-09-24"),
    ),
  );
  expect(attendance).toContain(PRACTICE_TITLE);
  expect(attendance).not.toContain("Local event registration rehearsal");
  // The stored content and the local preview keep the original words.
  expect(practiceEvent.title).toBe("Local event registration rehearsal");
  expect(practiceEvent.agenda).toContain("Read a synthetic example");
  const local = eventDetailPage(
    { status: "current", event: practiceEvent } as never,
    "UTC",
  );
  expect(local).toContain("<li>Read a synthetic example</li>");
  expect(local).toContain("<h1>Local event registration rehearsal</h1>");
  expect(eventEnrollmentReceiptPage(saved, "csrf")).toContain(
    "Local event registration rehearsal",
  );
});

it("READABLE-17 hosted test-unit download has a plain file name and keeps its machine-readable scope", async () => {
  const download = async (isHosted: boolean) => {
    const application = express();
    application.use((_req, res, next) => {
      res.locals.token = "invented-token";
      withHosting(isHosted, next);
    });
    registerMemberTestUnitsRoutes(
      application,
      { snapshot: vi.fn().mockResolvedValue({ kind: "ready", value: units }) },
      "demo",
    );
    return withLoopback(application, (listener) =>
      request(listener).get("/member/test-units/download"),
    );
  };
  const online = await download(true);
  expect(online.headers["content-disposition"]).toBe(
    'attachment; filename="test-units.json"',
  );
  expect(online.body.scope).toBe("synthetic-local-preview");
  const local = await download(false);
  expect(local.headers["content-disposition"]).toBe(
    'attachment; filename="local-test-units.json"',
  );
  expect(local.body.scope).toBe("synthetic-local-preview");
});

it("READABLE-18 hosted study-unit staff titles drop local wording and local keeps it", () => {
  const attempt = {
    kind: "issue",
    key: "key",
    checked: { requestId: fixtureReceipt.id },
  } as const;
  const staffPage = () => studyFixtureStaffPage("csrf", "reference", true);
  const confirm = () => studyFixtureConfirmation("csrf", attempt);
  const receipt = () =>
    studyFixtureReceiptPage(fixtureReceipt, new Date("2026-09-24"), true);
  expect(hosted(staffPage)).toContain("<h1>Study-unit issuance</h1>");
  expect(hosted(confirm)).toContain("Confirm three study units");
  expect(hosted(receipt)).toContain(">Issuance work</a>");
  for (const render of [staffPage, confirm, receipt])
    expect(visibleText(hosted(render))).not.toMatch(/\blocal\b/i);
  // The limits on what these units are stay on the staff page.
  expect(hosted(staffPage)).toContain(
    "It is not money, a purchased plan, live AI access or a qualified service.",
  );
  expect(staffPage()).toContain("<h1>Local study-unit issuance</h1>");
  expect(confirm()).toContain("Confirm three local study units");
  expect(receipt()).toContain(">Local issuance work</a>");
});

// #725: staff tools follow READABLE-18. Limits and machine values stay as they are.
const LOCAL_WORD = /\blocal\b/i;
const staffReference = {
  staffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reviewerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "moderator",
  expiresAt: new Date("2026-09-24T00:30:00Z"),
} as never;
const inventory = {
  ...(program as object),
  state: "closed",
  availability: "unavailable",
} as unknown as ProgramOverview;
const hold = {
  jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "running",
  unitState: "reserved",
  createdAt: new Date("2026-09-24T00:00:00Z"),
  updatedAt: new Date("2026-09-24T00:00:00Z"),
  leaseUntil: null,
  policy: "invented-policy",
  promptTemplateVersion: "invented-prompt",
  modelContractVersion: "invented-model",
  state: "needs-reconciliation",
} as never;
const cancellationAttempt = {
  eventId: "invented",
  eventVersion: 1,
  title: "Invented event",
  startsAt: "2026-09-24T00:00:00.000Z",
  endsAt: "2026-09-24T01:00:00.000Z",
  key: "key",
} as never;
const staffPages = {
  aiControl: () => localAiControlPage(false, "csrf"),
  aiControlPaused: () => localAiControlPage(true, "csrf"),
  manualObservations: () => manualObservationPage([], "csrf", "key"),
  staffLibrary: () => staffLibraryPage([], "csrf"),
  programs: () => programAdminPage({ ...program, state: "not_open" }, "csrf"),
  closedProgram: () => programAdminPage(inventory, "csrf"),
  holds: () => localAiHoldListPage([hold], null),
  hold: () => localAiHoldDetailPage(hold),
  holdsLive: () => localAiHoldUnavailablePage("live"),
  circleReference: () => circleGrantReferencePage(staffReference),
  circleNotice: () => circleGrantNoticePage("csrf", "Invented message"),
  circleHistory: () =>
    circleGrantHistoryPage("csrf", {
      staffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      circleId: "invented-circle",
      observedAt: new Date("2026-09-24T00:00:00Z"),
      items: [],
      nextCursor: null,
    } as never),
  supportReference: () => assignmentReferencePage(staffReference),
  reviewerReference: () => reviewerSampleReference(staffReference),
  cancellation: () => eventCancellationHome("csrf", true),
  cancellationConfirm: () =>
    eventCancellationConfirm(
      "csrf",
      { creationEnabled: true, receipt: null } as never,
      cancellationAttempt,
    ),
  rehearsal: () => eventRehearsalHome("csrf", true),
  rehearsalNotice: () => eventRehearsalNotice("csrf", "Invented message"),
  attendance: () => attendanceStaffHome("csrf", "reference", true),
};

it("READABLE-19 hosted staff pages drop local wording and the local preview keeps it", () => {
  for (const [name, render] of Object.entries(staffPages))
    expect(visibleText(hosted(render)), name).not.toMatch(LOCAL_WORD);
  for (const [render, heading] of [
    [staffPages.aiControl, "AI simulation control"],
    [staffPages.programs, "Program inventory"],
    [staffPages.holds, "Assigned test request holds"],
    [staffPages.hold, "Assigned test request snapshot"],
    [staffPages.holdsLive, "Test request inspection unavailable"],
    [staffPages.supportReference, "My assignment ID"],
  ] as const) {
    expect(hosted(render)).toContain(`<h1>${heading}</h1>`);
    expect(hosted(render)).toContain(`<title>${heading}`);
  }
  for (const [render, heading] of [
    [staffPages.aiControl, "Local AI simulation control"],
    [staffPages.programs, "Local program inventory"],
    [staffPages.holds, "Assigned local request holds"],
    [staffPages.holdsLive, "Local request inspection unavailable"],
    [staffPages.supportReference, "My local assignment ID"],
  ] as const)
    expect(render()).toContain(`<h1>${heading}</h1>`);
  expect(staffPages.aiControl()).toContain("LOCAL SIMULATION ONLY");
  expect(staffPages.staffLibrary()).toContain("LOCAL STAFF PREVIEW");
  expect(staffPages.circleReference()).toContain("trusted local administrator");
  expect(staffPages.reviewerReference()).toContain(
    "trusted local administrator",
  );
  expect(staffPages.cancellation()).toContain("PRIVATE LOCAL EVENT REHEARSAL");
  expect(staffPages.rehearsal()).toContain("local learning rehearsal");
  expect(staffPages.manualObservations()).toContain("Existing local member ID");
});

it("READABLE-19 hosted staff pages keep every statement about simulation, invented data and payment", () => {
  const control = hosted(staffPages.aiControl);
  expect(control).toContain("SIMULATION ONLY");
  expect(control).toContain("simulated demo and test requests");
  expect(control).toContain(
    "It grants no permission, credits, provider access or paid service.",
  );
  const holds = hosted(staffPages.holds);
  expect(holds).toContain("INVENTED TESTS");
  expect(holds).toContain(
    "not evidence of external provider execution, staffed coverage or an approved resolution. Nothing here charges, refunds, releases a unit or retries a request.",
  );
  const observations = hosted(staffPages.manualObservations);
  expect(observations).toContain("NO LIVE PAYMENT");
  expect(observations).toContain(
    "These invented records are not provider verification, a paid invoice, a charge, service delivery or a grant of access.",
  );
  expect(hosted(staffPages.programs)).toContain(
    "This operation does not publish content or provision teaching staff.",
  );
  expect(hosted(staffPages.rehearsal)).toContain(
    "This is not a real clinic, expert service, recording, attendance record or paid booking.",
  );
  expect(hosted(staffPages.cancellation)).toContain(
    "This does not cancel a real appointment, notify attendees, issue refunds or record attendance.",
  );
  expect(hosted(staffPages.circleHistory)).toContain(
    "Use invented information only.",
  );
});

it("READABLE-20 the attendance notice and attribution read plainly when hosted, and stored values stay", () => {
  const observation = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    recordedAt: new Date("2026-09-24T00:00:00Z"),
    attribution: "Local platform administrator",
  } as const;
  const receipt = {
    kind: "observe",
    observation: { ...observation, registrationId: registration.id },
  } as never;
  const member = () =>
    attendanceMemberPage(
      "csrf",
      {
        registrationId: registration.id,
        title: practiceEvent.title,
        eventVersion: practiceEvent.version,
        eventStartsAt: registration.startsAt,
        eventEndsAt: registration.endsAt,
        registrationWithdrawnAt: null,
        cancelledAt: null,
        observation,
        permission: null,
        creationEnabled: false,
      } as never,
      new Date("2026-09-24"),
      "key",
    );
  const saved = () => attendanceSavedPage(receipt, "key");
  const history = () =>
    attendanceHistoryPage(
      { items: [], nextCursor: null },
      new Date("2026-09-24"),
    );
  for (const [name, render] of Object.entries({ member, saved, history })) {
    const html = hosted(render);
    expect(visibleText(html), name).not.toMatch(LOCAL_WORD);
    expect(html, name).toContain("PRIVATE PRACTICE EVENT · INVENTED DATA ONLY");
    expect(html, name).toContain(
      "This is not a qualified assessment, course completion, credential or proof of real clinic service.",
    );
    expect(render(), name).toContain("PRIVATE LOCAL REHEARSAL");
  }
  expect(hosted(member)).toContain("· Platform administrator.");
  expect(hosted(saved)).toContain("by Platform administrator.");
  expect(member()).toContain("· Local platform administrator.");
  expect(saved()).toContain("by Local platform administrator.");
  const checked = {
    eventId: "invented",
    eventVersion: 1,
    permissionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    registrationId: registration.id,
    startsAt: new Date("2026-09-24"),
    expiresAt: new Date("2026-09-25"),
  } as never;
  const confirm = () => attendanceObservationConfirm("csrf", checked, "key");
  expect(hosted(confirm)).toContain(
    "this exact invented practice event. This is not a qualified assessment.",
  );
  expect(confirm()).toContain("this exact invented local rehearsal.");
});

it("READABLE-21 hosted staff notices name the tool plainly and the local preview keeps its words", async () => {
  const off = { mode: "test", localStaffEntry: false } as const;
  const cases: [string, (application: Express) => void, string, string][] = [
    [
      "/operator/circle-grants",
      (a) => mountCircleGrantRoutes(a, undefined, off as never),
      "Circle grant administration is unavailable on this site.",
      "Local circle grant administration is unavailable in this configuration.",
    ],
    [
      "/operator/event-attendance",
      (a) => mountEventAttendanceRoutes(a, undefined, off),
      "Attendance is unavailable on this site.",
      "Local rehearsal attendance is unavailable in this configuration.",
    ],
    [
      "/events/attendance",
      (a) => mountEventAttendanceRoutes(a, undefined, off),
      "Attendance is unavailable on this site.",
      "Local rehearsal attendance is unavailable in this configuration.",
    ],
    [
      "/operator/event-cancellations",
      (a) => mountEventCancellationRoutes(a, undefined, off),
      "Event cancellation is unavailable on this site.",
      "Local event cancellation is unavailable in this configuration.",
    ],
    [
      "/operator/event-rehearsals",
      (a) => mountEventRehearsalRoutes(a, undefined, off),
      "Rehearsal scheduling is unavailable on this site.",
      "Local rehearsal scheduling is unavailable in this configuration.",
    ],
    [
      "/operator/support-assignment",
      (a) => mountSupportAssignmentRoutes(a, undefined, off as never),
      "Support assignment administration is unavailable on this site.",
      "Local support assignment administration is unavailable in this configuration.",
    ],
    [
      STUDY_STAFF_PATH,
      (a) => mountStudyUnitFixtureRoutes(a, undefined, off),
      "Test-unit issuance is unavailable on this site.",
      "Local test-unit issuance is unavailable in this configuration.",
    ],
  ];
  const read = (
    path: string,
    mount: (application: Express) => void,
    isHosted: boolean,
  ) => {
    const application = express();
    application.use((_req, res, next) => {
      res.locals.csrf = "invented-csrf";
      withHosting(isHosted, next);
    });
    mount(application);
    return withLoopback(application, (listener) => request(listener).get(path));
  };
  for (const [path, mount, plain, original] of cases) {
    const online = await read(path, mount, true);
    expect(online.status, path).toBe(404);
    expect(online.text, path).toContain(plain);
    expect(visibleText(online.text), path).not.toMatch(LOCAL_WORD);
    expect((await read(path, mount, false)).text, path).toContain(original);
  }
});

it("READABLE-22 hosted staff sign-in and tools drop local wording, and the local preview keeps it", async () => {
  const read = async (hosted: boolean, role = "operator") => {
    const origin = hosted ? "https://engine.example" : "http://127.0.0.1:3000";
    const admit = vi.fn().mockResolvedValue({
      kind: "ready",
      role,
      deadline: performance.now() + 60000,
      expiresAt: new Date(Date.now() + 60000),
    });
    const application = app(
      {
        create: vi.fn(),
        session: vi.fn().mockResolvedValue({ kind: "missing" }),
      } as unknown as Store,
      {
        origin,
        ...(hosted ? { hostedOrigin: origin } : {}),
        secret: "invented-staff-test",
        localStaffEntry: true,
        staffEntry: { admit },
        catalog: disabledCatalogStore(),
        localAiControl: {
          current: vi.fn().mockResolvedValue("enabled"),
          read: vi.fn().mockResolvedValue({ paused: false }),
          set: vi.fn(),
        },
      },
    );
    const requestHost = new URL(origin).host;
    return withLoopback(application, async (listener) => ({
      signIn: await request(listener)
        .get("/staff/sign-in")
        .set("Host", requestHost),
      tools: await request(listener)
        .get("/staff")
        .set("Host", requestHost)
        .set("Cookie", `dne_staff=${"b".repeat(64)}`),
    }));
  };
  const online = await read(true);
  expect(online.signIn.text).toContain("<h1>Sign in to staff tools</h1>");
  expect(online.signIn.text).toContain("Trusted staff credential");
  expect(visibleText(online.signIn.text)).not.toMatch(/\blocal\b/i);
  expect(online.tools.text).toContain("<h1>Your staff tools</h1>");
  expect(online.tools.text).toContain("Current role: Operator.");
  expect(visibleText(online.tools.text)).not.toMatch(/\blocal\b/i);
  expect(online.tools.text).not.toContain("hosted service");
  expect((await read(true, "moderator")).tools.text).toContain(
    "Current role: Moderator.",
  );
  const platform = await read(true, "platform_admin");
  expect(platform.tools.text).toContain(">AI simulation control</a>");
  expect(visibleText(platform.tools.text)).not.toMatch(/\blocal\b/i);
  const local = await read(false);
  expect(local.signIn.text).toContain("<h1>Sign in to local staff tools</h1>");
  expect(local.signIn.text).toContain("Trusted local staff credential");
  expect(local.tools.text).toContain("<h1>Your local staff tools</h1>");
  expect(local.tools.text).toContain("Current role: Local operator.");
});

// #730: what #716, #717 and #725 left, using the report's own definitions.
it("READABLE-23 the hosted metrics report reads its real definitions without local wording", () => {
  const report = (definitions: PreviewMetrics["definitions"]) =>
    metricsReportPage({
      scope: "synthetic-local-preview",
      asOf: new Date("2026-09-24T00:00:00Z"),
      definitions,
      learning: learningDisclosure({
        members: 0,
        activated: 0,
        selfAssessed: 0,
        participated: 0,
        activeCircle: 0,
        submittedAssignment: 0,
        returnEligible: 0,
        crossContentReturned: 0,
      }),
      segments: learningSegments(
        { background: {}, goal: {}, interests: {} },
        0,
      ),
      cohorts: learningCohorts([]),
      usefulness: usefulnessDisclosure(0, 0, 0),
      contributions: contributionMetrics(new Date("2026-09-24T00:00:00Z"), []),
    } as never);
  const online = hosted(metricDefinitions);
  for (const text of Object.values(online))
    expect(text).not.toMatch(LOCAL_ON_HOSTED);
  const page = hosted(() => report(online));
  expect(visibleText(page)).not.toMatch(LOCAL_ON_HOSTED);
  expect(page).toContain("Current retained member records");
  expect(online.participated).toContain("ever joined a circle");
  expect(online.activeCircle).toContain("with a circle membership");
  // Keeping the promise: self-report, suppression and no live analytics stay.
  expect(online.usefulness).toContain(
    "Member self-reported usefulness on this site, not observed skill, qualified review or current curriculum quality.",
  );
  expect(online.usefulness).toContain("this is not approved live analytics");
  expect(online.activeCircle).toContain(
    "No shared community or clinic is implied.",
  );
  const local = metricDefinitions();
  expect(local.denominator).toContain(
    "Current retained local-preview member records",
  );
  expect(local.participated).toContain("ever joined a local circle");
  expect(local.activeCircle).toContain("with a local circle membership");
  expect(local.usefulness).toContain("in this synthetic local preview");
  // The metric keys and machine-readable scope are unchanged.
  expect(Object.keys(online)).toEqual(Object.keys(local));
});

it("DEMOACCT-03/04 the accounts definition follows the site, not the hosting", () => {
  expect(metricDefinitions().accounts).toBe(
    "Every figure counts only accounts that were not created while the site ran as a demo. Demo accounts and their activity are left out.",
  );
  expect(metricDefinitions(true).accounts).toBe(
    "This site runs as a demo, so every figure counts only accounts created on the demo. They are test data, not live figures.",
  );
  // Only the accounts sentence changes on a demo site.
  expect({ ...metricDefinitions(true), accounts: "" }).toEqual({
    ...metricDefinitions(),
    accounts: "",
  });
});

const comparison =
  "Simulation — unreviewed local comparison. Your paired words: “my local words and This deterministic comparison does not verify”\n" +
  "Exact source excerpt (SYN-960 v3): “a synthetic excerpt”\n" +
  "Compare the two yourself and identify a detail to verify. This deterministic comparison does not verify accuracy and cannot judge competence. Uncertainty remains; no qualified review has occurred.";
const practiceSource = {
  id: "SYN-960",
  version: 3,
  title: "Invented lesson",
  body: "Invented body.",
  promptVersion: "invented-prompt",
  prompt: "Invented prompt",
  response: null,
  withdrawnAt: null,
  sourceExcerpt: "Invented excerpt.",
  contentId: "SYN-960",
  contentVersion: 3,
  goal: "everyday",
  interview: {
    promptVersion: "invented-interview-prompt",
    prompt: "Invented interview prompt",
  },
} as never;
const practiceDetail = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  contentId: "SYN-960",
  contentVersion: 3,
  promptVersion: "invented-prompt",
  title: "Invented lesson",
  goal: "everyday",
  availability: "available",
  prompt: "Invented prompt",
  nextSequence: 2,
  createdAt: new Date("2026-09-24T00:00:00Z"),
  withdrawnAt: null,
  exchanges: [
    {
      sequence: 1,
      response: "Invented response",
      comparison,
      sourceExcerpt: "Invented excerpt.",
      acceptedAt: new Date("2026-09-24T00:00:00Z"),
    },
  ],
} as never;
const workflow = (await workflowBundle("WF-001"))!;
const reflectionSource = { ...invented, kind: "lesson" as const };
const memberPages = {
  availability: () => availabilityPage([], "UTC"),
  tailoredReview: () =>
    tailoredReviewUnavailablePage(
      {
        domain: "education",
        serviceType: "formal-review",
        state: "in preparation",
        gaps: [],
      } as never,
      "education" as never,
    ),
  proposal: () =>
    proposalPreviewPage(
      {
        id: "invented",
        origin: "sample",
        state: "changes_requested",
        title: "Invented",
        body: "Invented body",
        sources: "Invented sources",
        revision: 2,
        createdAt: new Date("2026-09-24T00:00:00Z"),
        updatedAt: new Date("2026-09-24T00:00:00Z"),
        rightsAttestedRevision: null,
        rightsAttestedAt: null,
        feedback: {
          reviewedRevision: 1,
          requestedAt: new Date("2026-09-24T00:00:00Z"),
          text: "Invented",
        },
      } as never,
      "csrf",
    ),
  readiness: () =>
    assignmentReadinessPage(
      {
        contentId: "SYN-960",
        contentVersion: 3,
        title: "Invented assignment",
        requirements: [],
        ready: true,
      } as never,
      "csrf",
    ),
  portfolio: () =>
    assignmentPortfolioStatement(attempt, {
      sequence: 1,
      submittedAt: "2026-09-24T00:00:00Z",
      response: "Invented",
    }),
  fullCircle: () =>
    circlesPage(
      [{ ...(circle as object), joined: false, seatsRemaining: 0 } as never],
      "everyday",
      "csrf",
    ),
  sample: () => contentPreview(reflectionSource, false),
  workflowNote: () =>
    workflowFeedbackPage(
      workflow,
      [
        {
          workflowId: "WF-001",
          workflowVersion: workflow.version,
          note: "Invented",
          revision: 1,
          createdAt: new Date("2026-09-24T00:00:00Z"),
          updatedAt: new Date("2026-09-24T00:00:00Z"),
        },
      ],
      "csrf",
      "WF-001",
      { configured: true, enabled: true },
    ),
  reflection: () =>
    studyReflectionPage(reflectionSource, "everyday", "csrf", "Invented"),
  practiceStart: () => practiceSessionStartPage(practiceSource, "csrf"),
  practice: () => practiceSessionPage(practiceDetail, "csrf"),
  privatePractice: () =>
    privatePracticePage(
      { ...(practiceSource as object), response: "Invented" } as never,
      "csrf",
    ),
  reviewRequest: () =>
    workflowReviewPreviewPage(
      {
        title: "Invented",
        workflowId: "WF-001",
        workflowVersion: 1,
        revision: 1,
        note: "Invented",
        expiresAt: new Date("2026-09-25T00:00:00Z"),
        checked: "checked",
      } as never,
      "csrf",
      "operation",
    ),
};

it("READABLE-24 hosted member pages drop local wording and the local preview keeps it", () => {
  // "local appointment times" means the member's own time zone and stays.
  const shown = (html: string) =>
    visibleText(html)
      .replace("local appointment times", "appointment times")
      .replace("my local words and This deterministic comparison", "")
      .replace("a synthetic excerpt", "");
  for (const [name, render] of Object.entries(memberPages))
    expect(shown(hosted(render)), name).not.toMatch(LOCAL_ON_HOSTED);
  // The workflow itself is reviewed, versioned content, so only its label changes.
  expect(hosted(() => workflowDetailPage(workflow))).toContain(
    "Select and copy the sample workflow text",
  );
  expect(workflowDetailPage(workflow)).toContain(
    "Select and copy the synthetic workflow text",
  );
  expect(hosted(memberPages.availability)).toContain(
    ">View your test units</a>",
  );
  expect(hosted(memberPages.fullCircle)).toContain("This circle is full.");
  expect(hosted(memberPages.practice)).toContain(
    "<h3>Comparison · turn 2</h3>",
  );
  for (const [render, text] of [
    [memberPages.availability, "View your local test units"],
    [memberPages.tailoredReview, "common local foundation"],
    [memberPages.proposal, "Private local feedback on revision"],
    [memberPages.readiness, "No additional local prerequisites are named."],
    [memberPages.portfolio, "Private local learning sample."],
    [memberPages.fullCircle, "This local circle is full."],
    [memberPages.workflowNote, "can permit local reading."],
    [memberPages.sample, "LOCAL PUBLISHED PREVIEW"],
    [memberPages.sample, "synthetic local preview"],
    [memberPages.reflection, "This published sample is synthetic"],
    [memberPages.reflection, "This deterministic prompt"],
    [memberPages.practiceStart, "one deterministic local source comparison"],
    [memberPages.practice, "These deterministic comparisons"],
    [memberPages.practice, "Local comparison · turn 2"],
    [memberPages.privatePractice, "local comparisons"],
    [memberPages.reviewRequest, "PRIVATE LOCAL REVIEW REQUEST"],
    [memberPages.reviewRequest, "individually assigned local moderator"],
  ] as const)
    expect(render()).toContain(text);
});

it("READABLE-24 hosted member pages keep every statement about simulation, invented data and review", () => {
  const history = (isHosted: boolean) =>
    withHosting(
      isHosted,
      () =>
        activityItems(undefined, [], [], [
          {
            lessonId: LESSON.id,
            version: LESSON.version,
            instruction: "Invented",
            verification: "Invented",
            completedAt: null,
            withdrawnAt: null,
            goalAtStart: "everyday",
          },
        ] as never)[0]!.availability,
    );
  expect(history(true)).toMatch(/Foundation exercise; no qualified review$/);
  expect(history(false)).toMatch(
    /Local foundation preview; no qualified review$/,
  );
  expect(hosted(memberPages.portfolio)).toContain(
    "This is not a credential, qualification, expert assessment or paid review.",
  );
  expect(hosted(memberPages.reflection)).toContain(
    "This published sample is invented and has not received qualified foundation sign-off.",
  );
  expect(hosted(memberPages.reflection)).toContain(
    "No live AI provider, paid allowance or formal reviewer is connected.",
  );
  expect(hosted(memberPages.reflection)).toContain(
    "This prompt is not a competence assessment, generated answer or formal review.",
  );
  expect(hosted(memberPages.practiceStart)).toContain(
    "No live AI provider, paid allowance or qualified reviewer is connected.",
  );
  expect(hosted(memberPages.practice)).toContain(
    "These comparisons cannot judge competence",
  );
  expect(hosted(memberPages.privatePractice)).toContain(
    "This prompt is not an evaluation.",
  );
  expect(hosted(memberPages.reviewRequest)).toContain(
    "It is not qualified assessment or public publication.",
  );
});

it("READABLE-25 a saved practice comparison reads plainly when hosted and is unchanged when saved", () => {
  const online = hosted(() => practiceComparison(comparison));
  expect(online).toMatch(/^Simulation — unreviewed comparison\. Your paired/);
  // A member's or a source's own words are never rewritten.
  expect(online).toContain(
    "“my local words and This deterministic comparison does not verify”",
  );
  expect(online).toContain("“a synthetic excerpt”");
  expect(online).toMatch(
    /This comparison does not verify accuracy and cannot judge competence\. Uncertainty remains; no qualified review has occurred\.$/,
  );
  expect(practiceComparison(comparison)).toBe(comparison);
  const page = hosted(memberPages.practice);
  expect(page).toContain("Simulation — unreviewed comparison.");
  expect(page).not.toContain("Simulation — unreviewed local comparison.");
  expect(memberPages.practice()).toContain(
    "Simulation — unreviewed local comparison.",
  );
});

it("INTERVIEW-03 a hosted interview comparison reads plainly and keeps its no-prediction line", () => {
  const notice =
    "This interview practice doesn't predict hiring, interview results or competence.";
  const online = hosted(() => practiceComparison(`${comparison}\n${notice}`));
  expect(online).toContain(
    "This comparison does not verify accuracy and cannot judge competence.",
  );
  expect(online).not.toContain("verify. This deterministic comparison");
  expect(online.endsWith(`\n${notice}`)).toBe(true);
});
it("READABLE-25 the provided-sample label reads plainly when hosted and keeps invented and unreviewed", () => {
  const origin = {
    label: PROVIDED_SAMPLE_LABEL,
    templateId: "invented",
    templateVersion: 1,
    templateDigest: "digest",
  };
  const clean = {
    ...evidence,
    quarantineState: "clean",
    origin,
    revisionParentId: null,
  } as never;
  const list = hosted(() => evidencePage([clean], "csrf"));
  expect(visibleText(list)).not.toMatch(/\blocal\b|synthetic/i);
  expect(list).toContain("Provided invented example · unreviewed · template");
  expect(list).toContain("Fixed provided example; bundled invented source");
  const samples = hosted(() => preparedSamplesPage("csrf", "everyday"));
  expect(samples).toContain(">Provided invented example · unreviewed<");
  expect(visibleText(samples)).not.toMatch(/\blocal\b|synthetic/i);
  expect(evidencePage([clean], "csrf")).toContain(PROVIDED_SAMPLE_LABEL);
  expect(preparedSamplesPage("csrf", "everyday")).toContain(
    PROVIDED_SAMPLE_LABEL,
  );
  // Saved and exported values stay as they are.
  expect(PROVIDED_SAMPLE_LABEL).toBe(
    "Provided invented example · local synthetic · unreviewed",
  );
});

it("READABLE-26 hosted review and support minutes drop local wording and keep their limits", async () => {
  for (const [form, limit, localHeading] of [
    [
      () => reviewGrantForm("csrf", true),
      "This creates no units, sample assignment, staff identity or qualification.",
      "PRIVATE LOCAL REVIEW MINUTES",
    ],
    [
      () => supportMinuteForm("csrf", true),
      "This creates no units, request-text assignment, staff identity or qualification.",
      "PRIVATE LOCAL SUPPORT MINUTES",
    ],
  ] as const) {
    const html = hosted(form);
    expect(visibleText(html)).not.toMatch(LOCAL_WORD);
    expect(html).toContain(limit);
    expect(html).toContain("invented");
    expect(form()).toContain(localHeading);
  }
  const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const receipt = {
    allocationId: id,
    state: "allocated",
    held: 20,
    consumed: 0,
    released: 0,
    sourceAvailable: true,
  };
  const read = async (isHosted: boolean) => {
    const application = express();
    application.use((_req, res, next) => {
      res.locals.token = "invented-token";
      res.locals.csrf = "invented-csrf";
      withHosting(isHosted, next);
    });
    mountReviewTimeRoutes(
      application,
      {
        receipt: vi.fn().mockResolvedValue({ kind: "applied", receipt }),
        history: vi
          .fn()
          .mockResolvedValue({ kind: "ready", receipts: [], next: null }),
      } as never,
      { owner: vi.fn().mockResolvedValue({ kind: "ready" }) } as never,
      true,
    );
    return withLoopback(application, async (listener) => ({
      history: (await request(listener).get("/review-minutes")).text,
      form: (await request(listener).get(`/evidence/${id}/review-allocation`))
        .text,
      receipt: (await request(listener).get(`/review-minutes/${id}`)).text,
    }));
  };
  const online = await read(true);
  for (const [name, text] of Object.entries(online))
    expect(visibleText(text), name).not.toMatch(LOCAL_ON_HOSTED);
  expect(online.form).toContain(
    "Private practice using existing test units. No payment, professional qualification or response time is promised.",
  );
  const local = await read(false);
  expect(local.history).toContain("Private local test-unit receipts");
  expect(local.form).toContain("Private local rehearsal using");
  expect(local.receipt).toContain("Local test units only.");
});
