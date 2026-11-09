import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import {
  deterministicPracticeSuggestionProvider,
  validatePracticeSuggestion,
  type PracticeSuggestionInput,
} from "../../src/practice-ai-suggestions.ts";
import type {
  PracticeSessionDetail,
  PracticeSessionStore,
} from "../../src/practice-sessions.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { practiceSessionPage } from "../../src/views.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #200 PRACTICE-AI: simulated suggestions on saved practice pairs.
const LABEL = "Simulated AI suggestion, not reviewed by a person.";
const NOTICE =
  "This interview practice doesn't predict hiring, interview results or competence.";
const input: PracticeSuggestionInput = {
  response: "I would check the invented <list> against the lesson first.",
  contentId: "SYN-840",
  contentVersion: 3,
  sourceExcerpt: "Check <source> only.",
  interview: false,
};
const QUOTE = `“${input.response}”`;
const TAIL =
  "This suggestion is uncertain and may be wrong. It gives no score and is not an assessment.";
const text = (body: string) => ({ text: body, reference: "test_abc" });

it("PRACTICE-AI-01 the local provider's suggestion quotes the member, cites the exact version and passes validation", async () => {
  const provider = deterministicPracticeSuggestionProvider("test");
  const raw = (await provider.suggest(input)) as {
    text: string;
    reference: string;
    usage: unknown;
  };
  expect(raw.text.startsWith(LABEL)).toBe(true);
  expect(raw.text).toContain(QUOTE);
  expect(raw.text).toContain("SYN-840 v3");
  expect(validatePracticeSuggestion(raw, input)).toEqual({
    text: raw.text,
    reference: raw.reference,
  });
  // #188: simulated usage at the test rates, bytes in and out.
  expect(raw.usage).toEqual({
    inputTokens: Math.ceil(
      (Buffer.byteLength(input.response) +
        Buffer.byteLength(input.sourceExcerpt)) /
        4,
    ),
    outputTokens: Math.ceil(Buffer.byteLength(raw.text) / 4),
  });
  expect(await provider.suggest(input)).toEqual(raw);

  const interview = { ...input, interview: true };
  const asked = (await provider.suggest(interview)) as { text: string };
  expect(asked.text).toContain(NOTICE);
  expect(validatePracticeSuggestion(asked, interview)?.text).toBe(asked.text);
  // Without the notice an interview suggestion is rejected.
  expect(validatePracticeSuggestion(raw, interview)).toBeNull();
});

it("PRACTICE-AI-01 a long or multi-line response is quoted from its first line, within the limit", async () => {
  const provider = deterministicPracticeSuggestionProvider("demo");
  const long = {
    ...input,
    response: `  ${"Invented words ".repeat(20)}\nSecond invented line.`,
  };
  const raw = (await provider.suggest(long)) as { text: string };
  const quote = /“([^”]*)”/.exec(raw.text)![1]!;
  expect(Array.from(quote).length).toBeLessThanOrEqual(160);
  expect(long.response).toContain(quote);
  expect(quote).not.toContain("Second");
  expect(validatePracticeSuggestion(raw, long)).not.toBeNull();
  const short = { ...input, response: "Hi\nInvented longer second line." };
  const brief = await provider.suggest(short);
  expect(validatePracticeSuggestion(brief, short)).not.toBeNull();
});

it("PRACTICE-AI-02 ungrounded, scored, unsafe or malformed output is rejected whole", () => {
  const good = `${LABEL} You wrote: ${QUOTE}. Compare that with SYN-840 v3. ${TAIL}`;
  expect(validatePracticeSuggestion(text(good), input)).not.toBeNull();
  for (const value of [
    null,
    "text",
    [good],
    { text: good },
    { text: good, reference: " spaced" },
    {
      reference: "test_abc",
      get text() {
        return good;
      },
    },
    text(""),
    text(`${good} `),
    text(`${good}\nSecond line`),
    text(good.replace(LABEL, "AI feedback.")),
    text(`${good} ${"x".repeat(1200)}`),
    // Not the member's own words, or too little of them.
    text(good.replace(QUOTE, "“I never wrote this sentence”")),
    text(good.replace(QUOTE, "“check”")),
    text(good.replace(QUOTE, "“ I would check”")),
    text(good.replace(QUOTE, "“”")),
    text(good.replace(QUOTE, `${QUOTE} and “${input.response}”`)),
    text(good.replace(QUOTE, `${QUOTE} ”`)),
    // Another or a missing source version.
    text(good.replace("SYN-840 v3", "SYN-840 v2")),
    text(`${good} See also SYN-841 v3.`),
    text(
      good.replace(
        "Compare that with SYN-840 v3.",
        "Compare that with the lesson.",
      ),
    ),
    // Scores, ratings, links and markup outside the member's words.
    text(`${good} Score 8.`),
    text(`${good} You got it 90% right.`),
    text(`${good} Rated excellent.`),
    text(`${good} You look competent.`),
    text(`${good} See https://example.invalid.`),
    text(`${good} <b>`),
    // No uncertainty, or no explicit no-score statement.
    text(good.replace("uncertain", "certain")),
    text(good.replace(" It gives no score and is not an assessment.", "")),
  ])
    expect(validatePracticeSuggestion(value, input)).toBeNull();
  // Digits and markup inside the member's own quoted words are theirs to keep.
  const numbered = { ...input, response: "Check 3 items <then> stop." };
  expect(
    validatePracticeSuggestion(
      text(
        `${LABEL} You wrote: “Check 3 items <then> stop.”. Compare that with SYN-840 v3. ${TAIL}`,
      ),
      numbered,
    ),
  ).not.toBeNull();
});

const sessionId = "11111111-1111-4111-8111-111111111111";
const base: PracticeSessionDetail = {
  id: sessionId,
  contentId: "SYN-840",
  contentVersion: 3,
  goal: "everyday",
  promptVersion: "practice-v1",
  createdAt: new Date("2026-10-01T12:00:00Z"),
  withdrawnAt: null,
  title: "Invented lesson",
  prompt: "Use invented detail.",
  availability: "available",
  exchanges: [
    {
      sequence: 1,
      response: "Invented <answer>",
      comparison: "Simulation — unreviewed local comparison.",
      sourceExcerpt: "Check source.",
      acceptedAt: new Date("2026-10-01T12:01:00Z"),
      suggestion: null,
    },
  ],
  nextSequence: 2,
  suggestions: "available",
};
const pair = (
  suggestion: PracticeSessionDetail["exchanges"][0]["suggestion"],
) => ({
  ...base,
  exchanges: [{ ...base.exchanges[0]!, suggestion }],
});

it("PRACTICE-AI-01/05 the session page offers a suggestion only where one can be requested", () => {
  const offered = practiceSessionPage(base, "csrf-token");
  expect(offered).toContain(
    `action="/practice-sessions/${sessionId}/pairs/1/suggestion"`,
  );
  expect(offered).toContain("Ask for a simulated AI suggestion on pair 1");
  expect(offered).toContain(
    "A person doesn't review it, and it gives no score.",
  );
  expect(offered).toContain('id="pair-1"');
  for (const detail of [
    { ...base, suggestions: undefined },
    { ...base, suggestions: "paused" as const },
    { ...base, availability: "source-unavailable" as const },
    { ...base, availability: "unknown-template" as const },
  ])
    expect(practiceSessionPage(detail, "csrf-token")).not.toContain(
      "/suggestion",
    );
  expect(
    practiceSessionPage({ ...base, availability: "full" }, "csrf-token"),
  ).toContain("/pairs/1/suggestion");
  expect(
    practiceSessionPage({ ...base, suggestions: "paused" }, "csrf-token"),
  ).toContain("Simulated AI suggestions are paused on this service.");
  expect(
    practiceSessionPage(
      {
        ...base,
        availability: "withdrawn",
        withdrawnAt: new Date(),
        exchanges: [],
      },
      "csrf-token",
    ),
  ).not.toContain("Simulated AI suggestions are paused");
});

it("PRACTICE-AI-01/02/03 the page shows a ready, rejected or unknown suggestion without asking again", () => {
  const requestedAt = new Date("2026-10-01T12:02:00Z");
  const ready = practiceSessionPage(
    pair({ state: "ready", text: `${LABEL} <script>x</script>`, requestedAt }),
    "csrf-token",
  );
  expect(ready).toContain("Simulated AI suggestion · not reviewed by a person");
  expect(ready).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(ready).not.toContain("<script>x");
  expect(ready).toContain("not a live AI service. No score.");
  expect(ready).not.toContain("/pairs/1/suggestion");
  const rejected = practiceSessionPage(
    pair({ state: "rejected", text: null, requestedAt }),
    "csrf-token",
  );
  expect(rejected).toContain('data-practice-suggestion-state="rejected"');
  expect(rejected).toContain("SYN-840 version 3");
  expect(rejected).toContain("it isn't requested again");
  expect(rejected).not.toContain("/pairs/1/suggestion");
  const unknown = practiceSessionPage(
    pair({ state: "unknown", text: null, requestedAt }),
    "csrf-token",
  );
  expect(unknown).toContain("isn't known. It isn't requested again");
  expect(unknown).not.toContain("/pairs/1/suggestion");
});

const origin = "http://127.0.0.1:3000",
  secret = "synthetic-practice-suggestion",
  token = "b".repeat(64);
function fixture(suggest?: PracticeSessionStore["suggest"]) {
  const session = vi.fn<Store["session"]>().mockResolvedValue({
    kind: "active",
    expiresAt: new Date(Date.now() + 3600000),
    learner: { id: "member", background: "explorer", goal: "everyday" },
  });
  const practiceSessions: PracticeSessionStore = {
    source: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue({ kind: "unavailable" }),
    history: vi.fn().mockResolvedValue(null),
    detail: vi.fn().mockResolvedValue(base),
    append: vi.fn().mockResolvedValue("unavailable"),
    withdraw: vi.fn().mockResolvedValue("unavailable"),
    ...(suggest ? { suggest } : {}),
  };
  const application = app({ session } as unknown as Store, {
    origin,
    secret,
    practiceSessions,
  });
  const post = (path: string, fields: Record<string, unknown> = {}) =>
    withLoopback(application, (server) =>
      request(server)
        .post(path)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`)
        .set("Origin", origin)
        .type("form")
        .send({ csrf: csrf(token, secret), ...fields }),
    );
  return { post };
}

it("PRACTICE-AI-01/03/04 the route asks once and returns to the pair for every recorded outcome", async () => {
  const suggest = vi.fn<NonNullable<PracticeSessionStore["suggest"]>>();
  const f = fixture(suggest);
  for (const outcome of [
    "ready",
    "rejected",
    "unknown",
    "replayed",
    "withdrawn",
  ] as const) {
    suggest.mockResolvedValueOnce(outcome);
    const r = await f.post(
      `/practice-sessions/${sessionId}/pairs/2/suggestion`,
    );
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`/practice-sessions/${sessionId}#pair-2`);
  }
  expect(suggest).toHaveBeenCalledTimes(5);
  expect(suggest).toHaveBeenLastCalledWith(token, sessionId, 2);
});

it("PRACTICE-AI-05/07/09 refusals say nothing was requested, and forged forms never reach the store", async () => {
  const suggest = vi.fn<NonNullable<PracticeSessionStore["suggest"]>>();
  const f = fixture(suggest);
  for (const [outcome, status, words] of [
    ["paused", 409, "paused on this service"],
    ["limit", 409, "3 unfinished AI requests"],
    ["ceiling", 409, "test spending ceiling"],
    ["unavailable", 404, "unavailable for a suggestion"],
  ] as const) {
    suggest.mockResolvedValueOnce(outcome);
    const r = await f.post(
      `/practice-sessions/${sessionId}/pairs/1/suggestion`,
    );
    expect(r.status).toBe(status);
    expect(r.text).toContain(words);
    expect(r.text).toContain("Nothing was requested");
  }
  suggest.mockClear();
  for (const [path, fields] of [
    [`/practice-sessions/${sessionId}/pairs/0/suggestion`, {}],
    [`/practice-sessions/${sessionId}/pairs/01/suggestion`, {}],
    [`/practice-sessions/${sessionId}/pairs/100/suggestion`, {}],
    [`/practice-sessions/${sessionId}/pairs/x/suggestion`, {}],
    [
      `/practice-sessions/${sessionId}/pairs/1/suggestion`,
      { memberId: "forged" },
    ],
    [`/practice-sessions/${sessionId}/pairs/1/suggestion`, { csrf: undefined }],
  ] as const) {
    const r = await f.post(path, fields);
    expect([403, 404]).toContain(r.status);
  }
  expect(suggest).not.toHaveBeenCalled();
  const off = fixture();
  expect(
    (await off.post(`/practice-sessions/${sessionId}/pairs/1/suggestion`))
      .status,
  ).toBe(404);
});

it("PRACTICE-AI-02 an output object that throws while being read is rejected", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("invented hostile output");
      },
    },
  );
  expect(validatePracticeSuggestion(hostile, input)).toBeNull();
});
