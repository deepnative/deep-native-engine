import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { learningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import {
  emptyLearningSnapshot,
  splitLearningSnapshot,
  type LearningBundle,
  type LearningDecision,
} from "../../src/learning-workspace-values.ts";
import { encodeLearningText } from "../../src/learning-workspace-text.ts";
import {
  bundleFixture as bundle,
  identityFixture as identity,
} from "./learning-workspace-fixtures.ts";

vi.mock("../../src/practice-session-lifetime.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts");
  return { ...actual, practiceTransaction: vi.fn() };
});
const id = "00000000-0000-4000-8000-000000000034",
  memberId = "00000000-0000-4000-8000-000000000035",
  token = "a".repeat(64),
  now = new Date("2026-10-29T12:00:00Z");
const state = () => emptyLearningSnapshot(bundle, "everyday");
const decision = (): LearningDecision => ({
  id: 1,
  commentVersion: 1,
  fromVersion: 1,
  toVersion: 2,
  decision: "revise",
  text: "Revised artifact",
  proposedText: "Revised artifact",
  reason: "Source evidence",
  question: "",
});
function fixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    row?: boolean;
    deleted?: boolean;
    metadata?: ReturnType<typeof state>;
    loaded?: LearningBundle | null;
    loaderFails?: boolean;
    source?: Record<string, unknown> | null;
    eligible?: boolean;
    receipt?: Record<string, unknown>;
    existing?: boolean;
    decisions?: number;
    head?: number;
    missingFields?: boolean;
    missingDecision?: boolean;
    corruptDecision?: boolean;
    fail?: boolean;
    expiry?: boolean;
    many?: boolean;
  } = {},
) {
  const metadata = splitLearningSnapshot(options.metadata ?? state()).metadata;
  const row = {
    ...identity,
    id,
    revision: 1,
    decisionSequence: options.head ?? 0,
    draftRevision: 1,
    draftBasedOnDecisionSequence: 0,
    metadata,
    savedAt: now,
    createdAt: now,
    deletedAt: options.deleted ? now : null,
  };
  const expected = bundle.publication;
  const source = {
    ...expected,
    state: "published",
    requires_qualified_signoff: false,
    structured_prerequisites: null,
    minimum_experience: "new",
    rubric_version: null,
  };
  const query = vi.fn(async (sql: string) => {
    if (options.fail) throw Error("Private driver diagnostic");
    if (sql.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: memberId, expires_at: new Date("2099-01-01") }],
      };
    if (sql.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: memberId }] };
    if (sql.includes("FROM learners")) return { rows: [{ id: memberId }] };
    if (sql.includes("FROM content_versions"))
      return {
        rows: options.source === null ? [] : [options.source ?? source],
      };
    if (sql.includes("member_content_eligible"))
      return { rows: [{ eligible: options.eligible !== false }] };
    if (sql.includes("FROM learning_workspace_operations"))
      return { rows: options.receipt ? [options.receipt] : [] };
    if (sql.includes("FROM learning_workspace_notebooks")) {
      if (sql.includes("LIMIT 21"))
        return {
          rows: Array.from({ length: options.many ? 21 : 1 }, () => row),
        };
      if (sql.startsWith("SELECT id FROM"))
        return { rows: options.existing ? [{ id }] : [] };
      return { rows: options.row === false ? [] : [row] };
    }
    if (sql.includes("FROM learning_workspace_fields"))
      return {
        rows: options.missingFields
          ? []
          : splitLearningSnapshot(state()).fields.map(([field_key, value]) => ({
              field_key,
              value_json: encodeLearningText(value),
            })),
      };
    if (sql.includes("FROM learning_workspace_decisions"))
      return {
        rows: options.missingDecision
          ? []
          : Array.from({ length: options.decisions ?? 1 }, (_, index) => ({
              sequence: index + 1,
              metadata: { ...decision(), id: index + 1 },
              acceptedAt: now,
            })),
      };
    if (sql.includes("FROM learning_workspace_decision_fields"))
      return {
        rows: Array.from({ length: options.decisions ?? 1 }, (_, index) =>
          (options.corruptDecision
            ? ["text"]
            : ["text", "reason", "question", "proposedText"]
          ).map((field_key) => ({
            sequence: index + 1,
            field_key,
            value_json: encodeLearningText(decision()[field_key as "text"]),
          })),
        ).flat(),
      };
    return { rows: [] };
  });
  const observe = vi.fn(async () => {
    if (options.expiry) throw new PracticeLifetimeFailure("denied");
  });
  const tx = {
    query,
    observe,
    bounded: async <T>(use: () => Promise<T>) => use(),
  } as unknown as PracticeTransaction;
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use(tx),
  );
  return {
    api: learningWorkspaceStore({} as Pool, async () => {
      if (options.loaderFails) throw Error("Missing teaching asset");
      return options.loaded === undefined ? bundle : options.loaded;
    }),
    query,
    observe,
    row,
    source,
  };
}
const saveInput = () => ({
  operationId: randomUUID(),
  expectedRevision: 1,
  basedOnDecisionSequence: 0,
  state: state(),
});
const receipt = () => ({
  notebookId: id,
  revision: 2,
  decisionSequence: 1,
  savedAt: now,
  request_digest: "b".repeat(64),
  deleted_at: null,
  kind: "save",
});

it("LWORK store rejects malformed public inputs before touching authority or private rows", async () => {
  const f = fixture();
  expect(
    await f.api.source(token, { ...identity, contentHash: "bad" }),
  ).toEqual({ kind: "invalid" });
  expect(
    await f.api.create(token, { ...identity, operationId: "bad" }),
  ).toEqual({ kind: "invalid" });
  expect(
    await f.api.create(token, {
      ...identity,
      contentVersion: 0,
      operationId: randomUUID(),
    }),
  ).toEqual({ kind: "invalid" });
  expect(await f.api.list(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.api.read(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.api.find(token, {} as never)).toEqual({ kind: "invalid" });
  expect(
    await f.api.save(token, id, {
      ...saveInput(),
      basedOnDecisionSequence: -1,
    }),
  ).toEqual({ kind: "invalid" });
  expect(
    await f.api.save(token, id, { ...saveInput(), expectedRevision: 0 }),
  ).toEqual({ kind: "invalid" });
  expect(await f.api.save(token, "bad", saveInput())).toEqual({
    kind: "invalid",
  });
  expect(await f.api.append(token, id, {} as never)).toEqual({
    kind: "invalid",
  });
  expect(await f.api.history(token, id, -1)).toEqual({ kind: "invalid" });
  expect(await f.api.history(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.api.remove(token, id, {} as never)).toEqual({
    kind: "invalid",
  });
  expect(await f.api.operation(token, "bad")).toEqual({ kind: "invalid" });
  expect(f.query).not.toHaveBeenCalled();
});

it("LWORK store confines denial/driver failures and observes original bearer authority", async () => {
  for (const options of [
    { principal: false },
    { workspace: false },
    { expiry: true },
  ])
    expect(await fixture(options).api.list(token)).toEqual({ kind: "denied" });
  expect(await fixture().api.list("bad")).toEqual({ kind: "denied" });
  expect(await fixture().api.list(null as never)).toEqual({ kind: "denied" });
  expect(await fixture({ fail: true }).api.list(token)).toEqual({
    kind: "unavailable",
  });
  const f = fixture();
  expect((await f.api.source(token, identity)).kind).toBe("ok");
  expect(f.observe).toHaveBeenCalledTimes(2);
});

it("LWORK source requires exact registered publication metadata and current eligibility", async () => {
  const { source } = fixture();
  for (const options of [
    { loaded: null },
    { loaded: { ...bundle, contentHash: "b".repeat(64) } },
    {
      loaded: {
        ...bundle,
        publication: { ...bundle.publication, id: "ALT-001" },
      },
    },
    {
      loaded: { ...bundle, publication: { ...bundle.publication, version: 2 } },
    },
    { source: null },
    { source: { ...source, state: "retired" } },
    { source: { ...source, requires_qualified_signoff: true } },
    { source: { ...source, body: "other" } },
    { eligible: false },
  ])
    expect(await fixture(options).api.source(token, identity)).toEqual({
      kind: "source-unavailable",
    });
  const specified = {
    ...bundle,
    publication: {
      ...bundle.publication,
      minimumExperience: "some" as const,
      structuredPrerequisites: { schemaVersion: 1 as const, all: [] },
    },
  };
  expect(
    (
      await fixture({
        loaded: specified,
        source: {
          ...source,
          minimum_experience: "some",
          structured_prerequisites:
            specified.publication.structuredPrerequisites,
        },
      }).api.source(token, identity)
    ).kind,
  ).toBe("ok");
});

it("LWORK create saves an initial draft once and reuses an existing active notebook", async () => {
  const input = { ...identity, operationId: randomUUID() };
  for (const existing of [false, true]) {
    const f = fixture({ existing });
    expect((await f.api.create(token, input)).kind).toBe("saved");
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO learning_workspace_notebooks"),
      ),
    ).toBe(!existing);
  }
  expect((await fixture({ loaded: null }).api.create(token, input)).kind).toBe(
    "source-unavailable",
  );
  expect(
    (await fixture({ receipt: receipt() }).api.create(token, input)).kind,
  ).toBe("conflict");
});

it("LWORK saved draft reads preserve writing, source-unavailable history and bounded summaries", async () => {
  const f = fixture();
  const read = await f.api.read(token, id);
  expect(read.kind).toBe("ok");
  if (read.kind === "ok") {
    expect(read.value.state).toEqual(state());
    expect(read.value.currentArtifact).toEqual(
      bundle.routes.everyday.feedback.initial,
    );
  }
  const unavailable = await fixture({ loaded: null }).api.read(token, id);
  expect(unavailable.kind).toBe("ok");
  if (unavailable.kind === "ok") {
    expect(unavailable.value.availability).toBe("source-unavailable");
    expect(unavailable.value.currentArtifact).toBeNull();
  }
  const advanced = await fixture({ head: 1 }).api.read(token, id);
  expect(advanced.kind).toBe("ok");
  if (advanced.kind === "ok")
    expect(advanced.value.currentArtifact).toEqual({
      id: 2,
      text: decision().text,
    });
  expect(await fixture({ row: false }).api.read(token, id)).toEqual({
    kind: "not-found",
  });
  expect(await fixture({ deleted: true }).api.read(token, id)).toEqual({
    kind: "deleted",
  });
  expect(await fixture({ missingFields: true }).api.read(token, id)).toEqual({
    kind: "unavailable",
  });
  expect(
    await fixture({ head: 1, missingDecision: true }).api.read(token, id),
  ).toEqual({ kind: "unavailable" });
  expect(
    await fixture({ head: 1, corruptDecision: true }).api.read(token, id),
  ).toEqual({ kind: "unavailable" });
  for (const many of [false, true]) {
    const list = await fixture({ many }).api.list(token, many ? id : undefined);
    expect(list.kind).toBe("ok");
    if (list.kind === "ok")
      expect(list.value.nextCursor).toBe(many ? id : null);
  }
});

it("LWORK current lookup checks exact eligibility without creating or losing retained writing", async () => {
  expect((await fixture().api.find(token, identity)).kind).toBe("ok");
  expect(await fixture({ row: false }).api.find(token, identity)).toEqual({
    kind: "not-found",
  });
  expect(await fixture({ loaded: null }).api.find(token, identity)).toEqual({
    kind: "source-unavailable",
  });
  const read = await fixture({ loaderFails: true }).api.read(token, id);
  expect(read.kind).toBe("ok");
  if (read.kind === "ok")
    expect(read.value.availability).toBe("source-unavailable");
});

it("LWORK mutation checks reject missing/deleted/stale/source-unavailable notebooks before writing", async () => {
  for (const [options, kind] of [
    [{ row: false }, "not-found"],
    [{ deleted: true }, "deleted"],
    [{ loaded: null }, "source-unavailable"],
  ] as const)
    expect((await fixture(options).api.save(token, id, saveInput())).kind).toBe(
      kind,
    );
  expect(
    (
      await fixture().api.save(token, id, {
        ...saveInput(),
        expectedRevision: 2,
      })
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await fixture().api.save(token, id, {
        ...saveInput(),
        basedOnDecisionSequence: 1,
      })
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await fixture().api.save(token, id, {
        ...saveInput(),
        state: {} as never,
      })
    ).kind,
  ).toBe("invalid");
  expect((await fixture().api.save(token, id, saveInput())).kind).toBe("saved");
  expect(
    (
      await fixture().api.append(token, id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        decision: decision(),
      })
    ).kind,
  ).toBe("saved");
  expect(
    (
      await fixture().api.append(token, id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        decision: { ...decision(), commentVersion: 2 },
      })
    ).kind,
  ).toBe("invalid");
  expect(
    (
      await fixture({ loaded: null }).api.remove(token, id, {
        operationId: randomUUID(),
        expectedRevision: 1,
      })
    ).kind,
  ).toBe("saved");
});

it("LWORK owner receipt inspection cannot return writing or resurrect erased work", async () => {
  expect(await fixture().api.operation(token, randomUUID())).toEqual({
    kind: "not-found",
  });
  expect(
    await fixture({ receipt: receipt() }).api.operation(token, randomUUID()),
  ).toEqual({
    kind: "replayed",
    notebookId: id,
    revision: 2,
    decisionSequence: 1,
    savedAt: now,
  });
  expect(
    await fixture({ receipt: { ...receipt(), deleted_at: now } }).api.operation(
      token,
      randomUUID(),
    ),
  ).toEqual({ kind: "deleted" });
  expect(
    (
      await fixture({
        receipt: { ...receipt(), deleted_at: now, kind: "remove" },
      }).api.operation(token, randomUUID())
    ).kind,
  ).toBe("replayed");
  expect(
    (await fixture({ receipt: receipt() }).api.save(token, id, saveInput()))
      .kind,
  ).toBe("conflict");
});

it("LWORK feedback history is paged without discarding the retained chain", async () => {
  expect(await fixture({ row: false }).api.history(token, id)).toEqual({
    kind: "not-found",
  });
  expect(await fixture({ deleted: true }).api.history(token, id)).toEqual({
    kind: "deleted",
  });
  for (const count of [1, 21]) {
    const result = await fixture({ decisions: count }).api.history(
      token,
      id,
      0,
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.items).toHaveLength(Math.min(count, 20));
      expect(result.value.nextSequence).toBe(count === 21 ? 20 : null);
    }
  }
});
