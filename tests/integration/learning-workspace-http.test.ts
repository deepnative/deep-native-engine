import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { once } from "node:events";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore } from "../../src/catalog.ts";
import { COOKIE, csrf, token, validCsrf } from "../../src/session.ts";
import {
  selectedStaffToken,
  STAFF_COOKIE,
} from "../../src/staff-entry-selection.ts";
import { mountLearningWorkspaceRoutes } from "../../src/learning-workspace-routes.ts";
import {
  LEARNING_WORKSPACE_ASSET_BASE,
  mountLearningWorkspaceAssets,
} from "../../src/learning-workspace-assets.ts";
import {
  learningWorkspacePack,
  resolveLearningWorkspaceBundle,
} from "../../src/learning-workspace-pack.ts";
import { learningWorkspacePublicationStore } from "../../src/learning-workspace-publication.ts";
import { learningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import {
  emptyLearningSnapshot,
  joinLearningSnapshot,
  splitLearningSnapshot,
  type LearningDecision,
  type LearningVariant,
} from "../../src/learning-workspace-values.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// Deliberately a composed route harness, not the protected main application.
// Every request uses actual session selection/CSRF and actual PostgreSQL stores.
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool);
const publication = learningWorkspacePublicationStore(pool);
const workspace = learningWorkspaceStore(pool, resolveLearningWorkspaceBundle);
const pack = await learningWorkspacePack();
const adapterUrl = new URL(
  "../../public/learning-workspace-storage.js",
  import.meta.url,
);
const { createLearningWorkspaceStorage } = await import(adapterUrl.href);
const identity = {
  contentId: pack.publication.id,
  contentVersion: pack.publication.version,
  contentHash: pack.contentHash,
};
const options = { origin: "", secret: "synthetic-http-workspace-secret" };
const prefix = "/api/learning-workspace",
  teaching = "/editor/library/learning-workspace";
let server: Server;
const bearer = () => randomBytes(32).toString("hex");

beforeAll(async () => {
  await migrate(pool);
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const selected = selectedStaffToken(
      req.path,
      req.headers.cookie,
      token(req.cookies[COOKIE]),
      true,
    );
    if (selected === null) return res.status(403).json({ kind: "denied" });
    res.locals.token = selected;
    res.locals.csrf = csrf(selected, options.secret);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      (req.get("origin") !== options.origin ||
        !validCsrf(
          req.get("x-csrf-token") ?? req.body?.csrf,
          selected,
          options.secret,
        ))
    )
      return res.status(403).json({ kind: "denied" });
    next();
  });
  mountLearningWorkspaceRoutes(app, workspace, options);
  mountLearningWorkspaceAssets(app, workspace, publication, options);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing isolated loopback address");
  options.origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs,principals,cohorts,content_versions CASCADE",
  );
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await pool.end();
});

function browserFetch(member: string, staff?: string) {
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(
      "cookie",
      `${COOKIE}=${member}${staff ? `; ${STAFF_COOKIE}=${staff}` : ""}`,
    );
    if (init.method && init.method !== "GET")
      headers.set("origin", options.origin);
    return fetch(new URL(path, options.origin), { ...init, headers });
  };
}
async function request(
  member: string,
  path: string,
  method = "GET",
  body?: unknown,
  overrides: Record<string, string> = {},
) {
  return fetch(new URL(path, options.origin), {
    method,
    headers: {
      cookie: `${COOKIE}=${member}`,
      origin: options.origin,
      "x-csrf-token": csrf(member, options.secret),
      "content-type": "application/json",
      ...overrides,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function actors(publish = true) {
  const member = bearer(),
    other = bearer(),
    editor = bearer(),
    reviewer = bearer();
  await db.create(member, { background: "explorer", goal: "everyday" });
  await db.create(other, { background: "professional", goal: "work" });
  await auth.provisionStaff(editor, "editor", new Date(Date.now() + 86400000));
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 86400000),
  );
  if (publish) {
    const imported = await browserFetch(member, editor)(`${teaching}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrf(editor, options.secret) }),
    });
    expect(await imported.json()).toEqual({ kind: "imported" });
    expect(await catalog.submit(editor, identity.contentId, 1)).toBe(true);
    expect(await catalog.approve(reviewer, identity.contentId, 1, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, identity.contentId, 1)).toBe(true);
  }
  return { member, other, editor, reviewer };
}
function adapter(member: string, transport = browserFetch(member)) {
  return createLearningWorkspaceStorage({
    fetch: transport,
    csrf: csrf(member, options.secret),
    randomUUID,
    identity,
    emptyState: (route: LearningVariant) => ({
      ...emptyLearningSnapshot(pack, route),
      feedback: { ...emptyLearningSnapshot(pack, route).feedback, records: [] },
    }),
    feedbackCases: pack.course.feedbackCases,
  });
}
function fullState(route: LearningVariant) {
  const split = splitLearningSnapshot(emptyLearningSnapshot(pack, route));
  const patterns = ["\u0000", "\ud800", "\udc00", "\\u0000", "\u0001", "😀中é"];
  split.fields.forEach((field, index) => {
    field[1] = (
      `${index}:` + patterns[index % patterns.length]!.repeat(30000)
    ).slice(0, 30000);
  });
  return joinLearningSnapshot(split.metadata, split.fields);
}
function decisions(route: LearningVariant, count = 2): LearningDecision[] {
  const source = pack.routes[route].feedback;
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    commentVersion: source.commentVersion,
    fromVersion: source.initial.id + index,
    toVersion: source.initial.id + index + 1,
    decision: "revise",
    text: `Invented revision ${index}\u0000\ud800`,
    proposedText: `Invented revision ${index}\u0000\ud800`,
    reason: "Explain the source and next action",
    question: "What happens if the source changes?",
  }));
}
function capture(
  route: LearningVariant,
  state = emptyLearningSnapshot(pack, route),
  count = 2,
) {
  return {
    route,
    operationId: randomUUID(),
    expectedRevision: null,
    immutableState: state,
    capturedFeedbackDecisions: decisions(route, count),
  };
}

it("LWORK-03 actual adapter explicitly saves all27 maximum fields and feedback then reloads the exact private variant", async () => {
  const a = await actors(),
    client = adapter(a.member);
  for (const route of ["everyday", "work", "technical"] as const)
    expect(await client.load(route)).toMatchObject({
      kind: "ready",
      notebookId: null,
      revision: null,
    });
  expect(
    (await pool.query("SELECT 1 FROM learning_workspace_notebooks")).rowCount,
  ).toBe(0);
  const state = fullState("everyday"),
    captured = capture("everyday", state);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(1024 * 1024);
  expect(await client.save(captured)).toMatchObject({
    kind: "saved",
    revision: 4,
    confirmedDecisionCount: 2,
    feedbackHead: { sequence: 2 },
  });
  const loaded = await adapter(a.member).load("everyday");
  expect(loaded.kind).toBe("ready");
  const restored = structuredClone(loaded.state);
  delete restored.feedback.records;
  delete restored.feedback.base;
  expect(restored).toEqual(state);
  expect(loaded.feedbackHistoryPage.items).toEqual(
    captured.capturedFeedbackDecisions.map((item) => ({
      ...item,
      acceptedAt: expect.any(String),
    })),
  );
  for (const route of ["work", "technical"] as const)
    expect(await adapter(a.member).load(route)).toMatchObject({
      notebookId: null,
      revision: null,
    });
  expect(await adapter(a.other).load("everyday")).toMatchObject({
    notebookId: null,
  });
  expect(
    (await request(a.other, `${prefix}/notebooks/${loaded.notebookId}`)).status,
  ).toBe(404);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_fields",
      )
    ).rows[0].count,
  ).toBe(27);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_operations",
      )
    ).rows[0].count,
  ).toBe(4);
});

it("LWORK-04 actual uncertain create, decision and draft responses inspect stable receipts before retry without duplicate history", async () => {
  const a = await actors();
  for (const [route, lostStage] of [
    ["everyday", "create"],
    ["work", "decision"],
    ["technical", "draft"],
  ] as const) {
    const calls: Array<{ method: string; path: string; operationId?: string }> =
      [];
    let dropped = false;
    const transport = async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        method,
        path,
        ...(typeof init.body === "string"
          ? { operationId: JSON.parse(init.body).operationId }
          : {}),
      });
      const response = await browserFetch(a.member)(path, init);
      const stage =
        method === "PUT"
          ? "draft"
          : path.endsWith("/feedback-decisions")
            ? "decision"
            : path === `${prefix}/notebooks` && method === "POST"
              ? "create"
              : "read";
      if (!dropped && stage === lostStage) {
        dropped = true;
        await response.arrayBuffer();
        throw Error("Synthetic connection closed after commit");
      }
      return response;
    };
    const client = adapter(a.member, transport),
      captured = capture(route, emptyLearningSnapshot(pack, route), 1);
    expect(await client.load(route)).toMatchObject({ kind: "ready" });
    expect(await client.save(captured)).toMatchObject({ kind: "unconfirmed" });
    const before = calls.length,
      lost = calls.at(-1)!;
    expect(await client.save(captured)).toMatchObject({
      kind: "saved",
      revision: 3,
      confirmedDecisionCount: 1,
    });
    expect(calls[before]).toEqual({
      method: "GET",
      path: `${prefix}/operations/${lost.operationId}`,
    });
    expect(
      calls.filter((call) => call.operationId === lost.operationId),
    ).toHaveLength(1);
    expect(
      (await adapter(a.member).load(route)).feedbackHistoryPage.items,
    ).toEqual(
      captured.capturedFeedbackDecisions.map((item) => ({
        ...item,
        acceptedAt: expect.any(String),
      })),
    );
  }
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_notebooks",
      )
    ).rows[0].count,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_decisions",
      )
    ).rows[0].count,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM learning_workspace_operations",
      )
    ).rows[0].count,
  ).toBe(9);
});

it("LWORK-04 missing receipt retries the same captured draft and a stale browser cannot overwrite it", async () => {
  const a = await actors(),
    requests: string[] = [];
  let dropped = false;
  const client = adapter(
    a.member,
    async (path: string, init: RequestInit = {}) => {
      if (init.method === "PUT") {
        requests.push(String(init.body));
        if (!dropped) {
          dropped = true;
          throw Error("Synthetic disconnect before request transmission");
        }
      }
      return browserFetch(a.member)(path, init);
    },
  );
  await client.load("work");
  const captured = capture("work", emptyLearningSnapshot(pack, "work"), 0);
  captured.immutableState.lessons[0]!.work =
    "Captured draft before transport failure";
  expect(await client.save(captured)).toMatchObject({ kind: "unconfirmed" });
  const first = JSON.parse(requests[0]!);
  expect(
    (await request(a.member, `${prefix}/operations/${first.operationId}`))
      .status,
  ).toBe(404);
  const competing = adapter(a.member),
    previous = await competing.load("work");
  expect(previous.revision).toBe(1);
  captured.immutableState.lessons[0]!.work =
    "Later local edit must remain separate";
  expect(await client.save(captured)).toMatchObject({
    kind: "saved",
    revision: 2,
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  const current = await adapter(a.member).load("work");
  expect(current.state.lessons[0].work).toBe(
    "Captured draft before transport failure",
  );
  const stale = {
    ...capture("work", previous.state, 0),
    expectedRevision: previous.revision,
  };
  stale.immutableState.lessons[0]!.work = "Competing words remain local";
  expect(await competing.save(stale)).toMatchObject({
    kind: "conflict",
    confirmedDecisionCount: 0,
  });
  const rescue = await competing.download({
    route: "work",
    state: stale.immutableState,
    pendingRecords: [],
    feedbackHead: previous.feedbackHead,
    historyPage: previous.feedbackHistoryPage,
  });
  expect(JSON.parse(rescue.text).unsavedState.lessons[0].work).toBe(
    "Competing words remain local",
  );
  expect((await adapter(a.member).load("work")).state.lessons[0].work).toBe(
    current.state.lessons[0].work,
  );
});

it("LWORK-04 / LWORK-06 HTTP origin, CSRF, parser and owner boundaries deny changes without modifying the saved record", async () => {
  const a = await actors(),
    client = adapter(a.member);
  await client.load("work");
  expect(await client.save(capture("work"))).toMatchObject({
    kind: "saved",
    revision: 4,
  });
  const loaded = await client.load("work"),
    path = `${prefix}/notebooks/${loaded.notebookId}/draft`;
  const draft = {
    operationId: randomUUID(),
    expectedRevision: 4,
    basedOnDecisionSequence: 2,
    state: emptyLearningSnapshot(pack, "work"),
  };
  for (const headers of [
    { origin: "https://outsider.invalid" },
    { "x-csrf-token": "" },
    { "x-csrf-token": csrf(a.other, options.secret) },
  ] as Record<string, string>[])
    expect((await request(a.member, path, "PUT", draft, headers)).status).toBe(
      403,
    );
  expect(
    (
      await request(a.member, path, "PUT", draft, {
        "content-type": "text/plain",
      })
    ).status,
  ).toBe(415);
  expect((await request(a.member, path, "PUT", "{")).status).toBe(400);
  for (const [target, method, bytes] of [
    [`${prefix}/notebooks`, "POST", 8 * 1024],
    [
      `${prefix}/notebooks/${loaded.notebookId}/feedback-decisions`,
      "POST",
      1024 * 1024,
    ],
    [path, "PUT", 8 * 1024 * 1024],
  ] as const)
    expect(
      (
        await request(
          a.member,
          target,
          method,
          JSON.stringify({ oversized: "x".repeat(bytes) }),
        )
      ).status,
    ).toBe(413);
  const excessive = structuredClone(draft);
  excessive.state.lessons[0]!.work = "x".repeat(30001);
  expect((await request(a.member, path, "PUT", excessive)).status).toBe(400);
  expect((await request(a.other, path, "PUT", draft)).status).toBe(404);
  for (const suffix of ["", "/history"])
    expect(
      (
        await request(
          a.other,
          `${prefix}/notebooks/${loaded.notebookId}${suffix}`,
        )
      ).status,
    ).toBe(404);
  expect((await client.load("work")).revision).toBe(4);
  expect(
    (await request(a.member, `${prefix}/current?variant=work&owner=someone`))
      .status,
  ).toBe(400);
});

it("LWORK-05 published teaching module is guarded while generic assets and explicit editorial preview remain available", async () => {
  const a = await actors(false),
    course = `${LEARNING_WORKSPACE_ASSET_BASE}/course.mjs`;
  for (const credential of [a.member, a.editor, bearer()]) {
    const response = await request(credential, course);
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain("export const course");
  }
  const preview = await browserFetch(
    a.member,
    a.reviewer,
  )(`${teaching}/bundle`);
  expect(await preview.json()).toMatchObject({
    kind: "ready",
    state: "not-imported",
    course: { version: 1 },
  });
  expect((await browserFetch(a.member)(`${teaching}/bundle`)).status).toBe(403);
  const imported = await browserFetch(a.member, a.editor)(
    `${teaching}/import`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrf(a.editor, options.secret) }),
    },
  );
  expect(await imported.json()).toEqual({ kind: "imported" });
  expect((await request(a.member, course)).status).toBe(409);
  expect(await catalog.submit(a.editor, identity.contentId, 1)).toBe(true);
  expect(await catalog.approve(a.reviewer, identity.contentId, 1, true)).toBe(
    true,
  );
  expect((await request(a.member, course)).status).toBe(409);
  expect(await catalog.publish(a.editor, identity.contentId, 1)).toBe(true);
  const published = await request(a.member, course);
  expect(published.status).toBe(200);
  expect(published.headers.get("cache-control")).toBe("no-store");
  expect(await published.text()).toBe(pack.module);
  expect((await request(a.editor, course)).status).toBe(403);
  expect(await catalog.retire(a.editor, identity.contentId)).toBe(true);
  expect(
    (
      await request(a.member, course, "GET", undefined, {
        "if-none-match": published.headers.get("etag") ?? "fixture",
      })
    ).status,
  ).toBe(409);
  for (const file of [
    "reader.mjs",
    "feedback.mjs",
    "contribution.mjs",
    "browser-notebook.mjs",
    "style.css",
    "fonts/InterVariable.woff2",
  ]) {
    const asset = await request(
      a.member,
      `${LEARNING_WORKSPACE_ASSET_BASE}/${file}`,
    );
    expect(asset.status).toBe(200);
    const bytes = Buffer.from(await asset.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    if (file.endsWith("woff2"))
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
  }
  expect(
    (await request(a.member, `${LEARNING_WORKSPACE_ASSET_BASE}/course.json`))
      .status,
  ).toBe(404);
});

it("LWORK-05 / LWORK-06 retirement keeps owner records and feedback downloadable but denies fresh writes and expired access", async () => {
  const a = await actors(),
    client = adapter(a.member);
  await client.load("everyday");
  const captured = capture("everyday");
  expect(await client.save(captured)).toMatchObject({ kind: "saved" });
  const loaded = await client.load("everyday");
  expect(await catalog.retire(a.editor, identity.contentId)).toBe(true);
  expect(await adapter(a.member).load("everyday")).toEqual({
    kind: "source-unavailable",
  });
  const record = await request(
    a.member,
    `${prefix}/notebooks/${loaded.notebookId}`,
  );
  expect(await record.json()).toMatchObject({
    kind: "ok",
    value: {
      availability: "source-unavailable",
      state: captured.immutableState,
    },
  });
  const history = await request(
    a.member,
    `${prefix}/notebooks/${loaded.notebookId}/history`,
  );
  expect(await history.json()).toMatchObject({
    kind: "ok",
    value: { items: captured.capturedFeedbackDecisions },
  });
  const download = await client.download({
    route: "everyday",
    state: loaded.state,
    pendingRecords: [],
    feedbackHead: loaded.feedbackHead,
    historyPage: loaded.feedbackHistoryPage,
  });
  expect(JSON.parse(download.text)).toMatchObject({
    savedHistoryComplete: true,
    savedHistory: captured.capturedFeedbackDecisions,
  });
  expect(
    (
      await request(a.member, `${prefix}/notebooks`, "POST", {
        ...identity,
        variant: "work",
        operationId: randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        a.member,
        `${prefix}/notebooks/${loaded.notebookId}/draft`,
        "PUT",
        {
          operationId: randomUUID(),
          expectedRevision: loaded.revision,
          state: captured.immutableState,
          basedOnDecisionSequence: 2,
        },
      )
    ).status,
  ).toBe(409);
  const owner = await db.session(a.member);
  if (owner.kind !== "active") throw Error("Missing synthetic owner");
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [owner.learner.id],
  );
  expect(
    (await request(a.member, `${prefix}/notebooks/${loaded.notebookId}`))
      .status,
  ).toBe(401);
  expect(
    (
      await request(
        a.member,
        `${prefix}/notebooks/${loaded.notebookId}/history`,
      )
    ).status,
  ).toBe(401);
});
