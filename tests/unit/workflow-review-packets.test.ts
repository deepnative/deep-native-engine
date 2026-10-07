import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { workflowReviewCheck } from "../../src/workflow-review-check.ts";
import { workflowReviewCursor } from "../../src/workflow-review-cursor.ts";
const secret = "invented-private-review-packet-secret";
const memberId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const source = {
  memberId,
  instanceId,
  workflowId: "WF-001",
  workflowVersion: 1,
  revision: 1,
  expiresAt: "2026-10-07T10:00:00.000Z",
};
const cursor = {
  actorId: memberId,
  id: instanceId,
  createdAt: "2026-10-07T09:00:00.123456Z",
};
function signedRaw(purpose: string, raw: string) {
  const text = Buffer.from(raw).toString("base64url");
  return `${text}.${createHmac("sha256", secret).update(`${purpose}\0${text}`).digest("base64url")}`;
}
it("WFREV-01 checked permission preserves exact owner, immutable source, revision and fixed deadline", () => {
  const codec = workflowReviewCheck(secret);
  expect(codec.read(codec.sign(source))).toEqual(source);
  expect(
    workflowReviewCheck("another-secret").read(codec.sign(source)),
  ).toBeNull();
  const packet = codec.sign(source);
  expect(
    codec.read(packet.replace(/^./, packet[0] === "a" ? "b" : "a")),
  ).toBeNull();
});
it.each([
  null,
  7,
  {},
  "",
  "x".repeat(2049),
  "invalid.packet",
  "abc." + "A".repeat(43),
])(
  "WFREV-01 malformed or unauthenticated preview packet %j denies",
  (value) => {
    expect(workflowReviewCheck(secret).read(value)).toBeNull();
  },
);
it.each([
  null,
  7,
  [],
  {},
  { ...source, extra: "unrecognized" },
  { ...source, workflowId: 7 },
  { ...source, workflowId: "another-workflow" },
  { ...source, workflowVersion: 1.5 },
  { ...source, workflowVersion: 0 },
  { ...source, revision: 1.5 },
  { ...source, revision: 0 },
  { ...source, instanceId: "not-source" },
  { ...source, memberId: "not-owner" },
  { ...source, expiresAt: "2026-10-07T10:00:00+00:00" },
  {
    memberId,
    instanceId,
    workflowId: "WF-001",
    workflowVersion: 1,
    revision: 1,
    other: "missing-deadline",
  },
])(
  "WFREV-01 authenticated but invalid preview instruction %j denies",
  (value) => {
    expect(
      workflowReviewCheck(secret).read(
        signedRaw("workflow-review-preview-v1", JSON.stringify(value)),
      ),
    ).toBeNull();
  },
);
it("WFREV-01 authenticated malformed JSON does not become a permission", () => {
  expect(
    workflowReviewCheck(secret).read(
      signedRaw("workflow-review-preview-v1", "{broken"),
    ),
  ).toBeNull();
});
it.each(["worklist", "member-history"] as const)(
  "WFREV-07 %s continuation preserves microsecond ordering and rejects other purposes/secrets",
  (purpose) => {
    const codec = workflowReviewCursor(secret, purpose),
      packet = codec.sign(cursor);
    expect(codec.read(packet)).toEqual(cursor);
    expect(
      workflowReviewCursor(
        secret,
        purpose === "worklist" ? "member-history" : "worklist",
      ).read(packet),
    ).toBeNull();
    expect(
      workflowReviewCursor("another-secret", purpose).read(packet),
    ).toBeNull();
    expect(
      codec.read(packet.replace(/^./, packet[0] === "a" ? "b" : "a")),
    ).toBeNull();
  },
);
it.each([
  null,
  7,
  {},
  "",
  "x".repeat(1025),
  "invalid.packet",
  "abc." + "A".repeat(43),
])("WFREV-07 malformed or forged continuation %j denies", (value) => {
  expect(workflowReviewCursor(secret, "member-history").read(value)).toBeNull();
});
it.each([
  null,
  7,
  [],
  {},
  { ...cursor, extra: "unrecognized" },
  { ...cursor, actorId: "not-owner" },
  { ...cursor, id: "not-request" },
  { ...cursor, createdAt: 7 },
  { ...cursor, createdAt: "2026-10-07T09:00:00.123Z" },
  { ...cursor, createdAt: "2026-99-07T09:00:00.123456Z" },
])("WFREV-07 authenticated invalid continuation %j denies", (value) => {
  expect(
    workflowReviewCursor(secret, "member-history").read(
      signedRaw("workflow-review-member-history-v1", JSON.stringify(value)),
    ),
  ).toBeNull();
});
it("WFREV-07 authenticated malformed continuation JSON denies", () => {
  expect(
    workflowReviewCursor(secret, "member-history").read(
      signedRaw("workflow-review-member-history-v1", "{broken"),
    ),
  ).toBeNull();
});
