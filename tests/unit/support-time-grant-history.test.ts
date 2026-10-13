import { expect, it, vi } from "vitest";
import {
  supportMinuteCandidates,
  supportMinuteLocks,
  supportMinuteProject,
  type SupportMinuteCandidate,
} from "../../src/support-time-grant-history.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
const at = new Date("2090-01-01T00:00:00Z"),
  candidate: SupportMinuteCandidate = {
    grantId: "grant",
    allocationId: "allocation",
    operatorId: "reviewer",
    operationId: "PRIVATE-OPERATION",
    workspaceId: "PRIVATE-WORKSPACE",
    ownerId: "PRIVATE-OWNER",
    requestId: "request",
    startsAt: at,
    expiresAt: at,
    createdAt: at,
    at: at.toISOString(),
  };
const fixture = () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "workspace" }] });
  return {
    query,
    c: {
      actorId: "admin",
      tx: { query },
    } as unknown as SampleAssignmentContext,
  };
};
it("SUPPORT-GRANT-07 candidate access passes bounded actor predicates and parameters to PostgreSQL", async () => {
  const f = fixture();
  expect(
    await supportMinuteCandidates(f.c, "WHERE g.granted_by=$1", ["admin"]),
  ).toEqual([{ id: "workspace" }]);
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE g.granted_by=$1"),
    ["admin"],
  );
});
it("SUPPORT-GRANT-05 locks sorted source hierarchy and denies a disappearing workspace", async () => {
  const f = fixture();
  await supportMinuteLocks(f.c, [candidate, candidate], true);
  const sql = f.query.mock.calls.map((c) => c[0]);
  expect(sql[0]).toContain("support_time_grants");
  expect(sql.slice(1).map((s) => s.match(/FROM (\w+)/)![1])).toEqual([
    "workspaces",
    "support_requests",
    "support_time_allocations",
  ]);
  expect(sql.at(-1)).toContain("FOR UPDATE");
  expect(sql[3]).toContain("FOR UPDATE");
  f.query.mockClear();
  await supportMinuteLocks(f.c, [candidate]);
  expect(f.query.mock.calls.at(-1)![0]).toContain("FOR SHARE");
  f.query.mockResolvedValue({ rows: [] });
  await expect(supportMinuteLocks(f.c, [candidate])).rejects.toMatchObject({
    kind: "denied",
  });
  await supportMinuteLocks(f.c, []);
});
it.each([null, at])(
  "SUPPORT-GRANT-04/07 projects metadata only, with revokedAt=%s",
  async (revokedAt) => {
    const f = fixture();
    f.query.mockResolvedValue({
      rows: [
        {
          allocationState: "allocated",
          ceiling: 20,
          revokedAt,
          state: "active",
          sourceAvailable: true,
          canRevoke: revokedAt === null,
        },
      ],
    });
    const result = await supportMinuteProject(f.c, candidate);
    expect(result.revokedAt).toBe(revokedAt?.toISOString() ?? null);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(result).toMatchObject({
      grantId: "grant",
      allocationId: "allocation",
      requestId: "request",
    });
  },
);
it("SUPPORT-GRANT-05 withholds disappeared own receipt", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [] });
  await expect(supportMinuteProject(f.c, candidate)).rejects.toMatchObject({
    kind: "denied",
  });
});
