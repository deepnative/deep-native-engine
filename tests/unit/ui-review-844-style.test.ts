import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("public/style.css", "utf8");
/** The declarations of the first rule whose selector list is exactly this. */
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

it("#844 WIDTH-01 task pages share the page column; only the invoice document keeps a document width, at the left edge", () => {
  expect(css).not.toMatch(
    /\.invoice-workspace(:has\(\.hours-dashboard\)|\.coaching-page)? \{\n {2}max-width/,
  );
  expect(
    rule(".invoice-workspace,\n.invoice-document,\n.invoice-controls"),
  ).not.toContain("max-width");
  expect(css).toContain(
    ".invoice-document,\n.invoice-controls {\n  max-width: 760px;\n}",
  );
  expect(css).not.toMatch(
    /\.invoice-(workspace|document|controls)[^{}]*\{[^}]*margin-inline:\s*auto/,
  );
  // Pages whose heading sat on the header rule start below it like the rest.
  expect(
    rule(
      ".portal-workspace:not(.invoice-workspace),\nmain > .reading:first-child",
    ),
  ).toContain("margin-top: 42px");
});

it("#844 INPUT-01 text fields and selects are capped at 28rem and number fields at 10rem", () => {
  const capped = css.slice(
    css.indexOf("/* #844 INPUT-01"),
    css.indexOf('input[type="number"] {\n  max-width'),
  );
  for (const selector of [
    "input:not([type])",
    'input[type="text"]',
    'input[type="email"]',
    "select",
  ])
    expect(capped).toContain(selector);
  expect(capped).toContain("max-width: 28rem");
  expect(rule('input[type="number"]')).toContain("max-width: 10rem");
  expect(rule(".duration-fields")).toContain("display: flex");
});

it("#844 TABLE-01 under 600px a stacked table shows every cell with its label and hides nothing from assistive technology", () => {
  const block = css.slice(css.indexOf("/* #844 */"));
  const phone = block.slice(block.indexOf("@media (max-width: 600px)"));
  expect(phone).not.toContain("display: none");
  expect(phone).toContain(".stack-table thead:not(:focus-within) {");
  expect(phone).toContain("content: attr(data-label);");
  expect(phone).not.toMatch(/td[^{]*\{[^}]*display:\s*none/);
  expect(rule(".visually-hidden")).toContain("clip-path: inset(50%)");
});
