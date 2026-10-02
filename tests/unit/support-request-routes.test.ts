import { expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountSupportRequestRoutes } from "../../src/support-request-routes.ts";
import {
  disabledSupportRequestStore,
  type SupportMemberDetail,
  type SupportOperatorDetail,
  type SupportRequestStore,
} from "../../src/support-requests.ts";
import { withLoopback } from "../support/loopback-server.ts";
const token = "a".repeat(64),
  id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  grantId = "33333333-3333-4333-8333-333333333333";
const date = new Date("2026-10-02T12:00:00Z");
const receipt = {
  requestId: id,
  receivedAt: date,
  acknowledgedAt: null,
  resolvedAt: null,
  withdrawnAt: null,
  coverageState: "unverified" as const,
};
const member: SupportMemberDetail = {
  ...receipt,
  subject: "Synthetic subject",
  body: "Sample body",
  replies: { items: [], nextCursor: null },
};
const operator: SupportOperatorDetail = {
  ...member,
  body: member.body!,
  grantId,
  messages: { items: [], nextCursor: null },
};
const mutation = {
  requestId: id,
  eventId: key,
  occurredAt: date,
  messageId: null,
};
const intake = {
  csrf: "csrf",
  idempotencyKey: key,
  subject: "  Synthetic <subject> ",
  body: "\nSample <body>\n",
  synthetic: "yes",
};
const transition = {
  csrf: "csrf",
  grantId,
  idempotencyKey: key,
  confirm: "yes",
};
const operatorHref = `/operator/support/${id}?grant=${grantId}`;
const actions = [
  ["acknowledge", "acknowledge"],
  ["replies", "reply"],
  ["notes", "note"],
  ["resolve", "resolve"],
] as const;
function fixture() {
  const store = {
    ...disabledSupportRequestStore(),
    create: vi
      .fn<SupportRequestStore["create"]>()
      .mockResolvedValue({ kind: "created", receipt }),
    receipt: vi
      .fn<SupportRequestStore["receipt"]>()
      .mockResolvedValue({ kind: "found", receipt }),
    ownerHistory: vi
      .fn<SupportRequestStore["ownerHistory"]>()
      .mockResolvedValue({
        kind: "ready",
        value: { items: [member], nextCursor: null },
      }),
    memberDetail: vi
      .fn<SupportRequestStore["memberDetail"]>()
      .mockResolvedValue({ kind: "ready", value: member }),
    operatorWorklist: vi
      .fn<SupportRequestStore["operatorWorklist"]>()
      .mockResolvedValue({
        kind: "ready",
        value: { items: [operator], nextCursor: null },
      }),
    operatorDetail: vi
      .fn<SupportRequestStore["operatorDetail"]>()
      .mockResolvedValue({ kind: "ready", value: operator }),
    acknowledge: vi
      .fn<SupportRequestStore["acknowledge"]>()
      .mockResolvedValue({ kind: "applied", receipt: mutation }),
    reply: vi
      .fn<SupportRequestStore["reply"]>()
      .mockResolvedValue({ kind: "applied", receipt: mutation }),
    note: vi
      .fn<SupportRequestStore["note"]>()
      .mockResolvedValue({ kind: "applied", receipt: mutation }),
    resolve: vi
      .fn<SupportRequestStore["resolve"]>()
      .mockResolvedValue({ kind: "applied", receipt: mutation }),
    withdraw: vi
      .fn<SupportRequestStore["withdraw"]>()
      .mockResolvedValue({ kind: "withdrawn" }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  // This isolated route test injects the host middleware's trusted locals.
  // Actual cookie/CSRF/member authorization is exercised through the mounted app.
  app.use((_req, res, next) => {
    res.locals.token = token;
    res.locals.csrf = "csrf";
    next();
  });
  mountSupportRequestRoutes(app, store);
  const get = (path: string) =>
    withLoopback(app, (server) => request(server).get(path));
  const post = (path: string, body?: Record<string, unknown>) =>
    withLoopback(app, (server) => {
      const req = request(server).post(path);
      return body === undefined ? req : req.type("form").send(body);
    });
  return { store, get, post };
}
it("offers a fresh private intake without creating data and honors only bounded owner navigation", async () => {
  const f = fixture(),
    fresh = await f.get("/support/new");
  expect(fresh.status).toBe(200);
  expect(fresh.text).toMatch(/name="idempotencyKey" value="[a-f0-9-]{36}"/);
  expect(f.store.create).not.toHaveBeenCalled();
  expect((await f.get("/support?after=opaque%2Bcursor")).status).toBe(200);
  expect(f.store.ownerHistory).toHaveBeenCalledWith(token, "opaque+cursor");
  expect((await f.get(`/support/${id}?after=reply-cursor`)).status).toBe(200);
  expect(f.store.memberDetail).toHaveBeenCalledWith(token, id, "reply-cursor");
});
it.each([
  "/support/new?actor=forged",
  "/support?after=a&after=b",
  "/support?memberId=forged",
  "/support/invalid",
  `/support/${id}?grant=forged`,
  "/support/receipts/bad",
  `/support/receipts/${key}?member=forged`,
  "/operator/support?actor=x",
  `/operator/support/${id}?grant=${grantId}&grant=${grantId}`,
  `/operator/support/${id}?grant=${grantId}&member=x`,
  `/operator/support/bad?grant=${grantId}`,
  `/operator/support/${id}?grant=bad`,
])("rejects malformed or forged read scope: %s", async (path) => {
  const f = fixture();
  expect((await f.get(path)).status).toBe(400);
  for (const method of [
    f.store.ownerHistory,
    f.store.memberDetail,
    f.store.receipt,
    f.store.operatorWorklist,
    f.store.operatorDetail,
  ])
    expect(method).not.toHaveBeenCalled();
});
it.each(["created", "replayed"] as const)(
  "redirects an intake %s to its durable receipt, preserving exact accepted text",
  async (kind) => {
    const f = fixture();
    f.store.create.mockResolvedValue({ kind, receipt });
    const response = await f.post("/support", intake);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`/support/${id}`);
    expect(f.store.create).toHaveBeenCalledExactlyOnceWith(token, {
      idempotencyKey: key,
      subject: intake.subject,
      body: intake.body,
    });
  },
);
it.each([
  ["extra actor", { ...intake, actor: "staff" }],
  ["nonstring subject", { ...intake, subject: ["a", "b"] }],
  ["nonstring body", { ...intake, body: ["a", "b"] }],
  ["missing CSRF", { ...intake, csrf: undefined }],
  ["bad key", { ...intake, idempotencyKey: "bad" }],
  ["missing confirmation", { ...intake, synthetic: undefined }],
  ["blank subject", { ...intake, subject: " \n" }],
  ["long subject", { ...intake, subject: "a".repeat(121) }],
  ["blank body", { ...intake, body: " \n" }],
  ["long body", { ...intake, body: "a".repeat(2001) }],
  ["body NUL", { ...intake, body: "sample\0" }],
] as const)(
  "rejects %s without a write and escapes attempted text",
  async (_name, body) => {
    const f = fixture(),
      response = await f.post("/support", body);
    expect(response.status).toBe(422);
    expect(response.text).toContain("Correct the request before sending");
    expect(response.text).not.toContain("<subject>");
    expect(response.text).not.toContain("Sample <body>");
    expect(f.store.create).not.toHaveBeenCalled();
  },
);
it("rejects bodyless and query-injected intake without writes", async () => {
  const f = fixture();
  expect((await f.post("/support")).status).toBe(422);
  expect((await f.post("/support?owner=forged", intake)).status).toBe(422);
  expect(f.store.create).not.toHaveBeenCalled();
});
it.each(["subject", "body", "idempotencyKey"] as const)(
  "preserves its original key on domain validation of %s",
  async (field) => {
    const f = fixture();
    f.store.create.mockResolvedValue({ kind: "invalid", field });
    const response = await f.post("/support", intake);
    expect(response.status).toBe(422);
    expect(response.text).toContain(`name="idempotencyKey" value="${key}"`);
    expect(response.text).toContain(
      `href="#${field === "idempotencyKey" ? "support-form" : field}"`,
    );
  },
);
it.each(["unavailable", "conflict", "withdrawn", "throw"] as const)(
  "keeps an intake %s recoverable through a read-only original-key lookup",
  async (kind) => {
    const f = fixture();
    if (kind === "throw")
      f.store.create.mockRejectedValue(new Error("PRIVATE DATABASE"));
    else f.store.create.mockResolvedValue({ kind });
    const response = await f.post("/support", intake);
    expect(response.status).toBe(
      kind === "unavailable" || kind === "throw" ? 503 : 409,
    );
    expect(response.text).toContain(`/support/receipts/${key}`);
    expect(response.text).toContain("Synthetic &lt;subject&gt;");
    expect(response.text).not.toContain("<form");
    expect(response.text).not.toContain("PRIVATE DATABASE");
    expect(f.store.create).toHaveBeenCalledTimes(1);
  },
);
it("does not echo attempted intake text after session denial", async () => {
  const f = fixture();
  f.store.create.mockResolvedValue({ kind: "denied" });
  const response = await f.post("/support", intake);
  expect(response.status).toBe(403);
  expect(response.text).not.toContain("Synthetic");
});
it("recovers an exact intake receipt without resubmitting and distinguishes known absence", async () => {
  const f = fixture();
  const found = await f.get(`/support/receipts/${key}`);
  expect(found.status).toBe(303);
  expect(found.headers.location).toBe(`/support/${id}`);
  expect(f.store.receipt).toHaveBeenCalledWith(token, key);
  f.store.receipt.mockResolvedValue({ kind: "missing" });
  const missing = await f.get(`/support/receipts/${key}`);
  expect(missing.status).toBe(404);
  expect(missing.text).toContain("Nothing was submitted by this lookup");
  expect(f.store.create).not.toHaveBeenCalled();
});
it.each([
  ["/support", "ownerHistory"],
  [`/support/${id}`, "memberDetail"],
  [`/support/receipts/${key}`, "receipt"],
  ["/operator/support", "operatorWorklist"],
  [operatorHref, "operatorDetail"],
] as const)(
  "fails closed without leaking backend details on %s",
  async (path, method) => {
    const f = fixture();
    for (const kind of ["denied", "unavailable"] as const) {
      f.store[method].mockResolvedValue({ kind });
      const response = await f.get(path);
      expect(response.status).toBe(kind === "denied" ? 403 : 503);
      expect(response.text).not.toContain("Synthetic subject");
    }
    f.store[method].mockRejectedValue(new Error("PRIVATE DATABASE"));
    const failure = await f.get(path);
    expect(failure.status).toBe(503);
    expect(failure.text).not.toContain("PRIVATE DATABASE");
    expect(failure.text).toContain("Nothing is retried automatically");
  },
);
it.each(["withdrawn", "already-withdrawn"] as const)(
  "returns the owner to the text-free receipt after %s",
  async (kind) => {
    const f = fixture();
    f.store.withdraw.mockResolvedValue({ kind });
    const response = await f.post(`/support/${id}/withdraw`, {
      csrf: "csrf",
      confirm: "yes",
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`/support/${id}`);
    expect(f.store.withdraw).toHaveBeenCalledWith(token, id);
  },
);
it.each([
  [id, undefined, ""],
  ["bad", { csrf: "csrf", confirm: "yes" }, ""],
  [id, { csrf: "csrf", confirm: "no" }, ""],
  [id, { confirm: "yes" }, ""],
  [id, { csrf: "csrf", confirm: "yes", actor: "x" }, ""],
  [id, { csrf: "csrf", confirm: "yes" }, "?grant=x"],
] as const)(
  "rejects invalid withdrawal %s %j %s",
  async (requestId, body, query) => {
    const f = fixture();
    expect(
      (await f.post(`/support/${requestId}/withdraw${query}`, body)).status,
    ).toBe(422);
    expect(f.store.withdraw).not.toHaveBeenCalled();
  },
);
it.each(["denied", "unavailable"] as const)(
  "handles %s withdrawal without implying success",
  async (kind) => {
    const f = fixture();
    f.store.withdraw.mockResolvedValue({ kind });
    expect(
      (
        await f.post(`/support/${id}/withdraw`, {
          csrf: "csrf",
          confirm: "yes",
        })
      ).status,
    ).toBe(kind === "denied" ? 403 : 503);
  },
);
it("forwards only authenticated session and exact grant to operator reads", async () => {
  const f = fixture();
  expect((await f.get("/operator/support?after=list-cursor")).status).toBe(200);
  expect(f.store.operatorWorklist).toHaveBeenCalledWith(token, "list-cursor");
  expect((await f.get(`${operatorHref}&after=message-cursor`)).status).toBe(
    200,
  );
  expect(f.store.operatorDetail).toHaveBeenCalledWith(
    token,
    { requestId: id, grantId },
    "message-cursor",
  );
  f.store.operatorDetail.mockResolvedValue({ kind: "withdrawn" });
  expect((await f.get(operatorHref)).status).toBe(410);
});
it.each(actions)(
  "makes %s a separate exact-granted transition and replays only its receipt",
  async (path, method) => {
    const f = fixture(),
      message = method === "reply" || method === "note",
      body = {
        ...transition,
        ...(message ? { body: "  <sample message>\n" } : {}),
      };
    for (const kind of ["applied", "replayed"] as const) {
      f.store[method].mockResolvedValue({ kind, receipt: mutation });
      const response = await f.post(`/operator/support/${id}/${path}`, body);
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe(operatorHref);
    }
    const expected = [
      token,
      { requestId: id, grantId },
      key,
      ...(message ? [body.body] : []),
    ];
    expect(f.store[method]).toHaveBeenLastCalledWith(...expected);
    expect(f.store.operatorDetail).not.toHaveBeenCalled();
  },
);
it.each(actions)(
  "rejects malformed %s forms, bodies and injected scope without a store mutation",
  async (path, method) => {
    const f = fixture(),
      message = method === "reply" || method === "note",
      body = { ...transition, ...(message ? { body: "Sample message" } : {}) };
    const invalid = [
      undefined,
      { ...body, actor: "forged" },
      { ...body, csrf: undefined },
      { ...body, grantId: "bad" },
      { ...body, idempotencyKey: "bad" },
      { ...body, confirm: "no" },
      { ...body, ...(message ? { body: undefined } : { body: "unwanted" }) },
      { ...body, grantId: [grantId, grantId] },
    ];
    for (const fields of invalid)
      expect(
        (await f.post(`/operator/support/${id}/${path}`, fields)).status,
      ).toBe(422);
    expect((await f.post(`/operator/support/bad/${path}`, body)).status).toBe(
      422,
    );
    expect(
      (await f.post(`/operator/support/${id}/${path}?grant=${grantId}`, body))
        .status,
    ).toBe(422);
    expect(f.store[method]).not.toHaveBeenCalled();
  },
);
it.each(actions)(
  "does not expose attempted %s text for denied, terminal, conflicting or unavailable transitions",
  async (path, method) => {
    const f = fixture(),
      body = {
        ...transition,
        ...(method === "reply" || method === "note"
          ? { body: "ATTEMPTED PRIVATE TEXT" }
          : {}),
      };
    for (const [kind, status] of [
      ["denied", 403],
      ["withdrawn", 410],
      ["conflict", 409],
      ["unavailable", 503],
    ] as const) {
      f.store[method].mockResolvedValue({ kind });
      const response = await f.post(`/operator/support/${id}/${path}`, body);
      expect(response.status).toBe(status);
      expect(response.text).not.toContain("ATTEMPTED PRIVATE TEXT");
      expect(response.text).not.toContain("<form");
    }
    f.store[method].mockRejectedValue(new Error("SECRET"));
    const failure = await f.post(`/operator/support/${id}/${path}`, body);
    expect(failure.status).toBe(503);
    expect(failure.text).not.toContain("SECRET");
  },
);
it.each([
  ["replies", "reply"],
  ["notes", "note"],
] as const)(
  "revalidates grant before rendering a safely entered %s correction with its same key",
  async (path, method) => {
    const f = fixture();
    f.store[method].mockResolvedValue({ kind: "invalid", field: "body" });
    const fields = { ...transition, body: " </textarea><script> " },
      response = await f.post(`/operator/support/${id}/${path}`, fields);
    expect(response.status).toBe(422);
    expect(response.text).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(response.text).not.toContain("<script>");
    expect(response.text).toContain(`href="#${method}-body"`);
    expect(response.text).toContain(`name="idempotencyKey" value="${key}"`);
    expect(f.store.operatorDetail).toHaveBeenCalledWith(token, {
      requestId: id,
      grantId,
    });
    for (const [kind, status] of [
      ["denied", 403],
      ["withdrawn", 410],
      ["unavailable", 503],
    ] as const) {
      f.store.operatorDetail.mockResolvedValue({ kind });
      const denied = await f.post(`/operator/support/${id}/${path}`, fields);
      expect(denied.status).toBe(status);
      expect(denied.text).not.toContain("script");
    }
    f.store.operatorDetail.mockResolvedValue({
      kind: "ready",
      value: { ...operator, resolvedAt: date },
    });
    expect(
      (await f.post(`/operator/support/${id}/${path}`, fields)).status,
    ).toBe(409);
  },
);
