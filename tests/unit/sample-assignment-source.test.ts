import { beforeEach, expect, it, vi } from "vitest";
import {
  sampleAssignmentDiscover,
  sampleAssignmentEligible,
} from "../../src/sample-assignment-source.ts";
import type {
  SampleAssignmentContext,
  SampleAssignmentPrincipal,
} from "../../src/sample-assignment-transaction.ts";
const query = vi.fn(),
  observe = vi.fn();
const context = {
  actorId: "admin",
  credentialHash: "hash",
  expires: [],
  tx: { query, observe, bounded: vi.fn(), deadline: () => 1000 },
} as SampleAssignmentContext;
const refs = {
  evidenceId: "source",
  sourceRevision: 2,
  reviewerId: "reviewer",
};
const discovered = { workspaceId: "workspace", ownerId: "owner" };
const end = new Date("2099-01-01T00:00:00Z");
const principal = (id: string, kind: string): SampleAssignmentPrincipal => ({
  id,
  kind,
  expires: end,
  revoked: null,
});
const actors = () => ({
  principals: new Map([
    ["owner", principal("owner", "member")],
    ["reviewer", principal("reviewer", "staff")],
  ]),
  profiles: new Map([["reviewer", "reviewer"]]),
});
beforeEach(() => {
  vi.resetAllMocks();
  context.expires = [];
  query.mockResolvedValue({ rows: [{ id: "submission" }] });
});
it("discovers only structural source identifiers before locks and accepts a missing reference", async () => {
  query
    .mockResolvedValueOnce({ rows: [discovered] })
    .mockResolvedValueOnce({ rows: [] });
  expect(await sampleAssignmentDiscover(context, "source")).toEqual(discovered);
  expect(await sampleAssignmentDiscover(context, "missing")).toBeUndefined();
  expect(query.mock.calls[0]![0]).not.toMatch(
    /original_name|storage_key|sha256/,
  );
});
it("rechecks eligibility under workspace/source/submission locks and bounds both current identities", async () => {
  expect(
    await sampleAssignmentEligible(context, refs, discovered, actors()),
  ).toEqual({
    ...discovered,
    submissionId: "submission",
    reviewerExpires: end,
  });
  expect(context.expires).toEqual([end, end]);
  expect(observe).toHaveBeenCalledWith([end, end]);
  const sql = query.mock.calls.map((call) => call[0] as string);
  expect(sql[0]).toMatch(/workspaces.*FOR SHARE/);
  expect(sql[1]).toMatch(
    /evidence_objects[\s\S]*private_review_allowed[\s\S]*FOR SHARE/,
  );
  expect(sql[2]).toMatch(/evidence_review_submissions[\s\S]*FOR SHARE/);
});
it.each([
  "missing discovery",
  "missing owner",
  "nonmember owner",
  "revoked owner",
  "missing reviewer",
  "nonstaff reviewer",
  "revoked reviewer",
  "wrong role",
  "self",
])("denies %s before source lookup", async (reason) => {
  const selected = actors();
  let keys: typeof discovered | undefined = discovered,
    reference = refs;
  if (reason === "missing discovery") keys = undefined;
  if (reason === "missing owner") selected.principals.delete("owner");
  if (reason === "nonmember owner")
    selected.principals.get("owner")!.kind = "staff";
  if (reason === "revoked owner")
    selected.principals.get("owner")!.revoked = end;
  if (reason === "missing reviewer") selected.principals.delete("reviewer");
  if (reason === "nonstaff reviewer")
    selected.principals.get("reviewer")!.kind = "member";
  if (reason === "revoked reviewer")
    selected.principals.get("reviewer")!.revoked = end;
  if (reason === "wrong role")
    selected.profiles.set("reviewer", "platform_admin");
  if (reason === "self") {
    selected.principals.set("admin", principal("admin", "staff"));
    selected.profiles.set("admin", "reviewer");
    reference = { ...refs, reviewerId: "admin" };
  }
  await expect(
    sampleAssignmentEligible(context, reference, keys, selected),
  ).rejects.toMatchObject({ kind: "denied" });
  expect(query).not.toHaveBeenCalled();
});
it.each([0, 1, 2])(
  "denies when authoritative source level %s disappeared while waiting",
  async (level) => {
    for (let i = 0; i < level; i++)
      query.mockResolvedValueOnce({ rows: [{ id: "present" }] });
    query.mockResolvedValueOnce({ rows: [] });
    await expect(
      sampleAssignmentEligible(context, refs, discovered, actors()),
    ).rejects.toMatchObject({ kind: "denied" });
    expect(query).toHaveBeenCalledTimes(level + 1);
  },
);
