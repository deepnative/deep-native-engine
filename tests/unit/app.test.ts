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
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const member = {
  id: "owned",
  background: "explorer" as const,
  goal: "everyday" as const,
};
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
    .expect(/Choose valid profile options/);
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
