import { expect, it } from "vitest";
import {
  PREPARED_SAMPLES,
  PROVIDED_SAMPLE_LABEL,
} from "../../src/prepared-sample-values.ts";
import {
  sampleFeedbackPage,
  sampleFeedbackPath,
  sampleFeedbackRecovery,
} from "../../src/sample-feedback-views.ts";
import type {
  SampleFeedbackView,
  SampleFeedbackRecord,
} from "../../src/sample-feedback.ts";
const id = "11111111-1111-4111-8111-111111111111";
function record(): SampleFeedbackRecord {
  return {
    id,
    submissionId: id,
    authorId: "invented-reviewer",
    sourceSha256: "a".repeat(64),
    sourceRevision: 1,
    criteria: [
      {
        label: "<Clarity>",
        comment: "<Explain>",
        quote: "echo",
        start: 5,
        end: 9,
      },
    ],
    preparationMinutes: null,
    reviewMinutes: 0,
    revision: 2,
    draftOperationId: id,
    publicationOperationId: null,
    publishedAt: null,
    clarification: null,
    clarificationOperationId: null,
    clarifiedAt: null,
    answer: null,
    answerOperationId: null,
    answeredAt: null,
  };
}
function view(): SampleFeedbackView {
  return {
    kind: "ready",
    evidenceId: id,
    submissionId: id,
    title: "<Invented title>",
    source: "echo echo",
    sourceSha256: "a".repeat(64),
    sourceRevision: 1,
    consent: true,
    records: [],
    next: null,
  };
}
function expectUnverifiedAuthorship(html: string) {
  expect(html).not.toContain("HUMAN-AUTHORED");
  expect(html).toContain("PRIVATE SAMPLE FEEDBACK · NOT FORMAL ASSESSMENT");
  expect(html).toContain(
    "Reviewer account attribution does not verify human authorship.",
  );
}
it("AHO-05 presents published assignment feedback as private member work without a formal assessment claim", () => {
  const html = sampleFeedbackPage(
    {
      ...view(),
      records: [{ ...record(), publishedAt: new Date("2026-10-27T12:00:00Z") }],
      assignmentOrigin: {
        kind: "member-assignment-submission",
        attemptId: id,
        sequence: 1,
        contentId: "ASSIGN-OWN",
        contentVersion: 2,
        rubricVersion: 1,
        submittedAt: new Date("2026-10-27T11:00:00Z"),
        sourceSha256: "a".repeat(64),
        acknowledgedAt: new Date("2026-10-27T11:10:00Z"),
        label: "Member assignment submission · private · unreviewed",
      },
    },
    "csrf",
    false,
  );
  expect(html).toContain("PRIVATE ASSIGNMENT FEEDBACK · NOT FORMAL ASSESSMENT");
  expect(html).toContain("Published assignment feedback");
  expect(html).toContain(
    "Reviewer account attribution does not verify human authorship.",
  );
  expect(html).not.toContain("Published sample feedback");
  expect(html).not.toContain("Reserved test-minute receipts");
  expect(html).not.toContain("Reserve review test minutes");
});
it("PREPARED-03 identifies a provided unreviewed source to member and reviewer without claiming authorship or assessment", () => {
  const template = PREPARED_SAMPLES[0]!;
  for (const reviewer of [false, true]) {
    const html = sampleFeedbackPage(
      {
        ...view(),
        source: template.text,
        origin: {
          kind: "platform-provided-invented",
          templateId: template.id,
          templateVersion: 1,
          templateDigest: template.digest,
          acknowledgedAt: new Date(),
          label: PROVIDED_SAMPLE_LABEL,
        },
      },
      "csrf",
      reviewer,
    );
    expect(html).toContain(PROVIDED_SAMPLE_LABEL);
    expect(html).toContain(template.digest);
    expect(html).not.toContain("Provided-example origin is not recorded");
    expectUnverifiedAuthorship(html);
  }
});
it("encodes path identifiers instead of allowing injected query or markup", () => {
  expect(sampleFeedbackPath("a/b?c")).toBe("/evidence/a%2Fb%3Fc/feedback");
  expect(sampleFeedbackPath(id, true)).toBe(`/review/evidence/${id}/feedback`);
});
it("reopens the saved draft at its exact quote occurrence and publishes only that version", () => {
  const v = view();
  v.records = [record()];
  const html = sampleFeedbackPage(v, "csrf", true);
  expectUnverifiedAuthorship(html);
  expect(html).toContain(
    'name="occurrence0" type="number" min="1" max="1048576" value="2"',
  );
  expect(html).toContain("Publish saved draft version 2");
  expect(html).toContain("unsaved form changes are not included");
  expect(html).toContain("&lt;Clarity&gt;");
  expect(html).not.toContain("<Clarity>");
  expect(html).toContain("&lt;Invented title&gt;");
  expect(html).toContain(
    'name="reviewMinutes" type="number" min="0" max="480" value="0"',
  );
});
it("renders an empty draft without a publish action", () => {
  const html = sampleFeedbackPage(view(), "csrf", true);
  expectUnverifiedAuthorship(html);
  expect(html).toContain('name="revision" value="0"');
  expect(html).not.toContain("Publish saved feedback");
});
it("lets the owner ask one clarification on published feedback", () => {
  const v = view();
  v.records = [{ ...record(), publishedAt: new Date("2026-10-03T12:00:00Z") }];
  const html = sampleFeedbackPage(v, "csrf", false);
  expectUnverifiedAuthorship(html);
  expect(html).toContain("Reviewer reference invented-reviewer");
  expect(html).toContain(
    "source version 1 · published 2026-10-03T12:00:00.000Z",
  );
  expect(html).toContain("Send clarification");
  expect(html).not.toContain("Send answer");
  expect(html).toContain(
    "preparation: not supplied minutes; review: 0 minutes",
  );
  expect(html).toContain("&lt;Explain&gt;");
});
it("offers only the original reviewer's answer form after a clarification", () => {
  const v = view();
  v.records = [
    {
      ...record(),
      publishedAt: new Date(),
      clarification: "<Question>",
      preparationMinutes: 4,
      reviewMinutes: null,
    },
  ];
  const html = sampleFeedbackPage(v, "csrf", true);
  expect(html).toContain("Send answer");
  expect(html).not.toContain("Send clarification");
  expect(html).toContain("&lt;Question&gt;");
  expect(html).toContain(
    "preparation: 4 minutes; review: not supplied minutes",
  );
  expect(sampleFeedbackPage(v, "csrf", false)).not.toContain(
    "Send clarification",
  );
});
it("shows completed exchange without another answer or clarification form", () => {
  const v = view();
  const original = record();
  original.criteria[0]!.comment =
    "Codex-generated demonstration feedback; not a human assessment.";
  v.records = [
    {
      ...original,
      publishedAt: new Date(),
      clarification: "Question",
      answer: "<Answer>",
    },
  ];
  for (const reviewer of [true, false]) {
    const html = sampleFeedbackPage(v, "csrf", reviewer);
    expectUnverifiedAuthorship(html);
    expect(html).toContain(original.criteria[0]!.comment);
    expect(html).toContain("Reviewer reference invented-reviewer");
    expect(html).toContain("&lt;Answer&gt;");
    expect(html).not.toContain("Send answer");
    expect(html).not.toContain("Send clarification");
  }
});
it("withdrawal retains published feedback but disables new exchanges", () => {
  const v = view();
  v.consent = false;
  v.records = [{ ...record(), publishedAt: new Date() }];
  v.next = id;
  const html = sampleFeedbackPage(v, "csrf", false);
  expectUnverifiedAuthorship(html);
  expect(html).toContain("Consent withdrawn");
  expect(html).toContain("Published sample feedback");
  expect(html).not.toContain("Send clarification");
  expect(html).toContain(`?after=${id}`);
});
it("keeps attempted text copyable while omitting hidden request credentials", () => {
  const html = sampleFeedbackRecovery("<Title>", "<Message>", "/safe?a=1&b=2", {
    csrf: "secret",
    operationId: "hidden-operation",
    revision: "123",
    confirm: "yes",
    message: "</textarea><script>bad</script>",
  });
  expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;bad&lt;/script&gt;");
  expect(html).not.toContain("hidden-operation");
  expect(html).not.toContain("secret");
  expect(html).toContain("/safe?a=1&amp;b=2");
  expect(sampleFeedbackRecovery("Title", "Message", "/safe")).not.toContain(
    "Your attempted text",
  );
});

it.each(["allocated", "begun", "completed", "needs_reconciliation"] as const)(
  "shows only appropriate controls for a %s review allocation",
  (state) => {
    for (const writesEnabled of [true, false]) {
      const v = view();
      v.records = [record()];
      v.reviewAllocation = {
        grantId: id,
        writesEnabled,
        receipt: {
          allocationId: id,
          state,
          ceiling: 20,
          held: 20,
          consumed: 0,
          released: 0,
          reviewMinutes: 0,
          preparationMinutes: 0,
          sourceAvailable: true,
        },
      };
      const html = sampleFeedbackPage(v, "csrf", true);
      expect(html.includes("Begin reserved review")).toBe(
        writesEnabled && state === "allocated",
      );
      expect(html.includes("Publish saved feedback")).toBe(
        writesEnabled && state === "begun",
      );
      if (writesEnabled && state === "begun") {
        expect(html).toContain('name="allocationId"');
        expect(html).toContain('name="grantId"');
        for (const name of [
          "reviewStart",
          "reviewEnd",
          "preparationStart",
          "preparationEnd",
        ])
          expect(html).toContain(`name="${name}"`);
      }
      expect(html.includes("New review work is paused")).toBe(!writesEnabled);
    }
  },
);
it("keeps manual publication recovery scoped to original fields and escapes attempted values", () => {
  const html = sampleFeedbackRecovery(
    "Uncertain",
    "Inspect first",
    "/review/evidence/source/feedback",
    {
      operationId: '"<original>',
      revision: "1",
      allocationId: id,
      grantId: id,
      reviewStart: "start",
      reviewEnd: "end",
      csrf: "old-token",
      unexpected: "not-a-posted-field",
    },
    { csrf: "fresh-token" },
  );
  expect(html).toContain('name="operationId" value="&quot;&lt;original&gt;"');
  expect(html).toContain('name="csrf" value="fresh-token"');
  expect(html).not.toContain('name="unexpected"');
  expect(html).not.toContain('name="preparationStart"');
  expect(html).not.toContain("old-token");
  expect(html).not.toContain('value=""<original>"');
  expect(
    sampleFeedbackRecovery(
      "Uncertain",
      "Inspect first",
      "/evidence",
      undefined,
      { csrf: "fresh-token" },
    ),
  ).not.toContain("Reconcile original publication");
});
