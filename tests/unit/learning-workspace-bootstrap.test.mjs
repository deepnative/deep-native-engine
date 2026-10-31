import { expect, it, vi } from "vitest";
import { bootstrapLearningWorkspace } from "../../public/learning-workspace.js";

const hash = "a".repeat(64);
const base = `/learn/workspace/content/LRN-001/1/${hash}`;
const feedbackCases = Object.fromEntries(
  ["everyday", "work", "technical"].map((route) => [
    route,
    {
      versions: [{ id: 2, text: `${route} example` }],
    },
  ]),
);

function page(overrides = {}) {
  const root = {
    dataset: {
      workspaceModuleBase: base,
      workspaceCsrf: "b".repeat(64),
      workspaceRoute: "everyday",
      ...overrides,
    },
    innerHTML: "Opening…",
  };
  const fetch = vi.fn(async () => globalThis.Response.json({ kind: "empty" }));
  const window = {
    fetch,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    location: { hash: "#route=technical&panel=notes" },
    history: { replaceState: vi.fn() },
  };
  const document = { querySelector: vi.fn(() => root) };
  const mountReader = vi.fn(async () => ({ mounted: true }));
  const emptyState = vi.fn((route) => ({ route }));
  const importModule = vi.fn(async (url) =>
    url.endsWith("/reader.mjs")
      ? { mountReader, emptyState }
      : { course: { version: 1, contentHash: hash, feedbackCases } },
  );
  return {
    root,
    fetch,
    window,
    document,
    mountReader,
    emptyState,
    importModule,
  };
}

it("LWORK-01: mounts the guarded account reader and keeps route changes in the URL hash", async () => {
  const ui = page();
  await bootstrapLearningWorkspace(ui);
  expect(ui.importModule.mock.calls.map(([url]) => url)).toEqual([
    `${base}/reader.mjs`,
    `${base}/course.mjs`,
  ]);
  expect(ui.mountReader).toHaveBeenCalledOnce();
  const mounted = ui.mountReader.mock.calls[0][0];
  expect(mounted).toMatchObject({
    root: ui.root,
    document: ui.document,
    window: ui.window,
    initialRoute: "technical",
    storage: { mode: "account" },
    presentation: { accountLabel: "Private to your account" },
  });
  expect((await mounted.storage.load("work")).state).toEqual({ route: "work" });
  expect(ui.fetch.mock.calls[0][0]).toBe(
    "/api/learning-workspace/current?variant=work",
  );
  mounted.presentation.onRouteChange("work");
  expect(ui.window.history.replaceState).toHaveBeenCalledWith(
    null,
    "",
    "#route=work&panel=notes",
  );
  mounted.presentation.onRouteChange("not-a-route");
  expect(ui.window.history.replaceState).toHaveBeenCalledOnce();
});

it("uses the server route when the URL hash does not select a valid example", async () => {
  const ui = page({ workspaceRoute: "work" });
  ui.window.location.hash = "#route=unknown";
  await bootstrapLearningWorkspace(ui);
  expect(ui.mountReader.mock.calls[0][0].initialRoute).toBe("work");
});

it.each([
  { workspaceModuleBase: "https://untrusted.example/reader" },
  { workspaceModuleBase: undefined },
  {
    workspaceModuleBase: `/learn/workspace/content/LRN-001/1/${hash.toUpperCase()}`,
  },
  { workspaceCsrf: undefined },
  { workspaceRoute: "unknown" },
])(
  "shows fixed recovery when page configuration is invalid: %j",
  async (dataset) => {
    const ui = page(dataset);
    const outcome = await bootstrapLearningWorkspace(ui);
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(ui.importModule).not.toHaveBeenCalled();
    expect(ui.mountReader).not.toHaveBeenCalled();
    expect(ui.root.innerHTML).toContain(
      "Your practice notebook is unavailable",
    );
    expect(ui.root.innerHTML).toContain('href="/learn/records"');
    expect(ui.root.innerHTML).toContain('href="/account"');
    expect(ui.root.innerHTML).not.toContain("untrusted.example");
  },
);

it.each([
  "content-hash",
  "content-version",
  "feedback-cases",
  "partial-feedback",
  "mount-export",
  "empty-export",
])("does not mount an incomplete %s module bundle", async (missing) => {
  const ui = page();
  ui.importModule.mockImplementation(async (url) => {
    if (url.endsWith("/course.mjs"))
      return {
        course: {
          version: missing === "content-version" ? 2 : 1,
          contentHash: missing === "content-hash" ? "c".repeat(64) : hash,
          feedbackCases:
            missing === "feedback-cases"
              ? undefined
              : missing === "partial-feedback"
                ? { everyday: feedbackCases.everyday }
                : feedbackCases,
        },
      };
    return {
      mountReader: missing === "mount-export" ? undefined : ui.mountReader,
      emptyState: missing === "empty-export" ? undefined : ui.emptyState,
    };
  });
  expect(await bootstrapLearningWorkspace(ui)).toEqual({
    kind: "unavailable",
  });
  expect(ui.mountReader).not.toHaveBeenCalled();
  expect(ui.root.innerHTML).toContain("Open your learning records");
});

it("keeps a fixed recovery page if the content import or mount fails", async () => {
  const ui = page();
  ui.importModule.mockRejectedValueOnce(new Error("<private source>"));
  expect(await bootstrapLearningWorkspace(ui)).toEqual({ kind: "unavailable" });
  expect(ui.root.innerHTML).not.toContain("private source");
  ui.importModule.mockImplementation(async (url) =>
    url.endsWith("/reader.mjs")
      ? {
          mountReader: vi.fn(async () => {
            throw Error("secret detail");
          }),
          emptyState: ui.emptyState,
        }
      : { course: { version: 1, contentHash: hash, feedbackCases } },
  );
  expect(await bootstrapLearningWorkspace(ui)).toEqual({ kind: "unavailable" });
  expect(ui.root.innerHTML).not.toContain("secret detail");
});

it("handles a missing app root and a missing imported module without unsafe output", async () => {
  const ui = page();
  ui.document.querySelector.mockReturnValue(null);
  expect(await bootstrapLearningWorkspace(ui)).toEqual({ kind: "unavailable" });
  expect(ui.importModule).not.toHaveBeenCalled();
  ui.document.querySelector.mockReturnValue(ui.root);
  expect(
    await bootstrapLearningWorkspace({
      document: ui.document,
      window: ui.window,
    }),
  ).toEqual({ kind: "unavailable" });
  expect(ui.root.innerHTML).toContain("Your practice notebook is unavailable");
});

it("starts automatically in a browser context and shows recovery for invalid configuration", async () => {
  const ui = page({ workspaceModuleBase: "invalid" });
  vi.stubGlobal("document", ui.document);
  vi.stubGlobal("window", ui.window);
  try {
    vi.resetModules();
    await import("../../public/learning-workspace.js?bootstrap-auto-test");
    await vi.waitFor(() =>
      expect(ui.root.innerHTML).toContain(
        "Your practice notebook is unavailable",
      ),
    );
    expect(ui.document.querySelector).toHaveBeenCalledWith("#app");
  } finally {
    vi.unstubAllGlobals();
  }
});
