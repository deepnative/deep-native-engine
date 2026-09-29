import { expect, it } from "vitest";
import { compareResponses } from "../../src/attempt-compare.ts";

function expectFaithful(from: string, to: string) {
  const result = compareResponses(from, to);
  expect(
    result.changes
      .filter((change) => change.kind !== "added")
      .map((change) => change.text)
      .join(""),
  ).toBe(from);
  expect(
    result.changes
      .filter((change) => change.kind !== "removed")
      .map((change) => change.text)
      .join(""),
  ).toBe(to);
  expect(result.changes.every((change) => change.text.length > 0)).toBe(true);
  return result;
}

it("explicitly identifies identical responses, including an empty response", () => {
  expect(compareResponses("", "")).toEqual({ kind: "identical", changes: [] });
  const response = "\n  Synthetic 🧪 response\r\n<script>literal</script>\n";
  expect(compareResponses(response, response)).toEqual({
    kind: "identical",
    changes: [{ kind: "unchanged", text: response }],
  });
});

it("identifies removed, added and unchanged text in original order", () => {
  expect(
    expectFaithful("First\nOld wording\nLast", "First\nNew wording\nLast"),
  ).toEqual({
    kind: "lines",
    changes: [
      { kind: "unchanged", text: "First\n" },
      { kind: "removed", text: "Old wording\n" },
      { kind: "added", text: "New wording\n" },
      { kind: "unchanged", text: "Last" },
    ],
  });
});

it("handles additions and removals at both ends and empty input", () => {
  for (const [from, to] of [
    ["", "First\nLast"],
    ["First\nLast", ""],
    ["Middle\n", "First\nMiddle\nLast"],
    ["First\nMiddle\nLast", "Middle\n"],
    ["First\n", "First\nLast"],
    ["First\nLast", "First\n"],
  ]) {
    expectFaithful(from!, to!);
  }
  expect(compareResponses("", "One\nTwo").changes).toEqual([
    { kind: "added", text: "One\nTwo" },
  ]);
  expect(compareResponses("One\nTwo", "").changes).toEqual([
    { kind: "removed", text: "One\nTwo" },
  ]);
});

it("keeps duplicate lines ordered and resolves equal choices deterministically", () => {
  expect(expectFaithful("A\nB\nA\n", "A\nA\nB\n")).toEqual({
    kind: "lines",
    changes: [
      { kind: "unchanged", text: "A\n" },
      { kind: "removed", text: "B\n" },
      { kind: "unchanged", text: "A\n" },
      { kind: "added", text: "B\n" },
    ],
  });
});

it("preserves leading blank lines, tabs, spaces and each line-ending convention", () => {
  const from = "\n\r\n\r  Same\r\n\tOld \rLast\n";
  const to = "\n\r\n\r  Same\r\n\tNew \rLast\n";
  expect(expectFaithful(from, to).changes).toEqual([
    { kind: "unchanged", text: "\n\r\n\r  Same\r\n" },
    { kind: "removed", text: "\tOld \r" },
    { kind: "added", text: "\tNew \r" },
    { kind: "unchanged", text: "Last\n" },
  ]);
  expectFaithful("No trailing newline", "No trailing newline\n");
  expectFaithful(" \n", "\n");
  expectFaithful("Same\r\n", "Same\n");
});

it("keeps HTML-like strings, Unicode and combining characters literal", () => {
  const from = "<script>alert('synthetic')</script>\n中文 👩‍💻 é\n";
  const to = '<img src=x onerror="synthetic">\n中文 👩‍💻 é\n';
  const result = expectFaithful(from, to);
  expect(result.changes).toEqual([
    { kind: "removed", text: from },
    { kind: "added", text: to },
  ]);
  expect(result.kind).toBe("lines");
});

it("accepts exact 4,000 UTF-16-unit responses without truncation", () => {
  expectFaithful("a".repeat(4000), "😀".repeat(2000));
  expect(compareResponses("😀".repeat(2000), "😀".repeat(2000)).kind).toBe(
    "identical",
  );
});

it("rejects either over-limit response before comparing or returning private text", () => {
  for (const [from, to] of [
    ["a".repeat(4001), "short"],
    ["short", "b".repeat(4001)],
    ["😀".repeat(2001), "😀".repeat(2001)],
  ]) {
    expect(() => compareResponses(from!, to!)).toThrow(
      new RangeError("Responses must contain at most 4,000 characters."),
    );
  }
});

it("uses line comparison at the matrix budget and section comparison above it", () => {
  expect(expectFaithful("a\n".repeat(499), "b\n".repeat(499)).kind).toBe(
    "lines",
  );
  expect(expectFaithful("a\n".repeat(500), "b\n".repeat(500)).kind).toBe(
    "sections",
  );
});

it("discloses bounded sections while retaining exact shared prefix and suffix", () => {
  const from = "\nShared 😀\r\n" + "old\n".repeat(600) + "\nLast";
  const to = "\nShared 😀\r\n" + "new\n".repeat(600) + "\nLast";
  expect(expectFaithful(from, to)).toEqual({
    kind: "sections",
    changes: [
      { kind: "unchanged", text: "\nShared 😀\r\n" },
      { kind: "removed", text: "old\n".repeat(600) },
      { kind: "added", text: "new\n".repeat(600) },
      { kind: "unchanged", text: "\nLast" },
    ],
  });
});

it("handles prefix-only and suffix-only changes in the section fallback", () => {
  const common = "\n".repeat(600);
  for (const [from, to] of [
    [common, common + "\n"],
    [common + "\n", common],
    ["A\n" + common, common],
    [common, "A\n" + common],
  ]) {
    expect(expectFaithful(from!, to!).kind).toBe("sections");
  }
});

it("bounds newline-heavy worst-case responses without losing data", () => {
  const result = expectFaithful("\n".repeat(4000), "x\n".repeat(2000));
  expect(result.kind).toBe("sections");
  expect(result.changes).toHaveLength(2);
});

it("reconstructs varied synthetic responses deterministically without normalization", () => {
  const samples = ["", "\n", "a\n", "b\n", "😀\r\n", "<tag>\r"];
  const responses = samples.flatMap((first) =>
    samples.map((last) => first + last),
  );
  for (const from of responses) {
    for (const to of responses) {
      const result = expectFaithful(from, to);
      expect(compareResponses(from, to)).toEqual(result);
    }
  }
});

it("isolates comparison results across interleaved callers and repeated reads", async () => {
  const from = "Shared\nOld";
  const to = "Shared\nNew";
  const first = compareResponses(from, to);
  first.changes[0]!.text = "Changed only by this caller";
  first.changes.push({ kind: "added", text: "Caller-local addition" });
  const results = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      await Promise.resolve();
      return index % 2 === 0
        ? compareResponses(from, to)
        : compareResponses("Other member", "Other member");
    }),
  );
  for (const [index, result] of results.entries()) {
    expect(result).toEqual(
      index % 2 === 0
        ? compareResponses(from, to)
        : {
            kind: "identical",
            changes: [{ kind: "unchanged", text: "Other member" }],
          },
    );
  }
});
