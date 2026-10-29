import { expect, it } from "vitest";
import { learningWorkspacePage } from "../../src/learning-workspace-views.ts";
import { LEARNING_WORKSPACE_ASSET_BASE } from "../../src/learning-workspace-assets.ts";

it("LWORK-01/07 gives the account reader its private context and preserves earlier learning and account recovery", () => {
  for (const route of ["everyday", "work", "technical"] as const) {
    const html = learningWorkspacePage(route, '"<unsafe>');
    expect(html).toContain(`data-workspace-route="${route}"`);
    expect(html).toContain(
      `data-workspace-module-base="${LEARNING_WORKSPACE_ASSET_BASE}"`,
    );
    expect(html).toContain('data-workspace-csrf="&quot;&lt;unsafe&gt;"');
    expect(html).toContain(`${LEARNING_WORKSPACE_ASSET_BASE}/style.css`);
    expect(html).toContain('src="/assets/learning-workspace.js"');
    expect(html).toContain('aria-label="Account and learning services"');
    for (const path of [
      "/account",
      "/learn/notebooks",
      "/learn/records",
      "/support",
      "/member/export",
    ])
      expect(html).toContain(`href="${path}"`);
    expect(html).toContain("Signed in");
    expect(html).toContain("<noscript>");
    expect(html).not.toContain("local-entry.mjs");
  }
});
