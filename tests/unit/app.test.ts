import { beforeEach, afterEach, it, expect, vi } from "vitest";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { app } from "../../src/app.ts";
import {
  LessonActivityUnavailable,
  type Store,
  type ExerciseHistory,
} from "../../src/store.ts";
import { LESSON } from "../../src/content.ts";
import { disabledSupportRequestStore } from "../../src/support-requests.ts";
import {
  disabledAuthorizationStore,
  type AuthorizationStore,
} from "../../src/authorization.ts";
import {
  disabledEvidenceStore,
  MAX_EVIDENCE_BYTES,
  type EvidenceStore,
} from "../../src/evidence.ts";
import {
  disabledLocalAiConsentStore,
  type LocalAiConsentStore,
} from "../../src/local-ai-consent.ts";
import type { LocalAiControlStore } from "../../src/local-ai-control.ts";
import {
  disabledCatalogStore,
  type CatalogStore,
  type ContentVersion,
} from "../../src/catalog.ts";
import {
  disabledTrackStore,
  type TrackStore,
} from "../../src/track-readiness.ts";
import {
  disabledProposalStore,
  type ProposalStore,
  type OwnerProposal,
} from "../../src/proposals.ts";
import { CIRCLES, type CircleStore } from "../../src/circles.ts";
import { type MetricsStore } from "../../src/metrics.ts";
import { type PracticeStore } from "../../src/practice.ts";
import { type UsefulnessStore } from "../../src/usefulness.ts";
import { type WorkflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { type MemberExportStore } from "../../src/member-export.ts";
import { disabledAttemptStore } from "../../src/attempts.ts";
import {
  disabledAvailabilityStore,
  type AvailabilityStore,
} from "../../src/availability.ts";
import type { ManualObservationStore } from "../../src/manual-observations.ts";
import type { AssignmentReadinessStore } from "../../src/assignment-readiness.ts";
import { SlotHoldFailure, type MemberSlotHolds } from "../../src/slot-holds.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
it("serves goal-matched event previews only to active members and never accepts enrollment", async () => {
  const db = storage();
  const agent = await managedAgent(app(db, { origin, secret: "secret" }));
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const listing = await agent.get("/events").set("Host", host).expect(200);
  expect(listing.text).toContain("Synthetic preview; enrollment unavailable");
  expect(listing.text).toContain("/events/everyday-ai-preview/2");
  expect(listing.text).not.toContain("/events/technical-practice-preview/1");
  const all = await agent.get("/events?all=1").set("Host", host).expect(200);
  expect(all.text).toContain("/events/technical-practice-preview/1");
  const detail = await agent
    .get("/events/everyday-ai-preview/2")
    .set("Host", host)
    .expect(200);
  expect(detail.text).toContain("Access and cost: unresolved");
  await agent
    .get("/events/everyday-ai-preview/1")
    .set("Host", host)
    .expect(410);
  await agent.get("/events/unknown-preview/1").set("Host", host).expect(404);
  const unavailable = await agent
    .post("/events/everyday-ai-preview/2/enroll")
    .set("Host", host)
    .set("Origin", origin)
    .send({ csrf: "forged" })
    .expect(403);
  expect(unavailable.text).not.toContain("enrolled");
  expect(db.create).not.toHaveBeenCalled();
  expect(db.save).not.toHaveBeenCalled();
  db.session.mockResolvedValue({ kind: "expired" });
  await agent.get("/events").set("Host", host).expect(303);
});
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const member = {
  id: "owned",
  background: "explorer" as const,
  goal: "everyday" as const,
};
it("keeps personalized assignment preparation private, exact and read-only", async () => {
  const db = storage();
  const blocked = {
    contentId: "SYN-831",
    contentVersion: 1,
    title: "Invented sample",
    eligible: false,
    requirements: [],
  };
  const readiness = {
    list: vi
      .fn<AssignmentReadinessStore["list"]>()
      .mockResolvedValue([blocked]),
    get: vi.fn<AssignmentReadinessStore["get"]>().mockResolvedValue(blocked),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", assignmentReadiness: readiness }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent
    .get("/assignments/readiness/SYN-831?version=1")
    .set("Host", host)
    .expect(303);
  expect(readiness.get).not.toHaveBeenCalled();
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const path = await agent.get("/learn").set("Host", host).expect(200);
  expect(path.text).toContain("Prepare Invented sample");
  const detail = await agent
    .get("/assignments/readiness/SYN-831?version=1")
    .set("Host", host)
    .expect(200);
  expect(detail.text).toContain("not yet available to choose or start");
  expect(detail.text).not.toContain("Start or return to this private attempt");
  expect(db.openLesson).not.toHaveBeenCalled();
  expect(db.chooseAssignment).not.toHaveBeenCalled();
  await agent
    .get("/assignments/readiness/SYN-831?version=bad")
    .set("Host", host)
    .expect(404);
  expect(readiness.get).toHaveBeenCalledTimes(1);
  readiness.get.mockResolvedValueOnce(null);
  await agent
    .get("/assignments/readiness/SYN-831?version=2")
    .set("Host", host)
    .expect(404);
  readiness.list.mockResolvedValueOnce(null);
  const unavailable = await agent.get("/learn").set("Host", host).expect(503);
  expect(unavailable.text).not.toContain("Invented sample");
  readiness.list.mockResolvedValueOnce(null);
  const unsavedProfile = await agent
    .post("/profile")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf })
    .expect(503);
  expect(unsavedProfile.text).not.toContain("Invented sample");
  db.session.mockResolvedValue({ kind: "expired" });
  await agent
    .get("/assignments/readiness/SYN-831?version=1")
    .set("Host", host)
    .expect(303);
  expect(readiness.get).toHaveBeenCalledTimes(2);
});
it("rejects stale pinned lesson links before opening or changing activity", async () => {
  const db = storage();
  const catalog = catalogMock();
  const item: ContentVersion = {
    id: "SYN-830",
    version: 2,
    kind: "lesson",
    origin: "curated",
    title: "Current invented lesson",
    body: "Sample",
    owner: "Editor",
    sources: "Original",
    rights: "Owned",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
    state: "published",
    requiresQualifiedSignoff: false,
    reviewedAt: new Date(),
    publishedAt: new Date(),
  };
  catalog.published.mockResolvedValue(item);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  db.session.mockResolvedValue({ kind: "active", learner: member });
  await agent.get("/library/SYN-830?version=1").set("Host", host).expect(409);
  await agent
    .get("/library/SYN-830?version=wrong")
    .set("Host", host)
    .expect(409);
  expect(db.openLesson).not.toHaveBeenCalled();
  const current = await agent
    .get("/library/SYN-830?version=2")
    .set("Host", host)
    .expect(200);
  expect(current.text).toContain("Current invented lesson");
  expect(db.openLesson).toHaveBeenCalledTimes(1);
  const advanced = await agent
    .post("/library/SYN-830/progress")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, content_version: "2", intent: "start" })
    .expect(303);
  expect(advanced.headers.location).toBe("/library/SYN-830?version=2");
  catalog.published.mockResolvedValue({ ...item, version: 3 });
  await agent.get("/library/SYN-830?version=2").set("Host", host).expect(409);
  expect(db.openLesson).toHaveBeenCalledTimes(1);
});
const managedServers: Server[] = [];
it("keeps workflow feedback owner-only and never claims a failed or stale write", async () => {
  const feedback = {
    list: vi.fn<WorkflowFeedbackStore["list"]>().mockResolvedValue([]),
    save: vi.fn<WorkflowFeedbackStore["save"]>().mockResolvedValue(false),
    withdraw: vi
      .fn<WorkflowFeedbackStore["withdraw"]>()
      .mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", workflowFeedback: feedback }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/workflows/WF-001").set("Host", host).expect(200);
  await agent.get("/workflow-feedback/WF-001").set("Host", host).expect(303);
  expect(feedback.list).not.toHaveBeenCalled();
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const form = await agent
    .get("/workflow-feedback/WF-001")
    .set("Host", host)
    .expect(200);
  expect(form.text).toContain("Only you can read");
  const post = (
    path: string,
    fields: Record<string, string>,
    csrfValue = csrf,
  ) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: csrfValue, ...fields });
  const save = {
    workflow_version: "1",
    revision: "0",
    note: "Invented private workflow note",
    confirm: "yes",
  };
  await post("/workflow-feedback/WF-001/save", save, "forged").expect(403);
  await post("/workflow-feedback/WF-001/save", {
    ...save,
    note: " ",
  }).expect(422);
  await post("/workflow-feedback/WF-001/save", save).expect(409);
  feedback.save.mockResolvedValueOnce(true);
  await post("/workflow-feedback/WF-001/save", save).expect(303);
  feedback.save.mockResolvedValueOnce("uncertain");
  const unconfirmed = await post("/workflow-feedback/WF-001/save", save).expect(
    503,
  );
  expect(unconfirmed.text).toContain("Feedback save unconfirmed");
  expect(unconfirmed.text).toContain("check your current note");
  expect(unconfirmed.text).not.toContain("Nothing was saved");
  expect(feedback.save).toHaveBeenCalledWith(
    expect.any(String),
    "WF-001",
    1,
    save.note,
    0,
  );
  feedback.list.mockResolvedValueOnce([
    {
      workflowId: "WF-001",
      workflowVersion: 1,
      note: "<private & invented>",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const saved = await agent
    .get("/workflow-feedback/WF-001")
    .set("Host", host)
    .expect(200);
  expect(saved.text).toContain("&lt;private &amp; invented&gt;");
  expect(saved.text).not.toContain("<private & invented>");
  await post("/workflow-feedback/WF-001/withdraw", {
    workflow_version: "1",
    revision: "0",
    confirm: "yes",
  }).expect(422);
  await post("/workflow-feedback/WF-001/withdraw", {
    workflow_version: "1",
    revision: "1",
    confirm: "yes",
  }).expect(409);
  feedback.withdraw.mockResolvedValueOnce(true);
  await post("/workflow-feedback/WF-001/withdraw", {
    workflow_version: "1",
    revision: "1",
    confirm: "yes",
  }).expect(303);
  await agent.get("/workflow-feedback/WF-999").set("Host", host).expect(404);
  for (const id of ["WF-001", "WF-999"]) {
    feedback.list.mockResolvedValueOnce(null);
    const denied = await agent
      .get(`/workflow-feedback/${id}`)
      .set("Host", host)
      .expect(403);
    expect(denied.text).toContain("Feedback unavailable");
    expect(denied.text).not.toMatch(
      /private &amp; invented|textarea|workflow_version|revision/,
    );
  }
  feedback.list.mockRejectedValueOnce(new Error("private database detail"));
  const failed = await agent
    .get("/workflow-feedback/WF-001")
    .set("Host", host)
    .expect(503);
  expect(failed.text).not.toContain("private database detail");
});
it("keeps optional slot discovery private and reports read failures without implying a booking", async () => {
  const availability = {
    ...disabledAvailabilityStore(),
    list: vi.fn<AvailabilityStore["list"]>().mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        domain: "education",
        serviceType: "coaching",
        startsAt: new Date("2026-11-01T05:30:00.000Z"),
        endsAt: new Date("2026-11-01T06:30:00.000Z"),
      },
    ]),
  };
  const db = storage();
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", availability }),
  );
  await agent.get("/availability").set("Host", host).expect(303);
  expect(availability.list).not.toHaveBeenCalled();
  db.session.mockResolvedValue({
    kind: "active",
    learner: { ...member, timezone: "America/Toronto" },
  });
  const shown = await agent.get("/availability").set("Host", host).expect(200);
  expect(shown.text).toContain("1:30");
  expect(shown.text).toContain("GMT-04:00");
  expect(shown.text).toContain("sample window, not bookable");
  expect(shown.text).not.toContain('name="staff_id"');
  availability.list.mockRejectedValueOnce(new Error("private database detail"));
  const failed = await agent.get("/availability").set("Host", host).expect(503);
  expect(failed.text).toContain(
    "Availability or receipts could not be checked",
  );
  expect(failed.text).not.toContain("private database detail");
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const noZone = await agent.get("/availability").set("Host", host).expect(200);
  expect(noZone.text).toContain("Choose a valid time zone");
});
it("denies an unconfigured operator metrics route and returns only a configured aggregate", async () => {
  const denied = await managedAgent(
    app(storage(), { origin, secret: "secret" }),
  );
  await denied.get("/operator/metrics").set("Host", host).expect(403);
  const metrics = {
    snapshot: vi.fn<MetricsStore["snapshot"]>().mockResolvedValue({
      scope: "synthetic-local-preview",
      asOf: new Date("2026-09-24T00:00:00Z"),
      definitions: {
        denominator: "retained members",
        activated: "lesson open",
        selfAssessed: "self-report",
        participated: "ever joined",
        activeCircle: "currently joined",
        submittedAssignment: "observed submission",
        returnEligible: "matured first-open cohort",
        crossContentReturned: "bounded observed return",
        usefulness: "coarse self-reported usefulness",
      },
      counts: {
        members: 3,
        activated: 2,
        selfAssessed: 1,
        participated: 1,
        activeCircle: 0,
        submittedAssignment: 1,
        returnEligible: 2,
        crossContentReturned: 1,
      },
      usefulness: { disclosure: "suppressed", helpfulShareBand: null },
    }),
  };
  const allowed = await managedAgent(
    app(storage(), { origin, secret: "secret", metrics }),
  );
  const response = await allowed
    .get("/operator/metrics")
    .set("Host", host)
    .expect(200);
  expect(response.body.counts).toEqual({
    members: 3,
    activated: 2,
    selfAssessed: 1,
    participated: 1,
    activeCircle: 0,
    submittedAssignment: 1,
    returnEligible: 2,
    crossContentReturned: 1,
  });
  expect(response.body.scope).toBe("synthetic-local-preview");
  expect(response.body.usefulness).toEqual({
    disclosure: "suppressed",
    helpfulShareBand: null,
  });
  metrics.snapshot.mockRejectedValueOnce(
    new Error("private usefulness detail"),
  );
  const failed = await allowed
    .get("/operator/metrics?member_id=forged")
    .set("Host", host)
    .expect(503);
  expect(failed.text).not.toContain("private usefulness detail");
  expect(failed.text).not.toContain("helpfulShareBand");
});
it("keeps the synthetic manual register admin-only, idempotent and explicitly unverified", async () => {
  const denied = await managedAgent(
    app(storage(), { origin, secret: "secret" }),
  );
  await denied.get("/operator/test-receipts").set("Host", host).expect(403);
  const observations = {
    list: vi.fn<ManualObservationStore["list"]>().mockResolvedValue([]),
    record: vi
      .fn<ManualObservationStore["record"]>()
      .mockResolvedValue({ kind: "denied" }),
  };
  const agent = await managedAgent(
    app(storage(), {
      origin,
      secret: "secret",
      manualObservations: observations,
    }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const register = await agent
    .get("/operator/test-receipts")
    .set("Host", host)
    .expect(200);
  expect(register.text).toContain("not provider verification");
  const key = register.text.match(
    /name="idempotencyKey" value="([a-f0-9-]+)"/,
  )![1]!;
  const input = {
    memberId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: key,
    evidenceReference: "SYN-INVENTED-01",
    amountCents: "2500",
    confirm: "yes",
  };
  const post = (fields: Record<string, string>, token = csrf) =>
    agent
      .post("/operator/test-receipts")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: token, ...fields });
  await post(input, "forged").expect(403);
  await post({ ...input, evidenceReference: "REAL-BANK" }).expect(422);
  expect(observations.record).not.toHaveBeenCalled();
  await post(input).expect(403);
  observations.record.mockResolvedValueOnce({ kind: "invalid" });
  await post(input).expect(422);
  observations.record.mockResolvedValueOnce({ kind: "member_missing" });
  await post(input).expect(422);
  observations.record.mockResolvedValueOnce({ kind: "conflict" });
  await post(input).expect(409);
  const saved = {
    id: "22222222-2222-4222-8222-222222222222",
    memberId: input.memberId,
    actorId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: key,
    evidenceReference: input.evidenceReference,
    amountCents: 2500,
    status: "unverified_manual" as const,
    createdAt: new Date("2026-09-27T12:00:00Z"),
  };
  observations.record.mockResolvedValueOnce({
    kind: "created",
    observation: saved,
  });
  await post(input).expect(303);
  observations.record.mockResolvedValueOnce({
    kind: "replayed",
    observation: saved,
  });
  await post(input).expect(303);
  expect(observations.record).toHaveBeenLastCalledWith(expect.any(String), {
    memberId: input.memberId,
    idempotencyKey: key,
    evidenceReference: input.evidenceReference,
    amountCents: 2500,
  });
  observations.list.mockResolvedValueOnce([
    { ...saved, evidenceReference: "SYN-<script>" },
  ]);
  const shown = await agent
    .get("/operator/test-receipts")
    .set("Host", host)
    .expect(200);
  expect(shown.text).toContain("SYN-&lt;script&gt;");
  expect(shown.text).not.toContain("SYN-<script>");
  observations.list.mockResolvedValueOnce(null);
  await agent.get("/operator/test-receipts").set("Host", host).expect(403);
  observations.list.mockRejectedValueOnce(new Error("private SQL detail"));
  const failedRead = await agent
    .get("/operator/test-receipts")
    .set("Host", host)
    .expect(503);
  expect(failedRead.text).not.toContain("private SQL detail");
  observations.record.mockRejectedValueOnce(new Error("private SQL detail"));
  const failedWrite = await post(input).expect(503);
  expect(failedWrite.text).not.toContain("private SQL detail");
  const live = await managedAgent(
    app(storage(), {
      origin,
      secret: "secret",
      mode: "live",
      manualObservations: observations,
    }),
  );
  await live.get("/operator/test-receipts").set("Host", host).expect(404);
  const liveHome = await live.get("/").set("Host", host).expect(200);
  const liveCsrf = liveHome.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await live
    .post("/operator/test-receipts")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: liveCsrf, ...input })
    .expect(404);
});
async function managedAgent(application: ReturnType<typeof app>) {
  const server = await listenLoopback(application);
  managedServers.push(server);
  return request.agent(server);
}
it("keeps another loopback listener from answering managed HTTP requests", async () => {
  const agent = await managedAgent(
    app(storage(), { origin, secret: "secret" }),
  );
  const server = managedServers.at(-1);
  const address = server?.address();
  if (!address || typeof address === "string")
    throw new Error("Managed test listener has no TCP port");
  let foreignHits = 0;
  const foreign = createServer((_request, response) => {
    foreignHits += 1;
    response.writeHead(418).end("synthetic foreign listener");
  });
  const foreignBound = await new Promise<boolean>((resolve, reject) => {
    foreign.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    foreign.listen(address.port, "127.0.0.1", () => resolve(true));
  });
  try {
    await agent.get("/readiness").set("Host", host).expect(200);
    expect(foreignHits).toBe(0);
  } finally {
    if (foreignBound) await closeLoopback(foreign);
  }
});
afterEach(async () => {
  await Promise.all(managedServers.splice(0).map(closeLoopback));
});
async function atStage<T>(stage: string, request: PromiseLike<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw new Error(
      `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
it("keeps member proposals private and moderation unable to publish", async () => {
  const sample: OwnerProposal = {
    feedback: null,
    rightsAttestedRevision: null,
    rightsAttestedAt: null,
    id: "sample-id",
    revision: 1,
    title: "Original sample",
    body: "Invented details",
    sources: "Original",
    state: "draft",
    createdAt: new Date("2026-09-23"),
    submittedAt: null,
  };
  const proposals = {
    ...disabledProposalStore(),
    createDraft: vi.fn<ProposalStore["createDraft"]>().mockResolvedValue(null),
    owned: vi.fn<ProposalStore["owned"]>().mockResolvedValue([sample]),
    preview: vi.fn<ProposalStore["preview"]>().mockResolvedValue(null),
    editDraft: vi.fn<ProposalStore["editDraft"]>().mockResolvedValue("denied"),
    submit: vi.fn<ProposalStore["submit"]>().mockResolvedValue("denied"),
    withdraw: vi.fn<ProposalStore["withdraw"]>().mockResolvedValue(false),
    moderationQueue: vi
      .fn<ProposalStore["moderationQueue"]>()
      .mockResolvedValue(null),
    moderationPage: vi
      .fn<ProposalStore["moderationPage"]>()
      .mockResolvedValue(null),
    moderate: vi.fn<ProposalStore["moderate"]>().mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(storage(), { origin, secret: "secret", proposals }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/contribute").set("Host", host).expect(303);
  await agent.get("/moderate/proposals").set("Host", host).expect(403);
  proposals.moderationPage.mockResolvedValue({ items: [], nextCursor: null });
  await agent.get("/moderate/proposals").set("Host", host).expect(200);
  const post = (path: string, fields: Record<string, string>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post("/moderate/proposals/sample-id/approve", {}).expect(409);
  await post("/moderate/proposals/sample-id/quarantine", {}).expect(409);
  proposals.moderate.mockResolvedValue(true);
  await post("/moderate/proposals/sample-id/reject", {}).expect(303);

  const memberAgent = await managedAgent(
    app(db, { origin, secret: "secret", proposals }),
  );
  const entry = await memberAgent.get("/").set("Host", host).expect(200);
  const memberCsrf = entry.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const memberPost = (path: string, fields: Record<string, string>) =>
    memberAgent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: memberCsrf, ...fields });
  await memberAgent.get("/contribute").set("Host", host).expect(200);
  await memberPost("/contribute", {}).expect(422);
  proposals.createDraft.mockResolvedValue(sample.id);
  await memberPost("/contribute", {
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
    sample_confirmed: "yes",
  }).expect(303);
  await memberAgent
    .get(`/contribute/${sample.id}`)
    .set("Host", host)
    .expect(404);
  proposals.preview.mockResolvedValue(sample);
  await memberAgent
    .get(`/contribute/${sample.id}`)
    .set("Host", host)
    .expect(200);
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "",
    body: sample.body!,
    sources: sample.sources!,
  }).expect(422);
  expect(proposals.editDraft).not.toHaveBeenCalled();
  const duplicateEdit = await memberAgent
    .post(`/contribute/${sample.id}/edit`)
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send(
      `csrf=${memberCsrf}&revision=1&title=First&title=Second&body=Sample&sources=Original`,
    )
    .expect(422);
  expect(duplicateEdit.text).toContain("No correction was saved");
  expect(proposals.editDraft).not.toHaveBeenCalled();
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1.0",
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
  }).expect(422);
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "999999999999999999999",
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
  }).expect(422);
  const oversized = await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "<unsafe>" + "x".repeat(161),
    body: sample.body!,
    sources: sample.sources!,
  }).expect(422);
  expect(oversized.text).toContain("&lt;unsafe&gt;");
  expect(oversized.text).not.toContain("<unsafe>");
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
    workflow_id: "WF-001",
  }).expect(422);
  const noBody = await memberAgent
    .post(`/contribute/${sample.id}/edit`)
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", memberCsrf)
    .expect(422);
  expect(noBody.text).toContain("No correction was saved");
  await memberAgent
    .post(`/contribute/${sample.id}/edit`)
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", memberCsrf)
    .set("Content-Type", "text/plain")
    .send("malformed edit")
    .expect(422);
  const badCsrf = await memberAgent
    .post(`/contribute/${sample.id}/edit`)
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf: "wrong",
      revision: "1",
      title: "<attempted>",
      body: sample.body!,
      sources: sample.sources!,
    })
    .expect(403);
  expect(badCsrf.text).toContain("&lt;attempted&gt;");
  db.session.mockResolvedValueOnce({ kind: "expired" });
  const expiredEdit = await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "<unsaved>",
    body: sample.body!,
    sources: sample.sources!,
  }).expect(401);
  expect(expiredEdit.text).toContain("&lt;unsaved&gt;");
  proposals.editDraft.mockResolvedValueOnce("conflict");
  const conflict = await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "Revised sample",
    body: sample.body!,
    sources: sample.sources!,
  }).expect(409);
  expect(conflict.text).toContain("Open the current private preview");
  proposals.editDraft.mockResolvedValueOnce("invalid");
  const invalidEdit = await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
  }).expect(422);
  expect(invalidEdit.text).toContain("correction fields or revision");
  expect(invalidEdit.text).toContain("workflow version is no longer current");
  proposals.editDraft.mockResolvedValueOnce("denied");
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
  }).expect(404);
  proposals.editDraft.mockRejectedValueOnce(
    new Error("private database detail"),
  );
  const uncertainEdit = await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "Uncertain sample",
    body: sample.body!,
    sources: sample.sources!,
  }).expect(503);
  expect(uncertainEdit.text).toContain("Saving could not be confirmed");
  expect(uncertainEdit.text).toContain("Proposal correction outcome unknown");
  expect(uncertainEdit.text).toContain("OUTCOME UNCONFIRMED");
  expect(uncertainEdit.text).not.toContain("Proposal corrections not saved");
  expect(uncertainEdit.text).toContain("Uncertain sample");
  expect(uncertainEdit.text).not.toContain("private database detail");
  proposals.editDraft.mockResolvedValueOnce("saved");
  await memberPost(`/contribute/${sample.id}/edit`, {
    revision: "1",
    title: "Revised sample",
    body: sample.body!,
    sources: sample.sources!,
  }).expect(303);
  expect(proposals.editDraft).toHaveBeenLastCalledWith(
    expect.any(String),
    sample.id,
    { title: "Revised sample", body: sample.body, sources: sample.sources },
    1,
  );
  await memberPost(`/contribute/${sample.id}/submit`, {}).expect(409);
  await memberAgent
    .post(`/contribute/${sample.id}/submit`)
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", memberCsrf)
    .set("Content-Type", "text/plain")
    .send("malformed submission")
    .expect(409);
  await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1.0",
    rights_confirmed: "yes",
  }).expect(409);
  await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1",
    rights_confirmed: "bogus",
  }).expect(409);
  await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1",
    rights_confirmed: "yes",
    workflow_id: "WF-001",
  }).expect(409);
  proposals.submit.mockResolvedValueOnce("conflict");
  const staleSubmit = await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1",
    rights_confirmed: "yes",
  }).expect(409);
  expect(staleSubmit.text).toContain("Nothing was submitted");
  await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1",
  }).expect(409);
  proposals.submit.mockResolvedValue("submitted");
  await memberPost(`/contribute/${sample.id}/submit`, {
    revision: "1",
    rights_confirmed: "yes",
  }).expect(303);
  expect(proposals.submit).toHaveBeenLastCalledWith(
    expect.any(String),
    sample.id,
    true,
    1,
  );
  await memberPost(`/contribute/${sample.id}/withdraw`, {}).expect(409);
  await memberPost(`/contribute/${sample.id}/withdraw`, {
    confirm: "yes",
  }).expect(409);
  proposals.withdraw.mockResolvedValue(true);
  await memberPost(`/contribute/${sample.id}/withdraw`, {
    confirm: "yes",
  }).expect(303);
  const workflowForm = await memberAgent
    .get("/contribute?workflow=WF-001")
    .set("Host", host)
    .expect(200);
  expect(workflowForm.text).toContain(
    "Private improvement for WF-001 version 1",
  );
  await memberAgent
    .get("/contribute?workflow=WF-999")
    .set("Host", host)
    .expect(404);
  await memberPost("/contribute", {
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
    sample_confirmed: "yes",
    workflow_id: "WF-001",
    workflow_version: "1",
  }).expect(303);
  expect(proposals.createDraft).toHaveBeenLastCalledWith(
    expect.any(String),
    { title: sample.title, body: sample.body, sources: sample.sources },
    true,
    { id: "WF-001", version: 1 },
  );
  proposals.createDraft.mockResolvedValueOnce(null);
  await memberPost("/contribute", {
    title: sample.title!,
    body: sample.body!,
    sources: sample.sources!,
    sample_confirmed: "yes",
    workflow_id: "WF-001",
    workflow_version: "1.0",
  }).expect(422);
  expect(proposals.createDraft).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Object),
    true,
    { id: "WF-001", version: Number.NaN },
  );
  proposals.preview.mockResolvedValue({
    ...sample,
    workflowId: "WF-001",
    workflowVersion: 1,
  });
  await memberAgent
    .get(`/contribute/${sample.id}`)
    .set("Host", host)
    .expect(200)
    .then((response) =>
      expect(response.text).toContain("Workflow reference: WF-001 version 1"),
    );
  proposals.preview.mockResolvedValue({
    ...sample,
    workflowId: "WF-999",
    workflowVersion: 1,
  });
  await memberAgent
    .get(`/contribute/${sample.id}`)
    .set("Host", host)
    .expect(200)
    .then((response) => expect(response.text).toContain("no longer current"));
});
it("shows honest track states and restricts the expert evidence roster", async () => {
  const tracks = disabledTrackStore();
  // Own the listener for the whole case and use its explicitly bound address.
  // These public/denied/allowed requests must never depend on automatic listener reuse.
  const readinessClient = async (application: ReturnType<typeof app>) => {
    const listener = await listenLoopback(application);
    managedServers.push(listener);
    expect(listener.address()).toMatchObject({
      address: "127.0.0.1",
      family: "IPv4",
    });
    return request.agent(listener);
  };
  const publicAgent = await readinessClient(
    app(storage(), { origin, secret: "secret", tracks }),
  );
  const publicView = await atStage(
    "GET /readiness/tracks public",
    publicAgent
      .get("/readiness/tracks")
      .set("Host", host)
      .expect((response) => {
        if (response.status !== 200)
          throw new Error(
            `Public readiness response: ${JSON.stringify({ status: response.status, method: response.request.method, target: response.request.url, contentType: response.headers["content-type"] })}`,
          );
      })
      .expect(200),
  );
  expect(publicView.text).toContain("in preparation");
  expect(publicView.text).toContain("General learners");
  await atStage(
    "GET /operator/experts denied",
    publicAgent.get("/operator/experts").set("Host", host).expect(403),
  );
  const allowed = await readinessClient(
    app(storage(), {
      origin,
      secret: "secret",
      tracks: { ...tracks, registry: async () => [] },
    }),
  );
  const roster = await atStage(
    "GET /operator/experts allowed",
    allowed.get("/operator/experts").set("Host", host).expect(200),
  );
  expect(roster.text).toContain("No expert commitments are recorded");
});
it("shows the approved no-purchase preview while keeping production terms undecided", async () => {
  const agent = await managedAgent(
    app(storage(), { origin, secret: "secret" }),
  );
  const catalog = await agent
    .get("/api/offer-hypotheses")
    .set("Host", host)
    .expect(200);
  const planning = await agent
    .get("/readiness/offers")
    .set("Host", host)
    .expect(200);
  expect(catalog.body.foundation).toMatchObject({
    interimDecision: "approved-no-purchase-private-preview",
    live: "pending-owner-decision",
    liveActivationEnabled: false,
    priceCents: null,
    participationLimit: null,
    aiAllowance: null,
  });
  expect(catalog.body.coaching).toHaveLength(6);
  expect(
    catalog.body.coaching.every(
      (offer: { livePurchasable: boolean }) => offer.livePurchasable === false,
    ),
  ).toBe(true);
  expect(planning.text).toContain("NO LIVE PURCHASE");
  expect(planning.text).toContain(
    "approved a no-purchase private/local preview",
  );
  expect(planning.text).toContain("IT, other professions and general learners");
  expect(planning.text).toContain("production terms remain undecided");
  expect(planning.text).not.toContain("Buy now");
  for (const offer of catalog.body.coaching) {
    expect(planning.text).toContain(offer.termsVersion);
    expect(planning.text).toContain(
      (offer.priceCents / 100).toLocaleString("en-CA"),
    );
  }
  await agent.get("/checkout/pilot").set("Host", host).expect(404);
});
function storage() {
  const progress = vi.fn<Store["progress"]>().mockResolvedValue(undefined);
  return {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
    create: vi.fn<Store["create"]>().mockResolvedValue(undefined),
    updateProfile: vi.fn<Store["updateProfile"]>().mockResolvedValue(true),
    progress,
    withExerciseRead: async <T>(
      _token: string,
      render: (rows: ExerciseHistory[]) => T,
    ): Promise<T | null> => {
      const saved = await progress(member.id);
      return render(
        saved
          ? [
              {
                lessonId: LESSON.id,
                version: LESSON.version,
                instruction: saved.instruction,
                verification: saved.verification,
                completedAt: saved.completed_at,
                withdrawnAt: saved.withdrawn_at ?? null,
                goalAtStart:
                  saved.goal_at_start === undefined
                    ? "everyday"
                    : saved.goal_at_start,
              },
            ]
          : [],
      );
    },
    withdrawExercise: vi
      .fn<Store["withdrawExercise"]>()
      .mockResolvedValue("unavailable"),
    lessonActivities: vi.fn<Store["lessonActivities"]>().mockResolvedValue([]),
    openLesson: vi.fn<Store["openLesson"]>().mockResolvedValue(true),
    advanceLesson: vi.fn<Store["advanceLesson"]>().mockResolvedValue(true),
    assignmentChoice: vi
      .fn<Store["assignmentChoice"]>()
      .mockResolvedValue(null),
    chooseAssignment: vi
      .fn<Store["chooseAssignment"]>()
      .mockResolvedValue(false),
    milestones: vi.fn<Store["milestones"]>().mockResolvedValue([]),
    createMilestone: vi.fn<Store["createMilestone"]>().mockResolvedValue(null),
    updateMilestone: vi.fn<Store["updateMilestone"]>().mockResolvedValue(false),
    deleteMilestone: vi.fn<Store["deleteMilestone"]>().mockResolvedValue(false),
    save: vi.fn<Store["save"]>().mockResolvedValue("saved"),
    remove: vi.fn<Store["remove"]>().mockResolvedValue(undefined),
  };
}
function evidenceStorage() {
  return {
    ...disabledEvidenceStore(),
    owned: vi.fn<EvidenceStore["owned"]>().mockResolvedValue([]),
    exportOwned: vi
      .fn<EvidenceStore["exportOwned"]>()
      .mockResolvedValue({ kind: "denied" }),
    upload: vi.fn<EvidenceStore["upload"]>().mockResolvedValue({
      kind: "denied",
    }),
    submitForReview: vi
      .fn<EvidenceStore["submitForReview"]>()
      .mockResolvedValue(false),
    revokePrivateReview: vi
      .fn<EvidenceStore["revokePrivateReview"]>()
      .mockResolvedValue(false),
    issueDownload: vi.fn<EvidenceStore["issueDownload"]>().mockResolvedValue({
      kind: "denied",
    }),
    download: vi.fn<EvidenceStore["download"]>().mockResolvedValue({
      kind: "denied",
    }),
    remove: vi.fn<EvidenceStore["remove"]>().mockResolvedValue(false),
    removeWorkspace: vi
      .fn<EvidenceStore["removeWorkspace"]>()
      .mockResolvedValue(undefined),
  };
}
it("requires explicit member confirmation and current local AI permission at every UI step", async () => {
  const localAiConsent = {
    ...disabledLocalAiConsentStore(),
    list: vi.fn<LocalAiConsentStore["list"]>().mockResolvedValue([
      {
        evidenceId: "evidence-id",
        name: "Invented & safe.txt",
        revisionNumber: 1,
        receiptId: null,
        grantedAt: null,
        withdrawnAt: null,
        jobs: [],
      },
    ]),
    grant: vi
      .fn<LocalAiConsentStore["grant"]>()
      .mockResolvedValue({ kind: "denied" }),
    withdraw: vi.fn<LocalAiConsentStore["withdraw"]>().mockResolvedValue(false),
    enqueue: vi
      .fn<LocalAiConsentStore["enqueue"]>()
      .mockResolvedValue({ kind: "denied" }),
    enqueueMetered: vi
      .fn<LocalAiConsentStore["enqueueMetered"]>()
      .mockResolvedValue({ kind: "denied" }),
    run: vi
      .fn<LocalAiConsentStore["run"]>()
      .mockResolvedValue({ kind: "denied" }),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", localAiConsent }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/evidence/local-ai").set("Host", host).expect(303);
  active();
  const local = await agent
    .get("/evidence/local-ai")
    .set("Host", host)
    .expect(200);
  expect(local.text).toContain("Invented &amp; safe.txt");
  expect(local.text).toContain("no network request");
  const post = (path: string, fields: Record<string, string> = {}) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post("/evidence/local-ai/evidence-id/grant").expect(422);
  expect(localAiConsent.grant).not.toHaveBeenCalled();
  await post("/evidence/local-ai/evidence-id/grant", { confirm: "yes" }).expect(
    403,
  );
  localAiConsent.grant.mockResolvedValueOnce({
    kind: "granted",
    receiptId: "receipt-id",
  });
  await post("/evidence/local-ai/evidence-id/grant", { confirm: "yes" }).expect(
    303,
  );
  await post("/evidence/local-ai/receipt-id/withdraw").expect(422);
  await post("/evidence/local-ai/receipt-id/withdraw", {
    confirm: "yes",
  }).expect(403);
  localAiConsent.withdraw.mockResolvedValueOnce(true);
  await post("/evidence/local-ai/receipt-id/withdraw", {
    confirm: "yes",
  }).expect(303);
  await post("/evidence/local-ai/receipt-id/queue").expect(403);
  localAiConsent.enqueue.mockResolvedValueOnce({ kind: "conflict" });
  await post("/evidence/local-ai/receipt-id/queue").expect(409);
  localAiConsent.enqueue.mockResolvedValueOnce({
    kind: "queued",
    jobId: "job-id",
  });
  await post("/evidence/local-ai/receipt-id/queue").expect(303);
  expect(localAiConsent.enqueue).toHaveBeenLastCalledWith(
    expect.any(String),
    "receipt-id",
    "receipt-id",
  );
  await post("/evidence/local-ai/receipt-id/queue-metered").expect(422);
  await post("/evidence/local-ai/receipt-id/queue-metered", {
    confirm: "yes",
  }).expect(422);
  expect(localAiConsent.enqueueMetered).not.toHaveBeenCalled();
  await post("/evidence/local-ai/receipt-id/queue-metered", {
    confirm: "yes",
    key: "private-key",
  }).expect(403);
  localAiConsent.enqueueMetered.mockResolvedValueOnce({ kind: "conflict" });
  await post("/evidence/local-ai/receipt-id/queue-metered", {
    confirm: "yes",
    key: "private-key",
  }).expect(409);
  localAiConsent.enqueueMetered.mockResolvedValueOnce({
    kind: "queued",
    jobId: "job-id",
  });
  await post("/evidence/local-ai/receipt-id/queue-metered", {
    confirm: "yes",
    key: "private-key",
  }).expect(303);
  expect(localAiConsent.enqueueMetered).toHaveBeenLastCalledWith(
    expect.any(String),
    "receipt-id",
    "private-key",
  );
  await post("/evidence/local-ai/job-id/run").expect(403);
  localAiConsent.run.mockResolvedValueOnce({ kind: "unavailable" });
  await post("/evidence/local-ai/job-id/run").expect(409);
  localAiConsent.run.mockResolvedValueOnce({
    kind: "completed",
    jobId: "job-id",
    status: "succeeded",
  });
  await post("/evidence/local-ai/job-id/run").expect(303);
});
it("keeps local AI pause control admin-only and shows member unavailability", async () => {
  const missingControl = await managedAgent(
    app(storage(), { origin, secret: "secret" }),
  );
  const missingHome = await missingControl
    .get("/")
    .set("Host", host)
    .expect(200);
  const missingCsrf = missingHome.text.match(
    /name="csrf" value="([a-f0-9]+)"/,
  )![1]!;
  await missingControl.get("/operator/local-ai").set("Host", host).expect(403);
  await missingControl
    .post("/operator/local-ai")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: missingCsrf, state: "paused", confirm: "yes" })
    .expect(403);
  const localAiControl = {
    current: vi
      .fn<LocalAiControlStore["current"]>()
      .mockResolvedValue("paused"),
    read: vi.fn<LocalAiControlStore["read"]>().mockResolvedValue(null),
    set: vi.fn<LocalAiControlStore["set"]>().mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", localAiControl }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/operator/local-ai").set("Host", host).expect(403);
  localAiControl.read.mockResolvedValueOnce({ paused: false });
  const control = await agent
    .get("/operator/local-ai")
    .set("Host", host)
    .expect(200);
  expect(control.text).toContain("Local simulation is available");
  const post = (state: string, confirm = "yes") =>
    agent
      .post("/operator/local-ai")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, state, confirm });
  await post("invalid").expect(422);
  await post("paused", "no").expect(422);
  expect(localAiControl.set).not.toHaveBeenCalled();
  await post("paused").expect(403);
  localAiControl.set.mockResolvedValueOnce(true);
  await post("paused").expect(303);
  expect(localAiControl.set).toHaveBeenLastCalledWith(expect.any(String), true);
  localAiControl.set.mockResolvedValueOnce(true);
  await post("enabled").expect(303);
  expect(localAiControl.set).toHaveBeenLastCalledWith(
    expect.any(String),
    false,
  );

  active();
  const memberPage = await agent
    .get("/evidence/local-ai")
    .set("Host", host)
    .expect(200);
  expect(memberPage.text).toContain("Local simulations are paused");
  const pausedQueue = await agent
    .post("/evidence/local-ai/receipt-id/queue")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf })
    .expect(403);
  expect(pausedQueue.text).toContain("No new local job was queued");
  const pausedRun = await agent
    .post("/evidence/local-ai/job-id/run")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf })
    .expect(403);
  expect(pausedRun.text).toContain("will not retry automatically");

  const live = await managedAgent(
    app(storage(), { origin, secret: "secret", mode: "live", localAiControl }),
  );
  const liveHome = await live.get("/").set("Host", host).expect(200);
  const liveCsrf = liveHome.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await live.get("/operator/local-ai").set("Host", host).expect(404);
  await live
    .post("/operator/local-ai")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: liveCsrf, state: "paused", confirm: "yes" })
    .expect(404);
});
let db: ReturnType<typeof storage>;
beforeEach(() => {
  db = storage();
});
it("renders only local circle state and handles join, full, denied, and leave outcomes", async () => {
  const circles = {
    list: vi.fn<CircleStore["list"]>().mockResolvedValue([
      { ...CIRCLES[0]!, joined: true, seatsRemaining: 3 },
      { ...CIRCLES[1]!, joined: false, seatsRemaining: 4 },
      { ...CIRCLES[2]!, joined: false, seatsRemaining: 0 },
    ]),
    join: vi.fn<CircleStore["join"]>().mockResolvedValue("joined"),
    leave: vi.fn<CircleStore["leave"]>().mockResolvedValue(true),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", circles }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/circles").set("Host", host).expect(303);
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const page = await agent.get("/circles").set("Host", host).expect(200);
  expect(page.text).toContain("NO LIVE COMMUNITY");
  expect(page.text).toContain("Matches your current goal");
  expect(page.text).toContain("You joined this local circle");
  expect(page.text).toContain("This local circle is full");
  expect(page.text).not.toContain("member-id");
  const post = (path: string, valid = true) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", valid ? origin : "https://wrong.example")
      .type("form")
      .send({ csrf });
  await post("/circles/professional-work/join", false).expect(403);
  expect(circles.join).not.toHaveBeenCalled();
  await post("/circles/professional-work/join").expect(303);
  circles.join.mockResolvedValueOnce("full");
  await post("/circles/professional-work/join").expect(409);
  circles.join.mockResolvedValueOnce("denied");
  await post("/circles/unknown/join").expect(404);
  await post("/circles/everyday-ai/leave").expect(303);
  circles.leave.mockResolvedValueOnce(false);
  await post("/circles/everyday-ai/leave").expect(409);
  circles.list.mockResolvedValueOnce(null);
  await agent.get("/circles").set("Host", host).expect(403);
});
function catalogMock() {
  return {
    ...disabledCatalogStore(),
    createDraft: vi.fn<CatalogStore["createDraft"]>().mockResolvedValue(false),
    submit: vi.fn<CatalogStore["submit"]>().mockResolvedValue(false),
    approve: vi.fn<CatalogStore["approve"]>().mockResolvedValue(false),
    publish: vi.fn<CatalogStore["publish"]>().mockResolvedValue(false),
    retire: vi.fn<CatalogStore["retire"]>().mockResolvedValue(false),
    preview: vi.fn<CatalogStore["preview"]>().mockResolvedValue(null),
    staffList: vi.fn<CatalogStore["staffList"]>().mockResolvedValue(null),
    published: vi.fn<CatalogStore["published"]>().mockResolvedValue(null),
    search: vi.fn<CatalogStore["search"]>().mockResolvedValue([]),
  };
}
async function client(evidence?: EvidenceStore) {
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", evidence }),
  );
  const response = await agent.get("/").set("Host", host).expect(200);
  const csrf = response.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  return { agent, csrf };
}
function active() {
  db.session.mockResolvedValue({ kind: "active", learner: member });
}
it("denies a member tailored-review request without accepting a service", async () => {
  const tracks = {
    ...disabledTrackStore(),
    snapshot: vi.fn<TrackStore["snapshot"]>(disabledTrackStore().snapshot),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", tracks }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/tailored-review").set("Host", host).expect(303);
  await agent
    .post("/tailored-review")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, domain: "education" })
    .expect(303);
  active();
  const form = await agent
    .get("/tailored-review")
    .set("Host", host)
    .expect(200);
  expect(form.text).toContain("Check tailored-review availability");
  expect(form.text).toContain("NO BOOKINGS");
  const post = (domain: unknown, formCsrf = csrf) =>
    agent
      .post("/tailored-review")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: formCsrf, domain });
  await post("education", "invalid").expect(403);
  await post("not-a-domain").expect(422);
  expect(tracks.snapshot).not.toHaveBeenCalled();
  const unavailable = await post("education").expect(409);
  expect(unavailable.text).toContain("No request was accepted or saved");
  expect(unavailable.text).toContain(
    "Qualified reviewer coverage not verified",
  );
  expect(unavailable.text).not.toContain("qualification_ref");
  tracks.snapshot.mockResolvedValueOnce({
    foundation: [],
    itSpecialties: [],
    specialties: [],
  });
  await post("education").expect(503);
  tracks.snapshot.mockResolvedValueOnce({
    foundation: [],
    itSpecialties: [],
    specialties: [
      {
        domain: "education",
        serviceType: "formal-review",
        state: "available",
        gaps: ["private roster reference"],
      },
    ],
  });
  const noOffer = await post("education").expect(409);
  expect(noOffer.text).toContain("Approved request terms are not available");
  expect(noOffer.text).not.toContain("private roster reference");
  tracks.snapshot.mockRejectedValueOnce(new Error("private roster reference"));
  const failedLookup = await post("education").expect(503);
  expect(failedLookup.text).not.toContain("private roster reference");
});
it("serves a member-owned activity view only through the active session", async () => {
  const history = vi.spyOn(db, "withExerciseRead");
  const attempts = {
    ...disabledAttemptStore(),
    list: vi.fn().mockResolvedValue([]),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  await agent.get("/progress").set("Host", host).expect(303);
  expect(history).not.toHaveBeenCalled();
  expect(db.lessonActivities).not.toHaveBeenCalled();
  expect(attempts.list).not.toHaveBeenCalled();
  active();
  db.lessonActivities.mockResolvedValue([
    {
      contentId: "SYN-982",
      contentVersion: 1,
      title: "Private invented reading",
      openedAt: new Date("2026-09-25T12:00:00Z"),
      startedAt: null,
      selfAssessedAt: null,
      available: true,
    },
  ]);
  const response = await agent
    .get("/progress?member_id=other")
    .set("Host", host)
    .expect(200);
  expect(response.text).toContain("Private invented reading");
  expect(response.text).toContain("Opened in reader");
  expect(history).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.any(Function),
  );
  expect(db.lessonActivities).toHaveBeenCalledWith(member.id);
  expect(attempts.list).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  attempts.list.mockResolvedValueOnce(null);
  const revokedRead = await agent
    .get("/progress")
    .set("Host", host)
    .expect(403);
  expect(revokedRead.text).toContain("Progress unavailable");
  expect(revokedRead.text).not.toContain("Private invented reading");
});
it("pins retained starter links to owned versions and reports unavailable or failed reads honestly", async () => {
  const retained: ExerciseHistory[] = [
    {
      lessonId: LESSON.id,
      version: 2,
      instruction: "Earlier invented instruction",
      verification: "Earlier invented check",
      completedAt: new Date("2026-09-25T12:00:00Z"),
      withdrawnAt: null,
      goalAtStart: "work",
    },
  ];
  db.withExerciseRead = async <T>(
    _token: string,
    render: (rows: ExerciseHistory[]) => T,
  ): Promise<T | null> => render(retained);
  const agent = await managedAgent(app(db, { origin, secret: "secret" }));
  active();
  const progress = await agent
    .get("/progress?member_id=other")
    .set("Host", host)
    .expect(200);
  expect(progress.text).toContain(
    "starter exercise · version 2 · Self-reported complete",
  );
  expect(progress.text).toContain(
    "/lesson?version=2&amp;goal=work#starter-version-2-work",
  );
  expect(progress.text).not.toContain("Earlier invented instruction");
  const exact = await agent
    .get("/lesson?version=2")
    .set("Host", host)
    .expect(200);
  expect(exact.text).toContain('id="starter-version-2-work"');
  expect(exact.text).toContain("Earlier invented instruction");
  for (const version of ["0", "no", "2147483648", "2&version=1", "3"]) {
    const missing = await agent
      .get(`/lesson?version=${version}`)
      .set("Host", host)
      .expect(404);
    expect(missing.text).toContain("Exercise version unavailable");
    expect(missing.text).not.toContain("Earlier invented instruction");
  }
  retained.push({
    lessonId: LESSON.id,
    version: 3,
    instruction: "Unfinished historical draft",
    verification: null,
    completedAt: null,
    withdrawnAt: null,
    goalAtStart: "work",
  });
  const draft = await agent
    .get("/lesson?version=3")
    .set("Host", host)
    .expect(200);
  expect(draft.text).toContain("Unfinished historical draft");
  expect(draft.text).not.toContain('action="/exercise"');
  db.withExerciseRead = async () => null;
  const denied = await agent.get("/progress").set("Host", host).expect(403);
  expect(denied.text).not.toContain("Earlier invented instruction");
  db.withExerciseRead = async () => {
    throw new Error("private storage detail");
  };
  const failed = await agent.get("/progress").set("Host", host).expect(503);
  expect(failed.text).not.toContain("private storage detail");
});
it("accepts a member's confirmed usefulness choice and fails closed on stale, forged and uncertain writes", async () => {
  const usefulness = {
    list: vi.fn<UsefulnessStore["list"]>().mockResolvedValue([]),
    save: vi.fn<UsefulnessStore["save"]>().mockResolvedValue(true),
    withdraw: vi.fn<UsefulnessStore["withdraw"]>().mockResolvedValue(true),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", usefulness }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (fields: Record<string, string>, validOrigin = true) =>
    agent
      .post("/library/SYN-971/usefulness")
      .set("Host", host)
      .set("Origin", validOrigin ? origin : "https://wrong.example")
      .type("form")
      .send({ csrf, content_version: "1", revision: "0", ...fields });
  await post({ intent: "save", choice: "helpful", confirm: "yes" }).expect(303);
  expect(usefulness.save).not.toHaveBeenCalled();
  active();
  await post(
    { intent: "save", choice: "helpful", confirm: "yes" },
    false,
  ).expect(403);
  expect(usefulness.save).not.toHaveBeenCalled();
  await post({ intent: "save", choice: "invalid", confirm: "yes" }).expect(422);
  await post({ intent: "save", choice: "helpful" }).expect(422);
  await post({ intent: "save", choice: "helpful", confirm: "yes" }).expect(303);
  expect(usefulness.save).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "SYN-971",
    1,
    "helpful",
    0,
  );
  usefulness.save.mockResolvedValueOnce(null);
  const denied = await post({
    intent: "save",
    choice: "helpful",
    confirm: "yes",
  }).expect(403);
  expect(denied.text).toContain("Usefulness response unavailable");
  expect(denied.text).not.toContain("SYN-971");
  usefulness.withdraw.mockResolvedValueOnce(null);
  await post({ intent: "withdraw", confirm: "yes", revision: "1" }).expect(403);
  usefulness.save.mockResolvedValueOnce(false);
  const stale = await post({
    intent: "save",
    choice: "not_yet",
    confirm: "yes",
    revision: "1",
  }).expect(409);
  expect(stale.text).toContain("Nothing was saved");
  usefulness.save.mockRejectedValueOnce(new Error("private database text"));
  const uncertain = await post({
    intent: "save",
    choice: "not_yet",
    confirm: "yes",
    revision: "1",
  }).expect(503);
  expect(uncertain.text).not.toContain("private database text");
  await post({ intent: "withdraw", confirm: "yes", revision: "1" }).expect(303);
  usefulness.withdraw.mockResolvedValueOnce(false);
  await post({ intent: "withdraw", confirm: "yes", revision: "1" }).expect(409);
  await post({ intent: "withdraw", confirm: "yes", revision: "0" }).expect(422);
});
it("serves owner evidence pages and denies malformed, expired or unavailable continuation safely", async () => {
  const files = evidenceStorage();
  const { agent } = await client(files);
  await agent.get("/api/evidence/export").set("Host", host).expect(403);
  for (const path of ["/api/evidence/export", "/evidence/export"]) {
    await agent.get(`${path}?cursor=a&cursor=b`).set("Host", host).expect(403);
    await agent.get(path).set("Host", host).expect(403);
    files.exportOwned.mockResolvedValueOnce({ kind: "unavailable" });
    const unavailable = await agent.get(path).set("Host", host).expect(503);
    expect(unavailable.text).not.toContain("private database");
  }
  const result = {
    kind: "ready" as const,
    version: "local-evidence-v2" as const,
    items: [],
    page: {
      number: 2,
      itemCount: 0,
      sourceBytes: 0,
      consistency: "live-pages" as const,
      complete: true,
      nextCursor: null,
      nextHref: null,
    },
  };
  files.exportOwned.mockResolvedValueOnce(result);
  const ready = await agent
    .get("/api/evidence/export?cursor=signed")
    .set("Host", host)
    .expect(200);
  expect(ready.body).toEqual(result);
  expect(files.exportOwned).toHaveBeenLastCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "signed",
  );
  expect(ready.headers["cache-control"]).toBe("no-store");
  expect(ready.headers["referrer-policy"]).toBe("no-referrer");
  expect(ready.headers["content-disposition"]).toContain(
    "deep-native-evidence-page-2.json",
  );
  files.exportOwned.mockResolvedValueOnce(result);
  const html = await agent
    .get("/evidence/export?cursor=signed%26quoted")
    .set("Host", host)
    .expect(200);
  expect(html.text).toContain(
    'data-url="/api/evidence/export?cursor=signed%26quoted"',
  );
  expect(html.text).toContain("not one frozen snapshot");
  expect(html.text).toContain("Download page 2");
  expect(html.text).toContain("data-export-next hidden");
  expect(html.text).not.toContain("sourceBase64");
  files.exportOwned.mockResolvedValueOnce({
    ...result,
    page: { ...result.page, number: 1 },
  });
  const initial = await agent
    .get("/evidence/export")
    .set("Host", host)
    .expect(200);
  expect(initial.text).toContain('data-url="/api/evidence/export"');
});
it("serves only a bounded owner structured export and explains safe failures", async () => {
  const memberExport = {
    exportOwned: vi
      .fn<MemberExportStore["exportOwned"]>()
      .mockResolvedValueOnce({ kind: "denied" })
      .mockResolvedValueOnce({ kind: "limit" })
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValueOnce({
        kind: "ready",
        payload: {
          kind: "ready",
          version: "local-member-records-v17",
          profile: { id: "owned" },
          records: { milestones: [] },
          page: {
            number: 1,
            recordCount: 0,
            consistency: "live-pages",
            complete: true,
            nextCursor: null,
          },
        },
      }),
  };
  const agent = await managedAgent(
    app(storage(), { origin, secret: "secret", memberExport }),
  );
  await agent
    .get("/api/member/export")
    .set("Host", host)
    .expect(403, { error: "forbidden" });
  const limited = await agent
    .get("/api/member/export")
    .set("Host", host)
    .expect(413);
  expect(limited.body.message).toContain("100 records and 256 KiB");
  await agent
    .get("/api/member/export")
    .set("Host", host)
    .expect(503, { error: "export_unavailable" });
  const ready = await agent
    .get("/api/member/export")
    .set("Host", host)
    .expect(200);
  expect(ready.body).toMatchObject({
    version: "local-member-records-v17",
    profile: { id: "owned" },
  });
  expect(ready.headers["cache-control"]).toBe("no-store");
  expect(ready.headers["content-disposition"]).toContain(
    "deep-native-member-records-page-1.json",
  );
});
it("serves the local welcome, stylesheet and safe security headers", async () => {
  const { agent } = await client();
  const res = await agent
    .get("/assets/style.css")
    .set("Host", host)
    .expect(200);
  expect(res.text).toContain("--ink");
  expect(res.headers["referrer-policy"]).toBe("same-origin");
  expect(res.headers["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  expect(res.headers["x-powered-by"]).toBeUndefined();
  expect(res.headers["cache-control"]).toBe("no-store");
});
it("reports deterministic integration readiness without claiming live effects", async () => {
  const agent = await managedAgent(app(db, { origin, secret: "s" }));
  const res = await agent.get("/readiness").set("Host", host).expect(200);
  expect(res.text).toContain("DEMO ENVIRONMENT");
  expect(res.text).toMatch(/<strong>ai<\/strong> · simulated/);
  expect(res.text).toMatch(/<strong>payment<\/strong> · simulated/);
  expect(res.text).toContain("no external side effect occurs");
  expect(res.text).not.toContain("configured");
});
it("serves concurrent requests through one test agent without transport failures", async () => {
  const server = await listenLoopback(app(db, { origin, secret: "secret" }));
  try {
    const agent = request.agent(server);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        agent.get("/readiness").set("Host", host).expect(200),
      ),
    );
    expect(responses).toHaveLength(8);
    for (const response of responses) {
      expect(response.text).toContain("DEMO ENVIRONMENT");
    }
  } finally {
    await closeLoopback(server);
  }
});
it("enforces private workspace and cohort decisions on direct API requests", async () => {
  const authorization: AuthorizationStore = {
    ...disabledAuthorizationStore(),
    readWorkspace: vi
      .fn()
      .mockResolvedValueOnce({ kind: "denied" })
      .mockResolvedValueOnce({
        kind: "allowed",
        via: "member",
        workspaceId: "owned",
        purpose: null,
        records: [],
      }),
    readCohort: vi
      .fn()
      .mockResolvedValueOnce({ kind: "denied" })
      .mockResolvedValueOnce({
        kind: "allowed",
        cohortId: "group",
        contentId: "guide",
        body: "Shared guide",
      }),
  };
  const server = await listenLoopback(
    app(db, { origin, secret: "secret", authorization }),
  );
  managedServers.push(server);
  const agent = request.agent(server);
  await atStage("open session", agent.get("/").set("Host", host).expect(200));
  await atStage(
    "deny foreign workspace",
    agent
      .get("/api/workspaces/other/private?purpose=ticket")
      .set("Host", host)
      .expect(403, { error: "forbidden" }),
  );
  await atStage(
    "read own workspace",
    agent
      .get("/api/workspaces/owned/private")
      .set("Host", host)
      .expect(200)
      .expect((response) => expect(response.body.via).toBe("member")),
  );
  expect(authorization.readWorkspace).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "other",
    "ticket",
  );
  await atStage(
    "deny foreign cohort content",
    agent
      .get("/api/cohorts/group/content/other")
      .set("Host", host)
      .expect(403, { error: "forbidden" }),
  );
  await atStage(
    "read shared cohort content",
    agent
      .get("/api/cohorts/group/content/guide")
      .set("Host", host)
      .expect(200)
      .expect((response) => expect(response.body.body).toBe("Shared guide")),
  );
});
it("preserves an unregistered session across tabs and rotates an expired session", async () => {
  const { agent, csrf } = await client();
  const next = await agent.get("/").set("Host", host);
  expect(next.text).toContain(csrf);
  db.session.mockResolvedValue({ kind: "expired" });
  const expired = await agent.get("/").set("Host", host);
  expect(expired.text).not.toContain(csrf);
  expect(String(expired.headers["set-cookie"])).toContain("HttpOnly");
  expect(String(expired.headers["set-cookie"])).toContain("SameSite=Strict");
});
it("shows only eligible published content to members and escapes draft previews", async () => {
  const catalog = catalogMock();
  const item = {
    id: "SYN-001",
    version: 1,
    kind: "lesson" as const,
    origin: "curated" as const,
    title: "Sample <lesson>",
    body: "<script>alert(1)</script>",
    owner: "Test editor",
    sources: "Original",
    rights: "Owned",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
    state: "published" as const,
    requiresQualifiedSignoff: false,
    reviewedAt: new Date("2026-09-23"),
    publishedAt: new Date("2026-09-23"),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  await agent.get("/").set("Host", host).expect(200);
  await agent.get("/library").set("Host", host).expect(303);
  active();
  catalog.search.mockResolvedValueOnce([item]);
  const listing = await agent
    .get("/library?q=sample&goal=everyday")
    .set("Host", host)
    .expect(200);
  expect(listing.text).toContain("Sample &lt;lesson&gt;");
  expect(catalog.search).toHaveBeenCalledWith({
    q: "sample",
    goal: "everyday",
    background: undefined,
    domain: undefined,
  });
  const filtered = await agent
    .get("/library?background=explorer&domain=education")
    .set("Host", host)
    .expect(200);
  expect(filtered.text).toContain('value="education" selected');
  const empty = await agent.get("/library").set("Host", host).expect(200);
  expect(empty.text).toContain("No published content matches");
  catalog.published.mockResolvedValueOnce(item);
  const opened = await agent
    .get("/library/SYN-001")
    .set("Host", host)
    .expect(200);
  expect(opened.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(opened.text).not.toContain("<script>");
  await agent.get("/library/MISSING").set("Host", host).expect(404);
  catalog.preview.mockResolvedValueOnce({
    ...item,
    state: "draft",
    reviewedAt: null,
    publishedAt: null,
    requiresQualifiedSignoff: true,
    rubric: "Synthetic rubric",
    rubricVersion: 1,
  });
  const preview = await agent
    .get("/editor/library/SYN-001/1")
    .set("Host", host)
    .expect(200);
  expect(preview.text).toContain(
    "Qualified curriculum and domain sign-off is pending",
  );
  expect(preview.text).toContain("Versioned rubric 1");
  await agent.get("/editor/library/SYN-001/2").set("Host", host).expect(403);
});
it("records only exact synthetic lesson openings and rejects invalid, stale or unconfirmed progress", async () => {
  const catalog = catalogMock();
  const item = {
    id: "SYN-105",
    version: 2,
    kind: "lesson" as const,
    origin: "curated" as const,
    title: "Invented lesson",
    body: "Sample text",
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
  catalog.published.mockResolvedValue(item);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const welcome = await agent.get("/").set("Host", host).expect(200);
  const csrf = welcome.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  active();
  const opened = {
    contentId: item.id,
    contentVersion: 2,
    openedAt: new Date(),
    startedAt: null,
    selfAssessedAt: null,
    available: true,
  };
  db.lessonActivities.mockResolvedValue([opened]);
  const reader = await agent
    .get("/library/SYN-105")
    .set("Host", host)
    .expect(200);
  expect(db.openLesson).toHaveBeenCalledWith(member.id, item.id, 2);
  expect(reader.text).toContain("Opened in reader");
  expect(reader.text).toContain("Start this lesson");
  db.openLesson.mockResolvedValueOnce(false);
  await agent.get("/library/SYN-105").set("Host", host).expect(409);
  db.openLesson.mockRejectedValueOnce(new Error("storage unavailable"));
  const failedOpen = await agent
    .get("/library/SYN-105")
    .set("Host", host)
    .expect(503);
  expect(failedOpen.text).toContain("could not confirm");
  const post = (fields: Record<string, string>) =>
    agent
      .post("/library/SYN-105/progress")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post({ content_version: "x", intent: "start" }).expect(422);
  await post({ content_version: "0", intent: "start" }).expect(422);
  await post({ content_version: "2", intent: "review" }).expect(422);
  await post({ content_version: "2", intent: "complete" }).expect(422);
  expect(db.advanceLesson).not.toHaveBeenCalled();
  await post({ content_version: "2", intent: "start" }).expect(303);
  expect(db.advanceLesson).toHaveBeenCalledWith(member.id, item.id, 2, "start");
  await post({
    content_version: "2",
    intent: "complete",
    confirm: "yes",
  }).expect(303);
  db.advanceLesson.mockResolvedValueOnce(false);
  const stale = await post({
    content_version: "1",
    intent: "complete",
    confirm: "yes",
  }).expect(409);
  expect(stale.text).toContain("version changed");
  db.advanceLesson.mockRejectedValueOnce(new Error("storage unavailable"));
  const failedSave = await post({
    content_version: "2",
    intent: "start",
  }).expect(503);
  expect(failedSave.text).toContain("could not confirm");
  catalog.published.mockResolvedValueOnce({ ...item, kind: "assignment" });
  await agent.get("/library/SYN-105").set("Host", host).expect(200);
  expect(db.openLesson).toHaveBeenCalledTimes(3);
});
it("saves only acknowledged current-version private sample practice and recovers from stale writes", async () => {
  const source = {
    id: "SYN-131",
    version: 2,
    title: "Invented lesson",
    body: "Compare <invented> details with the source.",
    goal: "everyday" as const,
    response: null as string | null,
    withdrawnAt: null as Date | null,
  };
  const practice = {
    current: vi.fn<PracticeStore["current"]>().mockResolvedValue(source),
    history: vi.fn<PracticeStore["history"]>().mockResolvedValue([]),
    save: vi.fn<PracticeStore["save"]>().mockResolvedValue("saved"),
    withdraw: vi
      .fn<PracticeStore["withdraw"]>()
      .mockResolvedValue("unavailable"),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", practice }),
  );
  await agent.get("/practice").set("Host", host).expect(303);
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  active();
  const page = await agent
    .get("/library/SYN-131/practice")
    .set("Host", host)
    .expect(200);
  expect(page.text).toContain("SIMULATED · UNREVIEWED · SAMPLE ONLY");
  expect(page.text).toContain("SYN-131 · version 2");
  expect(page.text).toContain("&lt;invented&gt;");
  expect(page.text).not.toContain("<invented>");
  const post = (fields: Record<string, string>) =>
    agent
      .post("/library/SYN-131/practice")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  const valid = {
    content_version: "2",
    response: "<script>invented</script> check source",
    synthetic: "yes",
  };
  await post({ ...valid, csrf: "invalid" }).expect(403);
  await post({ ...valid, content_version: "x" }).expect(409);
  await post({ ...valid, content_version: "1" }).expect(409);
  await post({ ...valid, response: " " }).expect(422);
  await post({ ...valid, response: "x".repeat(1001) }).expect(422);
  await post({ ...valid, response: `sample${" ".repeat(1000)}` }).expect(422);
  await post({ ...valid, synthetic: "" }).expect(422);
  expect(practice.save).not.toHaveBeenCalled();
  await post(valid).expect(303);
  expect(practice.save).toHaveBeenCalledWith(
    expect.any(String),
    "SYN-131",
    2,
    valid.response,
  );
  source.response = valid.response;
  const saved = await agent
    .get("/library/SYN-131/practice")
    .set("Host", host)
    .expect(200);
  expect(saved.text).toContain("&lt;script&gt;invented&lt;/script&gt;");
  expect(saved.text).toContain("insufficient evidence");
  expect(saved.text).not.toContain("<script>");
  practice.history.mockResolvedValue([
    {
      id: source.id,
      version: 2,
      title: source.title,
      response: valid.response,
      savedAt: new Date(),
      available: false,
      withdrawnAt: null,
    },
  ]);
  const history = await agent.get("/practice").set("Host", host).expect(200);
  expect(history.text).toContain("Source unavailable; saved private note only");
  expect(history.text).toContain("&lt;script&gt;invented&lt;/script&gt;");
  practice.save.mockResolvedValueOnce("replayed");
  await post(valid).expect(303);
  practice.save.mockResolvedValueOnce("conflict");
  await post(valid).expect(409);
  practice.save.mockResolvedValueOnce("unavailable");
  await post(valid).expect(409);
  practice.save.mockResolvedValueOnce("withdrawn");
  const withdrawnSave = await post(valid).expect(409);
  expect(withdrawnSave.text).toContain("cannot accept another note");
  source.response = null;
  source.withdrawnAt = new Date("2026-09-28T12:00:00Z");
  const withdrawnCurrent = await agent
    .get("/library/SYN-131/practice")
    .set("Host", host)
    .expect(200);
  expect(withdrawnCurrent.text).toContain("note was withdrawn");
  expect(withdrawnCurrent.text).not.toContain("Save private practice");
  expect(withdrawnCurrent.text).not.toContain(
    "Your saved sample and source comparison",
  );
  practice.current.mockResolvedValueOnce(null);
  await agent.get("/library/SYN-131/practice").set("Host", host).expect(404);
  practice.current.mockResolvedValueOnce(null);
  await post(valid).expect(409);
});
it("requires an owned, confirmed exact-version withdrawal from practice history", async () => {
  const practice = {
    current: vi.fn<PracticeStore["current"]>().mockResolvedValue(null),
    history: vi.fn<PracticeStore["history"]>().mockResolvedValue([]),
    save: vi.fn<PracticeStore["save"]>().mockResolvedValue("unavailable"),
    withdraw: vi.fn<PracticeStore["withdraw"]>().mockResolvedValue("withdrawn"),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", practice }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (
    fields: Record<string, string | string[]>,
    path = "/practice/SYN-131/2/withdraw",
  ) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post({ confirm: "yes" }).expect(303);
  expect(practice.withdraw).not.toHaveBeenCalled();
  active();
  db.session.mockResolvedValueOnce({ kind: "expired" });
  await post({ confirm: "yes" }).expect(303);
  db.session.mockResolvedValueOnce({ kind: "new" });
  await post({ confirm: "yes" }).expect(303);
  expect(practice.withdraw).not.toHaveBeenCalled();
  await post({ confirm: "yes" }, "/practice/SYN-131/0/withdraw").expect(404);
  await post(
    { confirm: "yes" },
    "/practice/SYN-131/2147483648/withdraw",
  ).expect(404);
  await post({ confirm: "yes" }, "/practice/not-a-source/2/withdraw").expect(
    404,
  );
  await post({ confirm: "" }).expect(422);
  await post({ confirm: ["yes", "yes"] }).expect(422);
  await post({ confirm: "yes", response: "forged" }).expect(422);
  await agent
    .post("/practice/SYN-131/2/withdraw")
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", csrf)
    .expect(422);
  await agent
    .post("/practice/SYN-131/2/withdraw")
    .set("Host", host)
    .type("form")
    .send({ csrf, confirm: "yes" })
    .expect(403);
  await post({ csrf: "forged", confirm: "yes" }).expect(403);
  await agent
    .post("/practice/SYN-131/2/withdraw")
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", csrf)
    .type("form")
    .send({ csrf: [csrf, csrf], confirm: "yes" })
    .expect(422);
  expect(practice.withdraw).not.toHaveBeenCalled();
  await post({ confirm: "yes" }).expect(303);
  expect(practice.withdraw).toHaveBeenCalledWith(
    expect.any(String),
    "SYN-131",
    2,
  );
  practice.withdraw.mockResolvedValueOnce("already-withdrawn");
  await post({ confirm: "yes" }).expect(303);
  practice.withdraw.mockResolvedValueOnce("unavailable");
  await post({ confirm: "yes" }).expect(404);
  practice.withdraw.mockRejectedValueOnce(new Error("secret database detail"));
  const unknown = await post({ confirm: "yes" }).expect(503);
  expect(unknown.text).toContain("Withdrawal outcome unknown");
  expect(unknown.text).toContain(
    "inspect this exact version before trying again",
  );
  expect(unknown.text).not.toContain("secret database detail");
});
it("offers ephemeral source-grounded study reflection only for the current published lesson", async () => {
  const catalog = catalogMock();
  const item: ContentVersion = {
    id: "SYN-106",
    version: 2,
    kind: "lesson",
    origin: "curated",
    title: "Invented learning sample",
    body: "Use invented facts. Check each suggestion against the original.",
    owner: "Test editor",
    sources: "Original invented text",
    rights: "Owned sample",
    goals: ["everyday", "work", "build"],
    backgrounds: ["explorer", "professional", "technical"],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
    state: "published",
    requiresQualifiedSignoff: false,
    reviewedAt: new Date(),
    publishedAt: new Date(),
  };
  catalog.published.mockResolvedValue(item);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  await agent.get("/library/SYN-106/study").set("Host", host).expect(303);
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  active();
  const reader = await agent
    .get("/library/SYN-106")
    .set("Host", host)
    .expect(200);
  expect(reader.text).toContain('href="/library/SYN-106/study"');
  for (const goal of ["everyday", "work", "build"] as const) {
    db.session.mockResolvedValue({
      kind: "active",
      learner: { ...member, goal },
    });
    const study = await agent
      .get("/library/SYN-106/study")
      .set("Host", host)
      .expect(200);
    expect(study.text).toContain("SYN-106 · version 2");
    expect(study.text).toMatch(/locally simulated/i);
    expect(study.text).toContain("Use invented facts");
  }
  const post = (fields: Record<string, string>) =>
    agent
      .post("/library/SYN-106/study")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post({
    content_version: "1",
    reflection: "My note",
    synthetic: "yes",
  }).expect(409);
  await post({
    content_version: "x",
    reflection: "My note",
    synthetic: "yes",
  }).expect(422);
  await post({
    content_version: "2",
    reflection: " ",
    synthetic: "yes",
  }).expect(422);
  await post({
    content_version: "2",
    reflection: "x".repeat(1001),
    synthetic: "yes",
  }).expect(422);
  await post({ content_version: "2", reflection: "My note" }).expect(422);
  const response = await post({
    content_version: "2",
    reflection: "<script>alert(1)</script> I would check the facts.",
    synthetic: "yes",
  }).expect(200);
  expect(response.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(response.text).not.toContain("<script>");
  expect(response.text).toContain("Use invented facts");
  expect(response.text).toContain("not a competence assessment");
  catalog.published.mockResolvedValueOnce(null);
  await post({
    content_version: "2",
    reflection: "My note",
    synthetic: "yes",
  }).expect(409);
  catalog.published.mockResolvedValueOnce({ ...item, kind: "assignment" });
  await agent.get("/library/SYN-106/study").set("Host", host).expect(404);
  catalog.published.mockResolvedValueOnce({
    ...item,
    requiresQualifiedSignoff: true,
  });
  await agent.get("/library/SYN-106/study").set("Host", host).expect(404);
  catalog.published.mockResolvedValueOnce({
    ...item,
    requiresQualifiedSignoff: true,
  });
  await post({
    content_version: "2",
    reflection: "Sample note",
    synthetic: "yes",
  }).expect(409);
});
it("supports the local editor/reviewer workflow without bypassing rejected transitions", async () => {
  const catalog = catalogMock();
  catalog.staffList.mockResolvedValue([]);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  catalog.staffList.mockResolvedValueOnce([
    {
      id: "SYN-001",
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: "Synthetic",
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
      state: "draft",
      requiresQualifiedSignoff: false,
      reviewedAt: null,
      publishedAt: null,
    },
  ]);
  const editorPage = await agent
    .get("/editor/library")
    .set("Host", host)
    .expect(200);
  expect(editorPage.text).toContain('name="rubric"');
  expect(editorPage.text).toContain('name="rubric_version"');
  expect(editorPage.text).toContain(
    "not qualified instruction or formal human assessment",
  );
  const post = (path: string, body: Record<string, string> = {}) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...body });
  const fields = {
    id: "SYN-001",
    version: "1",
    kind: "lesson",
    title: "Sample",
    body: "Synthetic",
    owner: "Editor",
    sources: "Original",
    rights: "Owned",
  };
  await post("/editor/library").expect(422);
  await post("/editor/library", fields).expect(422);
  await post("/editor/library", {
    ...fields,
    structured_prerequisites: "{broken",
  }).expect(422);
  await post("/editor/library", {
    ...fields,
    structured_prerequisites: '{"schemaVersion":2,"all":[]}',
  }).expect(422);
  expect(catalog.createDraft).toHaveBeenCalledTimes(2);
  catalog.createDraft.mockResolvedValueOnce(true);
  await post("/editor/library", {
    ...fields,
    structured_prerequisites: '{"schemaVersion":1,"all":[]}',
  }).expect(303);
  expect(catalog.createDraft).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      id: "SYN-001",
      version: 1,
      origin: "curated",
      structuredPrerequisites: { schemaVersion: 1, all: [] },
    }),
  );
  catalog.createDraft.mockResolvedValueOnce(true);
  await post("/editor/library", {
    ...fields,
    kind: "assignment",
    rubric: "Check source and uncertainty.",
    rubric_version: "2",
  }).expect(303);
  expect(catalog.createDraft).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      kind: "assignment",
      rubric: "Check source and uncertainty.",
      rubricVersion: 2,
    }),
  );
  for (const action of ["submit", "approve", "publish", "unknown"]) {
    await post(`/editor/library/SYN-001/1/${action}`).expect(409);
  }
  catalog.submit.mockResolvedValueOnce(true);
  catalog.approve.mockResolvedValueOnce(true);
  catalog.publish.mockResolvedValueOnce(true);
  for (const action of ["submit", "approve", "publish"]) {
    await post(
      `/editor/library/SYN-001/1/${action}`,
      action === "approve" ? { rights_confirmed: "yes" } : {},
    ).expect(303);
  }
  expect(catalog.approve).toHaveBeenLastCalledWith(
    expect.any(String),
    "SYN-001",
    1,
    true,
  );
  await post("/editor/library/SYN-001/retire").expect(409);
  catalog.retire.mockResolvedValueOnce(true);
  await post("/editor/library/SYN-001/retire").expect(303);
});
it("accepts controlled synthetic audience tags and preserves the form on rejection", async () => {
  const catalog = catalogMock();
  catalog.staffList.mockResolvedValue([]);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const fields = {
    id: "SYN-211",
    version: "1",
    kind: "assignment",
    title: "Invented <review> activity",
    body: "An invented exercise",
    owner: "Editor",
    sources: "Original sample",
    rights: "Owned sample",
    goals: ["everyday", "work"],
    backgrounds: ["explorer", "professional"],
    domains: ["education", "operations"],
  };
  const post = (input: Record<string, unknown>, token = csrf) =>
    agent
      .post("/editor/library")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: token, ...input });
  catalog.createDraft.mockResolvedValue(true);
  await post(fields, "forged").expect(403);
  expect(catalog.createDraft).not.toHaveBeenCalled();
  await post(fields).expect(303);
  expect(catalog.createDraft).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      goals: ["everyday", "work"],
      backgrounds: ["explorer", "professional"],
      domains: ["education", "operations"],
    }),
  );
  catalog.createDraft.mockClear();
  catalog.staffList.mockResolvedValueOnce(null);
  await post({ ...fields, goals: ["unknown"] }).expect(422);
  expect(catalog.createDraft).not.toHaveBeenCalled();
  for (const input of [
    { ...fields, goals: ["work", "work"] },
    { ...fields, goals: ["unknown"] },
    {
      ...fields,
      backgrounds: ["explorer", "professional", "technical", "explorer"],
    },
    { ...fields, domains: ["education", ""] },
    { ...fields, "domains[0]": "education" },
  ]) {
    const rejected = await post(input).expect(422);
    expect(rejected.text).toContain("Choose unique, listed audience tags");
    expect(rejected.text).toContain("Invented &lt;review&gt; activity");
    expect(rejected.text).toContain("An invented exercise");
    expect(rejected.text).toContain('name="goals"');
    expect(catalog.createDraft).not.toHaveBeenCalled();
  }
  const rejected = await post({ ...fields, goals: ["work", "work"] }).expect(
    422,
  );
  expect(rejected.text).toMatch(/name="goals" value="work" checked/);
});
it("does not expose the staff workflow page to a member", async () => {
  const catalog = catalogMock();
  const server = await listenLoopback(
    app(db, { origin, secret: "secret", catalog }),
  );
  managedServers.push(server);
  let receivedRequests = 0;
  server.on("request", () => {
    receivedRequests += 1;
  });
  const agent = request.agent(server);
  let denied;
  try {
    denied = await agent.get("/editor/library").set("Host", host);
  } catch (error) {
    throw new Error(
      `GET /editor/library member denial: ${JSON.stringify({
        receivedRequests,
        staffListCalls: catalog.staffList.mock.calls.length,
        error: String(error),
      })}`,
      { cause: error },
    );
  }
  expect(
    denied.status,
    JSON.stringify({
      receivedRequests,
      staffListCalls: catalog.staffList.mock.calls.length,
      status: denied.status,
      contentType: denied.headers["content-type"],
      connection: denied.headers.connection,
      bodyPrefix: denied.text?.slice(0, 80),
    }),
  ).toBe(403);
  expect(receivedRequests).toBe(1);
  expect(denied.text).not.toContain("Create a synthetic draft");
});
it("onboards only valid profiles and ignores caller-controlled ownership", async () => {
  const { agent, csrf } = await client();
  await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, background: "admin" })
    .expect(422);
  expect(db.create).not.toHaveBeenCalled();
  await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      background: "explorer",
      goal: "everyday",
      synthetic: "yes",
      id: "other",
    })
    .expect(303);
  expect(db.create).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.objectContaining({ background: "explorer", goal: "everyday" }),
  );
  active();
  await agent
    .get("/")
    .set("Host", host)
    .expect(303)
    .expect("Location", "/learn");
});
it("retains safe onboarding choices and acknowledgement on an unsaved field error", async () => {
  const { agent, csrf } = await client();
  const attempted = {
    csrf,
    background: "professional",
    goal: "work",
    background_tags: "technical",
    domain_tags: "finance",
    experience: "some",
    timezone: "Mars/Olympus",
    weekly_minutes: "60",
    synthetic: "yes",
  };
  const invalid = await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send(attempted)
    .expect(422);
  expect(db.create).not.toHaveBeenCalled();
  expect(invalid.text).toContain("<title>Error in your onboarding");
  expect(invalid.text).toContain("Your changes were not saved");
  expect(invalid.text).toContain('href="#timezone"');
  expect(invalid.text).toContain('<option value="professional" selected>');
  expect(invalid.text).toContain('<option value="work" selected>');
  expect(invalid.text).toContain(
    'name="background_tags" value="technical" checked',
  );
  expect(invalid.text).toContain('name="domain_tags" value="finance" checked');
  expect(invalid.text).toContain('<option value="some" selected>');
  expect(invalid.text).toContain('<option value="60" selected>');
  expect(invalid.text).toContain(
    'id="timezone" name="timezone" value="Mars/Olympus"',
  );
  expect(invalid.text).toContain(
    'aria-describedby="timezone-help timezone-error"',
  );
  expect(invalid.text).toContain(
    'name="synthetic" value="yes" required checked',
  );
  await agent.get("/").set("Host", host).expect(200);
  const unrelated = await managedAgent(app(db, { origin, secret: "secret" }));
  const otherPage = await unrelated.get("/").set("Host", host).expect(200);
  expect(otherPage.text).not.toContain('value="Mars/Olympus"');
  expect(otherPage.text).not.toContain('<option value="work" selected>');
  await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ ...attempted, timezone: "America/Toronto" })
    .expect(303);
  expect(db.create).toHaveBeenCalledTimes(1);
  expect(db.create).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      background: "professional",
      goal: "work",
      backgroundTags: ["technical"],
      domainTags: ["finance"],
      experience: "some",
      timezone: "America/Toronto",
      weeklyMinutes: 60,
    }),
  );
});
it("rejects forged onboarding inputs and never infers a missing sample-data acknowledgement", async () => {
  const { agent, csrf } = await client();
  const invalid = await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      background: ["technical", "technical"],
      goal: "admin",
      domain_tags: ["finance", "finance"],
      experience: ["new", "some"],
      weekly_minutes: ["15", "60"],
      timezone: '<img src=x onerror="alert(1)">',
      synthetic: ["yes", "yes"],
    })
    .expect(422);
  expect(db.create).not.toHaveBeenCalled();
  for (const field of [
    "background",
    "goal",
    "domain_tags",
    "experience",
    "weekly_minutes",
    "timezone",
    "synthetic",
  ])
    expect(invalid.text).toContain(`href="#${field}"`);
  expect(invalid.text).toContain('name="domain_tags" value="finance" checked');
  expect(invalid.text).toContain(
    'value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"',
  );
  expect(invalid.text).not.toContain('<img src=x onerror="alert(1)">');
  expect(invalid.text).not.toContain('<option value="admin"');
  expect(invalid.text).not.toContain(
    'name="synthetic" value="yes" required checked',
  );
  const missing = await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, background: "explorer", goal: "everyday" })
    .expect(422);
  expect(missing.text).toContain('href="#synthetic"');
  expect(missing.text).toContain('id="synthetic" type="checkbox"');
  expect(missing.text).toContain('aria-describedby="synthetic-error"');
  expect(db.create).not.toHaveBeenCalled();
});
it("lets an active member revise their direction without selecting another owner", async () => {
  const { agent, csrf } = await client();
  active();
  const rejected = await agent
    .post("/profile")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      background: "professional",
      goal: "work",
      domain_tags: "education",
      it_roles: "analysis",
      weekly_minutes: "60",
      timezone: "Mars/Olympus",
    })
    .expect(422);
  expect(rejected.text).toContain("Error in your profile");
  expect(rejected.text).toContain('href="#timezone"');
  expect(rejected.text).toContain('id="timezone"');
  expect(rejected.text).toContain('aria-invalid="true"');
  expect(rejected.text).toContain('value="Mars/Olympus"');
  expect(rejected.text).toContain('<option value="work" selected>');
  expect(rejected.text).toContain('<option value="60" selected>');
  expect(rejected.text).toContain(
    'name="domain_tags" value="education" checked',
  );
  expect(rejected.text).toContain('name="it_roles" value="analysis" checked');
  expect(rejected.text).toContain("Understand AI and try something useful");
  expect(db.updateProfile).not.toHaveBeenCalled();
  const savedPage = await agent.get("/learn").set("Host", host).expect(200);
  expect(savedPage.text).toContain('<option value="everyday" selected>');
  expect(savedPage.text).not.toContain('value="Mars/Olympus"');
  await agent
    .post("/profile")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      background: "professional",
      goal: "work",
      domain_tags: "education",
      it_roles: "analysis",
      exploratory: "yes",
      weekly_minutes: "60",
      timezone: "America/Toronto",
      id: "other",
    })
    .expect(303)
    .expect("Location", "/learn");
  expect(db.updateProfile).toHaveBeenCalledWith(
    "owned",
    expect.objectContaining({
      goal: "work",
      domainTags: ["education"],
      itRoles: ["analysis"],
      exploratory: true,
      weeklyMinutes: 60,
      timezone: "America/Toronto",
    }),
  );
});
it("returns a content-free denial when profile authorization changes after middleware", async () => {
  const { agent, csrf } = await client();
  active();
  db.updateProfile.mockResolvedValueOnce(false);
  const denied = await agent
    .post("/profile")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, background: "professional", goal: "work", timezone: "UTC" })
    .expect(403);
  expect(denied.text).toContain("Profile unavailable");
  expect(denied.text).not.toContain("owned");
  expect(denied.headers.location).toBeUndefined();
});
it.each(["/learn", "/lesson", "/exercise", "/profile", "/delete"])(
  "sends unauthenticated visitors away from %s",
  async (path) => {
    const agent = await managedAgent(app(db, { origin, secret: "s" }));
    await agent.get(path).set("Host", host).expect(303).expect("Location", "/");
  },
);
it("renders the active path and lesson using only the owned session", async () => {
  const { agent } = await client();
  active();
  await agent
    .get("/learn")
    .set("Host", host)
    .expect(200)
    .expect(/Ready when you are/);
  await agent
    .get("/lesson")
    .set("Host", host)
    .expect(200)
    .expect(/Plan a small community event/);
  expect(db.progress).toHaveBeenCalledWith("owned");
});
it("retains invalid answers without claiming they were saved, then saves valid input to the owner", async () => {
  const { agent, csrf } = await client();
  active();
  const invalid = await agent
    .post("/exercise")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      lesson_id: LESSON.id,
      lesson_version: String(LESSON.version),
      goal: "everyday",
      intent: "complete",
      instruction: "short",
    })
    .expect(422);
  expect(invalid.text).toContain("short");
  expect(invalid.text).toContain('href="#instruction"');
  expect(invalid.text).toContain('href="#verification"');
  expect(invalid.text).toContain('href="#checked"');
  expect(invalid.text).toContain("<title>Error in your exercise");
  expect(invalid.text).not.toContain("Your draft is saved");
  expect(db.save).not.toHaveBeenCalled();
  await agent
    .post("/exercise")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      lesson_id: LESSON.id,
      lesson_version: String(LESSON.version),
      goal: "everyday",
      intent: "draft",
      instruction: "My private draft",
      learner_id: "other",
    })
    .expect(303);
  expect(db.save).toHaveBeenCalledWith(
    "owned",
    expect.objectContaining({
      instruction: "My private draft",
      complete: false,
    }),
  );
});
it("requires confirmation and deletes only the current learner before clearing its cookie", async () => {
  const files = evidenceStorage(),
    { agent, csrf } = await client(files);
  active();
  await agent
    .post("/delete")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf })
    .expect(422);
  expect(db.remove).not.toHaveBeenCalled();
  const deleted = await agent
    .post("/delete")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, confirm: "yes", learner_id: "other" })
    .expect(303);
  expect(db.remove).toHaveBeenCalledWith("owned");
  expect(files.removeWorkspace).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(String(deleted.headers["set-cookie"])).toContain(
    "Expires=Thu, 01 Jan 1970",
  );
});
it("validates evidence upload consent and returns only safe result metadata", async () => {
  const files = evidenceStorage(),
    { agent, csrf } = await client(files);
  files.upload
    .mockResolvedValueOnce({ kind: "denied" })
    .mockResolvedValueOnce({ kind: "invalid" })
    .mockResolvedValueOnce({
      kind: "created",
      id: "11111111-1111-4111-8111-111111111111",
      state: "pending",
    });
  const upload = () =>
    agent
      .post("/api/evidence")
      .set("Host", host)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .set("Content-Type", "text/plain")
      .set("X-Evidence-Name", "sample.txt")
      .set("X-Evidence-Rights", "confirmed")
      .set("X-Evidence-Scopes", "private-review")
      .send(Buffer.from("Synthetic evidence"));
  await upload().expect(403, { error: "forbidden" });
  await upload().expect(422, { error: "invalid_evidence" });
  await upload().expect(201, {
    kind: "created",
    id: "11111111-1111-4111-8111-111111111111",
    state: "pending",
  });
  expect(files.upload).toHaveBeenLastCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.objectContaining({
      name: "sample.txt",
      mediaType: "text/plain",
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
        learningCircleId: undefined,
      },
      data: Buffer.from("Synthetic evidence"),
    }),
  );
  await agent
    .post("/api/evidence")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .set("X-Evidence-Scopes", "learning-circle")
    .set("X-Learning-Circle-Id", "group-a")
    .expect(403);
  expect(files.upload).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      consent: expect.objectContaining({ learningCircleId: "group-a" }),
      data: Buffer.alloc(0),
    }),
  );
  await agent
    .post("/api/evidence")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .expect(403);
  await agent
    .post("/api/evidence")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .set("X-Evidence-Scopes", "learning-circle")
    .expect(403);
  expect(files.upload).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      consent: expect.objectContaining({ learningCircleId: "" }),
    }),
  );
});

it("rejects oversized evidence without passing its bytes to storage", async () => {
  const files = evidenceStorage(),
    { agent, csrf } = await client(files);
  await agent
    .post("/api/evidence")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .set("Content-Type", "application/pdf")
    .send(Buffer.alloc(MAX_EVIDENCE_BYTES + 1))
    .expect(413, { error: "invalid_evidence" });
  expect(files.upload).not.toHaveBeenCalled();
});

it("gates review, short-lived download and deletion through evidence decisions", async () => {
  const files = evidenceStorage(),
    { agent, csrf } = await client(files),
    id = "11111111-1111-4111-8111-111111111111",
    write = (path: string) =>
      agent
        .post(path)
        .set("Host", host)
        .set("Origin", origin)
        .set("X-CSRF-Token", csrf);
  files.submitForReview
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await write(`/api/evidence/${id}/review`).expect(409, {
    error: "evidence_not_ready",
  });
  await write(`/api/evidence/${id}/review`).expect(204);
  files.issueDownload
    .mockResolvedValueOnce({ kind: "denied" })
    .mockResolvedValueOnce({
      kind: "issued",
      capability: "safe-capability",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  await write(`/api/evidence/${id}/download-link`).expect(403, {
    error: "forbidden",
  });
  const link = await write(`/api/evidence/${id}/download-link`).expect(200);
  expect(link.body).toEqual({
    href: `/api/evidence/${id}/download?capability=safe-capability`,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  files.download
    .mockResolvedValueOnce({ kind: "denied" })
    .mockResolvedValueOnce({
      kind: "allowed",
      name: "sample.pdf",
      mediaType: "application/pdf",
      data: Buffer.from("%PDF-synthetic"),
    });
  await agent
    .get(`/api/evidence/${id}/download?capability=bad`)
    .set("Host", host)
    .expect(403, { error: "forbidden" });
  const download = await agent
    .get(`/api/evidence/${id}/download?capability=one&capability=two`)
    .set("Host", host)
    .expect(200);
  expect(download.headers["content-disposition"]).toBe(
    'attachment; filename="sample.pdf"',
  );
  expect(download.headers["content-type"]).toContain("application/pdf");
  expect(download.body).toEqual(Buffer.from("%PDF-synthetic"));
  expect(files.download).toHaveBeenLastCalledWith(expect.any(String), id, "");
  files.remove.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const remove = () =>
    agent
      .delete(`/api/evidence/${id}`)
      .set("Host", host)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf);
  await remove().expect(403, { error: "forbidden" });
  await remove().expect(204);
});
it("lets a member revoke private-review evidence access through a CSRF-guarded request", async () => {
  const files = evidenceStorage();
  const { agent, csrf } = await client(files);
  const id = "11111111-1111-4111-8111-111111111111";
  const revoke = () =>
    agent
      .post(`/api/evidence/${id}/revoke-private-review`)
      .set("Host", host)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf);
  await agent
    .post(`/api/evidence/${id}/revoke-private-review`)
    .set("Host", host)
    .set("Origin", origin)
    .expect(403);
  expect(files.revokePrivateReview).not.toHaveBeenCalled();
  await revoke().expect(403, { error: "forbidden" });
  files.revokePrivateReview.mockResolvedValueOnce(true);
  await revoke().expect(204);
  expect(files.revokePrivateReview).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    id,
  );
});
it("shows a member-owned evidence manager with a usable empty state", async () => {
  const files = evidenceStorage();
  const { agent } = await client(files);
  active();
  const response = await agent.get("/evidence").set("Host", host).expect(200);
  expect(response.text).toContain("Your private evidence");
  expect(response.text).toContain("No sample evidence saved yet");
  expect(files.owned).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
});
it("offers a local review queue only for clean, consented, unsubmitted owner evidence", async () => {
  const files = evidenceStorage();
  const { agent } = await client(files);
  active();
  const candidate = "11111111-1111-4111-8111-111111111111";
  files.owned.mockResolvedValue([
    {
      id: candidate,
      name: "clean.txt",
      mediaType: "text/plain",
      quarantineState: "clean",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: null,
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "pending.txt",
      mediaType: "text/plain",
      quarantineState: "pending",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: null,
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "revoked.txt",
      mediaType: "text/plain",
      quarantineState: "clean",
      privateReviewAllowed: false,
      privateReviewRevokedAt: new Date(),
      submissionStatus: null,
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "queued.txt",
      mediaType: "text/plain",
      quarantineState: "clean",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: "queued",
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
  ]);
  const response = await agent.get("/evidence").set("Host", host).expect(200);
  expect(response.text).toContain(`action="/evidence/${candidate}/queue"`);
  expect(response.text.match(/\/queue"/g)).toHaveLength(1);
  expect(response.text).toContain("No qualified reviewer is assigned");
});
it("requires acknowledgement and current owner eligibility before queuing local evidence", async () => {
  const files = evidenceStorage();
  const { agent, csrf } = await client(files);
  active();
  const id = "11111111-1111-4111-8111-111111111111";
  const post = (value: string | undefined, token = csrf) =>
    agent
      .post(`/evidence/${id}/queue`)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: token, ...(value ? { acknowledge: value } : {}) });
  await post("yes", "wrong").expect(403);
  await post(undefined)
    .expect(422)
    .expect(/Acknowledge that no qualified reviewer/);
  expect(files.submitForReview).not.toHaveBeenCalled();
  await post("yes")
    .expect(409)
    .expect(/not eligible for the local review queue/);
  files.submitForReview.mockResolvedValueOnce(true);
  await post("yes").expect(303).expect("Location", "/evidence");
  expect(files.submitForReview).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    id,
  );
});
it("keeps a failed private evidence revision editable and never copies consent or reviewer access", async () => {
  const files = evidenceStorage();
  const { agent, csrf } = await client(files);
  active();
  const id = "11111111-1111-4111-8111-111111111111";
  const parent = {
    id,
    name: "original.txt",
    mediaType: "text/plain" as const,
    quarantineState: "clean" as const,
    privateReviewAllowed: true,
    privateReviewRevokedAt: null,
    submissionStatus: "queued" as const,
    createdAt: new Date(),
    revisionParentId: null,
    revisionParentStatus: "none" as const,
    revisionNumber: 1,
    hasRevision: false,
  };
  files.owned.mockResolvedValue([parent]);
  const path = `/evidence/${id}/revise`;
  await agent
    .get(path)
    .set("Host", host)
    .expect(200)
    .expect(/version 1/);
  files.owned.mockResolvedValue([{ ...parent, submissionStatus: "reviewed" }]);
  await agent.get(path).set("Host", host).expect(200);
  files.owned.mockResolvedValue([parent]);
  const post = (fields: Record<string, string>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  const fields = {
    name: "revision.txt",
    sample: "Invented <private> revision",
    rights_confirmed: "yes",
    private_review_consent: "yes",
  };
  await post({ rights_confirmed: "yes", private_review_consent: "yes" })
    .expect(422)
    .expect(/Enter invented text and confirm fresh rights/);
  await post({ ...fields, private_review_consent: "" })
    .expect(422)
    .expect(/Invented &lt;private&gt; revision/);
  expect(files.upload).not.toHaveBeenCalled();
  files.upload.mockResolvedValueOnce({ kind: "denied" });
  await post(fields)
    .expect(409)
    .expect(/Invented &lt;private&gt; revision/);
  files.upload.mockResolvedValueOnce({ kind: "invalid" });
  await post(fields).expect(422);
  files.upload.mockResolvedValueOnce({ kind: "created", id, state: "pending" });
  await post(fields).expect(303).expect("Location", "/evidence");
  expect(files.upload).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      revisesId: id,
      name: "revision.txt",
      data: Buffer.from(fields.sample),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    }),
  );
  files.owned.mockResolvedValue([
    {
      ...parent,
      id: "22222222-2222-4222-8222-222222222222",
      revisionParentId: id,
      revisionParentStatus: "none",
      revisionNumber: 2,
      submissionStatus: null,
    },
  ]);
  const history = await agent.get("/evidence").set("Host", host).expect(200);
  expect(history.text).toContain(`version 2 · revises ${id}`);
  files.owned.mockResolvedValue([]);
  await agent.get(path).set("Host", host).expect(403);
  await post(fields).expect(403);
});
it("keeps evidence form writes owner-scoped, confirmed and truthful", async () => {
  const files = evidenceStorage();
  const { agent, csrf } = await client(files);
  active();
  const id = "11111111-1111-4111-8111-111111111111";
  files.owned.mockResolvedValue([
    {
      id,
      name: "<script>private</script>",
      mediaType: "text/plain",
      quarantineState: "pending",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: "queued",
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "clean",
      mediaType: "text/plain",
      quarantineState: "clean",
      privateReviewAllowed: false,
      privateReviewRevokedAt: new Date(),
      submissionStatus: "withdrawn",
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "rejected",
      mediaType: "text/plain",
      quarantineState: "rejected",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: null,
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "blocked",
      mediaType: "text/plain",
      quarantineState: "infected",
      privateReviewAllowed: true,
      privateReviewRevokedAt: null,
      submissionStatus: "reviewed",
      createdAt: new Date(),
      revisionParentId: null,
      revisionParentStatus: "none",
      revisionNumber: 1,
      hasRevision: false,
    },
  ]);
  const page = await agent.get("/evidence").set("Host", host).expect(200);
  expect(page.text).not.toContain("<script>private</script>");
  expect(page.text).toContain("&lt;script&gt;private&lt;/script&gt;");
  for (const marker of [
    "Pending safety check",
    "Safety check passed",
    "Rejected by safety check",
    "Blocked by safety check",
    "Review submission withdrawn",
    "Submitted locally",
    "Not submitted for review",
    "Synthetic review state recorded",
  ])
    expect(page.text).toContain(marker);
  const post = (path: string, fields: Record<string, string> = {}) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post("/evidence", {
    name: "<b>title</b>",
    sample: "<script>sample</script>",
  })
    .expect(422)
    .expect(/&lt;script&gt;sample&lt;\/script&gt;/);
  expect(files.upload).not.toHaveBeenCalled();
  const form = {
    name: "invented.txt",
    sample: "Invented text",
    rights_confirmed: "yes",
    private_review_consent: "yes",
  };
  files.upload
    .mockResolvedValueOnce({ kind: "invalid" })
    .mockResolvedValueOnce({ kind: "denied" })
    .mockResolvedValueOnce({ kind: "created", id, state: "pending" });
  await post("/evidence", form).expect(422);
  await post("/evidence", form).expect(403);
  await post("/evidence", form).expect(303).expect("Location", "/evidence");
  expect(files.upload).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      name: "invented.txt",
      mediaType: "text/plain",
      data: Buffer.from("Invented text"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    }),
  );
  await post(`/evidence/${id}/revoke-private-review`).expect(422);
  await post(`/evidence/${id}/delete`).expect(422);
  expect(files.revokePrivateReview).not.toHaveBeenCalled();
  expect(files.remove).not.toHaveBeenCalled();
  await post(`/evidence/${id}/revoke-private-review`, {
    confirm: "yes",
  }).expect(403);
  files.revokePrivateReview.mockResolvedValueOnce(true);
  await post(`/evidence/${id}/revoke-private-review`, {
    confirm: "yes",
  }).expect(303);
  await post(`/evidence/${id}/delete`, { confirm: "yes" }).expect(403);
  files.remove.mockResolvedValueOnce(true);
  await post(`/evidence/${id}/delete`, { confirm: "yes" }).expect(303);
  await post(`/evidence/${id}/download`).expect(403);
  files.issueDownload.mockResolvedValueOnce({
    kind: "issued",
    capability: "token",
    expiresAt: new Date(),
  });
  await post(`/evidence/${id}/download`)
    .expect(303)
    .expect("Location", `/api/evidence/${id}/download?capability=token`);
  await agent
    .post(`/evidence/${id}/delete`)
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: "bad", confirm: "yes" })
    .expect(403);
});
it("rejects unrecognized Host and cross-origin, missing-origin or invalid-CSRF writes", async () => {
  const badHostAgent = await managedAgent(app(db, { origin, secret: "s" }));
  await atStage(
    "GET / unrecognized Host",
    badHostAgent.get("/").set("Host", "attacker.invalid").expect(403),
  );
  const { agent, csrf } = await atStage("GET / session setup", client());
  for (const from of ["http://attacker.invalid", "null", ""]) {
    await atStage(
      `POST /start Origin ${JSON.stringify(from)}`,
      agent
        .post("/start")
        .set("Host", host)
        .set("Origin", from)
        .type("form")
        .send({ csrf })
        .expect(403),
    );
  }
  await atStage(
    "POST /start invalid CSRF",
    agent
      .post("/start")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf: "0".repeat(64) })
      .expect(403),
  );
  await atStage(
    "POST /start unsupported content type",
    agent
      .post("/start")
      .set("Host", host)
      .set("Origin", origin)
      .set("Content-Type", "text/plain")
      .send("bad")
      .expect(403),
  );
  expect(db.create).not.toHaveBeenCalled();
});
it("reports unknown pages and storage failures without leaking secrets or claiming no commit", async () => {
  const { agent, csrf } = await client();
  await agent.get("/missing").set("Host", host).expect(404);
  db.session.mockRejectedValueOnce(new Error("secret connection password"));
  const failed = await agent.get("/learn").set("Host", host).expect(503);
  expect(failed.text).toContain("could not confirm");
  expect(failed.text).not.toContain("secret connection");
  active();
  const attemptedInstruction =
    "Plan a sample workshop with <script>window.leak=true</script> details.";
  const attemptedVerification =
    "Check the invented schedule against the original notes.\nKeep uncertainty visible.";
  db.save.mockRejectedValueOnce(new Error("lost acknowledgment secret"));
  const uncertainExercise = await agent
    .post("/exercise")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({
      csrf,
      lesson_id: LESSON.id,
      lesson_version: String(LESSON.version),
      goal: "everyday",
      intent: "draft",
      instruction: attemptedInstruction,
      verification: attemptedVerification,
    })
    .expect(503);
  expect(uncertainExercise.headers["cache-control"]).toContain("no-store");
  expect(uncertainExercise.text).toContain("Save outcome unknown");
  expect(uncertainExercise.text).toContain("Attempted instruction");
  expect(uncertainExercise.text).toContain("Attempted way to check");
  expect(uncertainExercise.text).toContain(
    "&lt;script&gt;window.leak=true&lt;/script&gt;",
  );
  expect(uncertainExercise.text).toContain(attemptedVerification);
  expect(uncertainExercise.text).toContain(
    "Inspect saved lesson (opens in a new tab)",
  );
  expect(uncertainExercise.text).not.toContain("lost acknowledgment secret");
  expect(uncertainExercise.text).not.toContain("Your draft is saved");
  db.remove.mockRejectedValueOnce(new Error("storage unavailable"));
  await agent
    .post("/delete")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, confirm: "yes" })
    .expect(503);
});
it("handles completed or saved paths without inventing formal assessment", async () => {
  const { agent } = await client();
  active();
  db.progress.mockResolvedValue({
    instruction: "saved",
    verification: "check",
    completed_at: new Date(),
  });
  const page = await agent.get("/learn").set("Host", host);
  expect(page.text).toContain("Completed · self-assessed");
});
it("requires a confirmed owned version to withdraw completed starter text", async () => {
  const { agent, csrf } = await client();
  active();
  db.progress.mockResolvedValue({
    instruction: "Invented private instruction",
    verification: "Invented private verification",
    completed_at: new Date("2026-09-29T00:00:00Z"),
  });
  const current = await agent.get("/lesson").set("Host", host).expect(200);
  expect(current.text).toContain("Withdraw completed exercise text");
  const post = (path: string, body: Record<string, string>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...body });
  await post("/exercise/clear-instructions/1/withdraw", {}).expect(422);
  await post("/exercise/clear-instructions/1/withdraw", {
    confirm: "yes",
    learner_id: "other",
  }).expect(422);
  await post("/exercise/clear-instructions/0/withdraw", {
    confirm: "yes",
  }).expect(404);
  await post("/exercise/other/1/withdraw", { confirm: "yes" }).expect(404);
  expect(db.withdrawExercise).not.toHaveBeenCalled();
  db.withdrawExercise.mockResolvedValueOnce("withdrawn");
  await post("/exercise/clear-instructions/1/withdraw", { confirm: "yes" })
    .expect(303)
    .expect("Location", "/lesson");
  expect(db.withdrawExercise).toHaveBeenCalledWith(
    expect.any(String),
    LESSON.id,
    1,
    undefined,
  );
  db.withdrawExercise.mockResolvedValueOnce("already-withdrawn");
  await post("/exercise/clear-instructions/1/withdraw", {
    confirm: "yes",
  }).expect(303);
  await post("/exercise/clear-instructions/1/withdraw", {
    confirm: "yes",
  }).expect(404);
  db.withdrawExercise.mockRejectedValueOnce(
    new Error("secret database detail"),
  );
  const uncertain = await post("/exercise/clear-instructions/1/withdraw", {
    confirm: "yes",
  }).expect(503);
  expect(uncertain.text).not.toContain("secret database detail");
  expect(uncertain.text).toContain("inspect the current state");
});
it("never echoes stale exercise text after withdrawal, including validation and uncertain saves", async () => {
  const { agent, csrf } = await client();
  active();
  db.progress.mockResolvedValue({
    instruction: null,
    verification: null,
    completed_at: new Date("2026-09-29T00:00:00Z"),
    withdrawn_at: new Date("2026-09-29T01:00:00Z"),
  });
  const attempted =
    "Invented stale private instruction that must remain hidden";
  const post = (instruction: string, verification: string) =>
    agent
      .post("/exercise")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf,
        lesson_id: LESSON.id,
        lesson_version: String(LESSON.version),
        goal: "everyday",
        intent: "complete",
        instruction,
        verification,
        checked: "yes",
      });
  const invalid = await post(attempted, "short").expect(409);
  expect(invalid.text).not.toContain(attempted);
  expect(db.save).not.toHaveBeenCalled();
  db.save.mockResolvedValueOnce("withdrawn");
  const stale = await post(
    attempted,
    "Check the invented source against notes",
  ).expect(409);
  expect(stale.text).not.toContain(attempted);
  db.save.mockRejectedValueOnce(new Error("secret database detail"));
  const uncertain = await post(
    attempted,
    "Check the invented source against notes",
  ).expect(503);
  expect(uncertain.text).not.toContain(attempted);
  expect(uncertain.text).not.toContain("secret database detail");
  const page = await agent.get("/lesson").set("Host", host).expect(200);
  expect(page.text).toContain("Saved exercise text withdrawn");
  expect(page.text).not.toContain(attempted);
});
it("rejects a form pinned to another starter version before saving or echoing its text", async () => {
  const { agent, csrf } = await client();
  active();
  const staleText = "Invented text from an earlier starter exercise version";
  for (const version of ["2", "", "01"]) {
    const result = await agent
      .post("/exercise")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf,
        lesson_id: LESSON.id,
        lesson_version: version,
        intent: "draft",
        instruction: staleText,
      })
      .expect(409);
    expect(result.text).not.toContain(staleText);
  }
  expect(db.save).not.toHaveBeenCalled();
});
it("withholds lesson text when the owner read cannot be confirmed", async () => {
  const { agent } = await client();
  active();
  db.withExerciseRead = async () => null;
  const response = await agent.get("/lesson").set("Host", host).expect(403);
  expect(response.text).toContain("Lesson unavailable");
  expect(response.text).not.toContain("Your instruction");
});
it("selects only an eligible published assignment for the active member and rejects stale or forged choices", async () => {
  const item: ContentVersion = {
    id: "SYN-920",
    version: 1,
    kind: "assignment",
    origin: "curated",
    title: "Invented event",
    body: "Use invented details.",
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
  const catalog = catalogMock();
  catalog.search.mockResolvedValue([item]);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const entry = await agent.get("/").set("Host", host).expect(200);
  const csrf = entry.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (values: Record<string, string>) =>
    agent
      .post("/assignments/select")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, content_id: item.id, content_version: "1", ...values });
  await post({}).expect(303);
  expect(db.chooseAssignment).not.toHaveBeenCalled();
  active();
  expect(
    (await agent.get("/learn").set("Host", host).expect(200)).text,
  ).toContain("Invented event");
  await post({ csrf: "invalid" }).expect(403);
  await post({ content_version: "1.5" }).expect(409);
  await post({ content_id: "SYN-999" }).expect(409);
  expect(db.chooseAssignment).not.toHaveBeenCalled();
  db.chooseAssignment.mockResolvedValueOnce(null);
  const denied = await post({}).expect(403);
  expect(denied.headers.location).toBeUndefined();
  expect(denied.text).toContain("This private action is not available.");
  expect(denied.text).not.toContain(item.title);
  db.chooseAssignment.mockRejectedValueOnce(
    new Error("PRIVATE SYNTHETIC selection failure"),
  );
  const failure = await post({}).expect(503);
  expect(failure.headers.location).toBeUndefined();
  expect(failure.text).not.toContain("PRIVATE SYNTHETIC");
  expect(failure.text).not.toContain(item.title);
  db.chooseAssignment.mockResolvedValueOnce(false);
  await post({}).expect(409);
  db.chooseAssignment.mockResolvedValueOnce(true);
  await post({}).expect(303);
  expect(db.chooseAssignment).toHaveBeenLastCalledWith(member.id, item.id, 1);
  catalog.search.mockResolvedValue([{ ...item, state: "retired" }]);
  await post({}).expect(409);
});
it("keeps private milestones local, validates edits and refuses stale or foreign writes", async () => {
  const { agent, csrf } = await client();
  await agent.get("/milestones").set("Host", host).expect(303);
  db.session.mockResolvedValue({
    kind: "active",
    learner: { ...member, timezone: "America/Toronto" },
  });
  const empty = await agent.get("/milestones").set("Host", host).expect(200);
  expect(empty.text).toContain("No milestones yet");
  const id = "a4ff1471-0226-4d5b-8677-99c0a94cdf40";
  const input = {
    goal_title: "Understand AI for daily decisions",
    milestone_title: "Compare invented answers",
    evidence_note: "I checked the original sample and found a gap.",
    next_action: "Ask one clearer question",
    reminder_date: "2028-02-29",
    reminder_time: "14:30",
    sample_only: "yes",
  };
  const post = (path: string, values: Record<string, string>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...values });
  await post("/milestones", { ...input, sample_only: "" }).expect(422);
  expect(db.createMilestone).not.toHaveBeenCalled();
  db.createMilestone.mockResolvedValueOnce(false).mockResolvedValueOnce(id);
  await post("/milestones", input).expect(409);
  await post("/milestones", input).expect(303);
  expect(db.createMilestone).toHaveBeenLastCalledWith(
    member.id,
    expect.objectContaining({ reminderTimezone: "America/Toronto" }),
  );
  const saved = {
    id,
    goalTitle: "Understand <AI> for daily decisions",
    milestoneTitle: "Compare invented answers",
    evidenceNote: "I checked the original sample and found a gap.",
    nextAction: "Ask one clearer question",
    reminderDate: "2028-02-29",
    reminderTime: "14:30",
    reminderTimezone: "America/Toronto",
    selfReportedComplete: false,
    version: 1,
    createdAt: new Date("2026-09-23"),
    updatedAt: new Date("2026-09-23"),
  };
  db.milestones.mockResolvedValue([saved]);
  const list = await agent.get("/milestones").set("Host", host).expect(200);
  expect(list.text).toContain("Understand &lt;AI&gt;");
  expect(list.text).not.toContain("Understand <AI>");
  expect(list.text).toContain("shown here only");
  await post("/milestones/not-an-id/update", { ...input, version: "1" }).expect(
    409,
  );
  await post(`/milestones/${id}/update`, { ...input, version: "0" }).expect(
    409,
  );
  await post(`/milestones/${id}/update`, {
    ...input,
    version: "1",
    next_action: "",
  }).expect(422);
  db.updateMilestone.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await post(`/milestones/${id}/update`, { ...input, version: "1" }).expect(
    409,
  );
  await post(`/milestones/${id}/update`, {
    ...input,
    version: "1",
    complete: "yes",
  }).expect(303);
  expect(db.updateMilestone).toHaveBeenLastCalledWith(
    member.id,
    id,
    1,
    expect.objectContaining({ selfReportedComplete: true }),
  );
  await post(`/milestones/${id}/delete`, { version: "2" }).expect(409);
  await post(`/milestones/${id}/delete`, {
    version: "bad",
    confirm: "yes",
  }).expect(409);
  db.deleteMilestone.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await post(`/milestones/${id}/delete`, {
    version: "2",
    confirm: "yes",
  }).expect(409);
  await post(`/milestones/${id}/delete`, {
    version: "2",
    confirm: "yes",
  }).expect(303);
  expect(db.deleteMilestone).toHaveBeenLastCalledWith(member.id, id, 2);
  await post("/milestones", { ...input, csrf: "invalid" }).expect(403);
});

it("withholds saved and attempted milestone content on every unavailable route branch", async () => {
  const { agent, csrf } = await client();
  db.session.mockResolvedValue({ kind: "active", learner: member });
  db.milestones.mockResolvedValue(null);
  db.createMilestone.mockResolvedValue(null);
  db.updateMilestone.mockResolvedValue(null);
  db.deleteMilestone.mockResolvedValue(null);
  const id = "a4ff1471-0226-4d5b-8677-99c0a94cdf40";
  const marker = "Attempted synthetic private milestone";
  const input = {
    csrf,
    version: "1",
    goal_title: marker,
    milestone_title: marker,
    evidence_note: marker,
    next_action: marker,
    sample_only: "yes",
    confirm: "yes",
  };
  const responses = [await agent.get("/milestones").set("Host", host)];
  for (const [path, fields] of [
    ["/milestones", { ...input, sample_only: "" }],
    [`/milestones/${id}/update`, { ...input, sample_only: "" }],
    ["/milestones", input],
    [`/milestones/${id}/update`, input],
    [`/milestones/${id}/delete`, input],
  ] as const)
    responses.push(
      await agent
        .post(path)
        .set("Host", host)
        .set("Origin", origin)
        .type("form")
        .send(fields),
    );
  for (const response of responses) {
    expect(response.status).toBe(403);
    expect(response.text).toContain("Milestones unavailable");
    expect(response.text).not.toContain(marker);
    expect(response.text).not.toContain("No milestones yet");
  }
});

it("compares only two selected submissions from an owned private attempt", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const earlier = "Invented <private> first\nKeep this";
  const later = "Invented <private> second\nKeep this";
  const item = {
    id,
    contentId: "SYN-960",
    contentVersion: 1,
    title: "Invented assignment",
    goalAtStart: "everyday",
    response: "unsubmitted draft must not enter comparison",
    revision: 4,
    startedAt: new Date("2026-09-24T00:00:00Z"),
    savedAt: new Date("2026-09-24T00:04:00Z"),
    submittedAt: null,
    submissionCount: 2,
    submissions: [
      { sequence: 1, response: earlier, submittedAt: "2026-09-24T00:01:00Z" },
      { sequence: 2, response: later, submittedAt: "2026-09-24T00:02:00Z" },
    ],
    currentPublished: false,
    currentEligible: false,
  };
  const db = storage();
  const attempts = {
    ...disabledAttemptStore(),
    detail: vi.fn().mockResolvedValue(item),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  await agent.get("/").set("Host", host).expect(200);
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const get = (query: string) =>
    agent.get(`/assignments/attempts/${id}/compare${query}`).set("Host", host);
  const result = await get("?from=1&to=2").expect(200);
  expect(result.text).toContain("Compare private submissions");
  expect(result.text).toContain("Invented &lt;private&gt; first");
  expect(result.text).toContain("Invented &lt;private&gt; second");
  expect(result.text).not.toContain(
    "unsubmitted draft must not enter comparison",
  );
  expect(result.text).not.toContain("Invented <private>");
  expect(attempts.detail).toHaveBeenCalledTimes(1);
  for (const query of [
    "",
    "?from=1&to=1",
    "?from=0&to=2",
    "?from=01&to=2",
    "?from=1&from=2&to=2",
    "?from=1&to=3",
  ]) {
    const invalid = await get(query).expect(422);
    expect(invalid.text).not.toContain(earlier);
    expect(invalid.text).not.toContain(later);
  }
  attempts.detail.mockResolvedValue(null);
  await get("?from=1&to=2").expect(404);
  await agent
    .get("/assignments/attempts/invalid/compare?from=1&to=2")
    .set("Host", host)
    .expect(404);
  attempts.detail.mockResolvedValue({ ...item, submissions: undefined });
  await get("?from=1&to=2").expect(422);
});

it("keeps synthetic assignment attempts private through start, validation, conflicts, submission and deletion", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const item = {
    id,
    contentId: "SYN-960",
    contentVersion: 1,
    title: "Invented assignment",
    goalAtStart: "everyday",
    response: "Saved invented response for the assignment.",
    revision: 2,
    startedAt: new Date("2026-09-24T00:00:00Z"),
    savedAt: new Date("2026-09-24T00:01:00Z"),
    submittedAt: null,
    currentPublished: true,
    currentEligible: true,
  };
  const db = storage();
  const attempts = {
    list: vi.fn().mockResolvedValue([]),
    detail: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(false),
    submit: vi.fn().mockResolvedValue(false),
    revise: vi.fn().mockResolvedValue(false),
    remove: vi.fn().mockResolvedValue(false),
    saveReflection: vi.fn().mockResolvedValue(false),
    deleteReflection: vi.fn().mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const post = (path: string, fields: Record<string, unknown>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await post("/assignments/select", { content_version: "1" }).expect(409);
  await agent.get("/assignments/attempts").set("Host", host).expect(200);
  attempts.list.mockResolvedValue([item]);
  expect(
    (await agent.get("/assignments/attempts").set("Host", host).expect(200))
      .text,
  ).toContain("Invented assignment");
  attempts.list.mockResolvedValueOnce(null);
  const deniedHistory = await agent
    .get("/assignments/attempts")
    .set("Host", host)
    .expect(403);
  expect(deniedHistory.text).toContain("Assignment history unavailable");
  expect(deniedHistory.text).not.toContain("Invented assignment");
  expect(deniedHistory.text).not.toContain(id);
  expect(deniedHistory.text).not.toContain(
    "No private assignment attempts yet",
  );
  await post("/assignments/attempts/start", {}).expect(409);
  attempts.start.mockResolvedValue(id);
  await post("/assignments/attempts/start", {}).expect(303);
  await agent
    .get("/assignments/attempts/invalid")
    .set("Host", host)
    .expect(404);
  await agent.get(`/assignments/attempts/${id}`).set("Host", host).expect(404);
  attempts.detail.mockResolvedValue(item);
  await agent.get(`/assignments/attempts/${id}`).set("Host", host).expect(200);
  const submitted = {
    ...item,
    submissions: [
      {
        sequence: 1,
        submittedAt: "2026-09-24T00:01:00Z",
        response: "Saved invented response for the assignment.",
      },
    ],
  };
  attempts.detail.mockResolvedValue(submitted);
  const exact = await agent
    .get(`/assignments/attempts/${id}?version=1&submission=1`)
    .set("Host", host)
    .expect(200);
  expect(exact.text).toContain('id="submission-1"');
  for (const query of [
    "?version=2&submission=1",
    "?version=1&submission=2",
    "?version=1&submission=01",
    "?version=1",
    "?submission=1",
    "?version=1&submission=1&submission=2",
  ]) {
    await agent
      .get(`/assignments/attempts/${id}${query}`)
      .set("Host", host)
      .expect(404);
  }
  attempts.detail.mockResolvedValue(item);
  attempts.list.mockRejectedValueOnce(
    new Error("Synthetic database read fault"),
  );
  const failedProgress = await agent
    .get("/progress")
    .set("Host", host)
    .expect(503);
  expect(failedProgress.text).toContain("We could not save or load that");
  expect(failedProgress.text).not.toContain("Synthetic database read fault");
  await post("/assignments/attempts/invalid/save", {
    revision: "2",
    response: "draft",
    sample_confirmed: "yes",
  }).expect(409);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "no",
    response: "draft",
    sample_confirmed: "yes",
  }).expect(422);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "999999999999999999999",
    response: "draft",
    sample_confirmed: "yes",
  }).expect(422);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    response: "x".repeat(4001),
    sample_confirmed: "yes",
  }).expect(422);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    response: "draft",
  }).expect(422);
  attempts.save.mockResolvedValueOnce(true);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    sample_confirmed: "yes",
  }).expect(303);
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
  const conflict = await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    response: "unsaved private text",
    sample_confirmed: "yes",
  }).expect(409);
  expect(conflict.text).toContain("unsaved private text");
  attempts.save.mockResolvedValue(true);
  await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    response: "draft",
    sample_confirmed: "yes",
  }).expect(303);
  attempts.save.mockRejectedValueOnce(
    new Error("private database connection secret"),
  );
  const failedWrite = await post(`/assignments/attempts/${id}/save`, {
    revision: "2",
    response: "unsaved text after a database failure",
    sample_confirmed: "yes",
  }).expect(503);
  expect(failedWrite.text).toContain("Save outcome unknown");
  expect(failedWrite.text).toContain("unsaved text after a database failure");
  expect(failedWrite.text).toContain("Reload this attempt");
  expect(failedWrite.text).not.toContain('name="revision"');
  expect(failedWrite.text).not.toContain("private database connection secret");
  await post("/assignments/attempts/invalid/submit", {
    revision: "2",
    confirm: "yes",
  }).expect(409);
  await post(`/assignments/attempts/${id}/submit`, { revision: "2" }).expect(
    422,
  );
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
  await post(`/assignments/attempts/${id}/submit`, {
    revision: "2",
    confirm: "yes",
  }).expect(409);
  attempts.submit.mockResolvedValue(true);
  await post(`/assignments/attempts/${id}/submit`, {
    revision: "2",
    confirm: "yes",
  }).expect(303);
  attempts.detail.mockResolvedValue({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
    submissionCount: 1,
  });
  await post("/assignments/attempts/invalid/revise", { confirm: "yes" }).expect(
    409,
  );
  await post(`/assignments/attempts/${id}/revise`, {}).expect(422);
  await post(`/assignments/attempts/${id}/revise`, {
    confirm: "yes",
  }).expect(409);
  attempts.detail
    .mockResolvedValueOnce({
      ...item,
      submittedAt: new Date("2026-09-24T00:02:00Z"),
      submissionCount: 1,
    })
    .mockResolvedValueOnce(null);
  expect(
    (
      await post(`/assignments/attempts/${id}/revise`, {
        confirm: "yes",
      }).expect(409)
    ).text,
  ).toContain("Attempt unavailable");
  attempts.detail.mockResolvedValue({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
  });
  expect(
    (
      await post(`/assignments/attempts/${id}/revise`, {
        confirm: "yes",
      }).expect(409)
    ).text,
  ).toContain("changed in another tab");
  attempts.detail.mockResolvedValueOnce(null);
  await post(`/assignments/attempts/${id}/revise`, { confirm: "yes" }).expect(
    409,
  );
  attempts.detail.mockResolvedValue({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
    submissionCount: 10,
  });
  expect(
    (
      await post(`/assignments/attempts/${id}/revise`, {
        confirm: "yes",
      }).expect(409)
    ).text,
  ).toContain("ten-submission limit");
  attempts.detail.mockResolvedValue({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
    submissionCount: 1,
    currentEligible: false,
  });
  expect(
    (
      await post(`/assignments/attempts/${id}/revise`, {
        confirm: "yes",
      }).expect(409)
    ).text,
  ).toContain("direction changed");
  attempts.detail.mockResolvedValue({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
    submissionCount: 1,
  });
  attempts.revise.mockRejectedValueOnce(new Error("private revision failure"));
  const uncertainRevision = await post(`/assignments/attempts/${id}/revise`, {
    confirm: "yes",
  }).expect(503);
  expect(uncertainRevision.text).toContain("Revision outcome unknown");
  expect(uncertainRevision.text).not.toContain("private revision failure");
  attempts.revise.mockResolvedValue(true);
  await post(`/assignments/attempts/${id}/revise`, {
    confirm: "yes",
  }).expect(303);
  expect(attempts.revise).toHaveBeenCalledWith(expect.any(String), id);
  await post("/assignments/attempts/invalid/delete", { confirm: "yes" }).expect(
    409,
  );
  await post(`/assignments/attempts/${id}/delete`, {}).expect(409);
  const uncertainDeletion = await post(`/assignments/attempts/${id}/delete`, {
    confirm: "yes",
  }).expect(409);
  expect(uncertainDeletion.text).toContain("Deletion not confirmed");
  expect(uncertainDeletion.text).toContain("check whether this record remains");
  attempts.remove.mockResolvedValue(true);
  await post(`/assignments/attempts/${id}/delete`, { confirm: "yes" }).expect(
    303,
  );
});

it("preserves attempted text and separates stale, ineligible, expired and uncertain assignment writes", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const item = {
    id,
    contentId: "SYN-962",
    contentVersion: 1,
    title: "Private invented assignment",
    goalAtStart: "everyday",
    response: "Previously saved synthetic response.",
    revision: 2,
    startedAt: new Date("2026-09-24T00:00:00Z"),
    savedAt: new Date("2026-09-24T00:01:00Z"),
    submittedAt: null,
    currentPublished: true,
    currentEligible: true,
  };
  const db = storage();
  const attempts = {
    list: vi.fn().mockResolvedValue([]),
    detail: vi.fn().mockResolvedValue(item),
    start: vi.fn().mockResolvedValue(id),
    save: vi.fn().mockResolvedValue(false),
    submit: vi.fn().mockResolvedValue(false),
    revise: vi.fn().mockResolvedValue(false),
    remove: vi.fn().mockResolvedValue(false),
    saveReflection: vi.fn().mockResolvedValue(false),
    deleteReflection: vi.fn().mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const post = (action: string, fields: Record<string, string>) =>
    agent
      .post(`/assignments/attempts/${id}/${action}`)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  const draft = {
    revision: "2",
    response: "A newer <private> response that must remain copyable.",
    sample_confirmed: "yes",
  };
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    revision: 3,
  });
  const stale = await post("save", draft).expect(409);
  expect(stale.text).toContain("Another tab saved a newer revision");
  expect(stale.text).toContain("A newer &lt;private&gt; response");
  expect(stale.text).toContain("Unsaved response to copy");
  expect(stale.text).not.toContain('name="response"');
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    currentEligible: false,
  });
  const ineligible = await post("save", draft).expect(409);
  expect(ineligible.text).toContain("learning direction changed");
  expect(ineligible.text).toContain("A newer &lt;private&gt; response");
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
  });
  expect((await post("save", draft).expect(409)).text).toContain(
    "already submitted",
  );
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(item);
  expect((await post("save", draft).expect(409)).text).toContain(
    "could not be changed",
  );
  attempts.detail.mockResolvedValueOnce({ ...item, response: "short" });
  expect(
    (
      await post("submit", {
        revision: "2",
        confirm: "yes",
        response_snapshot: "short",
      }).expect(422)
    ).text,
  ).toContain("Save at least 20 characters");
  attempts.detail.mockResolvedValue(item);
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    submittedAt: new Date("2026-09-24T00:02:00Z"),
  });
  expect(
    (
      await post("submit", {
        revision: "2",
        confirm: "yes",
        response_snapshot: item.response,
      }).expect(409)
    ).text,
  ).toContain("already submitted locally");
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    currentEligible: false,
  });
  expect(
    (
      await post("submit", {
        revision: "2",
        confirm: "yes",
        response_snapshot: item.response,
      }).expect(409)
    ).text,
  ).toContain("learning direction changed");
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce({
    ...item,
    revision: 3,
  });
  expect(
    (
      await post("submit", {
        revision: "2",
        confirm: "yes",
        response_snapshot: item.response,
      }).expect(409)
    ).text,
  ).toContain("Another tab saved a newer revision");
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(item);
  expect(
    (
      await post("submit", {
        revision: "2",
        confirm: "yes",
        response_snapshot: item.response,
      }).expect(409)
    ).text,
  ).toContain("Save at least 20 characters");
  attempts.submit.mockRejectedValueOnce(new Error("private storage secret"));
  const unknownSubmit = await post("submit", {
    revision: "2",
    confirm: "yes",
    response_snapshot: item.response,
  }).expect(503);
  expect(unknownSubmit.text).toContain("Submission outcome unknown");
  expect(unknownSubmit.text).toContain(item.response);
  expect(unknownSubmit.text).not.toContain("private storage secret");
  expect(unknownSubmit.text).not.toContain("Submit saved version locally");
  db.session.mockResolvedValueOnce({ kind: "expired" });
  const expired = await post("save", draft).expect(401);
  expect(expired.text).toContain("Session expired");
  expect(expired.text).toContain("A newer &lt;private&gt; response");
  db.session.mockResolvedValueOnce({ kind: "new" });
  const unknownSession = await agent
    .post(`/assignments/attempts/${id}/submit`)
    .set("Host", host)
    .set("Origin", origin)
    .set("x-csrf-token", csrf)
    .expect(401);
  expect(unknownSession.text).toContain("Session unavailable");
  expect(unknownSession.text).not.toContain("Private invented assignment");
  const invalidForm = await post("save", { ...draft, csrf: "invalid" }).expect(
    403,
  );
  expect(invalidForm.text).toContain("Form needs a refresh");
  expect(invalidForm.text).toContain("A newer &lt;private&gt; response");
});

it("keeps assignment self-reflection saves, deletion and recovery tied to an owned submitted version", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const item = {
    id,
    contentId: "SYN-REF-UNIT",
    contentVersion: 1,
    title: "Invented reflection assignment",
    rubric: "Original rubric",
    rubricVersion: 1,
    goalAtStart: "everyday",
    response: "Draft",
    revision: 2,
    startedAt: new Date("2026-09-30T00:00:00Z"),
    savedAt: null,
    submittedAt: new Date("2026-09-30T00:01:00Z"),
    currentPublished: true,
    currentEligible: true,
    submissions: [
      {
        sequence: 1,
        response: "Submitted response",
        submittedAt: "2026-09-30T00:01:00Z",
        reflection: null,
        reflectionRevision: 0,
      },
    ],
  };
  const db = storage();
  const attempts = {
    ...disabledAttemptStore(),
    detail: vi.fn().mockResolvedValue(item),
    saveReflection: vi.fn().mockResolvedValue(false),
    deleteReflection: vi.fn().mockResolvedValue(false),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const path = `/assignments/attempts/${id}/reflections/1`;
  const values = {
    evidence: "Attempted <private> evidence",
    gaps: "Unknown",
    intention: "Verify again",
  };
  const post = (action: string, fields: Record<string, string>) =>
    agent
      .post(`${path}/${action}`)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  const save = { ...values, reflection_revision: "0", sample_confirmed: "yes" };
  await post("save", { ...save, evidence: "", gaps: "", intention: "" }).expect(
    422,
  );
  await post("save", {
    reflection_revision: "0",
    sample_confirmed: "yes",
  }).expect(422);
  await post("save", { ...save, evidence: "x".repeat(1001) }).expect(422);
  await post("save", { ...save, sample_confirmed: "no" }).expect(422);
  await post("save", { ...save, reflection_revision: "-1" }).expect(422);
  await post("save", {
    ...save,
    reflection_revision: "999999999999999999999",
  }).expect(422);
  const badId = await agent
    .post("/assignments/attempts/invalid/reflections/1/save")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, ...save })
    .expect(404);
  expect(badId.text).not.toContain("Original rubric");
  await agent
    .post(`/assignments/attempts/${id}/reflections/11/save`)
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, ...save })
    .expect(404);
  attempts.detail.mockResolvedValueOnce(null);
  await post("save", save).expect(404);
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
  const unavailable = await post("save", save).expect(409);
  expect(unavailable.text).toContain("Attempted &lt;private&gt; evidence");
  expect(unavailable.text).not.toContain('name="reflection_revision"');
  const conflict = await post("save", save).expect(409);
  expect(conflict.text).toContain("Copy your attempted text");
  expect(conflict.text).toContain("Attempted &lt;private&gt; evidence");
  attempts.saveReflection.mockResolvedValueOnce(true);
  await post("save", save).expect(303);
  expect(attempts.saveReflection).toHaveBeenCalledWith(
    expect.any(String),
    id,
    1,
    0,
    values,
  );
  const invalidCsrf = await post("save", { ...save, csrf: "invalid" }).expect(
    403,
  );
  expect(invalidCsrf.text).toContain("Attempted &lt;private&gt; evidence");
  db.session.mockResolvedValueOnce({ kind: "expired" });
  const expired = await post("save", save).expect(401);
  expect(expired.text).toContain("Attempted &lt;private&gt; evidence");
  db.session.mockResolvedValueOnce({ kind: "new" });
  const unavailableSession = await post("save", save).expect(401);
  expect(unavailableSession.text).toContain("Session unavailable");
  attempts.saveReflection.mockRejectedValueOnce(
    new Error("secret storage failure"),
  );
  const uncertain = await post("save", save).expect(503);
  expect(uncertain.text).toContain("Reflection outcome unknown");
  expect(uncertain.text).toContain("Attempted &lt;private&gt; evidence");
  expect(uncertain.text).not.toContain("secret storage failure");
  await post("delete", { confirm: "no", reflection_revision: "1" }).expect(422);
  await post("delete", { confirm: "yes", reflection_revision: "0" }).expect(
    422,
  );
  await agent
    .post("/assignments/attempts/invalid/reflections/1/delete")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, confirm: "yes", reflection_revision: "1" })
    .expect(404);
  attempts.detail.mockResolvedValueOnce({ ...item, submissions: [] });
  await post("delete", { confirm: "yes", reflection_revision: "1" }).expect(
    404,
  );
  attempts.detail.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
  await post("delete", { confirm: "yes", reflection_revision: "1" }).expect(
    409,
  );
  await post("delete", { confirm: "yes", reflection_revision: "1" }).expect(
    409,
  );
  attempts.deleteReflection.mockResolvedValueOnce(true);
  await post("delete", { confirm: "yes", reflection_revision: "1" }).expect(
    303,
  );
  expect(attempts.deleteReflection).toHaveBeenCalledWith(
    expect.any(String),
    id,
    1,
    1,
  );
});

it("downloads only the selected simulated portfolio snapshot with safe attachment metadata", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const earlier = "Invented <private> first\nKeep this";
  const later = "Invented <private> second\nKeep this";
  const item = {
    id,
    contentId: "SYN-960",
    contentVersion: 1,
    title: "Invented <script> assignment",
    goalAtStart: "everyday",
    response: "unsubmitted draft must not enter comparison",
    revision: 4,
    startedAt: new Date("2026-09-24T00:00:00Z"),
    savedAt: new Date("2026-09-24T00:04:00Z"),
    submittedAt: null,
    submissionCount: 2,
    submissions: [
      { sequence: 1, response: earlier, submittedAt: "2026-09-24T00:01:00Z" },
      { sequence: 2, response: later, submittedAt: "2026-09-24T00:02:00Z" },
    ],
    currentPublished: false,
    currentEligible: false,
  };
  const db = storage();
  const attempts = {
    ...disabledAttemptStore(),
    detail: vi.fn().mockResolvedValue(item),
  };
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", attempts }),
  );
  await agent.get("/").set("Host", host).expect(200);
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const get = (sequence: string) =>
    agent
      .get(`/assignments/attempts/${id}/portfolio/${sequence}`)
      .set("Host", host);
  const result = await get("1").expect(200);
  expect(result.headers["content-type"]).toContain("text/html");
  expect(result.headers["content-disposition"]).toBe(
    'attachment; filename="simulated-portfolio-submission-1.html"',
  );
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.text).toContain("SIMULATED · SELF-AUTHORED · UNREVIEWED");
  expect(result.text).toContain("assignment version 1");
  expect(result.text).toContain("Invented &lt;script&gt; assignment");
  expect(result.text).not.toContain("<script>");
  expect(result.text).toContain("submission 1");
  expect(result.text).toContain("Invented &lt;private&gt; first");
  expect(result.text).not.toContain("Invented &lt;private&gt; second");
  expect(result.text).not.toContain(item.response);
  for (const sequence of ["0", "01", "11", "3", "1.html", "-1"])
    await get(sequence).expect(404);
  await agent
    .get("/assignments/attempts/invalid/portfolio/1")
    .set("Host", host)
    .expect(404);
  attempts.detail.mockResolvedValue(null);
  await get("1").expect(404);
  attempts.detail.mockResolvedValue({ ...item, submissions: undefined });
  await get("1").expect(404);
  attempts.detail.mockResolvedValue({
    ...item,
    submissions: [
      {
        sequence: 10,
        response: "<".repeat(4000) + "\r\n",
        submittedAt: "<time>",
      },
    ],
  });
  const bounded = await get("10").expect(200);
  expect(Buffer.byteLength(bounded.text)).toBeLessThan(30000);
  expect(bounded.text).toContain("&lt;time&gt;");
  expect(bounded.text).toContain("&#13;\n");
  expect(bounded.text).not.toContain("<time>");
});

it("renders live export page navigation and rechecks download cursors without leaking cursor referrers", async () => {
  const payload = {
    kind: "ready" as const,
    version: "local-member-records-v17" as const,
    profile: { id: "owned" },
    records: { milestones: [] },
    page: {
      number: 2,
      recordCount: 3,
      consistency: "live-pages" as const,
      complete: false,
      nextCursor: "signed-next",
    },
  };
  const memberExport = {
    exportOwned: vi
      .fn<MemberExportStore["exportOwned"]>()
      .mockResolvedValue({ kind: "ready", payload }),
  };
  const agent = await managedAgent(
    app(storage(), { origin, secret: "secret", memberExport }),
  );
  const html = await agent
    .get("/member/export?cursor=signed-current")
    .set("Host", host)
    .expect(200);
  expect(html.text).toContain("Download page 2");
  expect(html.text).toContain("Next page");
  expect(html.text).toContain("/api/member/export?cursor=signed-current");
  expect(html.headers["referrer-policy"]).toBe("no-referrer");
  expect(html.headers["cache-control"]).toBe("no-store");
  expect(memberExport.exportOwned).toHaveBeenLastCalledWith(
    expect.any(String),
    "signed-current",
  );
  const download = await agent
    .get("/api/member/export?cursor=signed-current")
    .set("Host", host)
    .expect(200);
  expect(download.headers["content-disposition"]).toContain(
    "deep-native-member-records-page-2.json",
  );
  expect(download.headers["referrer-policy"]).toBe("no-referrer");
  const calls = memberExport.exportOwned.mock.calls.length;
  await agent
    .get("/api/member/export?cursor=one&cursor=two")
    .set("Host", host)
    .expect(403);
  expect(memberExport.exportOwned).toHaveBeenCalledTimes(calls);
  for (const kind of ["denied", "limit", "unavailable"] as const) {
    memberExport.exportOwned.mockResolvedValueOnce({ kind });
    const error = await agent
      .get("/member/export")
      .set("Host", host)
      .expect(kind === "denied" ? 403 : kind === "limit" ? 413 : 503);
    expect(error.text).toContain("Export unavailable");
  }
});

it("keeps member sample-hold request parameters, receipts and uncertain outcomes private", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const slot = "22222222-2222-4222-8222-222222222222";
  const grant = "33333333-3333-4333-8333-333333333333";
  const receipt = {
    id,
    slotId: slot,
    domain: "education",
    serviceType: "coaching" as const,
    startsAt: new Date("2027-10-01T13:00:00Z"),
    endsAt: new Date("2027-10-01T14:00:00Z"),
    expiresAt: new Date("2027-09-01T13:10:00Z"),
    state: "held" as const,
    quantity: 60,
  };
  const holds = {
    snapshot: vi.fn<MemberSlotHolds["snapshot"]>().mockResolvedValue({
      grants: [{ id: grant, category: "coach_minutes" }],
      receipts: [receipt],
    }),
    get: vi.fn<MemberSlotHolds["get"]>().mockResolvedValue(receipt),
    request: vi.fn<MemberSlotHolds["request"]>().mockResolvedValue(id),
    withdraw: vi.fn<MemberSlotHolds["withdraw"]>().mockResolvedValue(id),
  };
  const db = storage();
  const availability = {
    ...disabledAvailabilityStore(),
    list: vi.fn<AvailabilityStore["list"]>().mockResolvedValue([
      { ...receipt, id: slot },
      { ...receipt, id: "55555555-5555-4555-8555-555555555555" },
    ]),
  };
  const agent = await managedAgent(
    app(db, {
      origin,
      secret: "secret",
      memberSlotHolds: holds,
      availability,
    }),
  );
  const home = await agent.get("/").set("Host", host);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const post = (fields: Record<string, unknown>) =>
    agent
      .post("/availability/holds")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  await agent.get(`/availability/holds/${id}`).set("Host", host).expect(303);
  expect(holds.get).not.toHaveBeenCalled();
  db.session.mockResolvedValue({
    kind: "active",
    learner: { ...member, timezone: "America/Toronto" },
  });
  const listing = await agent
    .get("/availability")
    .set("Host", host)
    .expect(200);
  expect(listing.text).toContain("Reserve sample hold");
  const formIds = [
    ...listing.text.matchAll(/name="requestId" value="([a-f0-9-]+)"/g),
  ].map((match) => match[1]);
  expect(formIds).toHaveLength(2);
  expect(new Set(formIds).size).toBe(2);
  availability.list.mockRejectedValueOnce(new Error("private slot failure"));
  const partial = await agent
    .get("/availability")
    .set("Host", host)
    .expect(503);
  expect(partial.text).toContain(`/availability/holds/${id}`);
  expect(partial.text).not.toContain("private slot failure");
  holds.snapshot.mockRejectedValueOnce(new SlotHoldFailure("unavailable"));
  const deniedSnapshot = await agent
    .get("/availability")
    .set("Host", host)
    .expect(403);
  expect(deniedSnapshot.text).toContain("Availability unavailable");
  for (const marker of [
    id,
    slot,
    grant,
    receipt.startsAt.toISOString(),
    "Sample hold receipt",
  ])
    expect(deniedSnapshot.text).not.toContain(marker);
  holds.snapshot.mockRejectedValueOnce(new SlotHoldFailure("uncertain"));
  await agent.get("/availability").set("Host", host).expect(503);

  expect(listing.text).toContain(`/availability/holds/${id}`);
  const fields = { slotId: slot, grantId: grant, requestId: id };
  expect((await post(fields).expect(303)).headers.location).toBe(
    `/availability/holds/${id}`,
  );
  expect(holds.request.mock.calls[0]!.slice(1)).toEqual([slot, grant, id]);
  expect(holds.request.mock.calls[0]![0]).not.toBe(member.id);
  for (const malformed of [
    { ...fields, memberId: "other" },
    { ...fields, deadline: "late" },
    { ...fields, slotId: [slot, slot] },
    { grantId: grant, requestId: id },
    { slotId: slot, requestId: id },
    { slotId: slot, grantId: grant },
  ])
    await post(malformed).expect(422);
  await post({ ...fields, csrf: "forged" }).expect(403);
  expect(holds.request).toHaveBeenCalledTimes(1);
  const shown = await agent
    .get(`/availability/holds/${id}`)
    .set("Host", host)
    .expect(200);
  expect(shown.text).toContain("SAMPLE HOLD — NOT A BOOKING");
  expect(shown.text).toContain("GMT-04:00");
  expect(shown.text).not.toContain(grant);
  holds.get.mockResolvedValueOnce(null);
  const missing = await agent
    .get(`/availability/holds/${id}`)
    .set("Host", host)
    .expect(404);
  expect(missing.text).toContain("does not confirm the outcome");
  holds.get.mockRejectedValueOnce(new Error("private database detail"));
  const unavailable = await agent
    .get(`/availability/holds/${id}`)
    .set("Host", host)
    .expect(503);
  expect(unavailable.text).not.toContain("private database detail");
  holds.request.mockRejectedValueOnce(new SlotHoldFailure("unavailable"));
  expect((await post(fields).expect(409)).text).toContain("No new sample hold");
  holds.request.mockRejectedValueOnce(new SlotHoldFailure("invalid_request"));
  expect(
    (await post({ ...fields, requestId: "bad" }).expect(409)).text,
  ).not.toContain("Inspect this request's receipt");
  for (const error of [
    new SlotHoldFailure("uncertain"),
    new Error("private detail"),
  ]) {
    holds.request.mockRejectedValueOnce(error);
    const unknown = await post(fields).expect(503);
    expect(unknown.text).toContain("Do not assume success or failure");
    expect(unknown.text).toContain(`/availability/holds/${id}`);
    expect(unknown.text).not.toContain("private detail");
    expect(
      (
        await agent
          .get(`/availability/holds/${id}`)
          .set("Host", host)
          .expect(200)
      ).text,
    ).toContain("held");
  }
  db.session.mockResolvedValue({ kind: "active", learner: member });
  await agent.get(`/availability/holds/${id}`).set("Host", host).expect(200);
  holds.snapshot.mockRejectedValueOnce(new Error("private detail"));
  expect(
    (await agent.get("/availability").set("Host", host).expect(503)).text,
  ).toContain("Inspect your receipts again");
  const withdraw = (extra: Record<string, unknown> = {}, target = id) =>
    agent
      .post(`/availability/holds/${target}/withdraw`)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...extra });
  expect(shown.text).toContain("Withdraw sample hold");
  expect((await withdraw().expect(303)).headers.location).toBe(
    `/availability/holds/${id}`,
  );
  expect(holds.withdraw.mock.calls[0]![1]).toBe(id);
  expect(holds.withdraw.mock.calls[0]![0]).not.toBe(member.id);
  for (const extra of [
    { memberId: "other" },
    { category: "coach_minutes" },
    { grantId: grant },
    { requestId: id },
  ])
    await withdraw(extra).expect(422);
  await withdraw({ csrf: "forged" }).expect(403);
  expect(holds.withdraw).toHaveBeenCalledTimes(1);
  holds.withdraw.mockRejectedValueOnce(new SlotHoldFailure("unavailable"));
  expect((await withdraw().expect(409)).text).toContain(
    "This withdrawal was not accepted",
  );
  holds.withdraw.mockRejectedValueOnce(new SlotHoldFailure("invalid_request"));
  expect((await withdraw({}, "bad").expect(409)).text).not.toContain(
    "Inspect this request's receipt",
  );
  for (const error of [
    new SlotHoldFailure("uncertain"),
    new Error("private withdrawal detail"),
  ]) {
    holds.withdraw.mockRejectedValueOnce(error);
    const unknown = await withdraw().expect(503);
    expect(unknown.text).toContain("Do not assume success or failure");
    expect(unknown.text).toContain(`/availability/holds/${id}`);
    expect(unknown.text).not.toContain("private withdrawal detail");
  }
  db.session.mockResolvedValue({ kind: "expired" });
  const writes = holds.withdraw.mock.calls.length;
  await withdraw().expect(303);
  expect(holds.withdraw).toHaveBeenCalledTimes(writes);
  await post(fields).expect(303);
});

it("requires exact retained goal identity and never offers another goal's editable form", async () => {
  const { agent } = await client();
  active();
  const rows: ExerciseHistory[] = [
    {
      lessonId: LESSON.id,
      version: 1,
      instruction: "Everyday invented record",
      verification: "Check sample",
      completedAt: new Date("2026-09-01"),
      withdrawnAt: null,
      goalAtStart: "everyday",
    },
    {
      lessonId: LESSON.id,
      version: 1,
      instruction: "Work invented record",
      verification: "Check sample",
      completedAt: null,
      withdrawnAt: null,
      goalAtStart: "work",
    },
    {
      lessonId: LESSON.id,
      version: 2,
      instruction: "Unattributed legacy record",
      verification: "Legacy check",
      completedAt: new Date("2026-09-01"),
      withdrawnAt: null,
      goalAtStart: null,
    },
  ];
  db.withExerciseRead = async (_token, render) => render(rows);
  for (const path of [
    "/lesson?goal=work",
    "/lesson?version=1&goal=bad",
    "/lesson?version=1&goal=work&goal=build",
    "/lesson?version=1",
    "/lesson?version=1&goal=build",
  ]) {
    expect((await agent.get(path).set("Host", host)).status).toBe(404);
  }
  for (const [version, goal, words] of [
    [1, "work", "Work invented record"],
    [2, "unattributed", "Unattributed legacy record"],
  ]) {
    const page = await agent
      .get(`/lesson?version=${version}&goal=${goal}`)
      .set("Host", host)
      .expect(200);
    expect(page.text).toContain(words);
    expect(page.text).not.toContain('action="/exercise"');
    expect(page.text).not.toContain("Everyday invented record");
  }
});
it("recovers without echoing answers after a transactional stale-goal or unavailable save", async () => {
  const { agent, csrf } = await client();
  active();
  for (const outcome of ["stale-goal", "unavailable"] as const) {
    db.save.mockResolvedValueOnce(outcome);
    const response = await agent
      .post("/exercise")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({
        csrf,
        lesson_id: LESSON.id,
        lesson_version: "1",
        goal: "everyday",
        intent: "draft",
        instruction: "Private attempted text",
      })
      .expect(409);
    expect(response.text).toContain("Exercise form out of date");
    expect(response.text).not.toContain("Private attempted text");
  }
  for (const goal of ["bad", ["work", "build"]]) {
    await agent
      .post("/exercise/clear-instructions/1/withdraw")
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, confirm: "yes", goal })
      .expect(422);
  }
});
it("withholds private lesson history consistently across every consumer and keeps storage failures distinct", async () => {
  const catalog = catalogMock();
  const item = {
    id: "SYN-105",
    version: 2,
    kind: "lesson" as const,
    origin: "curated" as const,
    title: "Private synthetic title",
    body: "Sample text",
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
  catalog.published.mockResolvedValue(item);
  const agent = await managedAgent(
    app(db, { origin, secret: "secret", catalog }),
  );
  const welcome = await agent.get("/").set("Host", host).expect(200);
  const csrf = welcome.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  active();
  db.lessonActivities.mockRejectedValue(new LessonActivityUnavailable());
  for (const path of ["/library", "/library/SYN-105", "/learn", "/progress"]) {
    const response = await agent.get(path).set("Host", host).expect(403);
    expect(response.text).toContain(
      path === "/progress"
        ? "Progress unavailable"
        : "Lesson history unavailable",
    );
    expect(response.text).not.toContain(item.title);
    expect(response.text).not.toContain(item.id);
  }
  for (const path of ["/assignments/select", "/profile"]) {
    const response = await agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf })
      .expect(403);
    expect(response.text).toContain("Lesson history unavailable");
  }
  expect(db.chooseAssignment).not.toHaveBeenCalled();
  expect(db.updateProfile).not.toHaveBeenCalled();
  db.lessonActivities.mockRejectedValue(
    new Error("Private synthetic database detail"),
  );
  const failed = await agent.get("/library").set("Host", host).expect(503);
  expect(failed.text).not.toContain("Private synthetic database detail");
  expect(failed.text).toContain("could not confirm");
});

it("mounts private support with member authentication and separate exact-granted operator authorization", async () => {
  const db = storage(),
    support = disabledSupportRequestStore();
  const history = vi.fn().mockResolvedValue({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  const worklist = vi.fn().mockResolvedValue({ kind: "denied" });
  const agent = await managedAgent(
    app(db, {
      origin,
      secret: "secret",
      supportRequests: {
        ...support,
        ownerHistory: history,
        operatorWorklist: worklist,
      },
    }),
  );
  await agent.get("/").set("Host", host).expect(200);
  await agent.get("/support/new").set("Host", host).expect(303);
  expect(history).not.toHaveBeenCalled();
  db.session.mockResolvedValue({ kind: "active", learner: member });
  const intake = await agent.get("/support/new").set("Host", host).expect(200);
  expect(intake.text).toContain("Send private sample request");
  await agent.get("/support").set("Host", host).expect(200);
  expect(history).toHaveBeenCalledOnce();
  const home = await agent.get("/learn").set("Host", host).expect(200);
  expect(home.text).toContain('href="/support"');
  db.session.mockResolvedValue({ kind: "new" });
  await agent.get("/operator/support").set("Host", host).expect(403);
  expect(worklist).toHaveBeenCalledOnce();
});
