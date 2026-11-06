import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const sources = (root: string) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|mjs)$/u.test(file))
    .map((file) => join(root, file));

// pool.end() can resolve while its sockets are still closing. A forced drop then
// terminates one of them, and the 57P01 that follows surfaces as an uncaught
// error after every assertion passed (#279). An ordinary DROP DATABASE waits for
// those backends and still fails visibly on a real leak.
it("TEST-DB-DROP-01 test fixtures drop their own databases without forcing connections closed", () => {
  const forced = ["tests/integration", "tests/support"]
    .flatMap(sources)
    .filter((file) =>
      /DROP DATABASE[^\n]*WITH \(FORCE\)/u.test(readFileSync(file, "utf8")),
    );
  expect(forced).toEqual([]);
});
