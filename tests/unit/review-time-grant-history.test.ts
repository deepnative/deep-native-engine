import { expect, it, vi } from "vitest";
import {
  reviewGrantCandidates,
  reviewGrantHistoryLocks,
  reviewGrantProject,
  type ReviewGrantCandidate,
} from "../../src/review-time-grant-history.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
const at = new Date("2090-01-01T00:00:00Z"),
  candidate: ReviewGrantCandidate = {
    grantId: "grant",
    allocationId: "allocation",
    reviewerId: "reviewer",
    operationId: "PRIVATE-OPERATION",
    workspaceId: "PRIVATE-WORKSPACE",
    ownerId: "PRIVATE-OWNER",
    evidenceId: "PRIVATE-SOURCE",
    submissionId: "PRIVATE-SUBMISSION",
    sourceRevision: 1,
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
it("REVIEW-GRANT-07 candidate access passes bounded actor predicates and parameters to PostgreSQL", async () => {
  const f = fixture();
  expect(
    await reviewGrantCandidates(f.c, "WHERE g.granted_by=$1", ["admin"]),
  ).toEqual([{ id: "workspace" }]);
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE g.granted_by=$1"),
    ["admin"],
  );
});
it("REVIEW-GRANT-05 locks sorted source hierarchy and denies a disappearing workspace", async () => {
  const f = fixture();
  await reviewGrantHistoryLocks(
    f.c,
    [candidate, { ...candidate, evidenceId: null, submissionId: null }],
    true,
  );
  const sql = f.query.mock.calls.map((c) => c[0]);
  expect(sql[0]).toContain("workspaces");
  expect(sql.slice(1).map((s) => s.match(/FROM (\w+)/)![1])).toEqual([
    "evidence_objects",
    "evidence_review_submissions",
    "review_time_allocations",
    "review_time_grants",
  ]);
  expect(sql.at(-1)).toContain("FOR UPDATE");
  expect(sql[3]).toContain("FOR SHARE");
  f.query.mockClear();
  await reviewGrantHistoryLocks(f.c, [candidate]);
  expect(f.query.mock.calls.at(-1)![0]).toContain("FOR SHARE");
  f.query.mockResolvedValue({ rows: [] });
  await expect(reviewGrantHistoryLocks(f.c, [candidate])).rejects.toMatchObject(
    { kind: "denied" },
  );
  await reviewGrantHistoryLocks(f.c, []);
});
it.each([null, at])(
  "REVIEW-GRANT-04/07 projects metadata only, with revokedAt=%s",
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
    const result = await reviewGrantProject(f.c, candidate);
    expect(result.revokedAt).toBe(revokedAt?.toISOString() ?? null);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(result).toMatchObject({
      grantId: "grant",
      allocationId: "allocation",
      sourceRevision: 1,
    });
  },
);
it("REVIEW-GRANT-05 withholds disappeared own receipt", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [] });
  await expect(reviewGrantProject(f.c, candidate)).rejects.toMatchObject({
    kind: "denied",
  });
});
