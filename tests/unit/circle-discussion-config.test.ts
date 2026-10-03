import { expect, it } from "vitest";
import { config } from "../../src/config.ts";
import { circlesPage } from "../../src/views.ts";
import { CIRCLES } from "../../src/circles.ts";
const database = "postgresql://dne:sample@127.0.0.1:54329/dne_dev";
it("requires explicit local discussion configuration and rejects invalid flags or live hosting", () => {
  expect(config({ DNE_DATABASE_URL: database }).circleDiscussion).toBe(false);
  expect(
    config({ DNE_DATABASE_URL: database, DNE_CIRCLE_DISCUSSION: "disabled" })
      .circleDiscussion,
  ).toBe(false);
  expect(
    config({ DNE_DATABASE_URL: database, DNE_CIRCLE_DISCUSSION: "enabled" })
      .circleDiscussion,
  ).toBe(true);
  expect(() =>
    config({ DNE_DATABASE_URL: database, DNE_CIRCLE_DISCUSSION: "yes" }),
  ).toThrow("DNE_CIRCLE_DISCUSSION must be enabled or disabled.");
  expect(() =>
    config({
      DNE_DATABASE_URL: database,
      DNE_CIRCLE_DISCUSSION: "enabled",
      DNE_APP_MODE: "live",
    }),
  ).toThrow();
});
it("offers deliberate sharing only while enabled and preserves owned history navigation while paused", () => {
  const items = CIRCLES.map((circle) => ({
    ...circle,
    joined: true,
    seatsRemaining: 3,
  }));
  const enabled = circlesPage(items, "everyday", "csrf", true),
    paused = circlesPage(items, "everyday", "csrf", false);
  expect(enabled).toContain("separate circle sharing choice");
  expect(enabled).toContain("Choose invented discussion sharing");
  expect(enabled).toContain("Read circle questions");
  expect(paused).toContain("New discussion sharing is paused");
  expect(paused).not.toContain("Choose invented discussion sharing");
  expect(paused).not.toContain("Read circle questions");
  for (const html of [enabled, paused]) {
    expect(html).toContain("Your retained circle contributions");
    expect(html).toContain("Your name and private learning work are not shown");
    expect(html).toContain("/circles/everyday-ai/leave");
  }
});
