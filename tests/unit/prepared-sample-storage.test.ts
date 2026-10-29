import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { preparedObjectStorage } from "../../src/prepared-sample-storage.ts";
import { PREPARED_SAMPLES } from "../../src/prepared-sample-values.ts";
const s = PREPARED_SAMPLES[0]!;
interface Binding {
  templateId: string;
  templateVersion: number;
  templateDigest: string;
  bytes: number;
  digest: string;
  name: string;
  media: string;
}
const exact = (): Binding => ({
  templateId: s.id,
  templateVersion: s.version,
  templateDigest: s.digest,
  bytes: Buffer.byteLength(s.text),
  digest: s.digest,
  name: s.name,
  media: "text/plain",
});
function fixture(row?: ReturnType<typeof exact>) {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  const files = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => Buffer.from("ordinary file")),
    remove: vi.fn(async () => {}),
  };
  return {
    query,
    files,
    storage: preparedObjectStorage({ query } as unknown as Pool, files),
  };
}
it("PREPARED-01/08 resolves fixed bytes only for an extant exact source binding, including creation-off readers", async () => {
  const f = fixture(exact()),
    key = randomUUID();
  const first = await f.storage.get(key);
  first[0] = 0;
  expect((await f.storage.get(key)).toString()).toBe(s.text);
  expect(f.files.get).not.toHaveBeenCalled();
  await expect(f.storage.put(key, Buffer.from("replacement"))).rejects.toThrow(
    "immutable",
  );
  await f.storage.remove(key);
  expect(f.files.put).not.toHaveBeenCalled();
  expect(f.files.remove).not.toHaveBeenCalled();
});
it("PREPARED-07 leaves ordinary file operations and absent erased bindings with the private file store", async () => {
  const f = fixture(),
    key = randomUUID(),
    bytes = Buffer.from("new member upload");
  await f.storage.put(key, bytes);
  expect(f.files.put).toHaveBeenCalledWith(key, bytes, { query: f.query });
  expect((await f.storage.get(key)).toString()).toBe("ordinary file");
  await f.storage.remove(key);
  expect(f.files.remove).toHaveBeenCalledWith(key, { query: f.query });
});
it("HOSTED-06 preserves the private provider's durable-write recovery requirement through prepared-source wrapping", async () => {
  const f = fixture();
  const abandon = vi.fn(async () => {});
  const wrapped = preparedObjectStorage({ query: f.query } as unknown as Pool, {
    ...f.files,
    requiresWriteRecovery: true,
    abandon,
  });
  expect(wrapped.requiresWriteRecovery).toBe(true);
  const key = randomUUID();
  await wrapped.abandon!(key);
  expect(abandon).toHaveBeenCalledExactlyOnceWith(key);
});
it.each([
  { templateId: "unknown" },
  { templateVersion: 2 },
  { templateDigest: "a".repeat(64) },
  { digest: "a".repeat(64) },
  { bytes: 1 },
  { name: "changed.txt" },
  { media: "text/html" },
])("PREPARED-02 refuses a mismatched provided binding %j", async (changed) => {
  const f = fixture({ ...exact(), ...changed });
  await expect(f.storage.get(randomUUID())).rejects.toThrow("unavailable");
  expect(f.files.get).not.toHaveBeenCalled();
});
it("PREPARED-02 rejects path input and does not hide storage discovery failures", async () => {
  const f = fixture();
  await expect(f.storage.get("../../private")).rejects.toThrow("Invalid");
  expect(f.query).not.toHaveBeenCalled();
  f.query.mockRejectedValueOnce(Error("discovery failed"));
  await expect(f.storage.get(randomUUID())).rejects.toThrow("discovery failed");
  expect(f.files.get).not.toHaveBeenCalled();
});
