import { Blob } from "node:buffer";
import { afterAll, expect, it, vi } from "vitest";
vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("window", {});
const { bindMemberExport } = await import("../../public/member-export.js");
afterAll(() => vi.unstubAllGlobals());
const payload = (page = {}) => ({
  kind: "ready",
  page: {
    number: 1,
    recordCount: 2,
    consistency: "live-pages",
    complete: false,
    nextCursor: "signed-next",
    ...page,
  },
  records: { examples: ["invented"] },
});
function setup(value = payload(), failure = "") {
  let click;
  const button = {
    disabled: false,
    addEventListener: (_name, handler) => {
      click = handler;
    },
  };
  const status = { textContent: "" };
  const next = {
    hidden: true,
    href: "",
    removeAttribute: () => {
      next.href = "";
    },
  };
  const link = {
    href: "",
    download: "",
    click: vi.fn(() => {
      if (failure === "download") throw Error("private failure");
    }),
  };
  const browser = {
    Blob,
    fetch: vi.fn(async () => {
      if (failure === "network") throw Error("private failure");
      return {
        ok: failure !== "denied",
        text: async () =>
          failure === "json"
            ? "{"
            : failure === "oversize"
              ? "x".repeat(256 * 1024 + 1)
              : JSON.stringify(value),
      };
    }),
    URL: {
      createObjectURL: vi.fn(() => "blob:synthetic"),
      revokeObjectURL: vi.fn(),
    },
    setTimeout: (fn) => fn(),
  };
  bindMemberExport(
    {
      querySelector: () => ({
        dataset: { url: "/api/member/export?cursor=current" },
        querySelector: (selector) =>
          selector === "button"
            ? button
            : selector === '[role="status"]'
              ? status
              : next,
      }),
      createElement: () => link,
    },
    browser,
  );
  return { click: () => click(), button, status, next, link, browser };
}
it("leaves unrelated pages alone", () => {
  bindMemberExport({ querySelector: () => null }, {});
});
it("downloads the actual response bytes and derives navigation only from that response", async () => {
  const f = setup();
  await f.click();
  expect(f.browser.fetch).toHaveBeenCalledWith(
    "/api/member/export?cursor=current",
    { cache: "no-store" },
  );
  const blob = f.browser.URL.createObjectURL.mock.calls[0][0];
  expect(await blob.text()).toBe(JSON.stringify(payload()));
  expect(f.link.download).toBe("deep-native-member-records-page-1.json");
  expect(f.link.click).toHaveBeenCalledOnce();
  expect(f.next.href).toBe("/member/export?cursor=signed-next");
  expect(f.next.hidden).toBe(false);
  expect(f.button.disabled).toBe(false);
  expect(f.browser.URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
});
it("announces the end only after the downloaded page completes and clears prior navigation", async () => {
  const f = setup(payload({ number: 2, complete: true, nextCursor: null }));
  f.next.href = "old";
  f.next.hidden = false;
  await f.click();
  expect(f.status.textContent).toContain("End of this live traversal");
  expect(f.next.hidden).toBe(true);
  expect(f.next.href).toBe("");
  expect(f.link.download).toContain("page-2");
});
it("ignores a repeated click while the page is already loading", async () => {
  const f = setup();
  f.button.disabled = true;
  await f.click();
  expect(f.browser.fetch).not.toHaveBeenCalled();
});
it.each(["denied", "network", "json", "oversize", "download"])(
  "offers safe restart and releases temporary resources on %s failure",
  async (failure) => {
    const f = setup(payload(), failure);
    f.next.hidden = false;
    f.next.href = "old";
    await f.click();
    expect(f.status.textContent).toContain("This page was not downloaded");
    expect(f.status.textContent).not.toContain("private");
    expect(f.next.hidden).toBe(true);
    expect(f.next.href).toBe("");
    expect(f.button.disabled).toBe(false);
    if (failure === "download")
      expect(f.browser.URL.revokeObjectURL).toHaveBeenCalledOnce();
    else expect(f.browser.URL.createObjectURL).not.toHaveBeenCalled();
  },
);
it.each([
  { kind: "other" },
  { page: undefined },
  ...[
    { consistency: "snapshot" },
    { number: 1.2 },
    { number: 0 },
    { recordCount: 1.2 },
    { recordCount: -1 },
    { recordCount: 101 },
    { complete: "yes" },
    { complete: true, nextCursor: "wrong" },
    { nextCursor: null },
    { nextCursor: "" },
  ].map((page) => payload(page)),
])("does not download malformed page metadata %#", async (value) => {
  const f = setup(value);
  await f.click();
  expect(f.link.click).not.toHaveBeenCalled();
  expect(f.status.textContent).toContain("not downloaded");
});
