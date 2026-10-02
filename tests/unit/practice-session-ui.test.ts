import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import type {
  PracticeSessionStore,
  PracticeSessionSource,
  PracticeSessionDetail,
} from "../../src/practice-sessions.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
import {
  practiceSessionStartPage,
  practiceSessionHistoryPage,
  practiceSessionPage,
} from "../../src/views.ts";

const origin = "http://127.0.0.1:3000",
  secret = "synthetic-practice-session";
const token = "a".repeat(64),
  sessionId = "11111111-1111-4111-8111-111111111111";
const source: PracticeSessionSource = {
  contentId: "SYN-840",
  contentVersion: 1,
  title: "Invented <lesson>",
  goal: "everyday",
  promptVersion: "practice-v1",
  prompt: "Use <invented> detail.",
  sourceExcerpt: "Check <source> only.",
};
const detail: PracticeSessionDetail = {
  id: sessionId,
  contentId: source.contentId,
  contentVersion: 1,
  goal: "everyday",
  promptVersion: "practice-v1",
  createdAt: new Date("2026-10-01T12:00:00Z"),
  withdrawnAt: null,
  title: source.title,
  prompt: source.prompt,
  availability: "available",
  exchanges: [],
  nextSequence: 1,
};
const startFields = {
  content_version: "1",
  goal: "everyday",
  prompt_version: "practice-v1",
  synthetic: "yes",
};
const appendFields = {
  expected_sequence: "1",
  response: "  Invented <answer>\n",
  synthetic: "yes",
};
function fixture() {
  const session = vi.fn<Store["session"]>().mockResolvedValue({
    kind: "active",
    learner: { id: "member", background: "explorer", goal: "everyday" },
  });
  const db = { session } as unknown as Store;
  const practiceSessions = {
    source: vi.fn<PracticeSessionStore["source"]>().mockResolvedValue(source),
    start: vi
      .fn<PracticeSessionStore["start"]>()
      .mockResolvedValue({ kind: "started", sessionId }),
    history: vi
      .fn<PracticeSessionStore["history"]>()
      .mockResolvedValue({ items: [], nextCursor: null }),
    detail: vi.fn<PracticeSessionStore["detail"]>().mockResolvedValue(detail),
    append: vi.fn<PracticeSessionStore["append"]>().mockResolvedValue("saved"),
    withdraw: vi
      .fn<PracticeSessionStore["withdraw"]>()
      .mockResolvedValue("withdrawn"),
  };
  const application = app(db, { origin, secret, practiceSessions });
  const get = (path: string) =>
    withLoopback(application, (server) =>
      request(server)
        .get(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const post = (
    path: string,
    fields: Record<string, unknown> = {},
    headerCsrf = false,
  ) =>
    withLoopback(application, (server) => {
      const r = request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`)
        .set("Origin", origin)
        .type("form");
      if (headerCsrf) r.set("x-csrf-token", csrf(token, secret));
      return r.send({ csrf: csrf(token, secret), ...fields });
    });
  return { db, session, practiceSessions, application, get, post };
}
it("requires active membership before reading, starting or changing practice sessions", async () => {
  const f = fixture();
  f.session.mockResolvedValue({ kind: "expired" });
  for (const path of [
    "/practice-sessions",
    `/practice-sessions/${sessionId}`,
    `/library/${source.contentId}/practice-session`,
  ])
    expect((await f.get(path)).status).toBe(303);
  for (const [path, fields] of [
    [`/practice-sessions/${sessionId}/responses`, appendFields],
    [`/practice-sessions/${sessionId}/withdraw`, { confirm: "yes" }],
    [`/library/${source.contentId}/practice-session/start`, startFields],
  ] as const)
    expect((await f.post(path, fields)).status).toBe(303);
  for (const fn of Object.values(f.practiceSessions))
    expect(fn).not.toHaveBeenCalled();
});
it.each([
  [
    "start",
    `/library/${source.contentId}/practice-session/start`,
    "Confirm sample practice",
  ],
  [
    "append",
    `/practice-sessions/${sessionId}/responses`,
    "Response not accepted",
  ],
  [
    "withdraw",
    `/practice-sessions/${sessionId}/withdraw`,
    "Confirm session withdrawal",
  ],
] as const)(
  "rejects a bodyless %s request even with authenticated header CSRF",
  async (_operation, path, heading) => {
    const f = fixture();
    const response = await withLoopback(f.application, (server) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`)
        .set("Origin", origin)
        .set("x-csrf-token", csrf(token, secret)),
    );
    expect(response.status).toBe(422);
    expect(response.text).toContain(`<h1>${heading}</h1>`);
    expect(response.text).toContain("Inspect private session history");
    expect(f.session).toHaveBeenCalledWith(token);
    expect(f.practiceSessions.start).not.toHaveBeenCalled();
    expect(f.practiceSessions.append).not.toHaveBeenCalled();
    expect(f.practiceSessions.withdraw).not.toHaveBeenCalled();
  },
);
it("offers exact-source opt-in without a write and starts or reopens the same returned session", async () => {
  const f = fixture();
  const preview = await f.get(`/library/${source.contentId}/practice-session`);
  expect(preview.status).toBe(200);
  expect(preview.text).toContain('name="goal" value="everyday"');
  expect(preview.text).toContain('name="prompt_version" value="practice-v1"');
  expect(preview.text).toContain("30 visible turns");
  expect(f.practiceSessions.start).not.toHaveBeenCalled();
  for (const kind of ["started", "replayed"] as const) {
    f.practiceSessions.start.mockResolvedValueOnce({ kind, sessionId });
    const r = await f.post(
      `/library/${source.contentId}/practice-session/start`,
      startFields,
    );
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`/practice-sessions/${sessionId}`);
  }
  expect(f.practiceSessions.start).toHaveBeenLastCalledWith(token, {
    contentId: source.contentId,
    contentVersion: 1,
    goal: "everyday",
    promptVersion: "practice-v1",
  });
  f.practiceSessions.source.mockResolvedValueOnce(null);
  expect(
    (await f.get(`/library/${source.contentId}/practice-session`)).status,
  ).toBe(404);
  for (const kind of ["unavailable", "withdrawn"] as const) {
    f.practiceSessions.start.mockResolvedValueOnce({ kind });
    const r = await f.post(
      `/library/${source.contentId}/practice-session/start`,
      startFields,
    );
    expect(r.status).toBe(409);
    expect(r.text).toContain("Inspect private session history");
  }
});
it("rejects missing consent, malformed pins and forged identity fields before start", async () => {
  const f = fixture();
  for (const changed of [
    { csrf: undefined },
    { memberId: "forged" },
    { sessionId: sessionId },
    { content_version: undefined },
    { content_version: ["1", "2"] },
    { content_version: "0" },
    { content_version: "1.2" },
    { content_version: "99999999999999999" },
    { content_version: "2147483648" },
    { goal: undefined },
    { goal: "__proto__" },
    { prompt_version: undefined },
    { prompt_version: "" },
    { prompt_version: "x".repeat(81) },
    { synthetic: "no" },
  ])
    expect(
      (
        await f.post(
          `/library/${source.contentId}/practice-session/start`,
          { ...startFields, ...changed },
          true,
        )
      ).status,
    ).toBe(422);
  expect(
    (
      await f.post(`/library/${source.contentId}/practice-session/start`, {
        ...startFields,
        csrf: "forged",
      })
    ).status,
  ).toBe(403);
  expect(f.practiceSessions.start).not.toHaveBeenCalled();
});
it("renders owner-only bounded history and rejects malformed or unavailable continuations", async () => {
  const f = fixture();
  expect((await f.get("/practice-sessions")).text).toContain(
    "No private sessions are saved yet",
  );
  f.practiceSessions.history.mockResolvedValueOnce({
    items: [detail],
    nextCursor: "safe.cursor",
  });
  const result = await f.get("/practice-sessions?after=previous");
  expect(result.status).toBe(200);
  expect(result.text).toContain('href="/practice-sessions?after=safe.cursor"');
  expect(f.practiceSessions.history).toHaveBeenLastCalledWith(
    token,
    "previous",
  );
  for (const suffix of ["?after=a&after=b", "?memberId=forged"])
    expect((await f.get(`/practice-sessions${suffix}`)).status).toBe(400);
  f.practiceSessions.history.mockResolvedValueOnce(null);
  expect((await f.get("/practice-sessions?after=wrong")).status).toBe(404);
  f.practiceSessions.detail.mockResolvedValueOnce(null);
  expect((await f.get(`/practice-sessions/${sessionId}`)).status).toBe(404);
  expect((await f.get(`/practice-sessions/${sessionId}`)).text).toContain(
    "No responses saved yet",
  );
});
it("preserves exact response bytes on accepted save/replay and refuses all non-success outcomes", async () => {
  const f = fixture();
  for (const outcome of ["saved", "replayed"] as const) {
    f.practiceSessions.append.mockResolvedValueOnce(outcome);
    const r = await f.post(
      `/practice-sessions/${sessionId}/responses`,
      appendFields,
    );
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`/practice-sessions/${sessionId}`);
  }
  expect(f.practiceSessions.append).toHaveBeenLastCalledWith(token, sessionId, {
    expectedSequence: 1,
    response: appendFields.response,
  });
  for (const outcome of [
    "conflict",
    "full",
    "withdrawn",
    "unavailable",
  ] as const) {
    f.practiceSessions.append.mockResolvedValueOnce(outcome);
    const r = await f.post(`/practice-sessions/${sessionId}/responses`, {
      ...appendFields,
      expected_sequence: "16",
    });
    expect(r.status).toBe(409);
    expect(r.text).toContain("no comparison is generated on this page");
  }
});
it("rejects invalid response forms and forged fields without invoking an append", async () => {
  const f = fixture();
  for (const changed of [
    { csrf: undefined },
    { memberId: "forged" },
    { sessionId },
    { expected_sequence: undefined },
    { expected_sequence: ["1", "2"] },
    { expected_sequence: "0" },
    { expected_sequence: "1.5" },
    { expected_sequence: "999999999999999999" },
    { expected_sequence: "17" },
    { response: undefined },
    { response: ["a", "b"] },
    { response: " \n " },
    { response: "a".repeat(1001) },
    { synthetic: "no" },
  ])
    expect(
      (
        await f.post(
          `/practice-sessions/${sessionId}/responses`,
          { ...appendFields, ...changed },
          true,
        )
      ).status,
    ).toBe(422);
  expect(
    (
      await f.post(`/practice-sessions/${sessionId}/responses`, {
        ...appendFields,
        csrf: "wrong",
      })
    ).status,
  ).toBe(403);
  expect(f.practiceSessions.append).not.toHaveBeenCalled();
});
it("requires withdrawal confirmation, refuses identity fields and makes replay harmless", async () => {
  const f = fixture();
  for (const changed of [
    { csrf: undefined },
    { confirm: "no" },
    { memberId: "forged" },
  ])
    expect(
      (
        await f.post(
          `/practice-sessions/${sessionId}/withdraw`,
          { confirm: "yes", ...changed },
          true,
        )
      ).status,
    ).toBe(422);
  expect(f.practiceSessions.withdraw).not.toHaveBeenCalled();
  for (const outcome of ["withdrawn", "already-withdrawn"] as const) {
    f.practiceSessions.withdraw.mockResolvedValueOnce(outcome);
    const r = await f.post(`/practice-sessions/${sessionId}/withdraw`, {
      confirm: "yes",
    });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`/practice-sessions/${sessionId}`);
  }
  f.practiceSessions.withdraw.mockResolvedValueOnce("unavailable");
  expect(
    (
      await f.post(`/practice-sessions/${sessionId}/withdraw`, {
        confirm: "yes",
      })
    ).status,
  ).toBe(404);
});
it("never reports a successful write or replays automatically after an uncertain storage result", async () => {
  const f = fixture();
  for (const [method, path, fields] of [
    [
      "start",
      `/library/${source.contentId}/practice-session/start`,
      startFields,
    ],
    ["append", `/practice-sessions/${sessionId}/responses`, appendFields],
    [
      "withdraw",
      `/practice-sessions/${sessionId}/withdraw`,
      { confirm: "yes" },
    ],
  ] as const) {
    f.practiceSessions[method].mockRejectedValueOnce(
      new Error("PRIVATE database credential"),
    );
    const r = await f.post(path, fields);
    expect(r.status).toBe(503);
    expect(r.text).toContain("could not confirm the result");
    expect(r.text).not.toContain("PRIVATE database credential");
    expect(f.practiceSessions[method]).toHaveBeenCalledTimes(1);
  }
});
it("disables session routes safely when storage is not configured", async () => {
  const f = fixture();
  const application = app(f.db, { origin, secret });
  const r = await withLoopback(application, (server) =>
    request(server)
      .get("/practice-sessions")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
  expect(r.status).toBe(404);
});
it("escapes source, response and stored comparisons while preserving ordering and read-only states", () => {
  const sourceHtml = practiceSessionStartPage(source, "csrf");
  expect(sourceHtml).toContain("Invented &lt;lesson&gt;");
  expect(sourceHtml).toContain("Check &lt;source&gt; only.");
  const pairs = [1, 2].map((sequence) => ({
    sequence,
    response: ` <response ${sequence}>\n`,
    comparison: `<comparison ${sequence}>`,
    sourceExcerpt: "<source>",
    acceptedAt: detail.createdAt,
  }));
  const html = practiceSessionPage(
    { ...detail, exchanges: pairs, nextSequence: 3 },
    "csrf",
  );
  expect(html.indexOf("&lt;response 1&gt;")).toBeLessThan(
    html.indexOf("&lt;response 2&gt;"),
  );
  expect(html).toContain("&lt;comparison 2&gt;");
  expect(html).toContain("2 of 15 saved pairs · 4 of 30 visible turns");
  expect(html).toContain('name="expected_sequence" value="3"');
  for (const availability of [
    "source-unavailable",
    "unknown-template",
    "full",
  ] as const) {
    const readonly = practiceSessionPage(
      {
        ...detail,
        availability,
        exchanges: pairs,
        nextSequence: null,
        prompt: null,
      },
      "csrf",
    );
    expect(readonly).not.toContain("Save response and compare");
    expect(readonly).toContain("&lt;response 1&gt;");
    expect(readonly).toContain("Withdraw session text");
  }
  expect(
    practiceSessionPage({ ...detail, nextSequence: null }, "csrf"),
  ).not.toContain("Save response and compare");
  const withdrawn = {
    ...detail,
    availability: "withdrawn" as const,
    withdrawnAt: detail.createdAt,
    exchanges: [],
    nextSequence: null,
  };
  const marker = practiceSessionPage(withdrawn, "csrf");
  expect(marker).toContain("Only content-free source");
  expect(marker).not.toContain("Withdraw session text");
  expect(marker).not.toContain(source.title);
  expect(
    practiceSessionHistoryPage({ items: [withdrawn], nextCursor: null }),
  ).toContain("response, comparison and excerpt text removed");
});
