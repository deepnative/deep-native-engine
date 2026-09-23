import { expect, it } from "vitest";
import { learningPlan } from "../../src/learning-plan.ts";

it("keeps a general learner's 15-minute week within the time they selected", () => {
  const plan = learningPlan({
    goal: "everyday",
    experience: "new",
    exploratory: true,
    weeklyMinutes: 15,
  });
  expect(plan.focus).toBe("Plan a small community event");
  expect(
    plan.steps.reduce((total, step) => total + step.minutes, 0),
  ).toBeLessThanOrEqual(15);
  expect(plan.steps).toHaveLength(1);
  expect(plan.nextSession).toMatch(/exercise/i);
  expect(plan.guidance).toMatch(/starting|new/i);
  expect(plan.exploratory).toMatch(/another direction/i);
});

it("adds practice and checking for available time without promising more lessons", () => {
  const plan = learningPlan({
    goal: "work",
    experience: "some",
    exploratory: false,
    weeklyMinutes: 60,
  });
  expect(plan.focus).toBe("Turn meeting notes into next steps");
  expect(plan.steps.map((step) => step.minutes)).toEqual([12, 15, 10]);
  expect(
    plan.steps.reduce((total, step) => total + step.minutes, 0),
  ).toBeLessThanOrEqual(60);
  expect(plan.nextSession).toBeNull();
  expect(plan.exploratory).toBeNull();
});

it("uses an honest starter when time is unknown and offers technical practice without coding", () => {
  const plan = learningPlan({
    goal: "build",
    experience: "experienced",
    exploratory: false,
    weeklyMinutes: null,
  });
  expect(plan.focus).toBe("Review a sign-up flow");
  expect(plan.steps).toHaveLength(1);
  expect(plan.nextSession).toMatch(/choose weekly time/i);
  expect(plan.guidance).toMatch(/experienced/i);
  expect(JSON.stringify(plan)).not.toMatch(/coaching|purchase|booking/i);
});

it("fits a 30-minute week and treats unspecified experience as a beginner-friendly start", () => {
  const plan = learningPlan({
    goal: "work",
    experience: null,
    exploratory: false,
    weeklyMinutes: 30,
  });
  expect(plan.steps.map((step) => step.minutes)).toEqual([12, 15]);
  expect(plan.guidance).toMatch(/starting|new/i);
});
