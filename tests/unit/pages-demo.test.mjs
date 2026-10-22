import { afterAll, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("window", {});
const { readSample, bindPagesDemo } =
  await import("../../public/pages-demo.js");
afterAll(() => vi.unstubAllGlobals());
const key = "dne-pages-demo-v1";
const draft = {
  version: 1,
  direction: "general",
  response: "Invite neighbours to the invented Saturday workshop.",
  checked: false,
  completed: false,
};

function view(initial = null, fail = "") {
  const data = new Map([["unrelated-example", "keep this"]]);
  if (initial !== null) data.set(key, initial);
  const ids = [
    "direction",
    "response",
    "check",
    "status",
    "progress",
    "save",
    "complete",
    "reset",
  ];
  const controls = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        value: "",
        checked: false,
        disabled: true,
        textContent: id === "progress" ? "0 / 1 sample completed" : "",
        handlers: new Map(),
        focused: false,
        addEventListener(event, handler) {
          this.handlers.set(event, handler);
        },
        focus() {
          this.focused = true;
        },
      },
    ]),
  );
  const storage = {
    getItem(k) {
      if (fail === "read") throw new Error("unavailable");
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (fail === "write") throw new Error("full");
      data.set(k, v);
    },
    removeItem(k) {
      if (fail === "remove") throw new Error("denied");
      data.delete(k);
    },
  };
  bindPagesDemo(
    { querySelector: () => ({ querySelector: (s) => controls[s.slice(6)] }) },
    { sessionStorage: storage },
  );
  return {
    controls,
    data,
    click(id) {
      controls[id].handlers.get("click")();
    },
    change(id, event) {
      controls[id].handlers.get(event)();
    },
  };
}

it("PAGES-DEMO-01 reads only compatible sample drafts and self-checked completions", () => {
  expect(readSample(null)).toBeNull();
  for (const direction of ["general", "professional", "technical"]) {
    const value = { ...draft, direction };
    expect(readSample(JSON.stringify(value))).toEqual(value);
    const complete = { ...value, checked: true, completed: true };
    expect(readSample(JSON.stringify(complete))).toEqual(complete);
  }
  expect(readSample(JSON.stringify({ ...draft, response: "" }))).toMatchObject({
    response: "",
    completed: false,
  });
});

it.each([
  "not json",
  "null",
  "1",
  "[]",
  JSON.stringify({ ...draft, version: 2 }),
  JSON.stringify({ ...draft, direction: "administrator" }),
  JSON.stringify({ ...draft, response: 4 }),
  JSON.stringify({ ...draft, response: "x".repeat(1201) }),
  JSON.stringify({ ...draft, checked: "yes" }),
  JSON.stringify({ ...draft, completed: 1 }),
  JSON.stringify({ ...draft, checked: true, completed: true, response: "  " }),
  JSON.stringify({ ...draft, completed: true }),
])(
  "PAGES-DEMO-03 refuses a malformed or incompatible saved sample: %s",
  (value) => {
    expect(() => readSample(value)).toThrow();
  },
);

it("leaves pages without a demo untouched", () => {
  bindPagesDemo({ querySelector: () => null }, {});
});

it("PAGES-DEMO-01 restores exact draft/completion values and enables only sample controls", () => {
  for (const completed of [false, true]) {
    const value = { ...draft, checked: completed, completed };
    const { controls } = view(JSON.stringify(value));
    expect(controls.direction.value).toBe(value.direction);
    expect(controls.response.value).toBe(value.response);
    expect(controls.check.checked).toBe(completed);
    expect(controls.progress.textContent).toBe(
      `${completed ? 1 : 0} / 1 sample completed`,
    );
    expect(controls.status.textContent).toContain("Restored");
    for (const id of [
      "direction",
      "response",
      "check",
      "save",
      "complete",
      "reset",
    ])
      expect(controls[id].disabled).toBe(false);
  }
});

it.each(["read", "malformed"])(
  "PAGES-DEMO-03 recovers from %s storage without altering it",
  (fail) => {
    const { data, controls } = view("broken sample", fail);
    expect(controls.status.textContent).toContain("could not be read");
    expect(controls.response.value).toBe("");
    expect(controls.progress.textContent).toBe("0 / 1 sample completed");
    expect(data.get(key)).toBe("broken sample");
    expect(data.get("unrelated-example")).toBe("keep this");
  },
);

it("PAGES-DEMO-03 handles a browser that refuses access to the storage property", () => {
  const { controls } = view();
  bindPagesDemo(
    { querySelector: () => ({ querySelector: (s) => controls[s.slice(6)] }) },
    {
      get sessionStorage() {
        throw new Error("disabled");
      },
    },
  );
  expect(controls.status.textContent).toContain("could not be read");
});

it("PAGES-DEMO-02 keeps entered text and last saved record through direction, length and completion corrections", () => {
  const v = view(JSON.stringify(draft));
  v.controls.direction.value = "";
  v.click("save");
  expect(v.controls.direction.focused).toBe(true);
  expect(v.controls.status.textContent).toContain("direction");
  expect(v.controls.response.value).toBe(draft.response);
  v.controls.direction.value = "technical";
  v.controls.response.value = "x".repeat(1201);
  v.click("save");
  expect(v.controls.response.focused).toBe(true);
  expect(v.controls.status.textContent).toContain("1,200");
  expect(v.controls.response.value.length).toBe(1201);
  v.controls.response.value = "  ";
  v.click("complete");
  expect(v.controls.status.textContent).toContain("Write a sample response");
  expect(v.controls.response.value).toBe("  ");
  v.controls.response.value = draft.response;
  v.click("complete");
  expect(v.controls.check.focused).toBe(true);
  expect(v.controls.status.textContent).toContain("self-check");
  expect(v.data.get(key)).toBe(JSON.stringify(draft));
  v.controls.check.checked = true;
  v.click("complete");
  expect(JSON.parse(v.data.get(key))).toEqual({
    ...draft,
    direction: "technical",
    checked: true,
    completed: true,
  });
  expect(v.controls.progress.textContent).toBe("1 / 1 sample completed");
  expect(v.controls.status.textContent).toContain("not an assessment");
});

it("PAGES-DEMO-01 deliberately saves a draft, preserving whitespace and keeping completion separate", () => {
  const v = view();
  v.controls.direction.value = "professional";
  v.controls.response.value = "  A draft\nwith sample details.  ";
  v.click("save");
  expect(JSON.parse(v.data.get(key))).toEqual({
    version: 1,
    direction: "professional",
    response: v.controls.response.value,
    checked: false,
    completed: false,
  });
  expect(v.controls.progress.textContent).toBe("0 / 1 sample completed");
  expect(v.controls.status.textContent).toContain("draft saved");
});

it("PAGES-DEMO-02 edits require a fresh self-check and an explicit save", () => {
  const value = JSON.stringify({ ...draft, checked: true, completed: true });
  const v = view(value);
  v.controls.response.value = "Changed draft";
  v.change("response", "input");
  expect(v.controls.check.checked).toBe(false);
  expect(v.controls.progress.textContent).toBe("Unsaved sample changes");
  v.controls.check.checked = true;
  v.change("direction", "change");
  expect(v.controls.check.checked).toBe(false);
  v.controls.check.checked = true;
  v.change("check", "change");
  expect(v.controls.status.textContent).toContain("self-check has changed");
  expect(v.data.get(key)).toBe(value);
});

it("PAGES-DEMO-03 never claims persistence after a failed write and retains the response", () => {
  const v = view(JSON.stringify(draft), "write");
  v.controls.response.value = "Keep this unsaved response";
  v.click("save");
  expect(v.controls.response.value).toBe("Keep this unsaved response");
  expect(v.controls.progress.textContent).toBe("Sample changes not saved");
  expect(v.controls.status.textContent).toContain("not saved");
  expect(v.data.get(key)).toBe(JSON.stringify(draft));
});

it("PAGES-DEMO-02 resets only the sample namespace", () => {
  const v = view(JSON.stringify(draft));
  v.click("reset");
  expect(v.data.has(key)).toBe(false);
  expect([...v.data]).toEqual([["unrelated-example", "keep this"]]);
  expect(v.controls.direction.value).toBe("");
  expect(v.controls.response.value).toBe("");
  expect(v.controls.check.checked).toBe(false);
  expect(v.controls.progress.textContent).toBe("0 / 1 sample completed");
  expect(v.controls.status.textContent).toContain("user portal are unchanged");
});

it("PAGES-DEMO-03 warns when resetting cannot remove a saved record", () => {
  const v = view(JSON.stringify(draft), "remove");
  v.click("reset");
  expect(v.controls.response.value).toBe("");
  expect(v.data.get(key)).toBe(JSON.stringify(draft));
  expect(v.controls.status.textContent).toContain("may return on reload");
  expect(v.data.get("unrelated-example")).toBe("keep this");
});
