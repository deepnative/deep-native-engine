import { emptyState } from "../../assets/docs/learning-design/reader/reader.mjs";

export function readerDom(route = "everyday") {
  const nodes = new Map();
  const groups = new Map();
  const node = (selector, dataset = {}) => {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        dataset,
        handlers: {},
        classList: { toggle() {}, remove() {} },
        addEventListener(type, handler) {
          this.handlers[type] = handler;
        },
        focus() {},
        scrollIntoView() {},
        matches() {
          return true;
        },
        setAttribute() {},
        isConnected: true,
        disabled: false,
      });
    }
    return nodes.get(selector);
  };
  const controls = (selector, values) => {
    groups.set(
      selector,
      values.map((dataset, index) => node(`${selector}:${index}`, dataset)),
    );
    return groups.get(selector);
  };
  const root = {
    innerHTML: "",
    querySelector: node,
    querySelectorAll(selector) {
      return groups.get(selector) ?? [];
    },
  };
  const listeners = new Map();
  const window = {
    location: { hash: `#route=${route}` },
    matchMedia: () => ({ matches: false }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    crypto: { randomUUID: () => "reader-test-save" },
    history: { replaceState() {} },
    scrollTo() {},
  };
  return { root, window, node, controls, listeners };
}

export function readyNotebook(route, overrides = {}) {
  return {
    kind: "ready",
    notebookId: `notebook-${route}`,
    revision: 1,
    savedDraftRevision: 1,
    state: emptyState(route),
    ...overrides,
  };
}
