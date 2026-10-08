import { describe, expect, it } from "vitest";
import {
  STUDY_FIXTURE_POLICY,
  studyFixtureCreation,
  studyFixtureLocal,
  studyRequestInstruction,
  studyIssueInstruction,
  studyFixtureFields,
  studyFixtureState,
  type StudyFixtureReceipt,
} from "../../src/study-unit-fixture-values.ts";
const request = {
  policy: STUDY_FIXTURE_POLICY,
  administratorId: "11111111-1111-4111-8111-111111111111",
  memberExpiresAt: "2030-01-01T02:00:00.000Z",
  administratorExpiresAt: "2030-01-01T01:00:00.000Z",
  checkedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:30:00.000Z",
};
const issue = {
  policy: STUDY_FIXTURE_POLICY,
  requestId: "22222222-2222-4222-8222-222222222222",
  requestExpiresAt: request.expiresAt,
  checkedAt: "2030-01-01T00:01:00.000Z",
  expiresAt: "2030-01-01T00:16:00.000Z",
};
it("TESTISSUE-01/08 only explicitly enabled local preview permits new fixtures", () => {
  for (const mode of ["demo", "test"] as const) {
    expect(studyFixtureLocal({ mode, enabled: false })).toBe(true);
    expect(studyFixtureCreation({ mode, enabled: false })).toBe(false);
    expect(studyFixtureCreation({ mode, enabled: true })).toBe(true);
  }
  expect(studyFixtureLocal({ mode: "live", enabled: true })).toBe(false);
  expect(studyFixtureCreation({ mode: "live", enabled: true })).toBe(false);
});
it("TESTISSUE-01/04 accepted intent is canonical without arbitrary category, quantity or private fields", () => {
  expect(studyRequestInstruction(request)).toEqual(request);
  expect(studyIssueInstruction(issue)).toEqual(issue);
  expect(studyRequestInstruction({ ...request, quantity: 100 })).toBeNull();
  expect(
    studyIssueInstruction({ ...issue, category: "coach_minutes" }),
  ).toBeNull();
  expect(
    studyRequestInstruction({ ...request, note: "PRIVATE-MARKER" }),
  ).toBeNull();
  expect(studyFixtureFields({ own: "value" }, ["own"])).toBe(true);
  expect(studyFixtureFields(Object.create({ own: "inherited" }), ["own"])).toBe(
    false,
  );
});
describe("TESTISSUE-01 request intent", () => {
  it.each([
    null,
    [],
    false,
    "not-an-intent",
    {},
    { ...request, policy: "paid" },
    { ...request, administratorId: "not-a-reference" },
    { ...request, memberExpiresAt: null },
    { ...request, administratorExpiresAt: "Infinity" },
    { ...request, checkedAt: "2030-02-30T00:00:00.000Z" },
    { ...request, expiresAt: "2030-01-01T00:30:00Z" },
    { ...request, expiresAt: request.checkedAt },
    { ...request, expiresAt: "2030-01-01T00:30:00.001Z" },
    { ...request, memberExpiresAt: "2030-01-01T00:29:59.999Z" },
    { ...request, administratorExpiresAt: "2030-01-01T00:29:59.999Z" },
  ])("rejects invalid or renewed finite scope %#", (input) => {
    expect(studyRequestInstruction(input)).toBeNull();
  });
});
describe("TESTISSUE-02 issuance intent", () => {
  it.each([
    null,
    [],
    false,
    {},
    { ...issue, policy: "paid" },
    { ...issue, requestId: "not-a-reference" },
    { ...issue, requestExpiresAt: undefined },
    { ...issue, checkedAt: "not-a-date" },
    { ...issue, expiresAt: "9999-99-99T00:00:00.000Z" },
    { ...issue, expiresAt: issue.checkedAt },
    { ...issue, expiresAt: "2030-01-01T00:16:00.001Z" },
    { ...issue, requestExpiresAt: "2030-01-01T00:15:59.999Z" },
  ])("rejects invalid or renewed finite scope %#", (input) => {
    expect(studyIssueInstruction(input)).toBeNull();
  });
});
it("TESTISSUE-05 withdrawal is distinct from natural expiry and does not hide earlier issuance", () => {
  const pending: StudyFixtureReceipt = {
    id: issue.requestId,
    policy: STUDY_FIXTURE_POLICY,
    administratorId: request.administratorId,
    createdAt: new Date(request.checkedAt),
    expiresAt: new Date(request.expiresAt),
    grantId: null,
    issuedAt: null,
    grantExpiresAt: null,
    withdrawnAt: null,
  };
  const now = new Date(issue.checkedAt);
  expect(studyFixtureState(pending, now)).toBe("pending");
  expect(studyFixtureState(pending, pending.expiresAt)).toBe("expired");
  expect(studyFixtureState({ ...pending, withdrawnAt: now }, now)).toBe(
    "cancelled",
  );
  const issued = {
    ...pending,
    grantId: "33333333-3333-4333-8333-333333333333",
    issuedAt: now,
    grantExpiresAt: new Date(issue.expiresAt),
  };
  expect(studyFixtureState(issued, now)).toBe("issued");
  expect(studyFixtureState(issued, issued.grantExpiresAt)).toBe("expired");
  expect(
    studyFixtureState({ ...issued, withdrawnAt: now }, pending.expiresAt),
  ).toBe("withdrawn");
});
