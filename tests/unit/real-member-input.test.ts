import { expect, it } from "vitest";
import { parseCareerDraft, parseCareerEntry } from "../../src/career.ts";
import {
  inventedInputOnly,
  privateRecordsLabel,
  withHosting,
} from "../../src/hosting-presentation.ts";
import { parseMilestone } from "../../src/milestones.ts";
import { careerPage } from "../../src/views.ts";

const milestone = {
  goal_title: "Plan my real project",
  milestone_title: "Write the first draft",
  next_action: "Ask one clearer question",
};
const entry = {
  kind: "career",
  title: "My real career note",
  next_action: "Ask one clearer question",
};
const draft = {
  kind: "professional",
  title: "My real draft",
  body: "A real draft that is long enough to save.",
};
const SAMPLE_ERROR =
  "Confirm that you used only invented or sample information.";

it("REALINPUT-03 only a validated hosted request lifts the invented-input rule", () => {
  expect(inventedInputOnly()).toBe(true);
  expect(withHosting(false, inventedInputOnly)).toBe(true);
  expect(withHosting(true, inventedInputOnly)).toBe(false);
});

it("REALINPUT-02/03 milestone and career parsing require the attestation only locally", () => {
  for (const parse of [
    () => parseMilestone(milestone, "UTC").errors,
    () => parseCareerEntry(entry).errors,
    () => parseCareerDraft(draft).errors,
  ]) {
    expect(parse()).toContain(SAMPLE_ERROR);
    expect(withHosting(true, parse)).not.toContain(SAMPLE_ERROR);
  }
  // Other limits still apply when hosted.
  expect(
    withHosting(
      true,
      () => parseCareerDraft({ ...draft, body: "short" }).errors,
    ),
  ).toContain("Write a draft between 20 and 4,000 characters.");
});

it("REALINPUT-01 career forms replace the checkbox with the privacy note when hosted", () => {
  const render = () =>
    careerPage({ enabled: true, entries: [], drafts: [] }, "csrf");
  const hosted = withHosting(true, render);
  expect(hosted).not.toContain('name="sample_only"');
  expect(hosted).not.toContain("invented");
  expect(hosted).not.toContain("sample information only");
  expect(hosted).toContain("Leave out passwords");
  const local = render();
  expect(local).toContain('name="sample_only"');
  expect(local).toContain("Use invented information only.");
  expect(local).not.toContain("Leave out passwords");
});

it("HOSTEDCOPY-01/02 the records download label follows the runtime", () => {
  expect(privateRecordsLabel()).toBe("Download private preview records");
  expect(withHosting(true, privateRecordsLabel)).toBe(
    "Download my private records",
  );
});
