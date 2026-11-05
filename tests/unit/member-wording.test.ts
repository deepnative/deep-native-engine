import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { withLoopback } from "../support/loopback-server.ts";
import { adapterReadiness } from "../../src/adapters.ts";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import {
  disabledCircleDiscussionStore,
  type CircleDiscussionStore,
} from "../../src/circle-discussion.ts";
import {
  eventEnrollmentHistoryPage,
  eventEnrollmentPage,
  eventEnrollmentReceiptPage,
} from "../../src/event-enrollment-views.ts";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import type { OwnedEvidence } from "../../src/evidence.ts";
import type { ContentVersion } from "../../src/catalog.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import type { LocalAiChoice } from "../../src/local-ai-consent.ts";
import {
  memberTestUnitsPage,
  memberTestUnitsUnavailablePage,
} from "../../src/member-test-units-views.ts";
import type { MemberTestUnitSnapshot } from "../../src/member-test-units.ts";
import {
  myCoursesPage,
  programAccountPage,
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
  circlesPage,
  dashboard,
  eventDetailPage,
  eventDiscoveryPage,
  evidencePage,
  contentPreview,
  libraryPage,
  localAiConsentPage,
  readinessPage,
  withPrerequisiteTitles,
  trackReadinessPage,
  welcome,
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
        "No money or token estimate is involved.",
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
