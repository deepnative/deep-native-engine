import { expect, it } from "vitest";
import { withMemberContributions } from "../../src/hosting-presentation.ts";
import { workflowBundle } from "../../src/workflow-registry.ts";
import {
  dashboard,
  proposalEditRecoveryPage,
  proposalListPage,
  workflowDetailPage,
} from "../../src/views.ts";

// WFB-NORMAL-03 (#115): when member contributions are on, proposal pages
// describe private drafting, editorial acceptance and the separate member
// sharing choice. They stop calling every proposal a sample that cannot be
// published. With contributions off, the sample wording stays.
const learner = {
  id: "a",
  background: "explorer" as const,
  goal: "everyday" as const,
};
const attempted = { title: "T", body: "B", sources: "S" };
const bundle = (await workflowBundle("WF-001"))!;
const pages = () => ({
  workflow: workflowDetailPage(bundle),
  learn: dashboard(learner, undefined, "csrf"),
  list: proposalListPage([], "csrf", null, true),
  edit: proposalEditRecoveryPage("p", "csrf", "Check the title.", attempted, 2),
  unsaved: proposalEditRecoveryPage("p", "csrf", "Unconfirmed.", attempted),
});

it("WFB-NORMAL-03 describes private drafting and separate member sharing when contributions are on", () => {
  const on = withMemberContributions(true, pages);
  expect(on.workflow).toContain(
    '<a href="/contribute?workflow=WF-001">private version-pinned improvement proposal</a>',
  );
  expect(on.workflow).toContain(
    "It stays private until editorial acceptance and your separate choice to share it with signed-in members. Nothing in it is executed.",
  );
  expect(on.workflow).not.toContain("It will not be published");
  expect(on.learn).toContain(
    '<a href="/contribute">Draft a private contribution</a>',
  );
  expect(on.learn).toContain(
    '<a href="/contributions">Read member contributions</a>',
  );
  expect(on.learn).toContain(
    "Contributions stay private until editorial acceptance and your separate choice to share them with signed-in members.",
  );
  expect(on.learn).not.toContain("sample contribution");
  expect(on.learn).not.toContain("reviewed publication remain pending");
  expect(on.learn).toContain("Live community services remain pending.");
  expect(on.list).toContain("No private proposals yet.");
  expect(on.list).not.toContain("No sample proposals yet.");
  for (const html of [on.edit, on.unsaved]) {
    expect(html).toContain("PRIVATE PROPOSAL · ");
    expect(html).not.toContain("PRIVATE SAMPLE");
  }
  expect(on.edit).toContain(">Original contribution</label>");
  expect(on.unsaved).toContain(
    '<label for="unsaved-proposal-body">Attempted text</label>',
  );
});

it("WFB-NORMAL-03 keeps the sample wording while contributions are off", () => {
  for (const off of [pages(), withMemberContributions(false, pages)]) {
    expect(off.workflow).toContain("private version-pinned sample proposal");
    expect(off.workflow).toContain(
      "It will not be published or executed from this preview.",
    );
    expect(off.learn).toContain("Draft a private sample contribution");
    expect(off.learn).toContain(
      "Live community services and reviewed publication remain pending.",
    );
    expect(off.learn).not.toContain('href="/contributions"');
    expect(off.edit).toContain("PRIVATE SAMPLE · CORRECTIONS NOT SAVED");
    expect(off.edit).toContain(">Original sample</label>");
    expect(off.unsaved).toContain("Attempted sample");
  }
  expect(proposalListPage([], "csrf")).toContain("No sample proposals yet.");
});

// WFB-LABEL-01/02 (#115): when the proposal is known, a failed correction
// uses that proposal's own wording, as its preview page does, whatever the
// site-wide switch says.
it("WFB-LABEL-01 a failed correction of a proposal created as a sample keeps the sample wording while contributions are on", () => {
  const html = withMemberContributions(true, () => ({
    edit: proposalEditRecoveryPage(
      "p",
      "csrf",
      "Check the title.",
      attempted,
      2,
      false,
      "sample",
    ),
    unsaved: proposalEditRecoveryPage(
      "p",
      "csrf",
      "Unconfirmed.",
      attempted,
      undefined,
      true,
      "sample",
    ),
  }));
  expect(html.edit).toContain("PRIVATE SAMPLE · CORRECTIONS NOT SAVED");
  expect(html.edit).toContain(">Original sample</label>");
  expect(html.edit).not.toContain("Original contribution");
  expect(html.unsaved).toContain("PRIVATE SAMPLE · OUTCOME UNCONFIRMED");
  expect(html.unsaved).toContain("Attempted sample");
});

it("WFB-LABEL-02 a failed correction of a member contribution uses the contribution wording, also with the site-wide switch off", () => {
  for (const enabled of [true, false]) {
    const html = withMemberContributions(enabled, () => ({
      edit: proposalEditRecoveryPage(
        "p",
        "csrf",
        "Check the title.",
        attempted,
        2,
        false,
        "member",
      ),
      unsaved: proposalEditRecoveryPage(
        "p",
        "csrf",
        "Unconfirmed.",
        attempted,
        undefined,
        false,
        "member",
      ),
    }));
    expect(html.edit).toContain("PRIVATE CONTRIBUTION · CORRECTIONS NOT SAVED");
    expect(html.edit).toContain(">Original contribution</label>");
    expect(html.unsaved).toContain("Attempted text");
    expect(html.unsaved).not.toContain("PRIVATE SAMPLE");
  }
});
