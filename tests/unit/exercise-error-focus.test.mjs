import { afterAll, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelector: () => null });
const { bindExerciseErrorFocus } =
  await import("../../public/exercise-error-focus.js");
afterAll(() => vi.unstubAllGlobals());

function exerciseError(target, field = "verification") {
  const handlers = new Map();
  const link = {
    getAttribute: () => `#${field}`,
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  const summary = { querySelectorAll: () => [link] };
  const doc = {
    querySelector: (selector) =>
      selector === "[data-exercise-errors]" ? summary : null,
    getElementById: (id) => (id === field ? target : null),
  };
  bindExerciseErrorFocus(doc);
  return (overrides = {}) => {
    const event = {
      button: 0,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
    handlers.get("click")(event);
    return event;
  };
}

it("leaves pages without exercise errors and summaries without field links alone", () => {
  const getElementById = vi.fn();
  bindExerciseErrorFocus({ querySelector: () => null, getElementById });
  bindExerciseErrorFocus({
    querySelector: () => ({ querySelectorAll: () => [] }),
    getElementById,
  });
  expect(getElementById).not.toHaveBeenCalled();
});

it.each(["", "Retained sample notes 📝"])(
  "focuses the matching textarea and places a caret after preserved text: %j",
  (value) => {
    const target = {
      tagName: "TEXTAREA",
      value,
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    const event = exerciseError(target)();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledOnce();
    expect(target.setSelectionRange).toHaveBeenCalledExactlyOnceWith(
      value.length,
      value.length,
    );
    expect(target.value).toBe(value);
  },
);

it("focuses confirmation without checking it or implicitly submitting", () => {
  const target = { tagName: "INPUT", checked: false, focus: vi.fn() };
  const event = exerciseError(target, "checked")();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(target.focus).toHaveBeenCalledOnce();
  expect(target.checked).toBe(false);
});

it("keeps ordinary fragment behavior when its target is absent", () => {
  const event = exerciseError(null)();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it.each([
  { defaultPrevented: true },
  { button: 1 },
  { button: 2 },
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
])(
  "leaves modified, nonprimary or already-handled clicks alone: %j",
  (click) => {
    const target = { tagName: "TEXTAREA", focus: vi.fn() };
    const event = exerciseError(target)(click);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(target.focus).not.toHaveBeenCalled();
  },
);
