import { expect, it } from "vitest";
import { workflowBundle } from "../../src/workflow-registry.ts";
import { workflowDetailPage, workflowFeedbackPage } from "../../src/views.ts";

it("shows private current and historical notes without publishing them on the workflow page", async () => {
  const bundle = await workflowBundle("WF-001");
  expect(bundle).not.toBeNull();
  const reports = [
    {
      workflowId: "WF-001",
      workflowVersion: bundle!.version,
      note: "<Invented & private>",
      revision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      workflowId: "WF-001",
      workflowVersion: bundle!.version + 1,
      note: "Historical invented response",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
  const privatePage = workflowFeedbackPage(bundle, reports, "csrf", "WF-001");
  expect(privatePage).toContain("&lt;Invented &amp; private&gt;");
  expect(privatePage).not.toContain("<Invented & private>");
  expect(privatePage).toContain("Historical version notes");
  expect(privatePage).toContain('name="revision" value="2"');
  expect(privatePage).toContain("not a publication request");
  const publicPage = workflowDetailPage(bundle!);
  expect(publicPage).toContain("Save private feedback about this draft");
  expect(publicPage).not.toContain("Invented &amp; private");
  const unavailable = workflowFeedbackPage(null, reports, "csrf", "WF-001");
  expect(unavailable).toContain("workflow draft is unavailable");
  expect(unavailable).not.toContain("Save private feedback</button>");
  expect(workflowFeedbackPage(bundle, [], "csrf", "WF-001")).toContain(
    'name="revision" value="0"',
  );
});
