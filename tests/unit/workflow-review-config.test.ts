import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
import { workflowBundle } from "../../src/workflow-registry.ts";
import { workflowFeedbackPage } from "../../src/views.ts";
const env = {
  DNE_DATABASE_URL:
    "postgresql://localhost/dne_test_0123456789abcdef0123456789abcdef",
  DNE_APP_MODE: "test",
  DNE_PORT: "0",
};
it("WFREV-08 review requests default off, require exact explicit configuration and cannot authorize live hosting", () => {
  expect(config(env).workflowReviewRequests).toBe(false);
  expect(
    config({ ...env, DNE_WORKFLOW_REVIEW_REQUESTS: "disabled" })
      .workflowReviewRequests,
  ).toBe(false);
  expect(
    config({ ...env, DNE_WORKFLOW_REVIEW_REQUESTS: "enabled" })
      .workflowReviewRequests,
  ).toBe(true);
  for (const value of ["true", "1", "", "Enabled", "enabled "])
    expect(() =>
      config({ ...env, DNE_WORKFLOW_REVIEW_REQUESTS: value }),
    ).toThrow("DNE_WORKFLOW_REVIEW_REQUESTS must be enabled or disabled.");
  expect(() =>
    config({
      ...env,
      DNE_APP_MODE: "live",
      DNE_WORKFLOW_REVIEW_REQUESTS: "enabled",
    }),
  ).toThrow(
    "Live application hosting requires a separately authorized configuration.",
  );
});
it.each([true, false])(
  "WFREV-01/08 configured private note offers new request only when enabled=%s and retains history",
  async (enabled) => {
    const bundle = await workflowBundle("WF-001");
    if (!bundle) throw Error("Trusted workflow required");
    const html = workflowFeedbackPage(
      bundle,
      [
        {
          workflowId: "WF-001",
          workflowVersion: 1,
          revision: 1,
          note: "Invented own private note",
          createdAt: new Date("2026-10-07T09:00:00Z"),
          updatedAt: new Date("2026-10-07T09:00:00Z"),
        },
      ],
      "csrf",
      "WF-001",
      { configured: true, enabled },
    );
    expect(html).toContain("Saving this note does not share it");
    expect(html).toContain('href="/workflow-feedback/review/history"');
    expect(html.includes('href="/workflow-feedback/WF-001/review"')).toBe(
      enabled,
    );
    expect(html).toContain("Invented own private note");
  },
);
