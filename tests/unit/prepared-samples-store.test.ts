import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import { preparedSampleStore } from "../../src/prepared-samples.ts";
import {
  PREPARED_SAMPLES,
  preparedPayloadDigest,
  type PreparedInstruction,
} from "../../src/prepared-sample-values.ts";
const token = "a".repeat(64),
  memberId = randomUUID(),
  workspaceId = randomUUID();
const example = PREPARED_SAMPLES[0]!;
const input = (): PreparedInstruction => ({
  operationId: randomUUID(),
  templateId: example.id,
  templateVersion: 1,
  templateDigest: example.digest,
  providedExample: true,
  privateReview: true,
});
function fixture() {
  const expiry = new Date(Date.now() + 60000);
  const state = {
    principal: true,
    workspace: true,
    throwQuery: false,
    forgetCreated: false,
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
    source: undefined as
      | {
          state: string;
          consent: boolean;
          templateId: string;
          templateVersion: number;
          templateDigest: string;
          acknowledgedAt: Date;
        }
      | undefined,
    disappearance: false,
    changeSource: false,
    changeOwner: false,
    validAuthority: true,
    operationReads: 0,
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (state.throwQuery) throw Error("private diagnostic");
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
      rows = state.principal ? [{ id: memberId, expires: expiry }] : [];
    else if (sql.includes("FROM workspaces w JOIN learners"))
      rows = state.workspace ? [{ id: workspaceId, goal: "everyday" }] : [];
    else if (sql.includes("FROM provided_evidence_operations WHERE")) {
      state.operationReads++;
      if (state.disappearance && state.operationReads === 2)
        state.operation = undefined;
      if (state.changeSource && state.operationReads === 2 && state.operation)
        state.operation.evidenceId = randomUUID();
      if (state.changeOwner && state.operationReads === 2 && state.operation)
        state.operation.memberId = randomUUID();
      rows = state.operation ? [{ ...state.operation }] : [];
    } else if (
      sql.includes("FROM evidence_objects e JOIN provided_evidence_origins")
    )
      rows = state.source ? [state.source] : [];
    else if (sql.includes("INSERT INTO evidence_objects"))
      state.source = {
        state: "clean",
        consent: true,
        templateId: example.id,
        templateVersion: 1,
        templateDigest: example.digest,
        acknowledgedAt: new Date(),
      };
    else if (
      sql.includes("INSERT INTO provided_evidence_operations") &&
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
    store: preparedSampleStore(pool, {
      enabled: true,
      mode: "test",
      origin: "http://127.0.0.1:3000",
    }),
  };
}
function retained(
  f: ReturnType<typeof fixture>,
  instruction: PreparedInstruction,
) {
  f.state.operation = {
    receiptId: randomUUID(),
    evidenceId: randomUUID(),
    createdAt: new Date(),
    digest: preparedPayloadDigest(instruction),
    memberId,
    workspaceId,
  };
  f.state.source = {
    state: "clean",
    consent: true,
    templateId: example.id,
    templateVersion: 1,
    templateDigest: example.digest,
    acknowledgedAt: new Date(),
  };
}
it("PREPARED-01/04 records one private original outcome, then exposes the same receipt on deliberate replay and read-only inspection", async () => {
  const f = fixture(),
    instruction = input();
  expect(await f.store.open(token)).toMatchObject({
    kind: "ready",
    goal: "everyday",
  });
  const created = await f.store.create(token, instruction);
  expect(created).toMatchObject({
    kind: "created",
    receipt: { state: "available", origin: { templateId: example.id } },
  });
  expect(await f.store.create(token, instruction)).toMatchObject({
    kind: "replayed",
    receipt: f.state.operation
      ? { receiptId: f.state.operation.receiptId }
      : {},
  });
  expect(await f.store.inspect(token, instruction.operationId)).toMatchObject({
    kind: "ready",
  });
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO evidence_objects"),
    ),
  ).toHaveLength(1);
  expect(
    await f.store.create(token, {
      ...instruction,
      templateId: PREPARED_SAMPLES[1]!.id,
      templateDigest: PREPARED_SAMPLES[1]!.digest,
    }),
  ).toEqual({ kind: "conflict" });
});
it("PREPARED-02/08 refuses new creation when disabled but keeps current-owner original recovery readable", async () => {
  const f = fixture(),
    instruction = input();
  retained(f, instruction);
  const paused = preparedSampleStore(f.pool, {
    enabled: false,
    mode: "test",
    origin: "http://127.0.0.1",
  });
  expect(await paused.open(token)).toEqual({ kind: "disabled" });
  expect(await paused.create(token, instruction)).toEqual({ kind: "disabled" });
  expect(await paused.inspect(token, instruction.operationId)).toMatchObject({
    kind: "ready",
  });
  expect(
    await f.store.create(token, { ...instruction, text: "private" }),
  ).toEqual({ kind: "invalid" });
  expect(await f.store.inspect(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.store.open("bad")).toEqual({ kind: "denied" });
});
it.each(["missing actor", "missing workspace", "database failure"])(
  "PREPARED-05 withholds results for %s",
  async (reason) => {
    const f = fixture();
    if (reason === "missing actor") f.state.principal = false;
    if (reason === "missing workspace") f.state.workspace = false;
    if (reason === "database failure") f.state.throwQuery = true;
    expect(await f.store.create(token, input())).toEqual({
      kind: reason === "database failure" ? "unavailable" : "denied",
    });
  },
);
it("PREPARED-04 an absent receipt remains absent and never authorizes an automatic write", async () => {
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
  "invalid origin",
  "source changed",
])(
  "PREPARED-05 withholds %s instead of disclosing or repairing a private copy",
  async (reason) => {
    const f = fixture(),
      instruction = input();
    retained(f, instruction);
    if (reason === "foreign member") f.state.operation!.memberId = randomUUID();
    if (reason === "foreign workspace")
      f.state.operation!.workspaceId = randomUUID();
    if (reason === "missing source") f.state.source = undefined;
    if (reason === "invalid origin")
      f.state.source!.templateDigest = "a".repeat(64);
    if (reason === "source changed") f.state.changeSource = true;
    expect(await f.store.inspect(token, instruction.operationId)).toEqual({
      kind: reason.startsWith("foreign") ? "denied" : "unavailable",
    });
  },
);
it.each(["withdrawn", "deleting", "removed"])(
  "PREPARED-05 retains %s outcome without recreating permission or source",
  async (state) => {
    const f = fixture(),
      instruction = input();
    retained(f, instruction);
    if (state === "withdrawn") f.state.source!.consent = false;
    if (state === "deleting") f.state.source!.state = "deleting";
    if (state === "removed") f.state.operation!.evidenceId = null;
    const result = await f.store.create(token, instruction);
    expect(result).toMatchObject({
      kind: "replayed",
      receipt: { state: state === "withdrawn" ? "withdrawn" : "removed" },
    });
    if (result.kind === "replayed" && state !== "withdrawn")
      expect(result.receipt.origin).toBeNull();
  },
);
it("PREPARED-05 source erasure during discovery can remove a receipt; no source result is emitted", async () => {
  const f = fixture(),
    instruction = input();
  retained(f, instruction);
  f.state.disappearance = true;
  expect(await f.store.inspect(token, instruction.operationId)).toMatchObject({
    kind: "absent",
  });
});
it("PREPARED-04 cannot report creation when its own retained receipt cannot be read", async () => {
  const f = fixture();
  f.state.forgetCreated = true;
  expect(await f.store.create(token, input())).toEqual({ kind: "unavailable" });
  expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});
it("PREPARED-05 authority expiring at the database observation withholds creation before any source is written", async () => {
  const f = fixture();
  f.state.validAuthority = false;
  expect(await f.store.create(token, input())).toEqual({ kind: "denied" });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  expect(f.release).toHaveBeenCalledTimes(1);
});
it("PREPARED-05 a corrupt receipt returned after the source wait cannot disclose another owner's source", async () => {
  const f = fixture(),
    instruction = input();
  retained(f, instruction);
  f.state.changeOwner = true;
  expect(await f.store.inspect(token, instruction.operationId)).toEqual({
    kind: "denied",
  });
});
