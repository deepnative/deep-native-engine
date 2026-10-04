import { expect, it } from "vitest";
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
it("encodes path identifiers instead of allowing injected query or markup", () => {
  expect(sampleFeedbackPath("a/b?c")).toBe("/evidence/a%2Fb%3Fc/feedback");
  expect(sampleFeedbackPath(id, true)).toBe(`/review/evidence/${id}/feedback`);
});
it("reopens the saved draft at its exact quote occurrence and publishes only that version", () => {
  const v = view();
  v.records = [record()];
  const html = sampleFeedbackPage(v, "csrf", true);
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
  expect(html).toContain('name="revision" value="0"');
  expect(html).not.toContain("Publish saved feedback");
});
it("lets the owner ask one clarification on published feedback", () => {
  const v = view();
  v.records = [{ ...record(), publishedAt: new Date("2026-10-03T12:00:00Z") }];
  const html = sampleFeedbackPage(v, "csrf", false);
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
  v.records = [
    {
      ...record(),
      publishedAt: new Date(),
      clarification: "Question",
      answer: "<Answer>",
    },
  ];
  for (const reviewer of [true, false]) {
    const html = sampleFeedbackPage(v, "csrf", reviewer);
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
