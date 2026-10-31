import { describe, expect, it, vi } from "vitest";
import {
  mountReader,
  emptyState,
  validState,
  writingSnapshot,
  icon,
} from "../../assets/docs/learning-design/reader/reader.mjs";
import { createBrowserNotebook } from "../../assets/docs/learning-design/reader/browser-notebook.mjs";
import {
  newFeedbackState,
  addFeedbackDecision,
  currentFeedbackArtifact,
  validFeedbackState,
  feedbackHistory,
  exportFeedback,
  renderFeedback,
} from "../../assets/docs/learning-design/reader/feedback.mjs";
import {
  newContribution,
  contributionReady,
  validContribution,
  renderContribution,
  exportContribution,
} from "../../assets/docs/learning-design/reader/contribution.mjs";
import { course } from "../../assets/docs/learning-design/reader/course.mjs";

function state(route = "everyday") {
  return {
    lesson: 0,
    step: 3,
    lessons: Array.from({ length: 6 }, () => ({
      transfer: "",
      work: "",
      selfChecked: false,
      selections: [],
      checked: false,
      reviewNeeded: false,
      hint: false,
    })),
    final: Array(6).fill(""),
    finalChecked: false,
    finalStep: 0,
    reviewCriterion: null,
    feedback: newFeedbackState(route),
    contribution: newContribution(),
  };
}

function fakeDom() {
  const nodes = new Map();
  const lists = new Map();
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        dataset: {},
        classList: { toggle() {}, remove() {} },
        handlers: {},
        addEventListener(type, handler) {
          this.handlers[type] = handler;
        },
        focus() {},
        scrollIntoView() {},
        matches() {
          return true;
        },
        setAttribute() {},
        disabled: false,
      });
    return nodes.get(selector);
  };
  const writing = node("writing");
  writing.dataset = { writing: "work", index: "" };
  const finalWriting = node("final-writing");
  finalWriting.dataset = { writing: "final", index: "0" };
  const routeButtons = ["everyday", "work", "technical"].map((route) => {
    const button = node(`route-${route}`);
    button.dataset.route = route;
    return button;
  });
  const root = {
    innerHTML: "",
    querySelector: node,
    querySelectorAll(selector) {
      if (lists.has(selector)) return lists.get(selector);
      if (selector === "[data-writing]")
        return this.innerHTML.includes('data-writing="final"')
          ? [finalWriting]
          : [writing];
      if (selector === "[data-route]") return routeButtons;
      return [];
    },
  };
  const window = {
    location: { hash: "#route=everyday" },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
    crypto: { randomUUID: () => "save-1" },
    scrollTo() {},
    history: { replaceState() {} },
  };
  return {
    root,
    window,
    node,
    writing,
    list: (selector, values) => lists.set(selector, values),
  };
}

describe("account-backed reader", () => {
  it("requires a mount target and falls back to the everyday route for an invalid link", async () => {
    const dom = fakeDom();
    await expect(
      mountReader({ root: null, document: {}, window: dom.window }),
    ).rejects.toThrow(/root/);
    dom.window.matchMedia = undefined;
    const load = vi.fn(async (route) => ({
      kind: "ready",
      state: state(route),
    }));
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: { mode: "account", load },
      initialRoute: "unknown",
    });
    expect(reader.route).toBe("everyday");
    expect(load).toHaveBeenCalledWith("everyday");
  });

  it("does not inspect browser notebooks in account mode", async () => {
    const dom = fakeDom();
    Object.defineProperty(dom.window, "localStorage", {
      get() {
        throw new Error("must not read localStorage");
      },
    });
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: state() }),
      },
    });
    expect(reader.getSession("everyday").loaded).toBe(true);
  });

  it("keeps a later edit dirty while the captured snapshot is saving", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    let captured;
    const storage = {
      mode: "account",
      load: vi.fn(async () => ({
        kind: "ready",
        notebookId: "n1",
        revision: 4,
        savedDraftRevision: 2,
        state: state(),
        feedbackHead: { sequence: 0, artifact: { id: 2, text: "Initial" } },
      })),
      save: vi.fn((value) => {
        captured = value;
        return pending;
      }),
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    expect(dom.root.innerHTML).toContain("Save my work");
    dom.writing.value = "first";
    dom.writing.handlers.input();
    const saveDone = dom.node("#save").handlers.click();
    expect(captured.immutableState.lessons[0].work).toBe("first");
    expect(captured.expectedRevision).toBe(4);
    dom.writing.value = "second";
    dom.writing.handlers.input();
    finish({
      kind: "saved",
      revision: 5,
      savedDraftRevision: 3,
      confirmedDecisionCount: 0,
    });
    await saveDone;
    expect(reader.getSession("everyday").state.lessons[0].work).toBe("second");
    expect(reader.getSession("everyday").dirty).toBe(true);
    expect(reader.getSession("everyday").message).toMatch(
      /Newer changes are still unsaved/,
    );
  });

  it("does not expose an empty writable notebook when loading fails", async () => {
    const dom = fakeDom();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(reader.getSession("everyday").blocked).toBe(true);
    expect(dom.root.innerHTML).toContain("could not be loaded");
    expect(dom.root.innerHTML).not.toContain("Save my work");
  });

  it("keeps unavailable or invalid account records read-only at initial load", async () => {
    for (const loaded of [
      { kind: "unavailable" },
      { kind: "ready", state: { ...state(), lessons: [] } },
    ]) {
      const dom = fakeDom();
      const reader = await mountReader({
        root: dom.root,
        document: {},
        window: dom.window,
        storage: { mode: "account", load: async () => loaded },
      });
      expect(reader.getSession("everyday").blocked).toBe(true);
      expect(dom.root.innerHTML).not.toContain('id="save"');
    }
  });

  it("starts a genuinely empty account notebook when the loader has no saved state", async () => {
    const dom = fakeDom();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: null, state: null }),
      },
    });
    expect(reader.getSession("everyday").loaded).toBe(true);
    expect(reader.getSession("everyday").state.lessons).toHaveLength(6);
    expect(dom.root.innerHTML).toContain("Your learning path");
  });

  it("coalesces rapid requests to load the same account route", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const load = vi.fn((route) =>
      route === "technical"
        ? pending
        : Promise.resolve({ kind: "ready", state: state(route) }),
    );
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: { mode: "account", load },
    });
    const first = dom.node("route-technical").handlers.click();
    const second = dom.node("route-technical").handlers.click();
    expect(
      load.mock.calls.filter(([route]) => route === "technical"),
    ).toHaveLength(1);
    finish({ kind: "ready", state: state("technical") });
    await Promise.all([first, second]);
    expect(reader.route).toBe("technical");
    expect(reader.getSession("technical").loaded).toBe(true);
  });

  it("keeps an in-flight save on its captured route after switching examples", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const load = vi.fn(async (route) => ({
      kind: "ready",
      state: state(route),
      revision: 1,
    }));
    const storage = {
      mode: "account",
      load,
      save: async () => pending,
    };
    const onRouteChange = vi.fn();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
      presentation: { onRouteChange },
    });
    dom.writing.value = "first";
    dom.writing.handlers.input();
    const saving = dom.node("#save").handlers.click();
    await dom.node("route-technical").handlers.click();
    finish({ kind: "saved", revision: 2, savedDraftRevision: 1 });
    await saving;
    expect(reader.route).toBe("technical");
    expect(reader.getSession("everyday").revision).toBe(2);
    expect(reader.getSession("technical").revision).toBe(1);
    expect(dom.root.innerHTML).toContain("Technical");
    expect(dom.root.innerHTML).not.toContain(
      "Saved to your private account notebook.",
    );
    await dom.node("route-everyday").handlers.click();
    expect(reader.route).toBe("everyday");
    expect(reader.getSession("everyday").revision).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onRouteChange.mock.calls).toEqual([["technical"], ["everyday"]]);
  });

  it("returns to the current notebook when another route cannot load", async () => {
    const dom = fakeDom();
    const storage = {
      mode: "account",
      load: async (route) => {
        if (route === "technical") throw new Error("offline");
        return { kind: "ready", state: state(route), revision: 1 };
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    dom.writing.value = "keep this";
    dom.writing.handlers.input();
    await dom.node("route-technical").handlers.click();
    expect(reader.route).toBe("everyday");
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "keep this",
    );
    expect(dom.root.innerHTML).toContain(
      "Technical notebook could not be loaded",
    );
  });

  it("does not repaint a host after it unmounts during a save", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: state(), revision: 1 }),
        save: async () => pending,
      },
    });
    const saving = dom.node("#save").handlers.click();
    reader.destroy();
    finish({ kind: "saved", revision: 2 });
    await saving;
    expect(dom.root.innerHTML).toBe("");
  });

  it("keeps lesson, step and practice navigation in the same account session", async () => {
    const dom = fakeDom();
    const open = dom.node("open-lesson-5");
    open.dataset.openLesson = "5";
    const step = dom.node("step-2");
    step.dataset.step = "2";
    const practice = dom.node("nav-practice");
    practice.dataset.view = "practice";
    dom.list("[data-open-lesson]", [open]);
    dom.list("[data-step]", [step]);
    dom.list("[data-view]", [practice]);
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: state() }),
      },
    });
    open.handlers.click();
    expect(reader.getSession("everyday").state.lesson).toBe(5);
    step.handlers.click();
    expect(reader.getSession("everyday").state.step).toBe(2);
    dom.node("#back").handlers.click();
    expect(reader.getSession("everyday").state.step).toBe(1);
    dom.node("#next").handlers.click();
    expect(reader.getSession("everyday").state.step).toBe(2);
    practice.handlers.click({ preventDefault() {} });
    expect(reader.getSession("everyday").view).toBe("practice");
    expect(dom.root.innerHTML).toContain("Make it stick");
    expect(reader.getSession("everyday").dirty).toBe(true);
  });

  it("records a feedback decision only after a source-linked reason", async () => {
    const dom = fakeDom();
    const textInput = dom.node("feedback-text");
    textInput.dataset.feedbackField = "text";
    const reasonInput = dom.node("feedback-reason");
    reasonInput.dataset.feedbackField = "reason";
    dom.list("[data-feedback-field]", [textInput, reasonInput]);
    const loaded = state();
    loaded.lesson = 5;
    loaded.step = 2;
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    dom
      .node("#feedback-choice")
      .handlers.change({ target: { value: "revise" } });
    textInput.value = "Corrected from the supplied source";
    textInput.handlers.input();
    dom.node("#feedback-form").handlers.submit({ preventDefault() {} });
    expect(dom.node("#feedback-notice").textContent).toMatch(/reason/);
    reasonInput.value = "The source supports the corrected claim";
    reasonInput.handlers.input();
    dom.node("#feedback-form").handlers.submit({ preventDefault() {} });
    expect(reader.getSession("everyday").state.feedback.records).toHaveLength(
      1,
    );
    expect(
      reader.getSession("everyday").state.feedback.records[0],
    ).toMatchObject({
      decision: "revise",
      reason: "The source supports the corrected claim",
    });
    expect(dom.root.innerHTML).toContain("Decision 1");
  });

  it("loads earlier feedback without marking the current draft dirty", async () => {
    const dom = fakeDom();
    const older = newFeedbackState("everyday");
    older.draft = {
      decision: "revise",
      text: "Earlier revision",
      reason: "Supplied source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", older)).toBeNull();
    const loaded = state();
    loaded.lesson = 5;
    loaded.step = 2;
    const history = vi.fn(async () => ({
      items: older.records,
      nextCursor: null,
    }));
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({
          kind: "ready",
          notebookId: "n1",
          state: loaded,
          feedbackHead: {
            sequence: 1,
            artifact: {
              id: older.records[0].toVersion,
              text: older.records[0].text,
            },
          },
          feedbackHistoryPage: { items: [], nextCursor: "older-page" },
        }),
        history,
      },
    });
    await dom.node("#feedback-older").handlers.click();
    expect(history).toHaveBeenCalledWith("everyday", "older-page");
    expect(
      reader.getSession("everyday").feedbackHistoryPage.items,
    ).toHaveLength(1);
    expect(reader.getSession("everyday").dirty).toBe(false);
    expect(dom.root.innerHTML).toContain("Decision 1");
    expect(dom.root.innerHTML).not.toContain("Load earlier decisions");
  });

  it("does not replace another route's view when older feedback arrives late", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const older = newFeedbackState("everyday");
    older.draft = {
      decision: "revise",
      text: "Earlier",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", older)).toBeNull();
    const initial = state();
    initial.lesson = 5;
    initial.step = 2;
    const storage = {
      mode: "account",
      load: async (route) => ({
        kind: "ready",
        state: route === "everyday" ? initial : state(route),
        feedbackHead:
          route === "everyday"
            ? {
                sequence: 1,
                artifact: {
                  id: older.records[0].toVersion,
                  text: older.records[0].text,
                },
              }
            : undefined,
        feedbackHistoryPage:
          route === "everyday"
            ? { items: [], nextCursor: "older" }
            : { items: [], nextCursor: null },
      }),
      history: async () => pending,
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    const loading = dom.node("#feedback-older").handlers.click();
    await dom.node("route-technical").handlers.click();
    finish({ items: older.records, nextCursor: null });
    await loading;
    expect(reader.route).toBe("technical");
    expect(
      reader.getSession("everyday").feedbackHistoryPage.items,
    ).toHaveLength(1);
    expect(dom.root.innerHTML).toContain("Technical");
    expect(dom.root.innerHTML).not.toContain("Decision 1");
  });

  it("updates a lesson self-check and hint from explicit learner actions", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lesson = 0;
    loaded.step = 3;
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    dom.writing.value = "A checkable answer";
    dom.writing.handlers.input();
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "A checkable answer",
    );
    expect(dom.node("#self-check").disabled).toBe(false);
    dom.node("#self-check").handlers.change({ target: { checked: true } });
    expect(reader.getSession("everyday").state.lessons[0].selfChecked).toBe(
      true,
    );
    dom
      .node("#hint")
      .handlers.toggle({ target: { isConnected: true, open: true } });
    expect(reader.getSession("everyday").state.lessons[0].hint).toBe(true);
    const before = reader.getSession("everyday").editCounter;
    dom
      .node("#hint")
      .handlers.toggle({ target: { isConnected: false, open: false } });
    dom
      .node("#hint")
      .handlers.toggle({ target: { isConnected: true, open: true } });
    expect(reader.getSession("everyday").editCounter).toBe(before);
  });

  it("refreshes the open earlier-notes panel as writing appears", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lesson = 0;
    loaded.step = 3;
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    dom.node("#notebook").open = true;
    dom.node("#notebook").handlers.toggle();
    expect(dom.node("#notebook-content").innerHTML).toContain(
      "Your notes will appear here",
    );
    dom.writing.value = "My own source check";
    dom.writing.handlers.input();
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "My own source check",
    );
    expect(dom.node("#notebook-content").innerHTML).toContain(
      "My own source check",
    );
  });

  it("resets final self-check when a learner revises a field and allows it after all six fields", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lesson = 6;
    loaded.finalStep = 1;
    loaded.final = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
    loaded.finalChecked = true;
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    const input = dom.node("final-writing");
    input.value = "Revised <exact>";
    input.handlers.input();
    expect(reader.getSession("everyday").state.final[0]).toBe(
      "Revised <exact>",
    );
    expect(reader.getSession("everyday").state.finalChecked).toBe(false);
    expect(dom.node("#self-check").disabled).toBe(false);
    dom.node("#self-check").handlers.change({ target: { checked: true } });
    expect(reader.getSession("everyday").state.finalChecked).toBe(true);
  });

  it("checks a complete practice response and keeps correction available", async () => {
    const dom = fakeDom();
    const feedback = dom.node("answer-feedback");
    const choice = dom.node("choice");
    choice.classList.remove = vi.fn();
    dom.list(".answer-feedback", [feedback]);
    dom.list(".choice", [choice]);
    const loaded = state();
    loaded.lesson = 0;
    loaded.step = 1;
    const questions = course.lessons[0].routes.everyday.practice.questions;
    const inputs = questions.map((question, index) => {
      const input = dom.node(`question-${index}`);
      input.dataset.question = String(index);
      input.value = question.choices[0].key;
      return input;
    });
    dom.list("[data-question]", inputs);
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    dom.node("#practice-form").handlers.submit({ preventDefault() {} });
    expect(dom.node("#practice-notice").textContent).toMatch(
      /Choose a response/,
    );
    for (const input of inputs) input.handlers.change();
    expect(feedback.hidden).toBe(true);
    expect(choice.classList.remove).toHaveBeenCalledWith(
      "correct",
      "reconsider",
    );
    dom.node("#practice-form").handlers.submit({ preventDefault() {} });
    expect(reader.getSession("everyday").state.lessons[0].checked).toBe(true);
    expect(reader.getSession("everyday").state.lessons[0].selections).toEqual(
      inputs.map((input) => input.value),
    );
  });

  it("returns from a final criterion to the retained connected record", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lesson = 6;
    loaded.finalStep = 3;
    const criterion = dom.node("criterion-zero");
    criterion.dataset.reviewCriterion = "0";
    dom.list("[data-review-criterion]", [criterion]);
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", notebookId: "n1", state: loaded }),
      },
    });
    criterion.handlers.click();
    expect(reader.getSession("everyday").state.reviewCriterion).toBe(0);
    expect(reader.getSession("everyday").state.lesson).toBeLessThan(6);
    dom.node("#return-final").handlers.click();
    expect(reader.getSession("everyday").state.lesson).toBe(6);
    expect(reader.getSession("everyday").state.finalStep).toBe(3);
    expect(reader.getSession("everyday").state.reviewCriterion).toBeNull();
  });

  it("opens lesson, review, final practice and contribution from their navigation controls", async () => {
    const dom = fakeDom();
    const review = dom.node("review-lesson");
    review.dataset.reviewLesson = "2";
    const write = dom.node("write-lesson");
    write.dataset.writeLesson = "3";
    write.dataset.writeStep = "3";
    const openFinal = dom.node("open-final");
    const finalStep = dom.node("final-step-2");
    finalStep.dataset.finalStep = "2";
    const lessonLink = dom.node("content-lesson-link");
    lessonLink.getAttribute = () => "#lesson=2";
    dom.list("[data-review-lesson]", [review]);
    dom.list("[data-write-lesson]", [write]);
    dom.list("[data-open-final]", [openFinal]);
    dom.list("[data-final-step]", [finalStep]);
    dom.list("a[href^='#lesson=']", [lessonLink]);
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: state() }),
      },
    });
    dom.node("[data-continue]").handlers.click();
    expect(reader.getSession("everyday").view).toBe("lesson");
    review.handlers.click();
    expect(reader.getSession("everyday").state).toMatchObject({
      lesson: 2,
      step: 1,
    });
    write.handlers.click();
    expect(reader.getSession("everyday").state).toMatchObject({
      lesson: 3,
      step: 3,
    });
    openFinal.handlers.click();
    expect(reader.getSession("everyday").state.lesson).toBe(6);
    finalStep.handlers.click();
    expect(reader.getSession("everyday").state.finalStep).toBe(2);
    dom.node("#next").handlers.click();
    expect(reader.getSession("everyday").state.finalStep).toBe(3);
    dom.node("#back").handlers.click();
    expect(reader.getSession("everyday").state.finalStep).toBe(2);
    dom.node("[data-open-contribution]").handlers.click();
    expect(reader.getSession("everyday").state.finalStep).toBe(3);
    expect(dom.node("#contribution-panel").open).toBe(true);
    dom.node("[data-source]").handlers.click();
    expect(dom.node("#final-source-reminder").open).toBe(true);
    dom.node("[data-return-exercise]").handlers.click();
    dom
      .node("#course-menu")
      .handlers.toggle({ target: { isConnected: true, open: false } });
    expect(reader.getSession("everyday").courseMenuOpen).toBe(false);
    dom
      .node("#course-menu")
      .handlers.toggle({ target: { isConnected: false, open: true } });
    expect(reader.getSession("everyday").courseMenuOpen).toBe(false);
    dom.node("#course-path").handlers.click({
      target: { closest: () => ({ dataset: { lesson: "4" } }) },
    });
    expect(reader.getSession("everyday").state.lesson).toBe(4);
    lessonLink.handlers.click({ preventDefault() {} });
    expect(reader.getSession("everyday").state.lesson).toBe(1);
    const query = dom.root.querySelector;
    dom.root.querySelector = (selector) =>
      selector === "#final-source-reminder" ? null : query(selector);
    dom.node("[data-source]").handlers.click();
    dom.node("[data-return-exercise]").handlers.click();
  });

  it("closes the course menu on narrow screens and focuses the page heading", async () => {
    const dom = fakeDom();
    dom.window.matchMedia = () => ({ matches: true });
    const practice = dom.node("mobile-practice");
    practice.dataset.view = "practice";
    const open = dom.node("mobile-open");
    open.dataset.openLesson = "0";
    dom.list("[data-view]", [practice]);
    dom.list("[data-open-lesson]", [open]);
    const heading = dom.node("#page-title");
    heading.matches = () => false;
    heading.setAttribute = vi.fn();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: state() }),
      },
    });
    reader.getSession("everyday").courseMenuOpen = true;
    practice.handlers.click({ preventDefault() {} });
    expect(reader.getSession("everyday").courseMenuOpen).toBe(false);
    expect(heading.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    reader.getSession("everyday").courseMenuOpen = true;
    open.handlers.click();
    expect(reader.getSession("everyday").courseMenuOpen).toBe(false);
    reader.render(true);
    expect(heading.setAttribute).toHaveBeenCalled();
  });

  it("keeps an uncertain save and retries the same captured operation", async () => {
    const dom = fakeDom();
    const attempts = [];
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: state(), revision: 0 }),
      save: async (value) => {
        attempts.push(value);
        return attempts.length === 1
          ? { kind: "unconfirmed", confirmedDecisionCount: 0 }
          : { kind: "saved", revision: 1, savedDraftRevision: 1 };
      },
      inspect: async () => ({ kind: "not-confirmed" }),
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    dom.writing.value = "retained";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").unconfirmed).toBe(true);
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "retained",
    );
    await dom.node("#check-save").handlers.click();
    expect(reader.getSession("everyday").unconfirmed).toBe(true);
    await dom.node("#save").handlers.click();
    expect(attempts[1]).toBe(attempts[0]);
    expect(reader.getSession("everyday").dirty).toBe(false);
  });

  it("keeps confirmed decisions distinct from an incomplete saved history page", async () => {
    const dom = fakeDom();
    const initial = state();
    const storage = {
      mode: "account",
      load: async () => ({
        kind: "ready",
        state: initial,
        revision: 2,
        feedbackHead: { sequence: 3, artifact: { id: 3, text: "A" } },
        feedbackHistoryPage: { items: [], nextCursor: "older" },
      }),
      save: async () => ({ kind: "unavailable", confirmedDecisionCount: 1 }),
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    const feedback = reader.getSession("everyday").state.feedback;
    feedback.draft = {
      decision: "revise",
      text: "B",
      reason: "From source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    feedback.draft = {
      decision: "revise",
      text: "C",
      reason: "New source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    await dom.node("#save").handlers.click();
    expect(feedback.base).toEqual({
      sequence: 4,
      artifact: { id: 4, text: "B" },
    });
    expect(feedback.records.map((r) => r.id)).toEqual([5]);
    expect(reader.getSession("everyday").feedbackHistoryPage).toMatchObject({
      nextCursor: "older",
      items: [{ id: 4 }],
    });
  });

  it("reports two confirmed decisions precisely when the draft save stops", async () => {
    const dom = fakeDom();
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: state(), revision: 1 }),
      save: async () => ({ kind: "unavailable", confirmedDecisionCount: 2 }),
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    const feedback = reader.getSession("everyday").state.feedback;
    feedback.draft = {
      decision: "revise",
      text: "First correction",
      reason: "Source one",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    feedback.draft = {
      decision: "revise",
      text: "Second correction",
      reason: "Source two",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    await dom.node("#save").handlers.click();
    expect(feedback.base.sequence).toBe(2);
    expect(feedback.records).toHaveLength(0);
    expect(reader.getSession("everyday").message).toMatch(
      /after 2 feedback decisions were confirmed/,
    );
    expect(reader.getSession("everyday").dirty).toBe(true);
  });

  it("uses a confirmed server feedback head after a complete decision-and-draft save", async () => {
    const dom = fakeDom();
    const serverHead = {
      sequence: 1,
      artifact: { id: 2, text: "Learner revision" },
    };
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: state(), revision: 1 }),
      save: async () => ({
        kind: "saved",
        revision: 3,
        savedDraftRevision: 3,
        confirmedDecisionCount: 1,
        feedbackHead: serverHead,
      }),
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    const feedback = reader.getSession("everyday").state.feedback;
    feedback.draft = {
      decision: "revise",
      text: "Learner revision",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    await dom.node("#save").handlers.click();
    expect(feedback.records).toHaveLength(0);
    expect(feedback.base).toEqual(serverHead);
    expect(reader.getSession("everyday").revision).toBe(3);
    expect(reader.getSession("everyday").dirty).toBe(false);
  });

  it("retains a denied account draft and offers a download instead of another save", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lessons[0].work = "Private draft";
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async () => ({ kind: "ready", state: loaded, revision: 2 }),
        save: async () => ({ kind: "denied", confirmedDecisionCount: 0 }),
      },
    });
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").blocked).toBe(true);
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "Private draft",
    );
    expect(reader.getSession("everyday").message).toMatch(/sign in again/);
    expect(dom.root.innerHTML).toContain("Download my work");
    expect(dom.node("#save").disabled).toBe(true);
  });

  it("checks an uncertain decision and draft once without duplicating its history", async () => {
    const dom = fakeDom();
    const loaded = state();
    let operationId;
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: loaded, revision: 1 }),
      save: async ({ operationId: id }) => {
        operationId = id;
        return { kind: "unconfirmed", confirmedDecisionCount: 1 };
      },
      inspect: async ({ operationId: id }) => {
        expect(id).toBe(operationId);
        return {
          kind: "saved",
          confirmedDecisionCount: 1,
          revision: 2,
          savedDraftRevision: 1,
        };
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    const feedback = reader.getSession("everyday").state.feedback;
    feedback.draft = {
      decision: "revise",
      text: "Checked revision",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").message).toMatch(
      /after 1 feedback decision/,
    );
    expect(
      reader.getSession("everyday").feedbackHistoryPage.items,
    ).toHaveLength(1);
    await dom.node("#check-save").handlers.click();
    expect(reader.getSession("everyday").unconfirmed).toBe(false);
    expect(
      reader.getSession("everyday").feedbackHistoryPage.items,
    ).toHaveLength(1);
    expect(reader.getSession("everyday").revision).toBe(2);
  });

  it("retains an account draft when its download fails and allows a later retry", async () => {
    const dom = fakeDom();
    const loaded = state();
    loaded.lessons[0].work = "Keep this writing";
    let calls = 0;
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: loaded }),
      download: async () => {
        calls += 1;
        throw new Error("offline");
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    await dom.node("#download").handlers.click();
    expect(calls).toBe(1);
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "Keep this writing",
    );
    expect(reader.getSession("everyday").message).toMatch(/Download failed/);
    expect(dom.root.innerHTML).toContain("Download my work");
  });

  it("keeps an uncertain save after a receipt lookup failure", async () => {
    const dom = fakeDom();
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: state(), revision: 1 }),
      save: async () => ({ kind: "unconfirmed", confirmedDecisionCount: 0 }),
      inspect: async () => {
        throw new Error("offline");
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    dom.writing.value = "Unsaved, still here";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    await dom.node("#check-save").handlers.click();
    expect(reader.getSession("everyday").unconfirmed).toBe(true);
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "Unsaved, still here",
    );
    expect(reader.getSession("everyday").message).toMatch(
      /Could not check save status/,
    );
  });

  it("does not start overlapping saves and retries the same snapshot after a transport error", async () => {
    const dom = fakeDom();
    let rejectFirst;
    const pending = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const attempts = [];
    const storage = {
      mode: "account",
      load: async () => ({ kind: "ready", state: state(), revision: 1 }),
      save: (captured) => {
        attempts.push(captured);
        return attempts.length === 1
          ? pending
          : Promise.resolve({ kind: "saved", revision: 2 });
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage,
    });
    dom.writing.value = "Keep after network loss";
    dom.writing.handlers.input();
    const first = dom.node("#save").handlers.click();
    await dom.node("#save").handlers.click();
    expect(attempts).toHaveLength(1);
    rejectFirst(new Error("network ended"));
    await first;
    expect(reader.getSession("everyday").message).toMatch(
      /Save did not complete/,
    );
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "Keep after network loss",
    );
    await dom.node("#save").handlers.click();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(reader.getSession("everyday").dirty).toBe(false);
  });
});

describe("reader storage and feedback", () => {
  it("has an authored icon and complete source packet for every published reader route", () => {
    for (const name of [
      "learn",
      "practice",
      "work",
      "arrow",
      "back",
      "check",
      "case",
      "source",
    ]) {
      expect(icon(name)).toContain('<svg class="ui-icon"');
      expect(icon(name)).not.toContain("undefined");
    }
    for (const route of ["everyday", "work", "technical"])
      expect(course.capstone[route].sourcePacket.length).toBeGreaterThan(0);
  });

  it("does not offer an incomplete local record if a future course omits its source packet", async () => {
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    let clicked = false;
    const document = {
      createElement: () => ({
        click() {
          clicked = true;
        },
        textContent: "",
      }),
    };
    const original = course.capstone.everyday.sourcePacket;
    course.capstone.everyday.sourcePacket = undefined;
    try {
      const reader = await mountReader({
        root: dom.root,
        document,
        window: dom.window,
      });
      await dom.node("#download").handlers.click();
      expect(clicked).toBe(false);
      expect(reader.getSession("everyday").message).toMatch(/Download failed/);
    } finally {
      course.capstone.everyday.sourcePacket = original;
    }
  });

  it("keeps the chosen local example route in the URL and restores its own notebook", async () => {
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    dom.window.history.replaceState = vi.fn();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
    });
    await dom.node("route-technical").handlers.click();
    expect(reader.route).toBe("technical");
    expect(reader.getSession("technical").loaded).toBe(true);
    expect(dom.window.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "#route=technical",
    );
  });

  it("keeps a local notebook read-only when its injected loader fails unexpectedly", async () => {
    const dom = fakeDom();
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "browser",
        load: () => {
          throw new Error("unavailable");
        },
      },
    });
    expect(reader.getSession("everyday").blocked).toBe(true);
    expect(dom.root.innerHTML).toContain("Your notebook could not be loaded");
  });

  it("restores the saved indicator after an explicit successful browser save", async () => {
    const dom = fakeDom();
    const values = {};
    dom.window.localStorage = {
      getItem: (name) => values[name] ?? null,
      setItem: (name, value) => {
        values[name] = value;
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
    });
    dom.writing.value = "My local draft";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").dirty).toBe(false);
    expect(dom.node("#save-indicator").textContent).toBe(
      "Saved in this browser",
    );
    expect(reader.getSession("everyday").raw).toContain("My local draft");
  });

  it("accepts exact maximum writing and rejects corrupted saved notebook boundaries", () => {
    const accepted = emptyState("everyday");
    accepted.lessons[0].work = "x".repeat(29997) + "\u0000\ud800!";
    expect(accepted.lessons[0].work.length).toBe(30000);
    expect(validState(accepted, "everyday")).toBe(true);
    expect(JSON.parse(writingSnapshot(accepted)).lessons[0].work).toBe(
      accepted.lessons[0].work,
    );
    const corruptions = [
      (copy) => {
        copy.lesson = -1;
      },
      (copy) => {
        copy.lesson = 7;
      },
      (copy) => {
        copy.step = 4;
      },
      (copy) => {
        copy.lessons.pop();
      },
      (copy) => {
        copy.final.pop();
      },
      (copy) => {
        copy.final[0] = "x".repeat(30001);
      },
      (copy) => {
        copy.finalChecked = "yes";
      },
      (copy) => {
        copy.reviewCriterion = -1;
      },
      (copy) => {
        copy.finalStep = 4;
      },
      (copy) => {
        copy.contribution.checked = "yes";
      },
      (copy) => {
        copy.feedback.caseId = "other";
      },
      (copy) => {
        copy.lessons[0].work += "x";
      },
      (copy) => {
        copy.lessons[0].checked = "yes";
      },
      (copy) => {
        copy.lessons[0].selections = ["impossible"];
      },
    ];
    for (const corrupt of corruptions) {
      const copy = globalThis.structuredClone(accepted);
      corrupt(copy);
      expect(validState(copy, "everyday")).toBe(false);
    }
    expect(validState(null, "everyday")).toBe(false);
  });

  it("keeps local navigation from triggering a writing-loss warning", async () => {
    const dom = fakeDom();
    let beforeUnload;
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    dom.window.addEventListener = (_type, handler) => {
      beforeUnload = handler;
    };
    const open = dom.node("open-first");
    open.dataset.openLesson = "0";
    dom.list("[data-open-lesson]", [open]);
    await mountReader({ root: dom.root, document: {}, window: dom.window });
    open.handlers.click();
    const preventDefault = vi.fn();
    beforeUnload({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("warns before leaving with unsaved writing and removes the listener on unmount", async () => {
    const dom = fakeDom();
    let beforeUnload;
    let removed;
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    dom.window.addEventListener = (type, handler) => {
      if (type === "beforeunload") beforeUnload = handler;
    };
    dom.window.removeEventListener = (type, handler) => {
      removed = type === "beforeunload" && handler === beforeUnload;
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
    });
    dom.writing.value = "unsaved";
    dom.writing.handlers.input();
    const preventDefault = vi.fn();
    beforeUnload({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    reader.destroy();
    expect(removed).toBe(true);
  });

  it("offers the original text download for a local notebook", async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    let downloaded;
    const document = {
      createElement(kind) {
        if (kind === "a")
          return {
            set href(value) {
              this.url = value;
            },
            set download(value) {
              this.filename = value;
            },
            click() {
              downloaded = this.filename;
            },
          };
        return {
          set innerHTML(_value) {
            this.textContent = "Invented source";
          },
          textContent: "",
        };
      },
    };
    try {
      await mountReader({ root: dom.root, document, window: dom.window });
      await dom.node("#download").handlers.click();
      expect(downloaded).toBe("foundation-everyday.txt");
      await vi.advanceTimersByTimeAsync(1000);
      expect(revoke).toHaveBeenCalledOnce();
    } finally {
      revoke.mockRestore();
      vi.useRealTimers();
    }
  });

  it("downloads an unreadable stored copy and a separate earlier version without overwriting either", async () => {
    const dom = fakeDom();
    const current = `dne-course-reader-1:everyday:${course.contentHash}`;
    const older = "dne-course-reader-1:everyday:older";
    const localStorage = {
      [current]: "{unreadable",
      [older]: "older raw",
      getItem(name) {
        return this[name] ?? null;
      },
      setItem: vi.fn(),
    };
    dom.window.localStorage = localStorage;
    const downloads = [];
    const document = {
      createElement(kind) {
        if (kind === "a")
          return {
            set href(value) {
              this.url = value;
            },
            set download(value) {
              this.filename = value;
            },
            click() {
              downloads.push(this.filename);
            },
          };
        return {
          set innerHTML(_value) {
            this.textContent = "Invented source";
          },
          textContent: "",
        };
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document,
      window: dom.window,
    });
    expect(reader.getSession("everyday").blocked).toBe(true);
    expect(dom.root.innerHTML).toContain("Download stored copy");
    expect(dom.root.innerHTML).toContain("Earlier notebooks (1)");
    dom.node("#download-stored").handlers.click();
    dom.node("#earlier-record").value = "0";
    dom.node("#download-earlier").handlers.click();
    expect(downloads).toEqual([
      "foundation-everyday-stored.txt",
      "foundation-everyday-earlier-1.txt",
    ]);
    await dom.node("#save").handlers.click();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("exports a complete local text record with the learner's retained source check and final revision", async () => {
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    let blob;
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((value) => {
        blob = value;
        return "blob:reader-test";
      });
    const document = {
      createElement(kind) {
        if (kind === "a") return { click() {}, href: "", download: "" };
        return {
          set innerHTML(_value) {
            this.textContent = "Invented source";
          },
          textContent: "",
        };
      },
    };
    try {
      const reader = await mountReader({
        root: dom.root,
        document,
        window: dom.window,
      });
      const current = reader.getSession("everyday").state;
      current.lessons[0].transfer = "Fresh attempt";
      current.lessons[0].work = "My checkable source";
      current.lessons[0].selfChecked = true;
      current.lessons[0].checked = true;
      current.lessons[0].selections = ["B"];
      current.final = [
        "task",
        "request",
        "claim",
        "sharing",
        "workflow",
        "revised record",
      ];
      current.finalChecked = true;
      current.finalStep = 3;
      current.reviewCriterion = 0;
      current.contribution.problem = "Private problem";
      await dom.node("#download").handlers.click();
      const text = await blob.text();
      expect(text).toContain("Fresh-case attempt: Fresh attempt");
      expect(text).toContain("Self-checked by learner: yes");
      expect(text).toContain("Revisiting for final practice:");
      expect(text).toContain("Feedback and revision: revised record");
      expect(text).toContain("Final record self-checked by learner: yes");
      expect(text).toContain("Problem and source version: Private problem");
      reader.getSession("everyday").view = "work";
      reader.render();
      expect(dom.root.innerHTML).toContain("Save them in this browser");
    } finally {
      createObjectURL.mockRestore();
    }
  });

  it("keeps local writing on screen after a storage quota failure", async () => {
    const dom = fakeDom();
    dom.window.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
    });
    dom.writing.value = "keep this";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "keep this",
    );
    expect(reader.getSession("everyday").saveFailed).toBe(true);
    expect(reader.getSession("everyday").message).toMatch(/Download your work/);
  });

  it("preserves the local explicit-save key and stored text exactly", () => {
    const values = {};
    const storage = {
      getItem: (key) => values[key] ?? null,
      setItem: (key, value) => {
        values[key] = value;
      },
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "lesson-v1",
      validState: () => true,
      emptyState: () => state(),
    });
    expect(notebook.load("everyday").state.lessons[0].work).toBe("");
    const exact = "a\u0000b\ud800c";
    const work = state();
    work.lessons[0].work = exact;
    notebook.save({ route: "everyday", immutableState: work });
    const loaded = notebook.load("everyday");
    expect(loaded.state.lessons[0].work).toBe(exact);
    expect(Object.keys(values)[0]).toBe(
      "dne-course-reader-1:everyday:lesson-v1",
    );
  });

  it("does not overwrite an unreadable local save and exposes its stored copy", () => {
    const key = "dne-course-reader-1:everyday:lesson-v1";
    const storage = {
      [key]: "{invalid",
      getItem(name) {
        return this[name] ?? null;
      },
      setItem: vi.fn(),
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "lesson-v1",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.blocked).toBe(true);
    expect(loaded.raw).toBe("{invalid");
    expect(loaded.message).toMatch(/stored copy is unchanged/i);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("leaves an earlier content version separate from the current notebook", () => {
    const oldKey = "dne-course-reader-1:everyday:older";
    const storage = {
      [oldKey]: JSON.stringify({
        version: 1,
        route: "everyday",
        contentHash: "older",
        state: state(),
      }),
      getItem(name) {
        return this[name] ?? null;
      },
      setItem: vi.fn(),
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "current",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.state.lessons[0].work).toBe("");
    expect(loaded.earlier).toEqual([{ key: oldKey, raw: storage[oldKey] }]);
    expect(loaded.message).toMatch(/not been copied/);
  });

  it("keeps a mismatched legacy save as an earlier notebook", () => {
    const legacy = "dne-course-reader-1:everyday";
    const storage = {
      [legacy]: JSON.stringify({
        version: 1,
        route: "everyday",
        contentHash: "old",
        state: state(),
      }),
      getItem(name) {
        return this[name] ?? null;
      },
      setItem: vi.fn(),
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "current",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.blocked).toBe(false);
    expect(loaded.earlier).toEqual([{ key: legacy, raw: storage[legacy] }]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("keeps another earlier notebook available after a corrupt current save", () => {
    const current = "dne-course-reader-1:everyday:current";
    const older = "dne-course-reader-1:everyday:older";
    const storage = {
      [current]: "{bad",
      [older]: "older raw",
      getItem(name) {
        return this[name] ?? null;
      },
      setItem: vi.fn(),
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "current",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.blocked).toBe(true);
    expect(loaded.earlier).toEqual([{ key: older, raw: "older raw" }]);
  });

  it("restores a matching legacy save and leaves other versions available", () => {
    const legacy = "dne-course-reader-1:everyday";
    const older = `${legacy}:older`;
    const saved = state();
    saved.lessons[0].work = "Earlier draft";
    const storage = {
      [legacy]: JSON.stringify({
        version: 1,
        route: "everyday",
        contentHash: "current",
        state: saved,
      }),
      [older]: JSON.stringify({
        version: 1,
        route: "everyday",
        contentHash: "older",
        state: state(),
      }),
      getItem(name) {
        return this[name] ?? null;
      },
      setItem() {},
    };
    const notebook = createBrowserNotebook({
      storage,
      contentHash: "current",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.state.lessons[0].work).toBe("Earlier draft");
    expect(loaded.view).toBe("lesson");
    expect(loaded.earlier).toEqual([{ key: older, raw: storage[older] }]);
  });

  it("allows work and download when browser storage itself is unavailable", () => {
    const notebook = createBrowserNotebook({
      storage: {
        getItem() {
          throw new Error("blocked");
        },
        setItem() {},
      },
      contentHash: "current",
      validState: () => true,
      emptyState: () => state(),
    });
    const loaded = notebook.load("everyday");
    expect(loaded.blocked).toBe(false);
    expect(loaded.message).toMatch(/Browser storage is unavailable/);
  });

  it("preserves a current-version record when its schema or lesson version is wrong", () => {
    const key = "dne-course-reader-1:everyday:current";
    for (const saved of [
      { version: 2, route: "everyday", contentHash: "current", state: state() },
      { version: 1, route: "work", contentHash: "current", state: state() },
      { version: 1, route: "everyday", contentHash: "older", state: state() },
      { version: 1, route: "everyday", contentHash: "current", state: null },
    ]) {
      const storage = {
        [key]: JSON.stringify(saved),
        getItem(name) {
          return this[name] ?? null;
        },
        setItem: vi.fn(),
      };
      const notebook = createBrowserNotebook({
        storage,
        contentHash: "current",
        validState: (value) => Boolean(value),
        emptyState: () => state(),
      });
      const loaded = notebook.load("everyday");
      expect(loaded.blocked).toBe(true);
      expect(loaded.raw).toBe(storage[key]);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });

  it("continues feedback decisions from a confirmed head without inventing older history", () => {
    const feedback = newFeedbackState("everyday");
    feedback.base = {
      sequence: 5,
      artifact: { id: 4, text: "Confirmed text" },
    };
    feedback.draft = {
      decision: "revise",
      text: "New text",
      reason: "Source confirms it",
      question: "",
    };
    expect(currentFeedbackArtifact("everyday", feedback)).toEqual(
      feedback.base.artifact,
    );
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    expect(feedback.records[0]).toMatchObject({
      id: 6,
      fromVersion: 4,
      toVersion: 5,
    });
    expect(validFeedbackState(feedback, "everyday")).toBe(true);
    expect(feedbackHistory(feedback)).toContain("Decision 6");
    expect(feedbackHistory(feedback)).not.toContain("Decision 5");
  });

  it("keeps a feedback decision pending until a reason and changed revision exist", () => {
    const feedback = newFeedbackState("everyday");
    feedback.draft.decision = "revise";
    expect(addFeedbackDecision("everyday", feedback)).toMatch(/reason/);
    feedback.draft.reason = "Checked against the supplied source";
    expect(addFeedbackDecision("everyday", feedback)).toMatch(/different/);
    feedback.draft.text = "Evidence corrected <here>";
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    expect(feedback.records).toHaveLength(1);
    expect(feedbackHistory(feedback)).toContain("&lt;here&gt;");
    expect(feedbackHistory(feedback)).not.toContain("<here>");
  });

  it("keeps declines, unapplied proposals and unfinished responses in feedback export", () => {
    const feedback = newFeedbackState("everyday");
    feedback.draft = {
      decision: "decline",
      text: "A separate suggestion",
      reason: "The source does not support it",
      question: "Which source?",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    feedback.draft.reason = "Unfinished thought";
    const exported = exportFeedback("everyday", feedback);
    expect(exported).toContain(
      "Unapplied proposal retained: A separate suggestion",
    );
    expect(exported).toContain("Unfinished response (not a recorded decision)");
    expect(exported).toContain("Clarification kept locally: Which source?");
  });

  it("rejects malformed feedback heads and contradictory decision records", () => {
    const feedback = newFeedbackState("everyday");
    feedback.base = { sequence: -1, artifact: { id: 2, text: "Base" } };
    expect(validFeedbackState(feedback, "everyday")).toBe(false);
    delete feedback.base;
    feedback.draft = {
      decision: "revise",
      text: "New",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    feedback.records[0].proposedText = "A mismatch";
    expect(validFeedbackState(feedback, "everyday")).toBe(false);
  });

  it("rejects a saved feedback chain that changes the source, version or decision", () => {
    const original = newFeedbackState("everyday");
    original.draft = {
      decision: "revise",
      text: "A checked revision",
      reason: "Source evidence",
      question: "",
    };
    expect(addFeedbackDecision("everyday", original)).toBeNull();
    const corruptions = [
      (copy) => {
        copy.caseId = "another-case";
      },
      (copy) => {
        copy.records[0].id = 3;
      },
      (copy) => {
        copy.records[0].decision = "unknown";
      },
      (copy) => {
        copy.records[0].reason = " ";
      },
      (copy) => {
        copy.records[0].commentVersion = 999;
      },
      (copy) => {
        copy.records[0].fromVersion = 999;
      },
      (copy) => {
        copy.records[0].toVersion = 999;
      },
      (copy) => {
        copy.records[0].text = "";
      },
      (copy) => {
        copy.records[0].proposedText = "different";
      },
      (copy) => {
        copy.draft.reason = "x".repeat(30001);
      },
    ];
    for (const corrupt of corruptions) {
      const copy = globalThis.structuredClone(original);
      corrupt(copy);
      expect(validFeedbackState(copy, "everyday")).toBe(false);
    }
    expect(validFeedbackState(original, "everyday")).toBe(true);
  });

  it("does not claim old feedback was addressed before a newer artifact exists", () => {
    const feedback = newFeedbackState("everyday");
    feedback.draft = {
      decision: "addressed",
      text: "Suggested edit",
      reason: "I checked the versions",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toMatch(
      /no newer draft/i,
    );
    expect(feedback.records).toHaveLength(0);
    feedback.draft.decision = "revise";
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    feedback.draft = {
      decision: "addressed",
      text: "Suggested edit",
      reason: "Now it is in v2",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    expect(validFeedbackState(feedback, "everyday")).toBe(true);
  });

  it("rejects a retained feedback decision that silently changes the artifact", () => {
    const feedback = newFeedbackState("everyday");
    feedback.draft = {
      decision: "decline",
      text: "Separate proposal",
      reason: "Unsupported by source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    expect(validFeedbackState(feedback, "everyday")).toBe(true);
    const changedVersion = globalThis.structuredClone(feedback);
    changedVersion.records[0].toVersion += 1;
    expect(validFeedbackState(changedVersion, "everyday")).toBe(false);
    const changedText = globalThis.structuredClone(feedback);
    changedText.records[0].text = "Silently replaced";
    expect(validFeedbackState(changedText, "everyday")).toBe(false);
    const unknown = newFeedbackState("everyday");
    unknown.draft.decision = "unknown";
    expect(addFeedbackDecision("everyday", unknown)).toMatch(
      /Choose what to do/,
    );
  });

  it("shows a retained decision, its clarification and local save guidance", () => {
    const feedback = newFeedbackState("everyday");
    feedback.draft = {
      decision: "decline",
      text: "Unapplied proposal",
      reason: "Source says otherwise",
      question: "Which source would change this?",
    };
    const pending = renderFeedback("everyday", feedback);
    expect(pending).toContain("This decision retains draft");
    expect(pending).toContain("Save in this browser");
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    expect(feedbackHistory(feedback)).toContain(
      "Clarification kept in this notebook",
    );
    expect(feedbackHistory(feedback)).toContain("Unapplied proposal retained");
    const revised = newFeedbackState("everyday");
    revised.draft = {
      decision: "revise",
      text: "New verified text",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", revised)).toBeNull();
    expect(exportFeedback("everyday", revised)).not.toContain(
      "Unapplied proposal retained",
    );
  });
});

describe("private contribution boundary", () => {
  it("retains an unfinished private proposal but requires source and rights notes for a self-check", () => {
    const proposal = newContribution();
    proposal.problem = "A useful problem";
    proposal.first = "First proposal";
    expect(validContribution(proposal)).toBe(true);
    expect(contributionReady(proposal)).toBe(false);
    proposal.checked = true;
    expect(validContribution(proposal)).toBe(false);
    proposal.checked = false;
    proposal.reason = "The supplied source supports it";
    proposal.rights = "Use only invented material";
    expect(contributionReady(proposal)).toBe(true);
    proposal.checked = true;
    expect(validContribution(proposal)).toBe(true);
    expect(renderContribution(proposal, true)).toContain("Save my work");
    expect(exportContribution(proposal, () => "Source")).toContain(
      "Proposal self-checked by learner: yes",
    );
  });

  it("requires attribution for a planned member audience without treating the plan as permission", () => {
    const proposal = newContribution();
    Object.assign(proposal, {
      problem: "Problem",
      first: "First",
      reason: "Evidence",
      rights: "Rights",
      audience: "members-later",
      checked: false,
    });
    expect(contributionReady(proposal)).toBe(false);
    proposal.attribution = "Example learner";
    expect(contributionReady(proposal)).toBe(true);
    const html = renderContribution(proposal);
    expect(html).toContain("An audience plan is not permission");
    expect(html).toContain("Save in this browser");
    expect(exportContribution(proposal, () => "Source")).toContain(
      "Member-only sharing considered for later",
    );
  });

  it("rejects invalid saved proposal shapes and overlong writing", () => {
    expect(validContribution(null)).toBe(false);
    expect(validContribution([])).toBe(false);
    const proposal = newContribution();
    proposal.problem = "x".repeat(30000);
    expect(validContribution(proposal)).toBe(true);
    for (const change of [
      (copy) => {
        copy.problem += "x";
      },
      (copy) => {
        copy.reason = null;
      },
      (copy) => {
        copy.audience = "public";
      },
      (copy) => {
        copy.checked = "yes";
      },
    ]) {
      const copy = globalThis.structuredClone(proposal);
      change(copy);
      expect(validContribution(copy)).toBe(false);
    }
  });
});

describe("local reader entry", () => {
  it("mounts the published browser preview with the existing explicit-save controls", async () => {
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    const document = {
      querySelector: (selector) => (selector === "#app" ? dom.root : null),
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", dom.window);
    try {
      await import("../../assets/docs/learning-design/reader/local-entry.mjs");
      expect(dom.root.innerHTML).toContain("Your learning path");
      expect(dom.root.innerHTML).toContain("Save in this browser");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reader controls and recovery edges", () => {
  const account = (dom, extra = {}) =>
    mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
      storage: {
        mode: "account",
        load: async (route) => ({ kind: "ready", state: state(route) }),
        ...extra,
      },
    });

  it("does not repaint after unmount or a late route load", async () => {
    const dom = fakeDom();
    let finish;
    const later = new Promise((resolve) => {
      finish = resolve;
    });
    const reader = await account(dom, {
      load: (route) =>
        route === "work"
          ? later
          : Promise.resolve({ kind: "ready", state: state(route) }),
    });
    const switched = dom.node("route-work").handlers.click();
    reader.destroy();
    reader.render();
    finish({ kind: "ready", state: state("work") });
    await switched;
    expect(dom.root.innerHTML).toBe("");
  });

  it("ignores empty course-path clicks and a stale detached hint", async () => {
    const dom = fakeDom();
    const reader = await account(dom);
    const original = reader.getSession("everyday").state.lesson;
    dom
      .node("#course-path")
      .handlers.click({ target: { closest: () => null } });
    expect(reader.getSession("everyday").state.lesson).toBe(original);
    dom
      .node("#hint")
      .handlers.toggle({ target: { isConnected: false, open: true } });
    expect(reader.getSession("everyday").state.lessons[0].hint).toBe(false);
  });

  it("navigates between lesson steps and both sides of the connected case", async () => {
    const dom = fakeDom();
    const reader = await account(dom);
    const s = reader.getSession("everyday");
    s.view = "lesson";
    s.state.lesson = 1;
    s.state.step = 1;
    reader.render();
    dom.node("#next").handlers.click();
    expect(s.state.step).toBe(2);
    dom.node("#back").handlers.click();
    expect(s.state.step).toBe(1);
    s.state.step = 0;
    reader.render();
    dom.node("#back").handlers.click();
    expect(s.state.lesson).toBe(0);
    s.state.lesson = 5;
    s.state.step = 3;
    reader.render();
    dom.node("#next").handlers.click();
    expect(s.state.lesson).toBe(6);
    expect(s.state.finalStep).toBe(0);
    reader.render();
    dom.node("#next").handlers.click();
    expect(s.state.finalStep).toBe(1);
    dom.node("#back").handlers.click();
    expect(s.state.finalStep).toBe(0);
    dom.node("#back").handlers.click();
    expect(s.state.lesson).toBe(5);
    expect(s.state.step).toBe(3);
  });

  it("keeps earlier feedback available when paging fails", async () => {
    const dom = fakeDom();
    const reader = await account(dom, {
      load: async () => ({
        kind: "ready",
        state: state(),
        feedbackHistoryPage: { items: [{ id: 1 }], nextCursor: "older" },
      }),
      history: async () => {
        throw new Error("offline");
      },
    });
    reader.getSession("everyday").view = "work";
    reader.render();
    await dom.node("#feedback-older").handlers.click();
    expect(reader.getSession("everyday").feedbackHistoryPage.items).toEqual([
      { id: 1 },
    ]);
    expect(reader.getSession("everyday").feedbackNotice).toMatch(
      /could not be loaded/,
    );
  });

  it("does not request another feedback page without an earlier cursor", async () => {
    const dom = fakeDom();
    const history = vi.fn();
    const reader = await account(dom, { history });
    reader.getSession("everyday").view = "work";
    reader.render();
    await dom.node("#feedback-older").handlers.click();
    expect(history).not.toHaveBeenCalled();
  });

  it("keeps an invalid feedback submission editable and records field edits", async () => {
    const dom = fakeDom();
    const input = dom.node("feedback-reason");
    input.dataset.feedbackField = "reason";
    dom.list("[data-feedback-field]", [input]);
    const reader = await account(dom);
    const s = reader.getSession("everyday");
    s.view = "lesson";
    s.state.lesson = 6;
    s.state.finalStep = 3;
    reader.render();
    dom.node("#feedback-form").handlers.submit({ preventDefault() {} });
    expect(dom.node("#feedback-notice").textContent).toMatch(
      /Choose|response|decision/i,
    );
    input.value = "The source was incomplete";
    input.handlers.input();
    expect(s.state.feedback.draft.reason).toBe("The source was incomplete");
    expect(s.dirty).toBe(true);
  });

  it("resolves a pending receipt check without repainting after unmount", async () => {
    const dom = fakeDom();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const reader = await account(dom, {
      save: async () => ({ kind: "unconfirmed" }),
      inspect: () => pending,
    });
    dom.writing.value = "draft";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    const checking = dom.node("#check-save").handlers.click();
    reader.destroy();
    finish({ kind: "saved", revision: 2 });
    await checking;
    expect(reader.getSession("everyday").dirty).toBe(false);
  });

  it("uses safe JSON download defaults", async () => {
    const dom = fakeDom();
    const anchor = { click: vi.fn() };
    const document = { createElement: () => anchor };
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:reader");
    const reader = await mountReader({
      root: dom.root,
      document,
      window: dom.window,
      storage: {
        mode: "account",
        load: async (route) => ({ kind: "ready", state: state(route) }),
        download: async () => ({ text: "exact" }),
      },
    });
    await dom.node("#download").handlers.click();
    expect(anchor.download).toBe("foundation-everyday.json");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    reader.destroy();
    create.mockRestore();
  });

  it("keeps a blocked notebook's writing without promising another save", async () => {
    const dom = fakeDom();
    const reader = await account(dom, {
      save: async () => ({ kind: "conflict" }),
    });
    const oldInput = dom.writing.handlers.input;
    dom.writing.value = "Before conflict";
    oldInput();
    await dom.node("#save").handlers.click();
    dom.writing.value = "After conflict";
    oldInput();
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "After conflict",
    );
    expect(reader.getSession("everyday").blocked).toBe(true);
    expect(reader.getSession("everyday").message).toMatch(/changed elsewhere/);
  });

  it("does not show late feedback paging failure on another route", async () => {
    const dom = fakeDom();
    let fail;
    const pending = new Promise((_resolve, reject) => {
      fail = reject;
    });
    const reader = await account(dom, {
      load: async (route) => ({
        kind: "ready",
        state: state(route),
        feedbackHistoryPage: { items: [], nextCursor: "older" },
      }),
      history: () => pending,
    });
    reader.getSession("everyday").view = "work";
    reader.render();
    const older = dom.node("#feedback-older").handlers.click();
    await dom.node("route-work").handlers.click();
    const workPage = dom.root.innerHTML;
    fail(new Error("offline"));
    await older;
    expect(reader.route).toBe("work");
    expect(dom.root.innerHTML).toBe(workPage);
    expect(reader.getSession("everyday").feedbackNotice).toMatch(
      /could not be loaded/,
    );
  });

  it("keeps feedback field changes when the comparison panel has moved away", async () => {
    const dom = fakeDom();
    const input = dom.node("feedback-text");
    input.dataset.feedbackField = "text";
    dom.list("[data-feedback-field]", [input]);
    const reader = await account(dom);
    reader.getSession("everyday").view = "lesson";
    reader.getSession("everyday").state.lesson = 6;
    reader.render();
    const oldInput = input.handlers.input;
    const original = dom.root.querySelector;
    dom.root.querySelector = (selector) =>
      selector === "#feedback-proposed" ? null : original(selector);
    input.value = "Changed proposed answer";
    oldInput();
    expect(reader.getSession("everyday").state.feedback.draft.text).toBe(
      "Changed proposed answer",
    );
  });

  it("records local feedback with local save guidance", async () => {
    const dom = fakeDom();
    dom.window.localStorage = { getItem: () => null, setItem() {} };
    const reader = await mountReader({
      root: dom.root,
      document: {},
      window: dom.window,
    });
    const s = reader.getSession("everyday");
    s.view = "lesson";
    s.state.lesson = 6;
    s.state.finalStep = 3;
    reader.render();
    s.state.feedback.draft = {
      decision: "revise",
      text: "Local revised answer",
      reason: "Source line",
      question: "",
    };
    dom.node("#feedback-form").handlers.submit({ preventDefault() {} });
    expect(s.state.feedback.records).toHaveLength(1);
    expect(s.feedbackNotice).toMatch(/Save in this browser/);
  });

  it("accepts transfer writing on the step without a self-check control", async () => {
    const dom = fakeDom();
    const reader = await account(dom);
    const s = reader.getSession("everyday");
    s.view = "lesson";
    s.state.step = 2;
    reader.render();
    const original = dom.root.querySelector;
    dom.root.querySelector = (selector) =>
      selector === "#self-check" ? null : original(selector);
    dom.writing.dataset.writing = "transfer";
    dom.writing.value = "New case attempt";
    dom.writing.handlers.input();
    expect(s.state.lessons[0].transfer).toBe("New case attempt");
  });

  it("uses the platform operation ID when the host does not provide crypto", async () => {
    const dom = fakeDom();
    delete dom.window.crypto;
    const save = vi.fn(async () => ({ kind: "saved", revision: 1 }));
    await account(dom, { save });
    await dom.node("#save").handlers.click();
    expect(save.mock.calls[0][0].operationId).toBeTruthy();
  });

  it("reports plural uncertain feedback decisions without claiming the draft saved", async () => {
    const dom = fakeDom();
    const reader = await account(dom, {
      save: async () => ({ kind: "unconfirmed", confirmedDecisionCount: 2 }),
    });
    const feedback = reader.getSession("everyday").state.feedback;
    for (const [text, reason] of [
      ["Revision 1", "Source 1"],
      ["Revision 2", "Source 2"],
    ]) {
      feedback.draft = { decision: "revise", text, reason, question: "" };
      expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    }
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").message).toMatch(
      /after 2 feedback decisions were confirmed/,
    );
    expect(reader.getSession("everyday").dirty).toBe(true);
  });

  it("reports a single confirmed decision when the draft save is unavailable", async () => {
    const dom = fakeDom();
    const reader = await account(dom, {
      save: async () => ({ kind: "unavailable", confirmedDecisionCount: 1 }),
    });
    const feedback = reader.getSession("everyday").state.feedback;
    feedback.draft = {
      decision: "revise",
      text: "Revision",
      reason: "Source",
      question: "",
    };
    expect(addFeedbackDecision("everyday", feedback)).toBeNull();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").message).toMatch(
      /after 1 feedback decision was confirmed/,
    );
  });

  it("ignores a repeated receipt check after a confirmed save", async () => {
    const dom = fakeDom();
    const inspect = vi.fn(async () => ({ kind: "saved", revision: 2 }));
    await account(dom, {
      save: async () => ({ kind: "unconfirmed" }),
      inspect,
    });
    await dom.node("#save").handlers.click();
    const check = dom.node("#check-save").handlers.click;
    await check();
    await check();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("warns before leaving an account with unsaved writing", async () => {
    const dom = fakeDom();
    let beforeUnload;
    dom.window.addEventListener = (type, handler) => {
      if (type === "beforeunload") beforeUnload = handler;
    };
    await account(dom);
    dom.writing.value = "Unsaved account writing";
    dom.writing.handlers.input();
    const preventDefault = vi.fn();
    beforeUnload({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("reports an unavailable draft save without inventing feedback confirmations", async () => {
    const dom = fakeDom();
    const reader = await account(dom, {
      save: async () => ({ kind: "unavailable", confirmedDecisionCount: 0 }),
    });
    dom.writing.value = "Unsaved answer";
    dom.writing.handlers.input();
    await dom.node("#save").handlers.click();
    expect(reader.getSession("everyday").message).toMatch(
      /^Save stopped\. Your writing remains here/,
    );
    expect(reader.getSession("everyday").state.lessons[0].work).toBe(
      "Unsaved answer",
    );
  });

  it("can resolve a cached receipt check after the reader unmounts", async () => {
    const dom = fakeDom();
    const inspect = vi.fn(async () => ({ kind: "not-confirmed" }));
    const reader = await account(dom, {
      save: async () => ({ kind: "unconfirmed" }),
      inspect,
    });
    await dom.node("#save").handlers.click();
    const check = dom.node("#check-save").handlers.click;
    reader.destroy();
    await check();
    expect(inspect).toHaveBeenCalledOnce();
    expect(dom.root.innerHTML).toBe("");
  });

  it("does not replace another route after a delayed download failure", async () => {
    const dom = fakeDom();
    let fail;
    const pending = new Promise((_resolve, reject) => {
      fail = reject;
    });
    const reader = await account(dom, { download: () => pending });
    const download = dom.node("#download").handlers.click();
    await dom.node("route-work").handlers.click();
    const currentPage = dom.root.innerHTML;
    fail(new Error("offline"));
    await download;
    expect(reader.route).toBe("work");
    expect(dom.root.innerHTML).toBe(currentPage);
    expect(reader.getSession("everyday").message).toMatch(/Download failed/);
  });
});
