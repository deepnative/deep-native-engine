import { afterEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  CONCURRENCY_RETRY_SECONDS,
  UPLOAD_ADMISSION_LIMITS,
  decide,
  refusal,
  uploadAdmissionStore,
  type AdmissionCounts,
} from "../../src/upload-admission.ts";

const limits = UPLOAD_ADMISSION_LIMITS;
const idle: AdmissionCounts = {
  member: true,
  subjectUploads: 0,
  subjectActive: 0,
  globalUploads: 0,
  globalActive: 0,
  secondsLeft: 12.2,
};
afterEach(() => vi.restoreAllMocks());

it("ADMIT-02/03/05 decides by member, signed-out and service bounds in order", () => {
  expect(decide(idle, limits)).toEqual({ kind: "admit" });
  expect(
    decide({ ...idle, subjectActive: 2, subjectUploads: 10 }, limits),
  ).toEqual({
    kind: "deny",
    reason: "member_concurrency",
    retryAfterSeconds: CONCURRENCY_RETRY_SECONDS,
  });
  expect(decide({ ...idle, subjectUploads: 10 }, limits)).toEqual({
    kind: "deny",
    reason: "member_rate",
    retryAfterSeconds: 13,
  });
  expect(
    decide(
      { ...idle, member: false, subjectUploads: 19, subjectActive: 9 },
      limits,
    ),
  ).toEqual({ kind: "admit" });
  expect(
    decide({ ...idle, member: false, subjectUploads: 20 }, limits),
  ).toEqual({
    kind: "deny",
    reason: "unauthenticated_rate",
    retryAfterSeconds: 13,
  });
  expect(decide({ ...idle, globalActive: 6 }, limits)).toMatchObject({
    reason: "global_concurrency",
  });
  expect(
    decide({ ...idle, globalUploads: 200, secondsLeft: 0.01 }, limits),
  ).toEqual({ kind: "deny", reason: "global_rate", retryAfterSeconds: 1 });
});

it("ADMIT-02/03/07 refuses with fixed guidance that carries no request data", () => {
  expect(refusal({ kind: "unavailable" })).toEqual({
    status: 503,
    retryAfterSeconds: 60,
    error: "uploads_unavailable",
    action:
      "Uploads are temporarily unavailable. Try again in a minute. Saved evidence is unchanged.",
  });
  expect(
    refusal({ kind: "denied", reason: "member_rate", retryAfterSeconds: 1 })
      .action,
  ).toBe("Wait 1 second, then upload again. Saved evidence is unchanged.");
  expect(
    refusal({ kind: "denied", reason: "global_rate", retryAfterSeconds: 42 }),
  ).toMatchObject({ status: 429, error: "too_many_uploads" });
  expect(
    refusal({
      kind: "denied",
      reason: "member_concurrency",
      retryAfterSeconds: 5,
    }),
  ).toMatchObject({ error: "upload_in_progress", retryAfterSeconds: 5 });
  expect(
    refusal({
      kind: "denied",
      reason: "global_concurrency",
      retryAfterSeconds: 5,
    }).action,
  ).toBe(
    "Uploads are busy. Wait 5 seconds, then upload again. Saved evidence is unchanged.",
  );
});

function fakePool(row: Record<string, unknown>, fail?: string) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (fail && text.includes(fail)) throw Error("unavailable");
      return { rows: [row], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client as unknown as PoolClient),
    query: vi.fn(async (): Promise<{ rows: unknown[]; rowCount: number }> => ({
      rows: [],
      rowCount: 0,
    })),
  };
  return { pool: pool as unknown as Pool & typeof pool, client, statements };
}
const row = {
  principal_id: "11111111-1111-4111-8111-111111111111",
  window_start: new Date(0),
  seconds_left: 30,
  subject_uploads: 0,
  subject_active: 0,
  global_uploads: 0,
  global_active: 0,
};

it("ADMIT-01/03 consumes budget once and releases the lease only once", async () => {
  const { pool, client, statements } = fakePool(row);
  const result = await uploadAdmissionStore(pool).admit("a".repeat(64));
  expect(result.kind).toBe("admitted");
  expect(
    statements.some((text) => text.includes("upload_admission_leases(id")),
  ).toBe(true);
  expect(statements.at(-1)).toBe("COMMIT");
  expect(client.release).toHaveBeenCalledWith(undefined);
  if (result.kind !== "admitted") throw Error("expected admission");
  pool.query.mockRejectedValueOnce(Error("lost"));
  await result.release();
  await result.release();
  expect(pool.query).toHaveBeenCalledOnce();
});

it("ADMIT-05 counts an admitted signed-out caller in the shared pool", async () => {
  const { pool, client } = fakePool({ ...row, principal_id: null });
  expect((await uploadAdmissionStore(pool).admit("not-a-token")).kind).toBe(
    "admitted",
  );
  expect(client.query).toHaveBeenCalledWith(
    expect.stringContaining("upload_admission_windows(pool"),
    [new Date(0), "unauthenticated", null],
  );
});

it("ADMIT-09 counts a denial instead of consuming budget", async () => {
  const { pool, statements } = fakePool({
    ...row,
    principal_id: null,
    subject_uploads: 20,
  });
  expect(await uploadAdmissionStore(pool).admit("not-a-token")).toEqual({
    kind: "denied",
    reason: "unauthenticated_rate",
    retryAfterSeconds: 30,
  });
  expect(
    statements.some((text) =>
      text.includes("upload_admission_denials(hour_start"),
    ),
  ).toBe(true);
  expect(
    statements.some((text) => text.includes("upload_admission_leases(id")),
  ).toBe(false);
});

it("ADMIT-07 fails closed and discards a connection whose rollback failed", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const lock = fakePool(row, "pg_advisory_xact_lock");
  expect(await uploadAdmissionStore(lock.pool).admit("a".repeat(64))).toEqual({
    kind: "unavailable",
  });
  expect(lock.client.release).toHaveBeenCalledWith(undefined);
  const broken = fakePool(row, "LOCK");
  broken.client.query.mockImplementation(async (text: string) => {
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    throw Error("unavailable");
  });
  expect(await uploadAdmissionStore(broken.pool).admit("a".repeat(64))).toEqual(
    {
      kind: "unavailable",
    },
  );
  expect(broken.client.release).toHaveBeenCalledWith(expect.any(Error));
  const unreachable = fakePool(row);
  unreachable.pool.connect.mockRejectedValueOnce(Error("refused"));
  expect(
    await uploadAdmissionStore(unreachable.pool).admit("a".repeat(64)),
  ).toEqual({ kind: "unavailable" });
  expect(errors).toHaveBeenCalledTimes(3);
  expect(new Set(errors.mock.calls.flat())).toEqual(
    new Set(["Upload admission unavailable; uploads are refused."]),
  );
});

it("ADMIT-09 reads the hourly denial signal", async () => {
  const { pool } = fakePool(row);
  pool.query.mockResolvedValueOnce({
    rows: [{ hourStart: new Date(0), reason: "member_rate", denied: 2 }],
    rowCount: 1,
  });
  expect(await uploadAdmissionStore(pool).denials()).toEqual([
    { hourStart: new Date(0), reason: "member_rate", denied: 2 },
  ]);
});
