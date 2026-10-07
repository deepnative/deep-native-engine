import { expect, it } from "vitest";
import {
  REHEARSAL_TEMPLATE,
  rehearsalInstruction,
  rehearsalSnapshot,
  checkedRehearsalSnapshot,
} from "../../src/event-rehearsal-values.ts";

const instruction = {
  templateId: "local-registration-rehearsal",
  templateVersion: 1,
  startsAt: "2026-10-07T15:30:00.000Z",
};

it("REHSCHED-01/04 accepts an exact trusted template and shows its unchanged content/capacity with the chosen UTC schedule", () => {
  const prior = JSON.stringify(REHEARSAL_TEMPLATE);
  expect(rehearsalInstruction(instruction)).toEqual(instruction);
  expect(rehearsalSnapshot(instruction)).toEqual({
    ...instruction,
    title: REHEARSAL_TEMPLATE.title,
    endsAt: "2026-10-07T16:30:00.000Z",
    capacity: 1,
    templateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(REHEARSAL_TEMPLATE)).toBe(prior);
  expect(REHEARSAL_TEMPLATE.startsAt).toBe("2030-11-03T05:30:00.000Z");
});

it("REHSCHED-01/06 accepts only the entire checked snapshot during confirmation or exact recovery", () => {
  const snapshot = rehearsalSnapshot(instruction)!;
  expect(checkedRehearsalSnapshot(snapshot)).toEqual(snapshot);
  for (const changed of [
    null,
    [],
    "rehearsal",
    {},
    instruction,
    { ...snapshot, title: "Different title" },
    { ...snapshot, capacity: 2 },
    { ...snapshot, endsAt: "2026-10-07T17:30:00.000Z" },
    { ...snapshot, templateDigest: "0".repeat(64) },
    { ...snapshot, templateVersion: 2 },
    { ...snapshot, unexpected: "field" },
  ])
    expect(checkedRehearsalSnapshot(changed)).toBeNull();
});

it("REHSCHED-04 rejects malformed or changed instructions instead of changing trusted content or normalizing a different instant", () => {
  const invalid = [
    undefined,
    null,
    "rehearsal",
    [],
    {},
    { ...instruction, title: "Real expert clinic" },
    {
      templateId: instruction.templateId,
      templateVersion: 1,
      unexpected: "value",
    },
    { ...instruction, startsAt: undefined, unexpected: "value" },
    { ...instruction, templateId: "another-template" },
    { ...instruction, templateVersion: 2 },
    { ...instruction, templateVersion: "1" },
    { ...instruction, startsAt: 1 },
    { ...instruction, startsAt: "2026-10-07T15:30:00Z" },
    { ...instruction, startsAt: "2026-10-07T15:30:00+00:00" },
    { ...instruction, startsAt: "2026-99-07T15:30:00.000Z" },
    { ...instruction, startsAt: "2026-02-30T15:30:00.000Z" },
  ];
  for (const value of invalid) {
    expect(rehearsalInstruction(value)).toBeNull();
    expect(rehearsalSnapshot(value)).toBeNull();
  }
});
