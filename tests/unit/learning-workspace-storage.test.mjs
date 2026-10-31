import { describe, expect, it, vi } from "vitest";
import { createLearningWorkspaceStorage } from "../../public/learning-workspace-storage.js";
import { emptyState } from "../../assets/docs/learning-design/reader/reader.mjs";
import { course } from "../../assets/docs/learning-design/reader/course.mjs";

const identity = {
  contentId: "LRN-034",
  contentVersion: 1,
  contentHash: "a".repeat(64),
};
const notebookId = "00000000-0000-4000-8000-000000000034";
const ok = (value, status = 200) => globalThis.Response.json(value, { status });
const body = (call) => JSON.parse(call[1].body);
const makeStorage = (fetch) => {
  let next = 0;
  return createLearningWorkspaceStorage({
    fetch,
    csrf: "test-csrf",
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    identity,
    emptyState,
    feedbackCases: course.feedbackCases,
  });
};
const backendState = (route) => {
  const state = emptyState(route);
  delete state.feedback.records;
  return state;
};
const savedRead = (route, options = {}) => ({
  kind: "ok",
  value: {
    ...identity,
    variant: route,
    id: notebookId,
    revision: 5,
    draftRevision: 4,
    decisionSequence: 0,
    availability: "available",
    currentArtifact: { ...course.feedbackCases[route].versions.at(-1) },
    state: backendState(route),
    ...options,
  },
});
const receipt = (revision, decisionSequence, kind = "saved") => ({
  kind,
  notebookId,
  revision,
  decisionSequence,
  savedAt: "2026-10-29T12:00:00Z",
});
const capture = (
  route,
  state,
  decisions = [],
  revision = 5,
  operationId = "reader-save-1",
) => ({
  route,
  operationId,
  immutableState: globalThis.structuredClone(state),
  capturedFeedbackDecisions: decisions,
  expectedRevision: revision,
  editCounter: 1,
});
const decision = (route, id, fromVersion, text) => ({
  id,
  commentVersion: course.feedbackCases[route].commentVersion,
  fromVersion,
  toVersion: fromVersion + 1,
  decision: "revise",
  text,
  proposedText: text,
  reason: "The invented source supports this revision",
  question: "",
});

it("LWORK-01: opening an eligible new route reads without creating a notebook", async () => {
  const fetch = vi.fn(async () => globalThis.Response.json({ kind: "empty" }));
  const storage = makeStorage(fetch);
  const loaded = await storage.load("work");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(
    "/api/learning-workspace/current?variant=work",
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: "GET",
    credentials: "same-origin",
  });
  expect(loaded).toMatchObject({
    kind: "ready",
    notebookId: null,
    revision: null,
    state: { feedback: { caseId: course.feedbackCases.work.id } },
    feedbackHead: { sequence: 0 },
  });
});

describe("LWORK-01 account storage", () => {
  it("restores a matching saved route with its exact writing and confirmed head", async () => {
    const text = "Exact \u0000 lone \ud800 and <private>";
    const state = backendState("technical");
    state.lessons[0].work = text;
    const fetch = vi.fn(async (url) => {
      expect(url).toBe("/api/learning-workspace/current?variant=technical");
      return ok(savedRead("technical", { state }));
    });
    const loaded = await makeStorage(fetch).load("technical");
    expect(loaded).toMatchObject({
      kind: "ready",
      notebookId,
      revision: 5,
      savedDraftRevision: 4,
      feedbackHead: { sequence: 0 },
      feedbackHistoryPage: { items: [], nextCursor: null },
    });
    expect(loaded.state.lessons[0].work).toBe(text);
    expect(loaded.state.feedback.records).toEqual([]);
    expect(loaded.state.feedback.base).toEqual(loaded.feedbackHead);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("creates only on explicit save, appends decisions in order, then writes one fixed snapshot", async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("current?variant=work")) return ok({ kind: "empty" });
      if (url.endsWith("/notebooks")) return ok(receipt(1, 0));
      if (url.endsWith("/feedback-decisions")) {
        const count = calls.filter(([path]) =>
          path.endsWith("/feedback-decisions"),
        ).length;
        return ok(receipt(count + 1, count));
      }
      if (url.endsWith("/draft")) return ok(receipt(4, 2));
      throw Error(`unexpected path ${url}`);
    });
    const storage = makeStorage(fetch);
    expect((await storage.load("work")).notebookId).toBeNull();
    const state = emptyState("work");
    state.lessons[0].work = "Saved \u0000 work";
    const initial = course.feedbackCases.work.versions.at(-1).id;
    const decisions = [
      decision("work", 1, initial, "First correction"),
      decision("work", 2, initial + 1, "Second correction"),
    ];
    state.feedback.records = decisions;
    state.feedback.base = {
      sequence: 0,
      artifact: course.feedbackCases.work.versions.at(-1),
    };
    const result = await storage.save(capture("work", state, decisions, null));
    expect(result).toMatchObject({
      kind: "saved",
      revision: 4,
      savedDraftRevision: 4,
      confirmedDecisionCount: 2,
      feedbackHead: {
        sequence: 2,
        artifact: { id: initial + 2, text: "Second correction" },
      },
    });
    expect(calls.map(([url, init]) => [init.method, url])).toEqual([
      ["GET", "/api/learning-workspace/current?variant=work"],
      ["POST", "/api/learning-workspace/notebooks"],
      [
        "POST",
        `/api/learning-workspace/notebooks/${notebookId}/feedback-decisions`,
      ],
      [
        "POST",
        `/api/learning-workspace/notebooks/${notebookId}/feedback-decisions`,
      ],
      ["PUT", `/api/learning-workspace/notebooks/${notebookId}/draft`],
    ]);
    for (const [, init] of calls) {
      expect(init.credentials).toBe("same-origin");
      if (init.method !== "GET")
        expect(init.headers).toMatchObject({
          "content-type": "application/json",
          "x-csrf-token": "test-csrf",
        });
    }
    expect(body(calls[1])).toMatchObject({ ...identity, variant: "work" });
    expect(body(calls[2])).toMatchObject({
      expectedRevision: 1,
      decision: decisions[0],
    });
    expect(body(calls[3])).toMatchObject({
      expectedRevision: 2,
      decision: decisions[1],
    });
    expect(body(calls[4])).toMatchObject({
      expectedRevision: 3,
      basedOnDecisionSequence: 2,
    });
    expect(body(calls[4]).state.lessons[0].work).toBe("Saved \u0000 work");
    expect(Object.keys(body(calls[4]).state.feedback).sort()).toEqual([
      "caseId",
      "draft",
    ]);
    expect(
      new Set(calls.slice(1).map((call) => body(call).operationId)).size,
    ).toBe(4);
  });

  it("keeps a lost create operation ID through inspection and retry", async () => {
    let createCalls = 0;
    const requests = [];
    const fetch = vi.fn(async (url, init) => {
      requests.push([url, init]);
      if (url.endsWith("current?variant=everyday"))
        return ok({ kind: "empty" });
      if (url.endsWith("/notebooks")) {
        createCalls += 1;
        if (createCalls === 1) throw Error("response lost");
        return ok(receipt(1, 0, "replayed"));
      }
      if (url.includes("/operations/")) return ok({ kind: "not-found" }, 404);
      if (url.endsWith("/draft")) {
        expect(body([url, init]).expectedRevision).toBe(1);
        return ok(receipt(2, 0));
      }
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const captured = capture("everyday", emptyState("everyday"), [], null);
    expect(await storage.save(captured)).toMatchObject({
      kind: "unconfirmed",
      confirmedDecisionCount: 0,
    });
    expect(
      await storage.inspect({
        route: "everyday",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      revision: 2,
    });
    const creates = requests.filter(([url]) => url.endsWith("/notebooks"));
    expect(body(creates[0]).operationId).toBe(body(creates[1]).operationId);
    expect(requests.find(([url]) => url.includes("/operations/"))[0]).toContain(
      body(creates[0]).operationId,
    );
  });

  it("reports only confirmed decisions when a later append conflicts", async () => {
    const fetch = vi.fn(async (url, init) => {
      if (url.includes("current?")) return ok(savedRead("everyday"));
      if (url.endsWith("/feedback-decisions"))
        return body([url, init]).decision.id === 1
          ? ok(receipt(6, 1))
          : ok({ kind: "conflict" }, 409);
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const initial = course.feedbackCases.everyday.versions.at(-1).id;
    const decisions = [
      decision("everyday", 1, initial, "First"),
      decision("everyday", 2, initial + 1, "Second"),
    ];
    const result = await storage.save(
      capture("everyday", emptyState("everyday"), decisions),
    );
    expect(result).toMatchObject({
      kind: "conflict",
      confirmedDecisionCount: 1,
      feedbackHead: { sequence: 1, artifact: { text: "First" } },
    });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/draft"))).toBe(
      false,
    );
  });

  it("inspects a lost draft receipt without posting a second draft", async () => {
    let draftCalls = 0;
    const fetch = vi.fn(async (url) => {
      if (url.includes("current?")) return ok(savedRead("technical"));
      if (url.endsWith("/draft")) {
        draftCalls += 1;
        throw Error("reply lost after commit");
      }
      if (url.includes("/operations/")) return ok(receipt(6, 0));
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("technical");
    const captured = capture("technical", emptyState("technical"));
    expect(await storage.save(captured)).toMatchObject({ kind: "unconfirmed" });
    expect(
      await storage.inspect({
        route: "technical",
        operationId: captured.operationId,
      }),
    ).toMatchObject({ kind: "saved", revision: 6, savedDraftRevision: 6 });
    expect(draftCalls).toBe(1);
  });

  it("paginates older decisions and exports complete captured history with exact text", async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      decision: "decline",
      reason: `Reason ${index + 1}`,
      text: `Saved ${index + 1}`,
      proposedText: `Saved ${index + 1}`,
    }));
    records[4].text = "Saved \u0000 lone \ud800";
    const fetch = vi.fn(async (url) => {
      if (url.includes("current?"))
        return ok(
          savedRead("work", {
            decisionSequence: 25,
            currentArtifact: { id: 27, text: "Saved 25" },
          }),
        );
      const after = Number(
        new URL(url, "https://example.invalid").searchParams.get("after"),
      );
      const page = records.filter((entry) => entry.id > after).slice(0, 20);
      return ok({
        kind: "ok",
        value: {
          items: page,
          nextSequence:
            after + page.length < records.length ? page.at(-1).id : null,
        },
      });
    });
    const storage = makeStorage(fetch);
    const loaded = await storage.load("work");
    expect(loaded.feedbackHistoryPage.nextCursor).toBe("6");
    expect(loaded.feedbackHistoryPage.items[0].id).toBe(6);
    expect(loaded.feedbackHistoryPage.items).toHaveLength(20);
    expect(await storage.history("work", "6")).toMatchObject({
      nextCursor: null,
      items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    });
    const state = emptyState("work");
    const exact = "a\u0000b\ud800c";
    state.final[5] = exact;
    const pending = [decision("work", 26, 27, "Unsaved <revision>")];
    const file = await storage.download({
      route: "work",
      state,
      pendingRecords: pending,
      feedbackHead: loaded.feedbackHead,
      historyPage: loaded.feedbackHistoryPage,
    });
    expect(file).toMatchObject({
      filename: "foundation-work.json",
      mimeType: "application/json;charset=utf-8",
    });
    const copy = JSON.parse(file.text);
    expect(copy.identity).toEqual({ ...identity, variant: "work" });
    expect(copy.savedHistoryComplete).toBe(true);
    expect(copy.savedHistory.map((record) => record.id)).toEqual(
      records.map((record) => record.id),
    );
    expect(copy.savedHistory[4].text).toBe("Saved \u0000 lone \ud800");
    expect(copy.unsavedState.final[5]).toBe(exact);
    expect(copy.pendingRecords).toEqual(pending);
    expect(
      fetch.mock.calls
        .filter(([url]) => url.includes("/history?"))
        .map(([url]) => url),
    ).toEqual([
      `${"/api/learning-workspace/notebooks/"}${notebookId}/history?after=5`,
      `${"/api/learning-workspace/notebooks/"}${notebookId}/history?after=0`,
      `${"/api/learning-workspace/notebooks/"}${notebookId}/history?after=0`,
      `${"/api/learning-workspace/notebooks/"}${notebookId}/history?after=20`,
    ]);
  });

  it("provides an explicitly incomplete rescue copy if later history is unavailable", async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
    }));
    let failExport = false;
    const fetch = vi.fn(async (url) => {
      if (url.includes("current?"))
        return ok(
          savedRead("work", {
            decisionSequence: 25,
            currentArtifact: { id: 27, text: "Saved 25" },
          }),
        );
      if (url.endsWith("after=20") && failExport)
        return ok({ kind: "unavailable" }, 503);
      const after = Number(
        new URL(url, "https://example.invalid").searchParams.get("after"),
      );
      const page = records.filter((entry) => entry.id > after).slice(0, 20);
      return ok({
        kind: "ok",
        value: {
          items: page,
          nextSequence: page.at(-1).id < 25 ? page.at(-1).id : null,
        },
      });
    });
    const storage = makeStorage(fetch);
    const loaded = await storage.load("work");
    failExport = true;
    const state = emptyState("work");
    state.final[5] = "Unsent \u0000 revision \ud800";
    const pendingRecords = [{ id: 26, text: "Pending local decision" }];
    const file = await storage.download({
      route: "work",
      state,
      pendingRecords,
      feedbackHead: loaded.feedbackHead,
      historyPage: loaded.feedbackHistoryPage,
    });
    expect(file.filename).toBe("foundation-work-local-rescue.json");
    const rescue = JSON.parse(file.text);
    expect(rescue.savedHistoryComplete).toBe(false);
    expect(rescue.errorStatus).toBe("saved-history-unavailable");
    expect(rescue.note).toContain("not a complete account export");
    expect(rescue.savedHistory.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(rescue.availableHistoryPage.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 6),
    );
    expect(rescue.unsavedState.final[5]).toBe("Unsent \u0000 revision \ud800");
    expect(rescue.pendingRecords).toEqual(pendingRecords);
  });

  it("rescues current writing after account access expires before history can load", async () => {
    let accessEnded = false;
    const fetch = vi.fn(async (url) => {
      if (url.includes("current?")) return ok(savedRead("everyday"));
      if (accessEnded && url.includes("/history?"))
        return ok({ kind: "denied" }, 401);
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    accessEnded = true;
    const state = emptyState("everyday");
    state.lessons[0].work = "My unsaved \u0000 words";
    const file = await storage.download({
      route: "everyday",
      state,
      pendingRecords: [{ id: 1, text: "Local decision" }],
      feedbackHead: { sequence: 1, artifact: { id: 3, text: "Latest known" } },
      historyPage: {
        items: [{ id: 1, text: "Previously shown" }],
        nextCursor: null,
      },
    });
    const copy = JSON.parse(file.text);
    expect(file.filename).toBe("foundation-everyday-local-rescue.json");
    expect(copy).toMatchObject({
      identity: { variant: "everyday" },
      savedHistoryComplete: false,
      errorStatus: "saved-history-unavailable",
      availableHistoryPage: [{ id: 1, text: "Previously shown" }],
      pendingRecords: [{ id: 1, text: "Local decision" }],
    });
    expect(copy.unsavedState.lessons[0].work).toBe("My unsaved \u0000 words");
    expect(copy.savedHistory).toEqual([]);
  });

  it("rejects crossed-route reads and invalid HTTP bodies without exposing content", async () => {
    const crossed = makeStorage(vi.fn(async () => ok(savedRead("technical"))));
    expect(await crossed.load("everyday")).toEqual({ kind: "unavailable" });
    const invalid = makeStorage(
      vi.fn(async () => new globalThis.Response("not JSON")),
    );
    expect(await invalid.load("work")).toEqual({ kind: "unavailable" });
    const denied = makeStorage(vi.fn(async () => ok({ kind: "denied" }, 403)));
    expect(await denied.load("work")).toEqual({ kind: "denied" });
  });

  it("does not make any request for invalid routes or uninitialized saves", async () => {
    const fetch = vi.fn();
    const storage = makeStorage(fetch);
    expect(await storage.load("other")).toEqual({ kind: "invalid" });
    expect(
      await storage.save(capture("work", emptyState("work"))),
    ).toMatchObject({ kind: "unavailable", confirmedDecisionCount: 0 });
    expect(
      await storage.inspect({ route: "work", operationId: "unknown" }),
    ).toEqual({ kind: "not-confirmed" });
    await expect(storage.history("work", "1")).rejects.toThrow(
      "Learning history unavailable",
    );
    await expect(
      storage.download({
        route: "other",
        state: emptyState("work"),
        pendingRecords: [],
        feedbackHead: { sequence: 0 },
      }),
    ).rejects.toThrow("Learning history unavailable");
    const rescue = await storage.download({
      route: "work",
      state: emptyState("work"),
      pendingRecords: [],
      feedbackHead: { sequence: 1 },
    });
    expect(JSON.parse(rescue.text).savedHistoryComplete).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats unknown HTTP errors and malformed JSON responses conservatively", async () => {
    const unauthorized = makeStorage(
      vi.fn(async () => ok({ kind: "mystery" }, 401)),
    );
    expect(await unauthorized.load("work")).toEqual({ kind: "denied" });
    const forbidden = makeStorage(
      vi.fn(async () => ok({ kind: "mystery" }, 403)),
    );
    expect(await forbidden.load("work")).toEqual({ kind: "denied" });
    const failed = makeStorage(vi.fn(async () => ok({ kind: "mystery" }, 500)));
    expect(await failed.load("work")).toEqual({ kind: "unavailable" });
    const malformed = makeStorage(vi.fn(async () => ok({ nope: true })));
    expect(await malformed.load("work")).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["deleted", 410, "denied"],
    ["not-found", 404, "denied"],
    ["source-unavailable", 409, "unavailable"],
    ["unavailable", 503, "unconfirmed"],
  ])(
    "maps an explicit %s draft failure without claiming a save",
    async (kind, status, expected) => {
      const fetch = vi.fn(async (url) =>
        url.includes("current?") ? ok(savedRead("work")) : ok({ kind }, status),
      );
      const storage = makeStorage(fetch);
      await storage.load("work");
      expect(
        await storage.save(capture("work", emptyState("work"))),
      ).toMatchObject({ kind: expected, confirmedDecisionCount: 0 });
    },
  );

  it("keeps a malformed successful receipt unconfirmed and retries its same operation", async () => {
    let writes = 0;
    const ids = [];
    const requests = [];
    const fetch = vi.fn(async (url, init) => {
      requests.push(url);
      if (url.includes("current?")) return ok(savedRead("work"));
      if (url.includes("/operations/")) return ok({ kind: "not-found" }, 404);
      if (url.endsWith("/draft")) {
        ids.push(body([url, init]).operationId);
        writes += 1;
        return writes === 1
          ? ok({
              kind: "saved",
              notebookId,
              revision: "bad",
              decisionSequence: 0,
            })
          : ok(receipt(6, 0, "replayed"));
      }
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("work");
    const captured = capture("work", emptyState("work"));
    expect(await storage.save(captured)).toMatchObject({ kind: "unconfirmed" });
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      revision: 6,
    });
    expect(ids).toEqual([ids[0], ids[0]]);
    expect(requests).toEqual([
      "/api/learning-workspace/current?variant=work",
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
      `/api/learning-workspace/operations/${ids[0]}`,
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
    ]);
  });

  it("keeps a 503 write checkable and retries with its original operation ID", async () => {
    const writeIds = [];
    const fetch = vi.fn(async (url, init) => {
      if (url.includes("current?")) return ok(savedRead("technical"));
      if (url.endsWith("/draft")) {
        writeIds.push(body([url, init]).operationId);
        return writeIds.length === 1
          ? ok({ kind: "unavailable" }, 503)
          : ok(receipt(6, 0, "replayed"));
      }
      if (url.includes("/operations/")) return ok({ kind: "not-found" }, 404);
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("technical");
    const captured = capture("technical", emptyState("technical"));
    expect(await storage.save(captured)).toMatchObject({
      kind: "unconfirmed",
      confirmedDecisionCount: 0,
    });
    expect(
      await storage.inspect({
        route: "technical",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      revision: 6,
    });
    expect(writeIds).toEqual([writeIds[0], writeIds[0]]);
  });

  it("checks the original receipt before an uncertain retry and resends only the captured draft", async () => {
    const requests = [];
    let writes = 0;
    const fetch = vi.fn(async (url, init) => {
      requests.push([url, init]);
      if (url.includes("current?")) return ok(savedRead("work"));
      if (url.includes("/operations/")) return ok({ kind: "not-found" }, 404);
      if (url.endsWith("/draft")) {
        writes += 1;
        return writes === 1
          ? ok({ kind: "unavailable" }, 503)
          : ok(receipt(6, 0, "replayed"));
      }
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("work");
    const state = emptyState("work");
    state.lessons[0].work = "first captured draft";
    const captured = capture("work", state);
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    captured.immutableState.lessons[0].work = "newer unsaved edit";
    expect((await storage.save(captured)).kind).toBe("saved");
    expect(requests.map(([url]) => url)).toEqual([
      "/api/learning-workspace/current?variant=work",
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
      `/api/learning-workspace/operations/${body(requests[1]).operationId}`,
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
    ]);
    expect(body(requests[1]).operationId).toBe(body(requests[3]).operationId);
    expect(body(requests[3]).state.lessons[0].work).toBe(
      "first captured draft",
    );
  });

  it("continues the captured save after a committed decision receipt without repeating the decision", async () => {
    const calls = [];
    const initial = course.feedbackCases.work.versions.at(-1).id;
    const pending = decision("work", 1, initial, "Captured correction");
    const fetch = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.includes("current?")) return ok(savedRead("work"));
      if (url.endsWith("/feedback-decisions"))
        return ok({ kind: "unavailable" }, 503);
      if (url.includes("/operations/")) return ok(receipt(6, 1));
      if (url.endsWith("/draft")) return ok(receipt(7, 1));
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("work");
    const state = emptyState("work");
    state.lessons[0].work = "Original captured answer";
    const captured = capture("work", state, [pending]);
    expect(await storage.save(captured)).toMatchObject({
      kind: "unconfirmed",
      confirmedDecisionCount: 0,
    });
    captured.immutableState.lessons[0].work = "Later unsaved answer";
    captured.capturedFeedbackDecisions[0].text = "Later feedback edit";
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      revision: 7,
      confirmedDecisionCount: 1,
      feedbackHead: { sequence: 1, artifact: { text: "Captured correction" } },
    });
    expect(calls.map(([url]) => url)).toEqual([
      "/api/learning-workspace/current?variant=work",
      `/api/learning-workspace/notebooks/${notebookId}/feedback-decisions`,
      `/api/learning-workspace/operations/${body(calls[1]).operationId}`,
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
    ]);
    expect(body(calls[3])).toMatchObject({
      expectedRevision: 6,
      basedOnDecisionSequence: 1,
    });
    expect(body(calls[3]).state.lessons[0].work).toBe(
      "Original captured answer",
    );
  });

  it.each([
    ["denied", 401, "denied"],
    ["deleted", 410, "denied"],
    ["conflict", 409, "conflict"],
  ])(
    "stops an uncertain retry when its receipt reports %s",
    async (kind, status, expected) => {
      const calls = [];
      const fetch = vi.fn(async (url, init) => {
        calls.push([url, init]);
        if (url.includes("current?")) return ok(savedRead("work"));
        if (url.includes("/operations/")) return ok({ kind }, status);
        if (url.endsWith("/draft")) return ok({ kind: "unavailable" }, 503);
        throw Error(url);
      });
      const storage = makeStorage(fetch);
      await storage.load("work");
      const captured = capture("work", emptyState("work"));
      expect((await storage.save(captured)).kind).toBe("unconfirmed");
      expect((await storage.save(captured)).kind).toBe(expected);
      expect(calls.map(([url]) => url)).toEqual([
        "/api/learning-workspace/current?variant=work",
        `/api/learning-workspace/notebooks/${notebookId}/draft`,
        `/api/learning-workspace/operations/${body(calls[1]).operationId}`,
      ]);
    },
  );

  it("waits for a readable receipt before resending an uncertain write", async () => {
    const calls = [];
    let reads = 0;
    let writes = 0;
    const fetch = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.includes("current?")) return ok(savedRead("work"));
      if (url.includes("/operations/")) {
        reads += 1;
        return reads === 1
          ? ok({ kind: "unavailable" }, 503)
          : ok({ kind: "not-found" }, 404);
      }
      if (url.endsWith("/draft")) {
        writes += 1;
        return writes === 1
          ? ok({ kind: "unavailable" }, 503)
          : ok(receipt(6, 0, "replayed"));
      }
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("work");
    const captured = capture("work", emptyState("work"));
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect(writes).toBe(1);
    expect((await storage.save(captured)).kind).toBe("saved");
    expect(calls.map(([url]) => url)).toEqual([
      "/api/learning-workspace/current?variant=work",
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
      `/api/learning-workspace/operations/${body(calls[1]).operationId}`,
      `/api/learning-workspace/operations/${body(calls[1]).operationId}`,
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
    ]);
  });

  it("checks the draft receipt after a lost create with no pending feedback", async () => {
    const calls = [];
    let createOperation;
    const fetch = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.includes("current?")) return ok({ kind: "empty" });
      if (url.endsWith("/notebooks")) {
        createOperation = body([url, init]).operationId;
        throw Error("create reply lost");
      }
      if (url.endsWith(`/operations/${createOperation}`))
        return ok(receipt(1, 0));
      if (url.includes("/operations/")) return ok({ kind: "not-found" }, 404);
      if (url.endsWith("/draft")) return ok(receipt(2, 0));
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const captured = capture("everyday", emptyState("everyday"), [], null);
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect(await storage.inspect(captured)).toEqual({ kind: "not-confirmed" });
    expect(await storage.inspect(captured)).toEqual({ kind: "not-confirmed" });
    expect((await storage.save(captured)).kind).toBe("saved");
    const urls = calls.map(([url]) => url);
    expect(urls[2]).toBe(
      `/api/learning-workspace/operations/${createOperation}`,
    );
    expect(urls[3]).toBe(
      `/api/learning-workspace/operations/${body(calls[4]).operationId}`,
    );
    expect(urls[4]).toBe(
      `/api/learning-workspace/notebooks/${notebookId}/draft`,
    );
    expect(body(calls[4]).expectedRevision).toBe(1);
  });

  it("stops a lost create when its receipt belongs to a competing save", async () => {
    const calls = [];
    let createOperation;
    const fetch = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.includes("current?")) return ok({ kind: "empty" });
      if (url.endsWith("/notebooks")) {
        createOperation = body([url, init]).operationId;
        throw Error("create reply lost");
      }
      if (url.endsWith(`/operations/${createOperation}`))
        return ok(receipt(5, 0));
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const captured = capture("everyday", emptyState("everyday"), [], null);
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect((await storage.save(captured)).kind).toBe("conflict");
    expect(calls.map(([url]) => url)).toEqual([
      "/api/learning-workspace/current?variant=everyday",
      "/api/learning-workspace/notebooks",
      `/api/learning-workspace/operations/${createOperation}`,
    ]);
  });

  it("rejects incomplete or gapped recent history during load", async () => {
    for (const items of [[], [{ id: 2 }]]) {
      const fetch = vi.fn(async (url) =>
        url.includes("current?")
          ? ok(
              savedRead("everyday", {
                decisionSequence: 2,
                currentArtifact: { id: 4, text: "Current" },
              }),
            )
          : ok({ kind: "ok", value: { items, nextSequence: null } }),
      );
      expect(await makeStorage(fetch).load("everyday")).toEqual({
        kind: "unavailable",
      });
    }
  });

  it("does not claim a complete export for an empty, gapped or truncated history page", async () => {
    for (const [items, nextSequence] of [
      [[], null],
      [[{ id: 2 }], null],
      [[{ id: 1 }], null],
    ]) {
      const fetch = vi.fn(async (url) =>
        url.includes("current?")
          ? ok(savedRead("work"))
          : ok({ kind: "ok", value: { items, nextSequence } }),
      );
      const storage = makeStorage(fetch);
      await storage.load("work");
      const file = await storage.download({
        route: "work",
        state: emptyState("work"),
        pendingRecords: [],
        feedbackHead: { sequence: 2, artifact: { id: 4, text: "Current" } },
      });
      expect(file.filename).toBe("foundation-work-local-rescue.json");
      expect(JSON.parse(file.text)).toMatchObject({
        savedHistoryComplete: false,
        errorStatus: "saved-history-unavailable",
      });
    }
  });

  it("rejects invalid paging and returns a complete zero-history private copy", async () => {
    const fetch = vi.fn(async () => ok({ kind: "empty" }));
    const storage = makeStorage(fetch);
    await storage.load("work");
    await expect(storage.history("work", "bad")).rejects.toThrow(
      "Learning history unavailable",
    );
    const file = await storage.download({
      route: "work",
      state: emptyState("work"),
      pendingRecords: [],
      feedbackHead: {
        sequence: 0,
        artifact: course.feedbackCases.work.versions.at(-1),
      },
    });
    expect(JSON.parse(file.text).savedHistory).toEqual([]);
    expect(JSON.parse(file.text).savedHistoryComplete).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["create", "everyday", (result) => ({ ...result, decisionSequence: 1 })],
    ["decision", "work", (result) => ({ ...result, decisionSequence: 2 })],
    ["draft", "technical", (result) => ({ ...result, decisionSequence: 1 })],
  ])(
    "does not confirm a %s reply with the wrong sequence",
    async (stage, route, corrupt) => {
      const initial = course.feedbackCases[route].versions.at(-1).id;
      const decisions =
        stage === "decision" ? [decision(route, 1, initial, "Correction")] : [];
      const fetch = vi.fn(async (url) => {
        if (url.includes("current?"))
          return ok(stage === "create" ? { kind: "empty" } : savedRead(route));
        if (url.endsWith("/notebooks")) return ok(corrupt(receipt(1, 0)));
        if (url.endsWith("/feedback-decisions"))
          return ok(corrupt(receipt(6, 1)));
        if (url.endsWith("/draft")) return ok(corrupt(receipt(6, 0)));
        throw Error(url);
      });
      const storage = makeStorage(fetch);
      await storage.load(route);
      const result = await storage.save(
        capture(
          route,
          emptyState(route),
          decisions,
          stage === "create" ? null : 5,
        ),
      );
      expect(result).toMatchObject({
        kind: stage === "create" ? "conflict" : "unconfirmed",
        confirmedDecisionCount: 0,
      });
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/draft"))).toBe(
        stage === "draft",
      );
    },
  );

  it("blocks a create race when another tab already saved this notebook", async () => {
    const fetch = vi.fn(async (url) =>
      url.includes("current?") ? ok({ kind: "empty" }) : ok(receipt(5, 0)),
    );
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const result = await storage.save(
      capture("everyday", emptyState("everyday"), [], null),
    );
    expect(result).toMatchObject({
      kind: "conflict",
      confirmedDecisionCount: 0,
    });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/draft"))).toBe(
      false,
    );
  });

  it("blocks a saved notebook with unavailable or unverifiable decision history", async () => {
    const unavailable = makeStorage(
      vi.fn(async (url) =>
        url.includes("current?")
          ? ok(
              savedRead("work", {
                decisionSequence: 1,
                currentArtifact: { id: 3, text: "Saved" },
              }),
            )
          : ok({ kind: "unavailable" }, 503),
      ),
    );
    expect(await unavailable.load("work")).toEqual({ kind: "unavailable" });
    const missingArtifact = makeStorage(
      vi.fn(async () =>
        ok(
          savedRead("work", {
            decisionSequence: 1,
            currentArtifact: null,
          }),
        ),
      ),
    );
    expect(await missingArtifact.load("work")).toEqual({ kind: "unavailable" });
    const initial = makeStorage(
      vi.fn(async () => ok(savedRead("work", { currentArtifact: null }))),
    );
    expect((await initial.load("work")).feedbackHead.artifact).toEqual(
      course.feedbackCases.work.versions.at(-1),
    );
  });

  it("uses a live CSRF supplier and handles a snapshot with no decision list", async () => {
    let csrf = "first-token";
    let next = 0;
    const fetch = vi.fn(async (url) =>
      url.includes("current?") ? ok(savedRead("work")) : ok(receipt(6, 0)),
    );
    const storage = createLearningWorkspaceStorage({
      fetch,
      csrf: () => csrf,
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
      identity,
      emptyState,
      feedbackCases: course.feedbackCases,
    });
    await storage.load("work");
    csrf = "new-token";
    const captured = capture("work", emptyState("work"));
    delete captured.capturedFeedbackDecisions;
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      confirmedDecisionCount: 0,
    });
    expect(fetch.mock.calls[1][1].headers["x-csrf-token"]).toBe("new-token");
  });

  it("keeps work and technical notebooks isolated while one route is saved", async () => {
    const workId = "00000000-0000-4000-8000-000000000041";
    const technicalId = "00000000-0000-4000-8000-000000000042";
    const fetch = vi.fn(async (url) => {
      if (url.endsWith("variant=work"))
        return ok(savedRead("work", { id: workId }));
      if (url.endsWith("variant=technical"))
        return ok(savedRead("technical", { id: technicalId }));
      if (url.endsWith(`${workId}/draft`))
        return ok({ ...receipt(6, 0), notebookId: workId });
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    expect((await storage.load("work")).notebookId).toBe(workId);
    expect((await storage.load("technical")).notebookId).toBe(technicalId);
    const state = emptyState("work");
    state.lessons[0].work = "Work-only note";
    expect(await storage.save(capture("work", state))).toMatchObject({
      kind: "saved",
      revision: 6,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toContain(
      `/api/learning-workspace/notebooks/${workId}/draft`,
    );
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(
      `/api/learning-workspace/notebooks/${technicalId}/draft`,
    );
    const technicalCopy = await storage.download({
      route: "technical",
      state: emptyState("technical"),
      pendingRecords: [],
      feedbackHead: {
        sequence: 0,
        artifact: course.feedbackCases.technical.versions.at(-1),
      },
    });
    expect(JSON.parse(technicalCopy.text).identity.variant).toBe("technical");
    expect(technicalCopy.text).not.toContain("Work-only note");
  });

  it("tracks create and decision receipts before completing the same captured save", async () => {
    const initial = course.feedbackCases.everyday.versions.at(-1).id;
    const draft = decision("everyday", 1, initial, "New source-bound draft");
    let appendixInspections = 0;
    let createOperation;
    let decisionOperation;
    const fetch = vi.fn(async (url, init) => {
      if (url.includes("current?")) return ok({ kind: "empty" });
      if (url.endsWith("/notebooks")) {
        createOperation = body([url, init]).operationId;
        throw Error("create reply lost");
      }
      if (url.endsWith("/feedback-decisions")) {
        expect(body([url, init]).expectedRevision).toBe(1);
        decisionOperation = body([url, init]).operationId;
        throw Error("decision reply lost");
      }
      if (url.includes("/operations/")) {
        if (url.endsWith(createOperation)) return ok(receipt(1, 0));
        appendixInspections += 1;
        if (appendixInspections === 1) return ok({ kind: "not-found" }, 404);
        if (appendixInspections === 2) return ok(receipt(2, 9));
        return ok(receipt(2, 1));
      }
      if (url.endsWith("/draft")) {
        expect(body([url, init])).toMatchObject({
          expectedRevision: 2,
          basedOnDecisionSequence: 1,
        });
        return ok(receipt(3, 1));
      }
      throw Error(url);
    });
    const storage = makeStorage(fetch);
    await storage.load("everyday");
    const captured = capture("everyday", emptyState("everyday"), [draft], null);
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect(
      await storage.inspect({
        route: "everyday",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect(
      await storage.inspect({
        route: "everyday",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect((await storage.save(captured)).kind).toBe("unconfirmed");
    expect(
      await storage.inspect({
        route: "everyday",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect(
      await storage.inspect({
        route: "everyday",
        operationId: captured.operationId,
      }),
    ).toEqual({ kind: "not-confirmed" });
    expect(await storage.save(captured)).toMatchObject({
      kind: "saved",
      revision: 3,
      confirmedDecisionCount: 1,
      feedbackHead: {
        sequence: 1,
        artifact: { text: "New source-bound draft" },
      },
    });
    expect(decisionOperation).toBeTruthy();
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/feedback-decisions")),
    ).toHaveLength(1);
  });
});
