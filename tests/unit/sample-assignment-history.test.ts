import { beforeEach, expect, it, vi } from "vitest";
import {
  sampleAssignmentCandidates,
  sampleAssignmentHistoryLocks,
  sampleAssignmentProject,
  type SampleAssignmentCandidate,
} from "../../src/sample-assignment-history.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
const query = vi.fn();
const context = {
  actorId: "admin",
  credentialHash: "hash",
  expires: [],
  tx: { query, observe: vi.fn(), bounded: vi.fn(), deadline: () => 1000 },
} as SampleAssignmentContext;
const row: SampleAssignmentCandidate = {
  receiptId: "receipt",
  workspaceId: "workspace",
  ownerId: "owner",
  administratorId: "admin",
  operationId: "private-key",
  reviewerId: "reviewer",
  evidenceId: "source",
  sourceRevision: 1,
  submissionId: "submission",
  assignmentId: "assignment",
  exactGrantId: "exact",
  startsAt: new Date("2090-01-01Z"),
  expiresAt: new Date("2090-01-02Z"),
  createdAt: new Date("2090-01-01Z"),
  at: "2090-01-01T00:00:00.000000Z",
};
beforeEach(() => vi.resetAllMocks());
it("queries bounded structural history without inventing legacy receipts", async () => {
  query.mockResolvedValue({ rows: [row] });
  expect(
    await sampleAssignmentCandidates(
      context,
      "WHERE c.exact_grant_id=$1 LIMIT 1",
      ["exact"],
    ),
  ).toEqual([row]);
  expect(query.mock.calls[0]![0]).toContain(
    "NOT EXISTS(SELECT 1 FROM private_sample_assignment_operations",
  );
  expect(query.mock.calls[0]![0]).not.toMatch(
    /original_name|storage_key|sha256|criteria/,
  );
  expect(query.mock.calls[0]![1]).toEqual(["exact"]);
});
it.each([false, true])(
  "locks deduplicated source levels in order; exact revoke exclusive=%s",
  async (revoking) => {
    query.mockResolvedValue({ rows: [{ id: "workspace" }] });
    await sampleAssignmentHistoryLocks(
      context,
      [row, { ...row, exactGrantId: "aaa" }],
      revoking,
    );
    const calls = query.mock.calls;
    expect(
      calls.map((call) => (call[0] as string).match(/FROM (\w+)/)![1]),
    ).toEqual([
      "workspaces",
      "evidence_objects",
      "evidence_review_submissions",
      "assignment_grants",
      "reviewer_evidence_grants",
    ]);
    expect(calls[4]![1]).toEqual([["aaa", "exact"]]);
    expect(calls[4]![0]).toContain(revoking ? "FOR UPDATE" : "FOR SHARE");
  },
);
it("denies a deleting/removed workspace while permitting missing historical source rows", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await expect(
    sampleAssignmentHistoryLocks(context, [row]),
  ).rejects.toMatchObject({ kind: "denied" });
  expect(query).toHaveBeenCalledTimes(1);
  query.mockResolvedValue({ rows: [] });
  await sampleAssignmentHistoryLocks(context, []);
});
it.each([null, "2090-01-01 01:00:00+00"])(
  "projects only safe fields for retained state with revokedAt=%s",
  async (revokedAt) => {
    query.mockResolvedValue({
      rows: [
        {
          revokedAt,
          state: "removed",
          canRevoke: false,
          ownerId: "not public",
        },
      ],
    });
    const projected = await sampleAssignmentProject(context, row);
    expect(projected).toEqual({
      receiptId: "receipt",
      reviewerId: "reviewer",
      evidenceId: "source",
      sourceRevision: 1,
      exactGrantId: "exact",
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      revokedAt: revokedAt ? new Date(revokedAt).toISOString() : null,
      state: "removed",
      canRevoke: false,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /owner|admin|operation|workspace|submission|assignmentId/,
    );
  },
);
it("does not return historical metadata after workspace authority disappears", async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(sampleAssignmentProject(context, row)).rejects.toMatchObject({
    kind: "denied",
  });
});
