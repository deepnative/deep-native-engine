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

it("advances a completed 15-minute starter plan without asking for the same exercise", () => {
  const plan = learningPlan(
    { goal: "everyday", experience: "new", weeklyMinutes: 15 },
    { completed_at: new Date(), goal_at_start: "everyday" },
  );
  expect(plan.status).toMatch(/completed.*current goal/i);
  expect(plan.steps).toEqual([]);
  expect(plan.nextSession).toMatch(/review your saved/i);
  expect(plan.nextHref).toBe("/lesson");
  expect(JSON.stringify(plan)).not.toMatch(/try the sample exercise/i);
});

it("keeps earlier-goal completion historical after a goal switch", () => {
  const plan = learningPlan(
    { goal: "work", experience: "some", weeklyMinutes: 60 },
    { completed_at: new Date(), goal_at_start: "everyday" },
  );
  expect(plan.focus).toBe("Turn meeting notes into next steps");
  expect(plan.status).toMatch(/earlier goal/i);
  expect(plan.status).not.toContain("completed for your current goal");
  expect(plan.steps).toEqual([]);
  expect(plan.nextHref).toBe("/library");
  expect(JSON.stringify(plan)).not.toMatch(/try the sample exercise/i);
});

it("keeps a withdrawn completion without asking to review erased answers", () => {
  const plan = learningPlan(
    { goal: "everyday", weeklyMinutes: 15 },
    {
      completed_at: new Date(),
      goal_at_start: "everyday",
      withdrawn_at: new Date(),
    },
  );
  expect(plan.status).toMatch(/completed.*withdrawn/i);
  expect(plan.nextSession).not.toMatch(/saved starter exercise|its checks/i);
  expect(plan.nextHref).toBe("/library");
});

it("does not assign an unrecorded completion to the current goal", () => {
  const plan = learningPlan(
    { goal: "build", weeklyMinutes: 30 },
    { completed_at: new Date(), goal_at_start: null },
  );
  expect(plan.status).toMatch(/no recorded goal/i);
  expect(plan.status).toMatch(/does not count.*current goal/i);
  expect(plan.steps).toEqual([]);
  expect(plan.nextHref).toBe("/library");
  expect(plan.nextLinkLabel).toBe("Browse published sample library");
});

it("reports a withdrawn earlier-goal completion without offering erased work", () => {
  const plan = learningPlan(
    { goal: "work", weeklyMinutes: 60 },
    {
      completed_at: new Date(),
      goal_at_start: "everyday",
      withdrawn_at: new Date(),
    },
  );
  expect(plan.status).toMatch(/earlier goal.*saved answers withdrawn/i);
  expect(plan.nextSession).toMatch(/browse published sample lessons/i);
  expect(plan.nextHref).toBe("/library");
  expect(JSON.stringify(plan)).not.toMatch(/try the sample exercise/i);
});

it("keeps withdrawn unrecorded-goal completion out of the current-goal plan", () => {
  const plan = learningPlan(
    { goal: "work", weeklyMinutes: 15 },
    { completed_at: new Date(), goal_at_start: null, withdrawn_at: new Date() },
  );
  expect(plan.status).toMatch(/no recorded goal.*saved answers withdrawn/i);
  expect(plan.status).toMatch(/does not count.*current goal/i);
  expect(plan.nextHref).toBe("/library");
});
