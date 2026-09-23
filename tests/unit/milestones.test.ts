import { it, expect } from "vitest";
import { parseMilestone, validMilestoneId } from "../../src/milestones.ts";

const fields = {
  goal_title: "Understand AI for daily decisions",
  milestone_title: "Compare two invented answers",
  evidence_note: "I compared the sources and identified an uncertainty.",
  next_action: "Ask one clearer question",
  sample_only: "yes",
};

it("accepts a private noncoding milestone and an optional local reminder without scheduling it", () => {
  expect(parseMilestone(fields, null)).toEqual({
    input: {
      goalTitle: fields.goal_title,
      milestoneTitle: fields.milestone_title,
      evidenceNote: fields.evidence_note,
      nextAction: fields.next_action,
      reminderDate: null,
      reminderTime: null,
      reminderTimezone: null,
      selfReportedComplete: false,
    },
    errors: [],
  });
  expect(
    parseMilestone(
      {
        ...fields,
        complete: "yes",
        reminder_date: "2028-02-29",
        reminder_time: "14:30",
      },
      "America/Toronto",
    ),
  ).toMatchObject({
    errors: [],
    input: {
      reminderDate: "2028-02-29",
      reminderTime: "14:30",
      reminderTimezone: "America/Toronto",
      selfReportedComplete: true,
    },
  });
});

it("rejects false completion, unconfirmed data and invalid local reminder fields", () => {
  const result = parseMilestone(
    {
      goal_title: "no",
      milestone_title: "x",
      evidence_note: "short",
      next_action: "",
      complete: "yes",
      reminder_date: "2027-02-29",
      reminder_time: "24:80",
    },
    null,
  );
  expect(result.errors).toHaveLength(7);
  expect(result.errors.join(" ")).toContain("evidence note");
  expect(result.errors.join(" ")).toContain("time zone");
  expect(
    parseMilestone({ ...fields, complete: "true" }, null).errors,
  ).toContain("Choose a valid completion state.");
  expect(
    parseMilestone({ ...fields, evidence_note: "x".repeat(1001) }, null).errors,
  ).toContain("Keep the evidence note within 1,000 characters.");
  expect(
    parseMilestone({ ...fields, next_action: "x".repeat(501) }, null).errors,
  ).toContain("Write a next action between 3 and 500 characters.");
  expect(
    parseMilestone({ ...fields, goal_title: "x".repeat(161) }, null).errors,
  ).toContain("Write a goal between 3 and 160 characters.");
  expect(
    parseMilestone({ ...fields, milestone_title: "x".repeat(161) }, null)
      .errors,
  ).toContain("Write a milestone between 3 and 160 characters.");
  expect(
    parseMilestone({ ...fields, reminder_date: "2029-01-01" }, "UTC").errors,
  ).toContain("Choose a valid local reminder date and time together.");
  expect(
    parseMilestone(
      { ...fields, reminder_date: "2019-12-31", reminder_time: "09:00" },
      "UTC",
    ).errors,
  ).toContain("Choose a valid local reminder date and time together.");
  expect(
    parseMilestone(
      { ...fields, reminder_date: "2101-01-01", reminder_time: "09:00" },
      "UTC",
    ).errors,
  ).toContain("Choose a valid local reminder date and time together.");
  expect(
    parseMilestone(
      { ...fields, reminder_date: "2028/02/29", reminder_time: "09:00" },
      "UTC",
    ).errors,
  ).toContain("Choose a valid local reminder date and time together.");
});

it("accepts only UUIDs as milestone route identifiers", () => {
  expect(validMilestoneId("a4ff1471-0226-4d5b-8677-99c0a94cdf40")).toBe(true);
  expect(validMilestoneId("not-an-id")).toBe(false);
});
