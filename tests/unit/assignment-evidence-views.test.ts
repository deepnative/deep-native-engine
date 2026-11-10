import { expect, it } from "vitest";
import { assignmentAttemptPage, evidencePage } from "../../src/views.ts";
import { assignmentReceiptPage } from "../../src/assignment-evidence-views.ts";
import { sampleFeedbackPage } from "../../src/sample-feedback-views.ts";
import type { OwnedEvidence } from "../../src/evidence.ts";
import type { AssignmentAttempt } from "../../src/attempts.ts";
import {
  ASSIGNMENT_ORIGIN_LABEL,
  type AssignmentEvidenceOrigin,
} from "../../src/assignment-evidence-values.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const date = new Date("2026-10-27T12:00:00Z");
const assignmentOrigin: AssignmentEvidenceOrigin = {
  kind: "member-assignment-submission" as const,
  attemptId: id,
  sequence: 1,
  contentId: "ASSIGN-OWN",
  contentVersion: 2,
  rubricVersion: 3,
  submittedAt: date,
  sourceSha256: "a".repeat(64),
  acknowledgedAt: date,
  label: ASSIGNMENT_ORIGIN_LABEL,
};
const evidence: OwnedEvidence = {
  id,
  name: "Assignment submission 1.txt",
  mediaType: "text/plain",
  quarantineState: "clean",
  privateReviewAllowed: true,
  privateReviewRevokedAt: null,
  submissionStatus: "queued",
  createdAt: date,
  revisionParentId: null,
  revisionParentStatus: "none",
  revisionNumber: 1,
  hasRevision: false,
  assignmentOrigin,
};
const attempt: AssignmentAttempt = {
  id,
  contentId: "ASSIGN-OWN",
  contentVersion: 2,
  title: "My assignment",
  rubric: "Explain choices",
  rubricVersion: 3,
  goalAtStart: "everyday",
  response: "My private draft",
  revision: 4,
  startedAt: date,
  savedAt: date,
  submittedAt: null,
  currentPublished: true,
  currentEligible: true,
  submissionCount: 1,
  submissions: [
    {
      sequence: 1,
      response: "An earlier submitted response",
      submittedAt: date.toISOString(),
    },
  ],
};
it("AHO-01/02 exposes exact submitted-version handoff only when enabled and permits own text", () => {
  const enabled = assignmentAttemptPage(
    attempt,
    "nonce",
    "",
    undefined,
    false,
    undefined,
    true,
  );
  expect(enabled).toContain(`/handoff?sequence=1`);
  expect(enabled).toContain("Your private response");
  expect(enabled).toContain("This response is mine to use");
  expect(enabled).toContain("Submit saved version</button>");
  expect(enabled).toContain("linked copies and feedback");
  const disabled = assignmentAttemptPage(attempt, "nonce");
  expect(disabled).not.toContain("/handoff?");
  expect(disabled).toContain("I used only invented or sample information");
});
it("AHO-03/07 labels bound assignments and hides unsupported independent source revisions", () => {
  const html = evidencePage([evidence], "nonce");
  expect(html).toContain("PRIVATE ASSIGNMENT COPIES");
  expect(html).toContain(ASSIGNMENT_ORIGIN_LABEL);
  expect(html).toContain(
    "assignment ASSIGN-OWN · version 2 · submission 1 · rubric 3",
  );
  expect(html).toContain(
    "Exact saved assignment text; no file upload or live scan",
  );
  expect(html).not.toContain("Create a new private revision of");
  expect(html).toContain("deleting only a copy keeps the original");
  const pending = evidencePage(
    [{ ...evidence, quarantineState: "pending" }],
    "nonce",
  );
  expect(pending).toContain("Pending safety check");
  expect(pending).not.toContain(
    "Exact saved assignment text; no file upload or live scan",
  );
});
it("AHO-05 presents pinned member assignment provenance to both owner and assigned reviewer", () => {
  for (const reviewer of [true, false]) {
    const html = sampleFeedbackPage(
      {
        kind: "ready",
        evidenceId: id,
        submissionId: id,
        title: "Assignment submission 1.txt",
        source: "Earlier response\r\nwith a second line",
        sourceSha256: "a".repeat(64),
        sourceRevision: 1,
        consent: true,
        records: [],
        next: null,
        assignmentOrigin,
      },
      "nonce",
      reviewer,
    );
    expect(html).toContain(ASSIGNMENT_ORIGIN_LABEL);
    expect(html).toContain(
      "assignment ASSIGN-OWN · version 2 · submission 1 · rubric 3",
    );
    expect(html).not.toContain("Provided-example origin is not recorded");
    expect(html).toContain("NOT FORMAL ASSESSMENT");
    expect(html).toContain("Earlier response&#13;\nwith a second line");
  }
});

it("GAPS-05 offers no feedback copy for a version that kept no rubric", () => {
  const html = assignmentAttemptPage(
    { ...attempt, rubric: null, rubricVersion: null } as never,
    "nonce",
    "",
    undefined,
    false,
    undefined,
    true,
  );
  expect(html).not.toContain("/handoff?");
});

it("CONSENT125-03 the receipt and the private copies list show the consent wording version, or say the copy predates versions, with how long it is kept", () => {
  const versioned = {
    ...assignmentOrigin,
    consentVersion: "assignment-feedback-v1",
  };
  const receipt = (origin: AssignmentEvidenceOrigin | null) =>
    assignmentReceiptPage({
      receiptId: id,
      evidenceId: origin ? id : null,
      createdAt: date,
      state: origin ? "available" : "removed",
      assignmentOrigin: origin,
    });
  const current = receipt(versioned);
  expect(current).toMatch(
    /<p>Consent wording assignment-feedback-v1, agreed <time [^>]*datetime="2026-10-27T12:00:00.000Z"/,
  );
  expect(current).toContain(
    "A private feedback copy of a submitted assignment is kept until you delete the copy, delete the original attempt or delete your account. Feedback on it is not a formal assessment, and there is no appeal process. You can delete the copy from your private copies.",
  );
  // Never back-filled: an earlier copy doesn't claim a version.
  for (const earlier of [
    assignmentOrigin,
    { ...assignmentOrigin, consentVersion: null },
  ]) {
    const old = receipt(earlier);
    expect(old).toMatch(
      /<p>Consent given <time [^>]*>.*?<\/time>, before wording versions were recorded\.<\/p>/,
    );
    expect(old).not.toContain("Consent wording");
  }
  const removed = receipt(null);
  expect(removed).not.toContain("Consent");
  expect(removed).toContain("has been removed");
  const list = evidencePage(
    [{ ...evidence, assignmentOrigin: versioned }],
    "nonce",
  );
  expect(list).toContain("Consent wording assignment-feedback-v1, agreed ");
  expect(list).toContain(
    "A copy is kept until you delete it, delete the original attempt or delete your account.",
  );
  expect(evidencePage([evidence], "nonce")).toContain(
    "before wording versions were recorded.",
  );
});
