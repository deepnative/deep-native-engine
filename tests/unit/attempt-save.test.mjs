import { afterAll, expect, it, vi } from "vitest";

// The browser module binds on load. Import it with an empty document first,
// then exercise the exported binder with explicit synthetic DOM controls.
vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("window", { addEventListener: () => {} });
const { bindAttemptSave } = await import("../../public/attempt-save.js");
afterAll(() => vi.unstubAllGlobals());

it("leaves unrelated pages without a save form alone", () => {
  let registered = false;
  bindAttemptSave(
    { querySelector: () => null },
    { addEventListener: () => (registered = true) },
  );
  expect(registered).toBe(false);
});

it("announces pending work, prevents repeat submit, and resets only restored pages", () => {
  const button = { disabled: false };
  const status = { hidden: true };
  const formHandlers = new Map();
  const browserHandlers = new Map();
  const form = {
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? button : status;
    },
    addEventListener(event, handler) {
      formHandlers.set(event, handler);
    },
  };
  bindAttemptSave(
    { querySelector: () => form },
    {
      addEventListener(event, handler) {
        browserHandlers.set(event, handler);
      },
    },
  );
  expect([...formHandlers.keys()]).toEqual(["submit"]);
  expect([...browserHandlers.keys()]).toEqual(["pageshow"]);
  formHandlers.get("submit")();
  expect(button.disabled).toBe(true);
  expect(status.hidden).toBe(false);
  browserHandlers.get("pageshow")({ persisted: false });
  expect(button.disabled).toBe(true);
  expect(status.hidden).toBe(false);
  browserHandlers.get("pageshow")({ persisted: true });
  expect(button.disabled).toBe(false);
  expect(status.hidden).toBe(true);
});
