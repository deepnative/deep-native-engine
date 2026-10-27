import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { sampleAssignmentIntake } from "../../src/sample-assignment-intake.ts";
const harness = vi.hoisted(() => ({ execute: vi.fn(), actors: vi.fn() }));
vi.mock("../../src/sample-assignment-transaction.ts", () => ({
  sampleAssignmentExecute: harness.execute,
  sampleAssignmentActors: harness.actors,
}));
const token = "a".repeat(64),
  secret = Buffer.alloc(32, 7),
  pool = {} as Pool;
const row = (n = 1) => ({
  evidenceId: randomUUID(),
  sourceRevision: n,
  submittedAt: `2026-10-27T09:00:${String(n).padStart(2, "0")}.123456Z`,
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
});
function fixture(discovered: ReturnType<typeof row>[], current = discovered) {
  let reads = 0;
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT e.id")
      ? ++reads === 1
        ? discovered
        : current
      : [],
  }));
  const observe = vi.fn();
  const context = {
    tx: { query, observe },
    actorId: randomUUID(),
    credentialHash: "invented",
    expires: [] as Date[],
  };
  const principals = new Map(
    discovered.map((r) => [
      r.ownerId,
      { kind: "member", revoked: null, expires: new Date(Date.now() + 60000) },
    ]),
  );
  harness.actors.mockResolvedValue({ principals });
  harness.execute.mockImplementation(async (_pool, _token, _writing, use) => ({
    ...(await use(context)),
    deadline: 1000,
  }));
  return {
    store: sampleAssignmentIntake(pool, true, secret),
    query,
    observe,
    principals,
    context,
  };
}
beforeEach(() => vi.clearAllMocks());
it("INTAKE-01 returns only pending references and request times, never incidental source or owner data", async () => {
  const candidate = {
    ...row(),
    filename: "private.txt",
    content: "Private source",
    email: "private@example.invalid",
  };
  const f = fixture([candidate]);
  const result = await f.store.pending(token);
  expect(result).toEqual({
    kind: "ready",
    items: [
      {
        evidenceId: candidate.evidenceId,
        sourceRevision: 1,
        submittedAt: candidate.submittedAt,
      },
    ],
    next: null,
    deadline: 1000,
  });
  expect(JSON.stringify(result)).not.toMatch(/private|owner|workspace/);
  expect(f.context.expires).toEqual([
    f.principals.get(candidate.ownerId)!.expires,
  ]);
  expect(harness.execute).toHaveBeenCalledWith(
    pool,
    token,
    false,
    expect.any(Function),
  );
});
it("INTAKE-04 rechecks identities, source versions and request generations after waiting", async () => {
  const original = Array.from({ length: 6 }, (_, i) => row(i + 1));
  const changed = [
    { ...original[0]!, ownerId: randomUUID() },
    { ...original[1]!, workspaceId: randomUUID() },
    { ...original[2]!, sourceRevision: 9 },
    { ...original[3]!, submittedAt: row(8).submittedAt },
    row(7),
    original[5]!,
  ];
  const f = fixture(original, changed);
  f.principals.delete(original[0]!.ownerId);
  f.principals.get(original[1]!.ownerId)!.kind = "staff";
  f.principals.get(original[2]!.ownerId)!.revoked =
    new Date() as unknown as null;
  expect(await f.store.pending(token)).toMatchObject({
    kind: "ready",
    items: [{ evidenceId: original[5]!.evidenceId }],
  });
});
it("INTAKE-01 still verifies the current administrator when the queue is empty", async () => {
  const f = fixture([]);
  expect(await f.store.pending(token)).toMatchObject({
    kind: "ready",
    items: [],
    next: null,
  });
  expect(harness.actors).toHaveBeenCalledWith(f.context, []);
});
it("INTAKE-05 continuation advances from the last visible item and retains its original expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  try {
    const rows = Array.from({ length: 21 }, (_, i) => row(i + 1)),
      f = fixture(rows);
    const first = await f.store.pending(token);
    if (first.kind !== "ready" || !first.next)
      throw Error("Expected continuation");
    expect(first.items).toHaveLength(20);
    const payload = JSON.parse(
      Buffer.from(first.next.split(".")[0]!, "base64url").toString(),
    );
    expect(payload).toEqual([
      rows[19]!.submittedAt,
      rows[19]!.evidenceId,
      Date.now() + 900000,
    ]);
    vi.advanceTimersByTime(1000);
    const next = fixture(rows);
    const second = await next.store.pending(token, first.next);
    expect(next.query).toHaveBeenCalledWith(
      expect.stringContaining("(s.created_at,e.id)>"),
      expect.arrayContaining([rows[19]!.submittedAt, rows[19]!.evidenceId]),
    );
    if (second.kind !== "ready" || !second.next)
      throw Error("Expected retained continuation");
    expect(
      JSON.parse(
        Buffer.from(second.next.split(".")[0]!, "base64url").toString(),
      )[2],
    ).toBe(payload[2]);
    expect((await next.store.pending("b".repeat(64), first.next)).kind).toBe(
      "invalid",
    );
    vi.advanceTimersByTime(899000);
    expect((await next.store.pending(token, first.next)).kind).toBe("invalid");
  } finally {
    vi.useRealTimers();
  }
});
it("INTAKE-05 continues past examined rows when withdrawals shrink a full page", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => row(i + 1)),
    f = fixture(rows, rows.slice(1, 3));
  const result = await f.store.pending(token);
  if (result.kind !== "ready" || !result.next)
    throw Error("Expected progress cursor");
  expect(result.items).toHaveLength(2);
  expect(
    JSON.parse(
      Buffer.from(result.next.split(".")[0]!, "base64url").toString(),
    ).slice(0, 2),
  ).toEqual([rows[20]!.submittedAt, rows[20]!.evidenceId]);
});
it("INTAKE-02/04 selection is read-only and denies a stale or no longer pending reference", async () => {
  const candidate = row(),
    source = { evidenceId: candidate.evidenceId, sourceRevision: 1 };
  const f = fixture([candidate]);
  expect(await f.store.selectPending(token, source)).toEqual({
    kind: "ready",
    source,
    deadline: 1000,
  });
  expect(harness.execute).toHaveBeenCalledWith(
    pool,
    token,
    false,
    expect.any(Function),
  );
  expect(
    await fixture([candidate], []).store.selectPending(token, source),
  ).toMatchObject({ kind: "denied" });
  expect(await fixture([]).store.selectPending(token, source)).toMatchObject({
    kind: "denied",
  });
  expect(
    await f.store.selectPending(token, { ...source, sourceRevision: 0 }),
  ).toEqual({ kind: "invalid" });
});
it("INTAKE-04 disabled intake never reads storage or grants access", async () => {
  const disabled = sampleAssignmentIntake(pool, false, secret),
    source = row();
  expect(await disabled.pending(token)).toEqual({ kind: "unavailable" });
  expect(await disabled.selectPending(token, source)).toEqual({
    kind: "unavailable",
  });
  expect(harness.execute).not.toHaveBeenCalled();
});
