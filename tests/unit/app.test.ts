import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
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
import { disabledCatalogStore, type CatalogStore } from "../../src/catalog.ts";
import { disabledTrackStore } from "../../src/track-readiness.ts";
import {
  disabledProposalStore,
  type ProposalStore,
  type Proposal,
} from "../../src/proposals.ts";
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const member = {
  id: "owned",
  background: "explorer" as const,
  goal: "everyday" as const,
};
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
  const agent = request.agent(
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

  const memberAgent = request.agent(
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
  const publicView = await request(server)
    .get("/readiness/tracks")
    .set("Host", host)
    .expect(200);
  expect(publicView.text).toContain("in preparation");
  expect(publicView.text).toContain("General learners");
  await request(server).get("/operator/experts").set("Host", host).expect(403);
  const allowed = app(storage(), {
    origin,
    secret: "secret",
    tracks: { ...tracks, registry: async () => [] },
  });
  const roster = await request(allowed)
    .get("/operator/experts")
    .set("Host", host)
    .expect(200);
  expect(roster.text).toContain("No expert commitments are recorded");
});
it("shows optional offer hypotheses while reporting foundation access as undecided", async () => {
  const server = app(storage(), { origin, secret: "secret" });
  const catalog = await request(server)
    .get("/api/offer-hypotheses")
    .set("Host", host)
    .expect(200);
  const planning = await request(server)
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
  await request(server).get("/checkout/pilot").set("Host", host).expect(404);
});
function storage() {
  return {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
    create: vi.fn<Store["create"]>().mockResolvedValue(undefined),
    updateProfile: vi.fn<Store["updateProfile"]>().mockResolvedValue(undefined),
    progress: vi.fn<Store["progress"]>().mockResolvedValue(undefined),
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
function catalogMock() {
  return {
    ...disabledCatalogStore(),
    createDraft: vi.fn<CatalogStore["createDraft"]>().mockResolvedValue(false),
    submit: vi.fn<CatalogStore["submit"]>().mockResolvedValue(false),
    approve: vi.fn<CatalogStore["approve"]>().mockResolvedValue(false),
    publish: vi.fn<CatalogStore["publish"]>().mockResolvedValue(false),
    retire: vi.fn<CatalogStore["retire"]>().mockResolvedValue(false),
    preview: vi.fn<CatalogStore["preview"]>().mockResolvedValue(null),
    staffList: vi.fn<CatalogStore["staffList"]>().mockResolvedValue([]),
    published: vi.fn<CatalogStore["published"]>().mockResolvedValue(null),
    search: vi.fn<CatalogStore["search"]>().mockResolvedValue([]),
  };
}
async function client(evidence?: EvidenceStore) {
  const agent = request.agent(app(db, { origin, secret: "secret", evidence }));
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
  const res = await request(app(db, { origin, secret: "s" }))
    .get("/readiness")
    .set("Host", host)
    .expect(200);
  expect(res.text).toContain("DEMO ENVIRONMENT");
  expect(res.text).toMatch(/<strong>ai<\/strong> · simulated/);
  expect(res.text).toMatch(/<strong>payment<\/strong> · simulated/);
  expect(res.text).toContain("no external side effect occurs");
  expect(res.text).not.toContain("configured");
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
  const agent = request.agent(
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
  const agent = request.agent(app(db, { origin, secret: "secret", catalog }));
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
it("supports the local editor/reviewer workflow without bypassing rejected transitions", async () => {
  const catalog = catalogMock();
  const agent = request.agent(app(db, { origin, secret: "secret", catalog }));
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
  await request(app(db, { origin, secret: "s" }))
    .get("/")
    .set("Host", "attacker.invalid")
    .expect(403);
  const { agent, csrf } = await client();
  for (const from of ["http://attacker.invalid", "null", ""]) {
    await agent
      .post("/start")
      .set("Host", host)
      .set("Origin", from)
      .type("form")
      .send({ csrf })
      .expect(403);
  }
  await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .type("form")
    .send({ csrf: "0".repeat(64) })
    .expect(403);
  await agent
    .post("/start")
    .set("Host", host)
    .set("Origin", origin)
    .set("Content-Type", "text/plain")
    .send("bad")
    .expect(403);
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
