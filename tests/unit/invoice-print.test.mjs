import { afterAll, expect, it, vi } from "vitest";

vi.stubGlobal("document", { querySelectorAll: () => [] });
vi.stubGlobal("window", { print: vi.fn() });
const { bindInvoicePrint } = await import("../../public/invoice-print.js");
afterAll(() => vi.unstubAllGlobals());

it("PAGE854-02 reveals each Print button and prints the page when it is pressed", () => {
  const handlers = [];
  const button = {
    hidden: true,
    addEventListener: (type, handler) => handlers.push([type, handler]),
  };
  const view = { print: vi.fn() };
  const querySelectorAll = vi.fn(() => [button]);
  bindInvoicePrint({ querySelectorAll }, view);
  expect(querySelectorAll).toHaveBeenCalledWith("button[data-print]");
  expect(button.hidden).toBe(false);
  expect(handlers.map(([type]) => type)).toEqual(["click"]);
  expect(view.print).not.toHaveBeenCalled();
  handlers[0][1]();
  expect(view.print).toHaveBeenCalledOnce();
});

it("PAGE854-02 leaves a page without a Print button alone", () => {
  const view = { print: vi.fn() };
  bindInvoicePrint({ querySelectorAll: () => [] }, view);
  expect(view.print).not.toHaveBeenCalled();
});
