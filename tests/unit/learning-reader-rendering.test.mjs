import { describe, expect, it, vi } from "vitest";
import { mountReader } from "../../assets/docs/learning-design/reader/reader.mjs";
import { addFeedbackDecision } from "../../assets/docs/learning-design/reader/feedback.mjs";
import {
  readerDom,
  readyNotebook,
} from "../support/learning-reader-unit-fixture.mjs";

const titles = [
  "Choose a task you can check",
  "Write a useful request",
  "Check an answer against its source",
  "Choose what to use and share",
  "Build a small repeatable workflow",
  "Give feedback someone can use",
];
// These answer keys and source excerpts are independently authored expectations,
// not read from the implementation's answer fields at test time.
const routes = {
  everyday: {
    source: [
      "Twelve volunteers",
      "Twelve volunteers",
      "Twelve volunteers",
      "six helpers, forty seed packets",
      "six helpers available",
      "six helpers and forty packets",
    ],
    fresh: [
      "eight helpers",
      "six helpers",
      "nine people",
      "ten helpers",
      "Four helpers",
      "nine people",
    ],
    keys: [
      ["B"],
      ["C"],
      ["Supported", "Contradicted", "Not given"],
      ["B"],
      ["B"],
      ["A"],
    ],
  },
  work: {
    source: [
      "Sam will write",
      "Sam writes",
      "assigned owner is Sam",
      "client's name",
      "Mina drafts",
      "Mina drafts",
    ],
    fresh: [
      "three comments",
      "Mina drafts",
      "Noor",
      "eighteen support requests",
      "Jo on Friday",
      "Noor",
    ],
    keys: [
      ["A"],
      ["B"],
      ["Supported", "Contradicted", "Not given"],
      ["C"],
      ["C"],
      ["C"],
    ],
  },
  technical: {
    source: [
      "email and password",
      "email and password",
      "No tests have been run",
      "access token",
      "contact form requires",
      "No tests have been run",
    ],
    fresh: [
      "PDFs up to 2 MB",
      "blank message",
      "PNG images up to 4 MB",
      "PDF up to 2 MB",
      "3 MB PDF",
      "PDFs up to 2 MB",
    ],
    keys: [
      ["C"],
      ["A"],
      ["Supported", "Contradicted", "Not given"],
      ["A"],
      ["A"],
      ["B"],
    ],
  },
};

async function mounted(
  route,
  overrides = {},
  storageOverrides = {},
  document = {},
) {
  const dom = readerDom(route);
  const storage = {
    mode: "account",
    load: vi.fn(async () => readyNotebook(route, overrides)),
    ...storageOverrides,
  };
  const reader = await mountReader({
    root: dom.root,
    document,
    window: dom.window,
    storage,
    initialRoute: route,
    presentation: { accountLabel: "Learner <private>" },
  });
  return { ...dom, storage, reader, session: reader.getSession(route) };
}

describe("LWORK-01 account reader rendering", () => {
  it("keeps account lesson navigation on available account pages and the standalone walkthrough local", async () => {
    for (const mode of ["account", "browser"]) {
      const ui = await mounted("work", {}, { mode });
      ui.session.view = "lesson";
      ui.reader.render();
      if (mode === "account") {
        expect(ui.root.innerHTML).toContain('href="/learn/records"');
        expect(ui.root.innerHTML).not.toContain('href="../prototype/"');
      } else {
        expect(ui.root.innerHTML).toContain('href="../prototype/"');
      }
      ui.reader.destroy();
    }
  });
  for (const [route, expected] of Object.entries(routes)) {
    for (let index = 0; index < 6; index += 1) {
      it(`${route} lesson ${index + 1}: source, practice, correction and fresh writing remain distinct`, async () => {
        const ui = await mounted(route);
        const lesson = ui.session.state.lessons[index];
        ui.session.state.lesson = index;
        ui.session.view = "lesson";

        ui.session.state.step = 0;
        ui.reader.render();
        expect(ui.root.innerHTML).toContain(titles[index]);
        expect(ui.root.innerHTML).toContain(
          expected.source[index].replaceAll("'", "&#39;"),
        );
        expect(ui.root.innerHTML).toContain(
          `Lesson ${index + 1} · Step 1 of 4`,
        );

        ui.session.state.step = 1;
        ui.reader.render();
        expect(ui.root.innerHTML).toContain(
          index === 2 ? "Check answers" : "Check answer",
        );
        expect(ui.root.innerHTML).toContain(
          "Choose your response, then compare the explanation with the source.",
        );
        expect(ui.root.innerHTML).toMatch(
          /class="answer-feedback[^"]*"[^>]*hidden/,
        );
        lesson.selections = [...expected.keys[index]];
        ui.node("#practice-form").handlers.submit({ preventDefault() {} });
        expect(lesson.checked).toBe(true);
        expect(lesson.reviewNeeded).toBe(false);
        expect(ui.root.innerHTML).toContain(
          "This response matches the source.",
        );
        expect(ui.root.innerHTML).toContain("Practice checked");
        expect(ui.root.innerHTML).not.toContain(
          "Try another choice after comparing with the source.",
        );

        lesson.selections[0] = expected.keys[index][0] === "A" ? "B" : "A";
        ui.node("#practice-form").handlers.submit({ preventDefault() {} });
        expect(lesson.reviewNeeded).toBe(true);
        expect(ui.root.innerHTML).toContain(
          "Try another choice after comparing with the source.",
        );
        expect(ui.root.innerHTML).toContain("Revisit the practice");
        ui.session.view = "practice";
        ui.reader.render();
        expect(ui.root.innerHTML).toContain(`data-review-lesson="${index}"`);
        expect(ui.root.innerHTML).toContain(
          "Your last checked response needs another look at the source.",
        );

        ui.session.view = "lesson";
        ui.session.state.step = 2;
        ui.reader.render();
        expect(ui.root.innerHTML).toContain(expected.fresh[index]);
        expect(ui.root.innerHTML).toContain("Fresh source");
        ui.reader.destroy();
      });
    }
  }

  it("keeps a three-part source check incomplete until every response is chosen", async () => {
    const ui = await mounted("everyday");
    ui.session.view = "lesson";
    ui.session.state.lesson = 2;
    ui.session.state.step = 1;
    ui.reader.render();
    ui.session.state.lessons[2].selections = ["Supported"];
    ui.node("#practice-form").handlers.submit({ preventDefault() {} });
    expect(ui.session.state.lessons[2].checked).toBe(false);
    expect(ui.node("#practice-notice").textContent).toBe(
      "Choose a response for each question first.",
    );
    expect(ui.root.innerHTML).toContain(
      "Choose your response, then compare the explanation with the source.",
    );
    ui.session.state.lessons[2].selections = [
      "Supported",
      "Contradicted",
      "Not given",
    ];
    ui.node("#practice-form").handlers.submit({ preventDefault() {} });
    expect(ui.session.state.lessons[2].checked).toBe(true);
    expect(ui.root.innerHTML).toContain("Your response matches the source.");
  });

  it("opens a new account notebook on the learning path without implying a grade", async () => {
    const state = readyNotebook("everyday").state;
    state.lesson = 4;
    state.step = 2;
    state.lessons[4].selections = ["B"];
    const ui = await mounted("everyday", {
      notebookId: null,
      revision: null,
      state,
    });
    expect(ui.session.view).toBe("learn");
    expect(ui.root.innerHTML).toContain("Your learning path");
    expect(ui.root.innerHTML).toContain("Lesson 5 of 6");
    expect(ui.root.innerHTML).toContain("Response chosen");
    expect(ui.root.innerHTML).toContain(
      "These describe your activity. They are not a skill score.",
    );
    expect(ui.root.innerHTML).toContain("Nothing saved yet.");
    expect(ui.root.innerHTML).toContain("Learner &lt;private&gt;");
    expect(ui.root.innerHTML).not.toContain("Learner <private>");
  });

  it("shows partial drafts, a feedback decision and a long preview as separate work", async () => {
    const state = readyNotebook("work").state;
    state.lessons[0].transfer = "Source-bound first attempt";
    state.lessons[1].work = `${"A".repeat(191)}<private>`;
    state.final[0] = "Only the first field";
    state.contribution.revision = "Private improvement";
    const ui = await mounted("work", {
      state,
      feedbackHead: {
        sequence: 1,
        artifact: { id: 2, text: "Confirmed draft" },
      },
    });
    ui.session.view = "work";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("1 of 6 writing fields have notes.");
    expect(ui.root.innerHTML).toContain(
      "Your first draft and revision stay separate.",
    );
    expect(ui.root.innerHTML).toContain("Source-bound first attempt");
    expect(ui.root.innerHTML).toContain("Continue writing lesson 1");
    expect(ui.root.innerHTML).toContain("1 feedback decision recorded.");
    expect(ui.root.innerHTML).toContain("A private proposal and revision");
    expect(ui.root.innerHTML).toContain(`${"A".repeat(190)}…`);
    expect(ui.root.innerHTML).not.toContain("<private>");
    ui.session.view = "learn";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Lessons with writing</dt><dd>2");
    expect(ui.root.innerHTML).toContain("Practices checked</dt><dd>0");
  });

  it("shows older local copies by version without copying their answers into current lessons", async () => {
    const dom = readerDom("everyday");
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      initialRoute: "everyday",
      storage: {
        mode: "browser",
        load: async () =>
          readyNotebook("everyday", {
            raw: "current saved copy",
            blocked: true,
            earlier: [
              {
                key: "dne-course-reader-1:everyday",
                raw: "old private answer",
              },
              {
                key: "dne-course-reader-1:everyday:prior-v1",
                raw: "old version answer",
              },
            ],
          }),
      },
    });
    expect(dom.root.innerHTML).toContain("Earlier notebooks (2)");
    expect(dom.root.innerHTML).toContain("original save");
    expect(dom.root.innerHTML).toContain("prior-v1");
    expect(dom.root.innerHTML).toContain(
      "Their answers and self-checks belong to their original content version",
    );
    expect(dom.root.innerHTML).toContain("Download stored copy");
    expect(dom.root.innerHTML).toContain("Download earlier notebook");
    expect(dom.root.innerHTML).not.toContain("old private answer");
    expect(reader.getSession("everyday").state.lessons[0].work).toBe("");
    reader.destroy();
  });

  it("shows empty work, then keeps an exact private draft and escaped preview", async () => {
    const ui = await mounted("work");
    ui.session.view = "work";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Make something you can come back to.");
    expect(ui.root.innerHTML).not.toContain("work-preview");

    const text = `A <script> & "quote" '\u0000\ud800`;
    ui.session.state.lessons[0].work = text;
    ui.session.state.lessons[0].selfChecked = true;
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("work-preview");
    expect(ui.root.innerHTML).toContain(
      "A &lt;script&gt; &amp; &quot;quote&quot; &#39;",
    );
    expect(ui.root.innerHTML).not.toContain("<script>");
    expect(ui.root.innerHTML).toContain("Self-check recorded");
    ui.session.view = "lesson";
    ui.session.state.step = 3;
    const [writing] = ui.controls("[data-writing]", [
      { writing: "work", index: "" },
    ]);
    ui.reader.render();
    expect(writing.value).toBe(text);
    ui.session.state.lesson = 1;
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("These are your Lesson 1 notes");
    expect(ui.root.innerHTML).toContain("not been independently verified");
  });

  for (const route of Object.keys(routes)) {
    it(`${route} capstone retains six separate fields, source and private contribution intent`, async () => {
      const ui = await mounted(route);
      ui.session.view = "lesson";
      ui.session.state.lesson = 6;
      ui.session.state.finalStep = 3;
      const fields = [
        "Task & <check>",
        "A request with a missing fact",
        "First draft to retain",
        "No public sharing",
        "Repeatable source check",
        "Revision with reason",
      ];
      ui.session.state.final = fields;
      ui.session.state.finalChecked = true;
      ui.session.state.contribution.problem = "Invented case <private>";
      ui.session.state.contribution.audience = "members-later";
      ui.session.state.contribution.attribution = "Example learner";
      const writing = ui.controls(
        "[data-writing]",
        fields.map((_, index) => ({ writing: "final", index: String(index) })),
      );
      ui.reader.render();
      expect(writing.map((node) => node.value)).toEqual(fields);
      expect(ui.root.innerHTML).toContain("Task &amp; &lt;check&gt;");
      expect(ui.root.innerHTML).not.toContain("Task & <check>");
      expect(ui.root.innerHTML).toContain("Your retained first draft");
      expect(ui.root.innerHTML).toContain("First draft to retain");
      expect(ui.root.innerHTML).toContain("Revision with reason");
      expect(ui.root.innerHTML).toContain("Source reminder");
      expect(ui.root.innerHTML).toContain("Applied case");
      expect(ui.root.innerHTML).toContain("Consider member-only sharing later");
      expect(ui.root.innerHTML).toContain(
        "An audience plan is not permission.",
      );
      expect(ui.root.innerHTML).toContain("Not submitted or shared.");
      expect(ui.root.innerHTML).toContain("Invented case &lt;private&gt;");
      ui.session.view = "work";
      ui.reader.render();
      expect(ui.root.innerHTML).toContain("6 of 6 writing fields have notes.");
      expect(ui.root.innerHTML).toContain("A private proposal");
      expect(ui.root.innerHTML).toContain(
        "It has not been submitted or shared.",
      );
    });
  }

  it("shows confirmed feedback history separately from an unsaved decision", async () => {
    const saved = {
      id: 2,
      decision: "revise",
      commentVersion: 1,
      fromVersion: 2,
      toVersion: 3,
      text: "Saved revision",
      proposedText: "Saved revision",
      reason: "Saved source",
      question: "",
    };
    const ui = await mounted("everyday", {
      feedbackHead: {
        sequence: 2,
        artifact: { id: 3, text: "Saved revision" },
      },
      feedbackHistoryPage: { items: [saved], nextCursor: "older" },
    });
    ui.session.state.lesson = 5;
    ui.session.state.step = 2;
    ui.session.view = "lesson";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Decision 2");
    expect(ui.root.innerHTML).toContain("Recent artifact versions");
    expect(ui.root.innerHTML).toContain("Load earlier decisions");
    expect(ui.root.innerHTML).not.toContain("Decision 3");

    ui.session.state.feedback.draft = {
      decision: "revise",
      text: "Pending <revision>",
      reason: "Use the newer source",
      question: "Which date?",
    };
    expect(
      addFeedbackDecision("everyday", ui.session.state.feedback),
    ).toBeNull();
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Decision 2");
    expect(ui.root.innerHTML).toContain("Decision 3");
    expect(ui.root.innerHTML).toContain("Pending &lt;revision&gt;");
    expect(ui.root.innerHTML).toContain("Clarification kept in this notebook:");
    expect(ui.root.innerHTML).toContain("Which date?");
    expect(ui.session.state.feedback.records).toHaveLength(1);
    expect(ui.session.feedbackHistoryPage.items).toHaveLength(1);
  });

  it("keeps recent feedback visible when an older page fails, then shows recovered history", async () => {
    const recent = {
      id: 2,
      decision: "decline",
      commentVersion: 1,
      fromVersion: 2,
      toVersion: 2,
      text: "Recent draft",
      proposedText: "Recent draft",
      reason: "Recent source",
      question: "",
    };
    const older = {
      ...recent,
      id: 1,
      text: "Older draft",
      proposedText: "Older draft",
      reason: "Older source",
    };
    const history = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [older], nextCursor: null });
    const ui = await mounted(
      "technical",
      {
        feedbackHistoryPage: { items: [recent], nextCursor: "older-page" },
      },
      { history },
    );
    ui.session.state.lesson = 5;
    ui.session.state.step = 2;
    ui.session.view = "lesson";
    ui.reader.render();
    await ui.node("#feedback-older").handlers.click();
    expect(ui.root.innerHTML).toContain(
      "Earlier decisions could not be loaded.",
    );
    expect(ui.root.innerHTML).toContain("Decision 2");
    await ui.node("#feedback-older").handlers.click();
    expect(ui.root.innerHTML).toContain("Decision 1");
    expect(ui.root.innerHTML).toContain("Decision 2");
    expect(ui.root.innerHTML).not.toContain("Load earlier decisions");
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("cancels a contribution audience plan while keeping the private proposal", async () => {
    const ui = await mounted("work");
    ui.session.state.lesson = 6;
    ui.session.state.finalStep = 3;
    ui.session.view = "lesson";
    const [problem, first, reason, rights, attribution] = ui.controls(
      "[data-contribution-field]",
      ["problem", "first", "reason", "rights", "attribution"].map(
        (contributionField) => ({ contributionField }),
      ),
    );
    ui.reader.render();
    expect(ui.root.innerHTML).toMatch(/id="contribution-check"[^>]*disabled/);
    for (const [control, value] of [
      [problem, "Invented source v1"],
      [first, "Propose a checklist"],
      [reason, "Source supports the check"],
      [rights, "Invented content"],
    ]) {
      control.value = value;
      control.handlers.input();
    }
    expect(ui.node("#contribution-check").disabled).toBe(false);
    ui.node("#contribution-audience").handlers.change({
      target: { value: "members-later" },
    });
    expect(ui.node("#contribution-check").disabled).toBe(true);
    attribution.value = "Example learner";
    attribution.handlers.input();
    expect(ui.node("#contribution-check").disabled).toBe(false);
    ui.node("#contribution-check").handlers.change({
      target: { checked: true },
    });
    expect(ui.session.state.contribution.checked).toBe(true);
    ui.node("#contribution-cancel").handlers.click();
    expect(ui.session.state.contribution).toMatchObject({
      audience: "private",
      attribution: "",
      checked: false,
      first: "Propose a checklist",
      reason: "Source supports the check",
    });
    expect(ui.node("#contribution-status").textContent).toContain(
      "Sharing plan cancelled; private draft retained.",
    );
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Keep this draft private");
    expect(ui.root.innerHTML).toContain("Propose a checklist");
    expect(ui.root.innerHTML).toContain("Not submitted or shared.");
  });

  it("keeps the writing visible with a copy action after a concurrent save conflict", async () => {
    const ui = await mounted(
      "technical",
      {},
      {
        save: vi.fn(async () => ({
          kind: "conflict",
          confirmedDecisionCount: 0,
        })),
      },
    );
    ui.session.view = "lesson";
    ui.session.state.step = 3;
    const [writing] = ui.controls("[data-writing]", [
      { writing: "work", index: "" },
    ]);
    ui.reader.render();
    writing.value = "My unsaved <private> investigation";
    writing.handlers.input();
    await ui.node("#save").handlers.click();
    expect(ui.session.blocked).toBe(true);
    expect(ui.session.state.lessons[0].work).toBe(writing.value);
    expect(ui.root.innerHTML).toContain("This notebook changed elsewhere.");
    expect(ui.root.innerHTML).toContain("Download my work");
    expect(ui.root.innerHTML).toContain('id="save" disabled');
    expect(ui.root.innerHTML).toContain(
      "My unsaved &lt;private&gt; investigation",
    );
  });

  it("downloads a private account copy with all capstone fields and pending feedback", async () => {
    const anchor = { click: vi.fn(), href: "", download: "" };
    const document = { createElement: vi.fn(() => anchor) };
    const download = vi.fn(async () => ({
      text: '{"private":true}',
      filename: "learning-copy.json",
      mimeType: "application/json",
    }));
    const ui = await mounted("everyday", {}, { download }, document);
    ui.session.state.final = [
      "task",
      "request",
      "claim",
      "sharing",
      "workflow",
      "revision",
    ];
    ui.session.state.feedback.draft = {
      decision: "revise",
      text: "Pending revision",
      reason: "Source comparison",
      question: "",
    };
    expect(
      addFeedbackDecision("everyday", ui.session.state.feedback),
    ).toBeNull();
    await ui.node("#download").handlers.click();
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0][0]).toMatchObject({
      route: "everyday",
      state: {
        final: ["task", "request", "claim", "sharing", "workflow", "revision"],
      },
      pendingRecords: [{ id: 1, text: "Pending revision" }],
    });
    expect(anchor.download).toBe("learning-copy.json");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(ui.session.state.feedback.records).toHaveLength(1);
  });

  it("resumes the connected case at its retained update step", async () => {
    const ui = await mounted("work");
    ui.session.view = "learn";
    ui.session.state.lesson = 6;
    ui.session.state.finalStep = 2;
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Applied case");
    expect(ui.root.innerHTML).toContain("Read the update");
    expect(ui.root.innerHTML).toContain("Continue learning");
  });

  it("distinguishes an unfinished feedback response from recorded decisions in My work", async () => {
    const ui = await mounted("everyday");
    ui.session.view = "work";
    ui.session.state.feedback.draft.decision = "decline";
    ui.session.state.feedback.draft.reason = "Need to check the source";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Feedback response draft in progress");
    expect(ui.root.innerHTML).not.toContain("0 feedback decisions recorded");
  });

  it("shows the saved count from the confirmed feedback head without loading all history", async () => {
    const ui = await mounted("technical");
    ui.session.view = "work";
    ui.session.state.feedback.base = {
      sequence: 2,
      artifact: { id: 3, text: "Confirmed artifact" },
    };
    ui.session.feedbackHistoryPage = { items: [], nextCursor: "older" };
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("2 feedback decisions recorded");
    expect(ui.root.innerHTML).not.toContain("No decision recorded yet");
  });

  it("reopens a legacy checked response when its stored review flag is absent", async () => {
    const ui = await mounted("everyday");
    const prior = ui.session.state.lessons[0];
    delete prior.reviewNeeded;
    prior.checked = true;
    prior.selections = ["A"];
    ui.session.view = "learn";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain('class="state-tag needs-review"');
    expect(ui.root.innerHTML).toContain("Revisit the practice");
    ui.session.view = "practice";
    ui.reader.render();
    expect(ui.root.innerHTML).toContain('data-review-lesson="0"');
  });

  it("keeps a learner-opened practice hint visible after another render", async () => {
    const ui = await mounted("everyday");
    ui.session.view = "lesson";
    ui.session.state.lesson = 0;
    ui.session.state.step = 1;
    ui.session.state.lessons[0].hint = true;
    ui.reader.render();
    expect(ui.root.innerHTML).toContain('<details id="hint" open>');
    expect(ui.root.innerHTML).toContain("Show a hint");
  });

  it("offers the connected case after the last lesson's own work", async () => {
    const ui = await mounted("work");
    ui.session.view = "lesson";
    ui.session.state.lesson = 5;
    ui.session.state.step = 3;
    ui.reader.render();
    expect(ui.root.innerHTML).toContain("Start the final practice");
  });
});
