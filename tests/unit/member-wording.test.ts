import { expect, it } from "vitest";
import { adapterReadiness } from "../../src/adapters.ts";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import type { OwnedEvidence } from "../../src/evidence.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import type { TrackSnapshot } from "../../src/track-readiness.ts";
import {
  assignmentAttemptPage,
  circlesPage,
  dashboard,
  eventDetailPage,
  eventDiscoveryPage,
  evidencePage,
  libraryPage,
  readinessPage,
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
