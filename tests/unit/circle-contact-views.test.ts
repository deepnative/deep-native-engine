import { expect, it } from "vitest";
import { circlesPage } from "../../src/views.ts";

for (const discussionEnabled of [false, true]) {
  it(`CIRCONTACT-01/02 offers the selected moderation contact with no service promise when discussion is ${discussionEnabled ? "enabled" : "paused"}`, () => {
    const html = circlesPage([], "everyday", "csrf", discussionEnabled);
    expect(html).toContain("Circle moderation contact");
    expect(html).toContain('href="mailto:info@deepnative.io"');
    expect(html).toContain("No response time or backup coverage is promised.");
    expect(html).toContain(
      "Use the report action on a specific shared contribution",
    );
    expect(html).toContain(
      "Keep private assignments and evidence out of email.",
    );
    expect(html).toContain("NO LIVE COMMUNITY");
    expect(html).toContain(
      "Joining is optional and grants no paid service or staff role.",
    );
    expect(html).toContain(
      discussionEnabled
        ? "Invented discussion is available only after a separate circle sharing choice."
        : "New discussion sharing is paused.",
    );
  });
}
