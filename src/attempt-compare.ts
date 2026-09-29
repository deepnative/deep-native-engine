export interface ResponseChange {
  kind: "unchanged" | "removed" | "added";
  text: string;
}

export interface ResponseComparison {
  kind: "identical" | "lines" | "sections";
  changes: ResponseChange[];
}

// Includes the terminal row/column: at most 500 KB of Uint16 matrix storage.
const matrixCellBudget = 250_000;

function append(
  changes: ResponseChange[],
  kind: ResponseChange["kind"],
  text: string,
) {
  if (!text) return;
  const previous = changes.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else changes.push({ kind, text });
}

function compareSections(from: string[], to: string[]): ResponseChange[] {
  let prefix = 0;
  while (
    prefix < from.length &&
    prefix < to.length &&
    from[prefix] === to[prefix]
  )
    prefix++;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (
    fromEnd > prefix &&
    toEnd > prefix &&
    from[fromEnd - 1] === to[toEnd - 1]
  ) {
    fromEnd--;
    toEnd--;
  }
  const changes: ResponseChange[] = [];
  append(changes, "unchanged", from.slice(0, prefix).join(""));
  append(changes, "removed", from.slice(prefix, fromEnd).join(""));
  append(changes, "added", to.slice(prefix, toEnd).join(""));
  append(changes, "unchanged", from.slice(fromEnd).join(""));
  return changes;
}

/**
 * Pure, neutral comparison of already-authorized snapshot responses. Filtering
 * out additions/removals reconstructs the respective input exactly. Text is
 * literal data; the caller must escape it when rendering HTML.
 *
 * Preserve whole lines, including CRLF/CR/LF endings. Large line-count products
 * use exact shared edge sections instead of a quadratic matrix. Whole-line
 * boundaries also avoid splitting surrogate pairs or combining sequences.
 */
export function compareResponses(from: string, to: string): ResponseComparison {
  // Match the existing response-save bound (JavaScript UTF-16 string length).
  if (from.length > 4000 || to.length > 4000)
    throw new RangeError("Responses must contain at most 4,000 characters.");
  if (from === to)
    return {
      kind: "identical",
      changes: from ? [{ kind: "unchanged", text: from }] : [],
    };
  const fromLines = from.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const toLines = to.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const width = toLines.length + 1;
  const cells = (fromLines.length + 1) * width;
  if (cells > matrixCellBudget)
    return { kind: "sections", changes: compareSections(fromLines, toLines) };

  const lengths = new Uint16Array(cells);
  for (let i = fromLines.length - 1; i >= 0; i--) {
    for (let j = toLines.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        fromLines[i] === toLines[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(
              lengths[(i + 1) * width + j]!,
              lengths[i * width + j + 1]!,
            );
    }
  }

  const changes: ResponseChange[] = [];
  let i = 0;
  let j = 0;
  while (i < fromLines.length && j < toLines.length) {
    if (fromLines[i] === toLines[j]) {
      append(changes, "unchanged", fromLines[i]!);
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      // Removal first on ties makes duplicate-line alignment deterministic.
      append(changes, "removed", fromLines[i++]!);
    } else {
      append(changes, "added", toLines[j++]!);
    }
  }
  append(changes, "removed", fromLines.slice(i).join(""));
  append(changes, "added", toLines.slice(j).join(""));
  return { kind: "lines", changes };
}
