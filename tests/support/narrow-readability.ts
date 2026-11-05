import { expect, type Page } from "@playwright/test";

export interface NarrowReadability {
  sideways: boolean;
  rawTimestamps: string[];
  splitCodes: string[];
  midWordBreaks: string[];
}

/**
 * Measures the laid-out page rather than its markup, so it reports what a
 * reader sees: a raw timestamp, a short code or date split across lines, a word
 * split although it would fit on a line of its own, or sideways scrolling.
 */
export function measureNarrowReadability(page: Page) {
  return page.evaluate((): NarrowReadability => {
    const rawTimestamps = document.body.innerText.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^\s]*/g,
    );
    const splitCodes: string[] = [];
    const midWordBreaks: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const top = (node: Text, index: number) => {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      return range.getClientRects()[0];
    };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement!;
      if (parent.closest("script,style,textarea,option,select,noscript"))
        continue;
      if (!parent.getClientRects().length) continue;
      const preformatted = getComputedStyle(parent).whiteSpace.startsWith("pre");
      for (const match of text.data.matchAll(/\S{2,}/g)) {
        const word = match[0];
        const rects = Array.from(word, (_, offset) =>
          top(text, match.index + offset),
        );
        if (rects.some((rect) => !rect)) continue;
        const lines = new Set(rects.map((rect) => Math.round(rect!.top)));
        if (lines.size < 2) continue;
        if (
          /^[([]?(?:[A-Z]{2,5}-\d{2,4}|\d{4}-\d{2}-\d{2})[)\],.;:]*$/.test(word)
        ) {
          splitCodes.push(word);
          continue;
        }
        // Text wider than its whole line has to break somewhere.
        const width = rects.reduce((sum, rect) => sum + rect!.width, 0);
        let block: Element = parent;
        while (getComputedStyle(block).display === "inline")
          block = block.parentElement!;
        const style = getComputedStyle(block);
        const room =
          block.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        if (width >= room || preformatted) continue;
        for (let offset = 1; offset < word.length; offset += 1) {
          const before = rects[offset - 1]!,
            after = rects[offset]!;
          if (
            Math.round(before.top) !== Math.round(after.top) &&
            /[\p{L}\p{N}]/u.test(word[offset - 1]!) &&
            /[\p{L}\p{N}]/u.test(word[offset]!)
          ) {
            midWordBreaks.push(word);
            break;
          }
        }
      }
    }
    return {
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      rawTimestamps: rawTimestamps ?? [],
      splitCodes,
      midWordBreaks,
    };
  });
}

export async function expectReadableAtNarrowWidth(page: Page, label: string) {
  expect(await measureNarrowReadability(page), label).toEqual({
    sideways: false,
    rawTimestamps: [],
    splitCodes: [],
    midWordBreaks: [],
  });
}
