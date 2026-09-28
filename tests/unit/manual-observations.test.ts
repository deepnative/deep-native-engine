import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  disabledManualObservationStore,
  manualObservationStore,
  parseManualObservation,
  type ManualObservation,
} from "../../src/manual-observations.ts";

const memberId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const input = {
  memberId,
  idempotencyKey: key,
  evidenceReference: "SYN-INVENTED-01",
  amountCents: 90000,
};
const observation: ManualObservation = {
  ...input,
  id: "44444444-4444-4444-8444-444444444444",
  actorId,
  status: "unverified_manual",
  createdAt: new Date("2026-09-27T12:00:00Z"),
};

function fakePool(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  const release = vi.fn();
  const client = { query: vi.fn(query), release };
  const pool = {
    query: vi.fn(query),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, client, release };
}

it("accepts only bounded invented manual observation details", () => {
  expect(parseManualObservation(null)).toBeNull();
  expect(parseManualObservation("invented")).toBeNull();
  expect(
    parseManualObservation({
      memberId,
      idempotencyKey: key,
      evidenceReference: "SYN-INVENTED-01",
      amountCents: "90000",
      confirm: "yes",
    }),
  ).toEqual({
    memberId,
    idempotencyKey: key,
    evidenceReference: "SYN-INVENTED-01",
    amountCents: 90000,
  });
  for (const invalid of [
    { memberId: "forged" },
    { idempotencyKey: "bad" },
    { evidenceReference: "REAL-BANK-123" },
    { evidenceReference: "SYN-<script>" },
    { amountCents: "0" },
    { amountCents: "10.5" },
    { amountCents: "10000001" },
    { confirm: "no" },
  ]) {
    expect(
      parseManualObservation({
        memberId,
        idempotencyKey: key,
        evidenceReference: "SYN-INVENTED-01",
        amountCents: "90000",
        confirm: "yes",
        ...invalid,
      }),
    ).toBeNull();
  }
});

it("disables unconfigured internal observations", async () => {
  const store = disabledManualObservationStore();
  expect(await store.list("token")).toBeNull();
  expect(
    await store.record("token", {
      memberId,
      idempotencyKey: key,
      evidenceReference: "SYN-INVENTED-01",
      amountCents: 90000,
    }),
  ).toEqual({ kind: "denied" });
});

it("denies unknown readers, permits an empty authorized register and caps a busy preview", async () => {
  const denied = fakePool(async () => ({ rows: [] }));
  expect(await manualObservationStore(denied.pool).list("unknown")).toBeNull();
  const empty = fakePool(async () => ({
    rows: [{ authorized: actorId, id: null }],
  }));
  expect(await manualObservationStore(empty.pool).list("admin")).toEqual([]);
  const populated = fakePool(async () => ({
    rows: Array.from({ length: 101 }, (_, index) => ({
      ...observation,
      id: `${index}`,
    })),
  }));
  const rows = await manualObservationStore(populated.pool).list("admin");
  expect(rows).toHaveLength(100);
  expect(rows?.[0]?.evidenceReference).toBe(input.evidenceReference);
  expect(populated.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("s.role='platform_admin'"),
    [expect.stringMatching(/^[a-f0-9]{64}$/)],
  );
});

it("requires valid details and an active admin plus existing member before writing", async () => {
  const invalid = fakePool(async () => ({ rows: [] }));
  expect(
    await manualObservationStore(invalid.pool).record("admin", {
      ...input,
      amountCents: 0,
    }),
  ).toEqual({ kind: "invalid" });
  expect(invalid.pool.connect).not.toHaveBeenCalled();
  const denied = fakePool(async (sql) => ({
    rows: sql.includes("SELECT p.id") ? [] : [],
  }));
  expect(
    await manualObservationStore(denied.pool).record("reviewer", input),
  ).toEqual({ kind: "denied" });
  expect(denied.release).toHaveBeenCalledOnce();
  const missing = fakePool(async (sql) => ({
    rows: sql.includes("SELECT p.id") ? [{ id: actorId }] : [],
  }));
  expect(
    await manualObservationStore(missing.pool).record("admin", input),
  ).toEqual({ kind: "member_missing" });
  expect(missing.release).toHaveBeenCalledOnce();
});

it("returns a created observation and replays only the same actor and details", async () => {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([memberId, input.evidenceReference, input.amountCents]),
    )
    .digest("hex");
  const returned = async (
    inserted: boolean,
    old?: Partial<ManualObservation> & { requestFingerprint?: string },
  ) =>
    fakePool(async (sql, values) => {
      if (sql.includes("SELECT p.id")) return { rows: [{ id: actorId }] };
      if (sql.includes("SELECT id FROM learners"))
        return { rows: [{ id: memberId }] };
      if (sql.includes("INSERT INTO")) {
        expect(values?.[1]).toBe(memberId);
        return { rows: inserted ? [observation] : [] };
      }
      if (sql.includes("request_fingerprint AS"))
        return { rows: old ? [{ ...observation, ...old }] : [] };
      return { rows: [] };
    });
  const created = await returned(true);
  expect(
    await manualObservationStore(created.pool).record("admin", input),
  ).toEqual({ kind: "created", observation });
  expect(created.client.query).toHaveBeenCalledWith("COMMIT");
  const replayed = await returned(false, { requestFingerprint: fingerprint });
  expect(
    await manualObservationStore(replayed.pool).record("admin", input),
  ).toEqual({
    kind: "replayed",
    observation,
  });
  for (const previous of [
    undefined,
    { actorId: memberId, requestFingerprint: fingerprint },
    { requestFingerprint: "different" },
  ]) {
    const conflict = await returned(false, previous);
    expect(
      await manualObservationStore(conflict.pool).record("admin", input),
    ).toEqual({ kind: "conflict" });
    expect(conflict.client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(conflict.release).toHaveBeenCalledOnce();
  }
});

it("releases a failed transaction without surfacing database detail in the store result", async () => {
  const broken = fakePool(async (sql) => {
    if (sql.includes("SELECT p.id")) return { rows: [{ id: actorId }] };
    if (sql.includes("SELECT id FROM learners"))
      return { rows: [{ id: memberId }] };
    if (sql.includes("INSERT INTO")) throw new Error("private SQL detail");
    if (sql === "ROLLBACK") throw new Error("rollback failed");
    return { rows: [] };
  });
  await expect(
    manualObservationStore(broken.pool).record("admin", input),
  ).rejects.toThrow("private SQL detail");
  expect(broken.client.query).toHaveBeenCalledWith("ROLLBACK");
  expect(broken.release).toHaveBeenCalledOnce();
});
