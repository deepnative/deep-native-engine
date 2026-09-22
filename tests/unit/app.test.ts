import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const member = {
  id: "owned",
  background: "explorer" as const,
  goal: "everyday" as const,
};
function storage() {
  return {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
    create: vi.fn<Store["create"]>().mockResolvedValue(undefined),
    progress: vi.fn<Store["progress"]>().mockResolvedValue(undefined),
    save: vi.fn<Store["save"]>().mockResolvedValue(undefined),
    remove: vi.fn<Store["remove"]>().mockResolvedValue(undefined),
  };
}
let db: ReturnType<typeof storage>;
beforeEach(() => {
  db = storage();
});
async function client() {
  const agent = request.agent(app(db, { origin, secret: "secret" }));
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
    { background: "explorer", goal: "everyday" },
  );
  active();
  await agent
    .get("/")
    .set("Host", host)
    .expect(303)
    .expect("Location", "/learn");
});
it.each(["/learn", "/lesson", "/exercise", "/delete"])(
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
  const { agent, csrf } = await client();
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
  expect(String(deleted.headers["set-cookie"])).toContain(
    "Expires=Thu, 01 Jan 1970",
  );
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
