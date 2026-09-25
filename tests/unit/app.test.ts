import { beforeEach, afterEach, it, expect, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
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
  disabledCatalogStore,
  type CatalogStore,
  type ContentVersion,
} from "../../src/catalog.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import {
  disabledProposalStore,
  type ProposalStore,
  type Proposal,
} from "../../src/proposals.ts";
import { CIRCLES, type CircleStore } from "../../src/circles.ts";
import { type MetricsStore } from "../../src/metrics.ts";
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const member = {
  id: "owned",
  background: "explorer" as const,
  goal: "everyday" as const,
};
const managedServers: Server[] = [];
it("denies an unconfigured operator metrics route and returns only a configured aggregate", async () => {
  const denied = managedAgent(app(storage(), { origin, secret: "secret" }));
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
      },
      counts: {
        members: 3,
        activated: 2,
        selfAssessed: 1,
        participated: 1,
        activeCircle: 0,
      },
    }),
  };
  const allowed = managedAgent(
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
  });
  expect(response.body.scope).toBe("synthetic-local-preview");
});
function managedAgent(application: ReturnType<typeof app>) {
  const server = application.listen(0);
  managedServers.push(server);
  return request.agent(server);
}
afterEach(async () => {
  await Promise.all(
    managedServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
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
  const sample: Proposal = {
    id: "sample-id",
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
    submit: vi.fn<ProposalStore["submit"]>().mockResolvedValue(false),
    withdraw: vi.fn<ProposalStore["withdraw"]>().mockResolvedValue(false),
    moderationQueue: vi
      .fn<ProposalStore["moderationQueue"]>()
      .mockResolvedValue(null),
    moderate: vi.fn<ProposalStore["moderate"]>().mockResolvedValue(false),
  };
  const agent = managedAgent(
    app(storage(), { origin, secret: "secret", proposals }),
  );
  const home = await agent.get("/").set("Host", host).expect(200);
  const csrf = home.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/contribute").set("Host", host).expect(303);
  await agent.get("/moderate/proposals").set("Host", host).expect(403);
  proposals.moderationQueue.mockResolvedValue([]);
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

  const memberAgent = managedAgent(
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
  await memberPost(`/contribute/${sample.id}/submit`, {}).expect(409);
  proposals.submit.mockResolvedValue(true);
  await memberPost(`/contribute/${sample.id}/submit`, {
    rights_confirmed: "yes",
  }).expect(303);
  await memberPost(`/contribute/${sample.id}/withdraw`, {}).expect(409);
  await memberPost(`/contribute/${sample.id}/withdraw`, {
    confirm: "yes",
  }).expect(409);
  proposals.withdraw.mockResolvedValue(true);
  await memberPost(`/contribute/${sample.id}/withdraw`, {
    confirm: "yes",
  }).expect(303);
});
it("shows honest track states and restricts the expert evidence roster", async () => {
  const tracks = disabledTrackStore();
  const server = app(storage(), { origin, secret: "secret", tracks });
  const publicView = await atStage(
    "GET /readiness/tracks public",
    request(server).get("/readiness/tracks").set("Host", host).expect(200),
  );
  expect(publicView.text).toContain("in preparation");
  expect(publicView.text).toContain("General learners");
  await atStage(
    "GET /operator/experts denied",
    request(server).get("/operator/experts").set("Host", host).expect(403),
  );
  const allowed = app(storage(), {
    origin,
    secret: "secret",
    tracks: { ...tracks, registry: async () => [] },
  });
  const roster = await atStage(
    "GET /operator/experts allowed",
    request(allowed).get("/operator/experts").set("Host", host).expect(200),
  );
  expect(roster.text).toContain("No expert commitments are recorded");
});
it("shows optional offer hypotheses while reporting foundation access as undecided", async () => {
  const agent = managedAgent(app(storage(), { origin, secret: "secret" }));
  const catalog = await agent
    .get("/api/offer-hypotheses")
    .set("Host", host)
    .expect(200);
  const planning = await agent
    .get("/readiness/offers")
    .set("Host", host)
    .expect(200);
  expect(catalog.body.foundation).toMatchObject({
    live: "pending-owner-decision",
    priceCents: null,
    participationLimit: null,
  });
  expect(catalog.body.coaching).toHaveLength(6);
  expect(
    catalog.body.coaching.every(
      (offer: { livePurchasable: boolean }) => offer.livePurchasable === false,
    ),
  ).toBe(true);
  expect(planning.text).toContain("NO LIVE PURCHASE");
  expect(planning.text).toContain("pending owner approval");
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
  return {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
    create: vi.fn<Store["create"]>().mockResolvedValue(undefined),
    updateProfile: vi.fn<Store["updateProfile"]>().mockResolvedValue(undefined),
    progress: vi.fn<Store["progress"]>().mockResolvedValue(undefined),
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
    save: vi.fn<Store["save"]>().mockResolvedValue(undefined),
    remove: vi.fn<Store["remove"]>().mockResolvedValue(undefined),
  };
}
function evidenceStorage() {
  return {
    ...disabledEvidenceStore(),
    upload: vi.fn<EvidenceStore["upload"]>().mockResolvedValue({
      kind: "denied",
    }),
    submitForReview: vi
      .fn<EvidenceStore["submitForReview"]>()
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
  const agent = managedAgent(app(db, { origin, secret: "secret", circles }));
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
  const agent = managedAgent(app(db, { origin, secret: "secret", evidence }));
  const response = await agent.get("/").set("Host", host).expect(200);
  const csrf = response.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  return { agent, csrf };
}
function active() {
  db.session.mockResolvedValue({ kind: "active", learner: member });
}
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
  const agent = managedAgent(app(db, { origin, secret: "s" }));
  const res = await agent.get("/readiness").set("Host", host).expect(200);
  expect(res.text).toContain("DEMO ENVIRONMENT");
  expect(res.text).toMatch(/<strong>ai<\/strong> · simulated/);
  expect(res.text).toMatch(/<strong>payment<\/strong> · simulated/);
  expect(res.text).toContain("no external side effect occurs");
  expect(res.text).not.toContain("configured");
});
it("serves concurrent requests through one test agent without transport failures", async () => {
  const server = app(db, { origin, secret: "secret" }).listen(0);
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
  const agent = managedAgent(
    app(db, { origin, secret: "secret", authorization }),
  );
  await agent.get("/").set("Host", host).expect(200);
  await agent
    .get("/api/workspaces/other/private?purpose=ticket")
    .set("Host", host)
    .expect(403, { error: "forbidden" });
  await agent
    .get("/api/workspaces/owned/private")
    .set("Host", host)
    .expect(200)
    .expect((response) => expect(response.body.via).toBe("member"));
  expect(authorization.readWorkspace).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/^[a-f0-9]{64}$/),
    "other",
    "ticket",
  );
  await agent
    .get("/api/cohorts/group/content/other")
    .set("Host", host)
    .expect(403, { error: "forbidden" });
  await agent
    .get("/api/cohorts/group/content/guide")
    .set("Host", host)
    .expect(200)
    .expect((response) => expect(response.body.body).toBe("Shared guide"));
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
  const agent = managedAgent(app(db, { origin, secret: "secret", catalog }));
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
  const agent = managedAgent(app(db, { origin, secret: "secret", catalog }));
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
  const agent = managedAgent(app(db, { origin, secret: "secret", catalog }));
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
  const agent = managedAgent(app(db, { origin, secret: "secret", catalog }));
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
  await agent.get("/editor/library").set("Host", host).expect(200);
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
  catalog.createDraft.mockResolvedValueOnce(true);
  await post("/editor/library", fields).expect(303);
  expect(catalog.createDraft).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ id: "SYN-001", version: 1, origin: "curated" }),
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
it("does not expose the staff workflow page to a member", async () => {
  const catalog = catalogMock();
  const server = app(db, { origin, secret: "secret", catalog }).listen(0);
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
it("lets an active member revise their direction without selecting another owner", async () => {
  const { agent, csrf } = await client();
  active();
  await agent
    .post("/profile")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, background: "explorer", goal: "admin" })
    .expect(422)
    .expect(/Choose valid profile, time zone and weekly time options/);
  expect(db.updateProfile).not.toHaveBeenCalled();
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
    }),
  );
});
it.each(["/learn", "/lesson", "/exercise", "/profile", "/delete"])(
  "sends unauthenticated visitors away from %s",
  async (path) => {
    await request(app(db, { origin, secret: "s" }))
      .get(path)
      .set("Host", host)
      .expect(303)
      .expect("Location", "/");
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
    .send({ csrf, intent: "complete", instruction: "short" })
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
it("rejects unrecognized Host and cross-origin, missing-origin or invalid-CSRF writes", async () => {
  await atStage(
    "GET / unrecognized Host",
    request(app(db, { origin, secret: "s" }))
      .get("/")
      .set("Host", "attacker.invalid")
      .expect(403),
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
  db.save.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await agent
    .post("/exercise")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf, intent: "draft" })
    .expect(503);
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
  const agent = managedAgent(app(db, { origin, secret: "secret", catalog }));
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
  db.createMilestone.mockResolvedValueOnce(null).mockResolvedValueOnce(id);
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
    remove: vi.fn().mockResolvedValue(false),
  };
  const agent = managedAgent(app(db, { origin, secret: "secret", attempts }));
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
  await post("/assignments/attempts/invalid/delete", { confirm: "yes" }).expect(
    409,
  );
  await post(`/assignments/attempts/${id}/delete`, {}).expect(409);
  await post(`/assignments/attempts/${id}/delete`, { confirm: "yes" }).expect(
    409,
  );
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
    remove: vi.fn().mockResolvedValue(false),
  };
  const agent = managedAgent(app(db, { origin, secret: "secret", attempts }));
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
