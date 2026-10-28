import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { assignmentObjectStorage } from "../../src/assignment-evidence-storage.ts";
const text = "Invented exact submitted bytes — 中文 🤖.\r\n";
const digest = createHash("sha256").update(text).digest("hex");
const exact = () => ({
  bound: true,
  response: text,
  sequence: 1,
  bytes: Buffer.byteLength(text),
  digest,
  sourceDigest: digest,
  name: "Assignment submission 1.txt",
  media: "text/plain",
});
function fixture(row?: Record<string, unknown>) {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  const files = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => Buffer.from("ordinary upload")),
    remove: vi.fn(async () => {}),
  };
  return {
    query,
    files,
    storage: assignmentObjectStorage({ query } as unknown as Pool, files),
  };
}
it("AHO-01/07 resolves fresh exact submitted bytes and refuses physical replacement or deletion of a retained source", async () => {
  const f = fixture(exact()),
    key = randomUUID();
  const bytes = await f.storage.get(key);
  expect(bytes.equals(Buffer.from(text))).toBe(true);
  bytes[0] = 0;
  expect((await f.storage.get(key)).toString()).toBe(text);
  await expect(f.storage.put(key, Buffer.from("replacement"))).rejects.toThrow(
    "immutable",
  );
  await f.storage.remove(key);
  expect(f.files.put).not.toHaveBeenCalled();
  expect(f.files.get).not.toHaveBeenCalled();
  expect(f.files.remove).not.toHaveBeenCalled();
});
it.each([undefined, { ...exact(), bound: false }])(
  "AHO-10 preserves ordinary storage semantics for unrelated evidence %j",
  async (row) => {
    const f = fixture(row),
      key = randomUUID(),
      bytes = Buffer.from("ordinary upload");
    await f.storage.put(key, bytes);
    expect(f.files.put).toHaveBeenCalledWith(key, bytes, { query: f.query });
    expect(await f.storage.get(key)).toEqual(bytes);
    await f.storage.remove(key);
    expect(f.files.remove).toHaveBeenCalledWith(key, { query: f.query });
  },
);
it.each([
  { response: null },
  { sequence: null },
  { media: "text/html" },
  { name: "other.txt" },
  { bytes: 1 },
  { digest: "b".repeat(64) },
  { sourceDigest: "b".repeat(64) },
])(
  "AHO-09 damaged bound source %j fails closed without physical fallback",
  async (change) => {
    const f = fixture({ ...exact(), ...change });
    await expect(f.storage.get(randomUUID())).rejects.toThrow("unavailable");
    expect(f.files.get).not.toHaveBeenCalled();
  },
);
it("AHO-09 rejects malformed keys and preserves discovery faults without a guessed fallback", async () => {
  const f = fixture();
  await expect(f.storage.get("../private")).rejects.toThrow("Invalid");
  expect(f.query).not.toHaveBeenCalled();
  f.query.mockRejectedValueOnce(Error("storage discovery fault"));
  await expect(f.storage.get(randomUUID())).rejects.toThrow(
    "storage discovery fault",
  );
  expect(f.files.get).not.toHaveBeenCalled();
});
it("AHO-10 retains the configured provider's durable write recovery contract", async () => {
  const f = fixture(),
    abandon = vi.fn(async () => {});
  const storage = assignmentObjectStorage(
    { query: f.query } as unknown as Pool,
    { ...f.files, requiresWriteRecovery: true, abandon },
  );
  expect(storage.requiresWriteRecovery).toBe(true);
  const key = randomUUID();
  await storage.abandon!(key);
  expect(abandon).toHaveBeenCalledExactlyOnceWith(key);
});
