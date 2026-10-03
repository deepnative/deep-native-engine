import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { registerCircleDiscussion } from "../../src/circle-discussion-routes.ts";
import { disabledCircleDiscussionStore } from "../../src/circle-discussion.ts";
import { withLoopback } from "../support/loopback-server.ts";
const key = "00000000-0000-4000-8000-000000000001",
  url = "/circles/everyday-ai/discussion";
function fixture() {
  const application = express(),
    store = disabledCircleDiscussionStore();
  application.use(express.urlencoded({ extended: false }));
  application.use((_req, res, next) => {
    res.locals.token = "invented-token";
    res.locals.csrf = "invented-csrf";
    next();
  });
  registerCircleDiscussion(application, store);
  return { application, store };
}
it("provides original-key reconciliation after an unconfirmed write without echoing submitted private text", async () => {
  const { application, store } = fixture();
  store.post = vi
    .fn()
    .mockRejectedValue(Error("Invented SQL details that must stay private"));
  await withLoopback(application, async (server) => {
    const response = await request(server)
      .post(url + "/posts")
      .type("form")
      .send({
        idempotencyKey: key,
        body: "Invented private input <script>escape</script>",
        confirm: "yes",
      })
      .expect(503);
    expect(response.text).toContain(
      `${url}/reconcile?kind=post&amp;key=${key}`,
    );
    expect(response.text).toContain("Check the original form key");
    expect(response.text).not.toContain("Invented private input");
    expect(response.text).not.toContain("Invented SQL details");
  });
});
it("renders an owned receipt and a truthful not-found result without implying a fresh submission is safe", async () => {
  const { application, store } = fixture();
  store.reconcile = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "ready",
      value: { found: true, id: key, status: "withdrawn", revision: 2 },
    })
    .mockResolvedValueOnce({
      kind: "ready",
      value: { found: false, id: null, status: null, revision: null },
    });
  await withLoopback(application, async (server) => {
    const receipt = await request(server)
      .get(`${url}/reconcile?kind=post&key=${key}`)
      .expect(200);
    expect(receipt.text).toContain("Original-key receipt");
    expect(receipt.text).toContain("withdrawn");
    expect(receipt.text).toContain("revision 2");
    expect(receipt.text).not.toContain("<textarea");
    expect(receipt.text).toContain(url + "/owned");
    const absent = await request(server)
      .get(`${url}/reconcile?kind=post&key=${key}`)
      .expect(200);
    expect(absent.text).toContain("No retained receipt was found");
    expect(absent.text).toContain(
      "This does not confirm whether an earlier request committed",
    );
    expect(store.reconcile).toHaveBeenCalledWith(
      "invented-token",
      "everyday-ai",
      "post",
      key,
    );
  });
});
it.each([
  [
    "/choice",
    "choice",
    {
      generation: "1",
      policyVersion: "circle-discussion-test-v1",
      confirm: "yes",
    },
  ],
  [`/posts/${key}/reports`, "report", { category: "privacy" }],
  [
    `/moderate/circles/everyday-ai/posts/${key}`,
    "moderation",
    { action: "hide", expectedRevision: "1", reason: "privacy" },
  ],
] as const)(
  "links the exact original key after %s uncertainty",
  async (path, kind, fields) => {
    const { application, store } = fixture();
    store.choose = vi.fn().mockRejectedValue(Error("invented fault"));
    store.report = vi.fn().mockRejectedValue(Error("invented fault"));
    store.moderate = vi.fn().mockRejectedValue(Error("invented fault"));
    await withLoopback(application, async (server) => {
      const response = await request(server)
        .post(path.startsWith("/moderate/") ? path : url + path)
        .type("form")
        .send({ ...fields, idempotencyKey: key })
        .expect(503);
      expect(response.text).toContain(`kind=${kind}&amp;key=${key}`);
      if (kind === "moderation")
        expect(response.text).toContain(
          "/moderate/circles/everyday-ai/reconcile",
        );
    });
  },
);
it("authorizes blank recovery forms and rejects array, unknown-field and role-mismatched queries before receipt lookup", async () => {
  const { application, store } = fixture();
  store.reconcile = vi.fn().mockResolvedValue({ kind: "denied" });
  await withLoopback(application, async (server) => {
    await request(server)
      .get(url + "/reconcile")
      .expect(403);
    await request(server)
      .get("/moderate/circles/everyday-ai/reconcile")
      .expect(403);
    expect(store.reconcile).toHaveBeenCalledTimes(2);
    for (const query of [
      `kind=post&key=${key}&extra=1`,
      `kind=post&key=${key}&key=${key}`,
      `kind=moderation&key=${key}`,
      `kind=post`,
      `key=${key}`,
      `kind=unknown&key=${key}`,
    ])
      await request(server)
        .get(url + "/reconcile?" + query)
        .expect(422);
    await request(server)
      .get(`/moderate/circles/everyday-ai/reconcile?kind=post&key=${key}`)
      .expect(422);
    expect(store.reconcile).toHaveBeenCalledTimes(2);
    store.reconcile = vi.fn().mockResolvedValue({
      kind: "ready",
      value: { found: false, id: null, status: null, revision: null },
    });
    const form = await request(server)
      .get(url + "/reconcile")
      .expect(200);
    expect(form.text).toContain('name="key"');
    expect(form.text).toContain('name="kind"');
    const mod = await request(server)
      .get("/moderate/circles/everyday-ai/reconcile")
      .expect(200);
    expect(mod.text).toContain('value="moderation"');
    expect(mod.text).toContain("Inspect current report worklist");
  });
});
it("omits invalid recovery keys and keeps receipt lookup failures generic", async () => {
  const { application, store } = fixture();
  store.post = vi.fn().mockRejectedValue(Error("Invented DB details"));
  store.reconcile = vi
    .fn()
    .mockRejectedValue(Error("Invented private receipt failure"));
  await withLoopback(application, async (server) => {
    const failure = await request(server)
      .post(url + "/posts")
      .type("form")
      .send({
        body: "Invented input",
        idempotencyKey: "<img src=x onerror=alert(1)>",
        confirm: "yes",
      })
      .expect(503);
    expect(failure.text).not.toContain("onerror");
    expect(failure.text).not.toContain("Check the original form key</a>");
    const receipt = await request(server)
      .get(`${url}/reconcile?kind=post&key=${key}`)
      .expect(503);
    expect(receipt.text).not.toContain("Invented private receipt failure");
  });
});
