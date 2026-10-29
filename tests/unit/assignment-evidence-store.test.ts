import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import { assignmentEvidenceStore } from "../../src/assignment-evidence.ts";
import {
  ASSIGNMENT_ORIGIN_LABEL,
  assignmentPayloadDigest,
  type AssignmentEvidenceOrigin,
  type AssignmentEvidenceInstruction,
} from "../../src/assignment-evidence-values.ts";
const token = "a".repeat(64),
  memberId = randomUUID(),
  workspaceId = randomUUID(),
  attemptId = randomUUID();
const input = (): AssignmentEvidenceInstruction => ({
  operationId: randomUUID(),
  attemptId,
  sequence: 1,
  contentId: "SYN-545",
  contentVersion: 1,
  rubricVersion: 4,
  sourceSha256: "b".repeat(64),
  privateReview: true,
});
const source = {
  attemptId,
  sequence: 1,
  contentId: "SYN-545",
  contentVersion: 1,
  rubricVersion: 4,
  sourceSha256: "b".repeat(64),
  response: "Invented exact submitted response.\n",
  title: "Original title",
  rubric: "Original rubric",
  submittedAt: new Date(),
};
const origin = (): AssignmentEvidenceOrigin => ({
  kind: "member-assignment-submission",
  attemptId,
  sequence: 1,
  contentId: source.contentId,
  contentVersion: 1,
  rubricVersion: 4,
  sourceSha256: source.sourceSha256,
  submittedAt: source.submittedAt,
  acknowledgedAt: new Date(),
  label: ASSIGNMENT_ORIGIN_LABEL,
});
function fixture() {
  const state = {
    principal: true,
    workspace: true,
    attempt: true,
    snapshot: true,
    validAuthority: true,
    throwQuery: false,
    forgetCreated: false,
    operationReads: 0,
    disappearance: false,
    changeSource: false,
    changeOwner: false,
    changeWorkspace: false,
    operation: undefined as
      | {
          receiptId: string;
          evidenceId: string | null;
          createdAt: Date;
          digest: string;
          memberId: string;
          workspaceId: string;
        }
      | undefined,
    retained: undefined as
      | {
          state: string;
          consent: boolean;
          assignmentOrigin: AssignmentEvidenceOrigin | null;
        }
      | undefined,
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (state.throwQuery) throw Error("Private diagnostic");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [
        {
          remaining: "60000",
          valid: state.validAuthority,
          observed: new Date(),
        },
      ];
    else if (sql.includes("FROM principals WHERE token_hash"))
      rows = state.principal
        ? [{ id: memberId, expires: new Date(Date.now() + 60000) }]
        : [];
    else if (sql.includes("SELECT id FROM workspaces"))
      rows = state.workspace ? [{ id: workspaceId }] : [];
    else if (sql.includes("SELECT id FROM assignment_attempts"))
      rows = state.attempt ? [{ id: attemptId }] : [];
    else if (
      sql.includes(
        "FROM assignment_submission_snapshots s JOIN assignment_attempts",
      )
    )
      rows = state.snapshot ? [source] : [];
    else if (sql.includes("FROM assignment_evidence_operations WHERE")) {
      state.operationReads++;
      if (state.operationReads === 2) {
        if (state.disappearance) state.operation = undefined;
        if (state.changeSource && state.operation)
          state.operation.evidenceId = randomUUID();
        if (state.changeOwner && state.operation)
          state.operation.memberId = randomUUID();
        if (state.changeWorkspace && state.operation)
          state.operation.workspaceId = randomUUID();
      }
      rows = state.operation ? [{ ...state.operation }] : [];
    } else if (
      sql.includes(
        "FROM evidence_objects e LEFT JOIN assignment_evidence_origins",
      )
    )
      rows = state.retained ? [state.retained] : [];
    else if (sql.includes("INSERT INTO evidence_objects"))
      state.retained = {
        state: "clean",
        consent: true,
        assignmentOrigin: origin(),
      };
    else if (
      sql.includes("INSERT INTO assignment_evidence_operations") &&
      !state.forgetCreated
    )
      state.operation = {
        receiptId: values![0] as string,
        evidenceId: values![5] as string,
        createdAt: new Date(),
        digest: values![4] as string,
        memberId,
        workspaceId,
      };
    return { rows };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
  } as unknown as Pool;
  return {
    state,
    query,
    release,
    pool,
    store: assignmentEvidenceStore(pool, { enabled: true }),
  };
}
function retained(
  f: ReturnType<typeof fixture>,
  instruction: AssignmentEvidenceInstruction,
) {
  f.state.operation = {
    receiptId: randomUUID(),
    evidenceId: randomUUID(),
    createdAt: new Date(),
    digest: assignmentPayloadDigest(instruction),
    memberId,
    workspaceId,
  };
  f.state.retained = {
    state: "clean",
    consent: true,
    assignmentOrigin: origin(),
  };
}
it("AHO-01/02 shows the exact submitted source and creates one private copy without source substitution", async () => {
  const f = fixture(),
    instruction = input();
  expect(await f.store.open(token, attemptId, 1)).toMatchObject({
    kind: "ready",
    source,
  });
  const created = await f.store.create(token, instruction);
  expect(created).toMatchObject({
    kind: "created",
    receipt: {
      state: "available",
      assignmentOrigin: { attemptId, sequence: 1 },
    },
  });
  expect(await f.store.create(token, instruction)).toMatchObject({
    kind: "replayed",
    receipt: { receiptId: f.state.operation!.receiptId },
  });
  expect(await f.store.inspect(token, instruction.operationId)).toMatchObject({
    kind: "ready",
    receipt: { state: "available" },
  });
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO evidence_objects"),
    ),
  ).toHaveLength(1);
  expect(
    await f.store.create(token, {
      ...instruction,
      sourceSha256: "c".repeat(64),
    }),
  ).toEqual({ kind: "conflict" });
});
it("AHO-10 configured creation-off keeps current-owner inspection without permitting new effects", async () => {
  const f = fixture(),
    instruction = input();
  retained(f, instruction);
  const disabled = assignmentEvidenceStore(f.pool, { enabled: false });
  expect(await disabled.open(token, attemptId, 1)).toEqual({
    kind: "disabled",
  });
  expect(await disabled.create(token, instruction)).toEqual({
    kind: "disabled",
  });
  expect(await disabled.inspect(token, instruction.operationId)).toMatchObject({
    kind: "ready",
  });
});
it("AHO-04 validates target and deliberate instructions before acquiring a private database connection", async () => {
  const f = fixture();
  expect(await f.store.open(token, "bad", 1)).toEqual({ kind: "invalid" });
  expect(await f.store.open(token, attemptId, 0)).toEqual({ kind: "invalid" });
  expect(await f.store.inspect(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.store.create(token, {})).toEqual({ kind: "invalid" });
  expect(await f.store.open("bad", attemptId, 1)).toEqual({ kind: "denied" });
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it.each([
  "principal",
  "workspace",
  "attempt",
  "snapshot",
  "validAuthority",
] as const)(
  "AHO-04 missing or stale %s refuses a source and copy",
  async (field) => {
    const f = fixture();
    f.state[field] = false;
    expect(await f.store.open(token, attemptId, 1)).toEqual({ kind: "denied" });
    expect(await f.store.create(token, input())).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  },
);
it("AHO-03 query failure withholds a result without exposing diagnostic text", async () => {
  const f = fixture();
  f.state.throwQuery = true;
  expect(await f.store.create(token, input())).toEqual({ kind: "unavailable" });
  expect(f.release).toHaveBeenCalledTimes(1);
});
it.each([
  { contentId: "SYN-546" },
  { contentVersion: 2 },
  { rubricVersion: 5 },
  { sourceSha256: "c".repeat(64) },
])(
  "AHO-01 rejects altered selected provenance %j instead of substituting the current source",
  async (changed) => {
    const f = fixture();
    expect(await f.store.create(token, { ...input(), ...changed })).toEqual({
      kind: "conflict",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  },
);
it("AHO-03 absent original operation inspection cannot create a source", async () => {
  const f = fixture();
  expect(await f.store.inspect(token, randomUUID())).toMatchObject({
    kind: "absent",
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([
  "foreign member",
  "foreign workspace",
  "missing source",
  "missing origin",
  "source changed",
  "quarantine",
])(
  "AHO-04/09 withholds %s without disclosing or repairing a copied source",
  async (reason) => {
    const f = fixture(),
      instruction = input();
    retained(f, instruction);
    if (reason === "foreign member") f.state.operation!.memberId = randomUUID();
    if (reason === "foreign workspace")
      f.state.operation!.workspaceId = randomUUID();
    if (reason === "missing source") f.state.retained = undefined;
    if (reason === "missing origin") f.state.retained!.assignmentOrigin = null;
    if (reason === "source changed") f.state.changeSource = true;
    if (reason === "quarantine") f.state.retained!.state = "infected";
    expect(await f.store.inspect(token, instruction.operationId)).toEqual({
      kind: reason.startsWith("foreign") ? "denied" : "unavailable",
    });
  },
);
it.each(["withdrawn", "deleting", "removed"])(
  "AHO-03/08 recovers canonical %s state without reviving permission",
  async (state) => {
    const f = fixture(),
      instruction = input();
    retained(f, instruction);
    if (state === "withdrawn") f.state.retained!.consent = false;
    if (state === "deleting") f.state.retained!.state = "deleting";
    if (state === "removed") f.state.operation!.evidenceId = null;
    const result = await f.store.create(token, instruction);
    expect(result).toMatchObject({
      kind: "replayed",
      receipt: { state: state === "withdrawn" ? "withdrawn" : "removed" },
    });
    if (result.kind === "replayed" && state !== "withdrawn")
      expect(result.receipt.assignmentOrigin).toBeNull();
  },
);
it("AHO-03 disappearance while waiting on the source remains absent", async () => {
  const f = fixture(),
    instruction = input();
  retained(f, instruction);
  f.state.disappearance = true;
  expect(await f.store.inspect(token, instruction.operationId)).toMatchObject({
    kind: "absent",
  });
});
it.each(["changeOwner", "changeWorkspace"] as const)(
  "AHO-04 %s after a source wait cannot return another actor's receipt",
  async (reason) => {
    const f = fixture(),
      instruction = input();
    retained(f, instruction);
    f.state[reason] = true;
    expect(await f.store.inspect(token, instruction.operationId)).toEqual({
      kind: "denied",
    });
  },
);
it("AHO-03 missing own just-created receipt cannot be reported as a confirmed effect", async () => {
  const f = fixture();
  f.state.forgetCreated = true;
  expect(await f.store.create(token, input())).toEqual({ kind: "unavailable" });
  expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});
