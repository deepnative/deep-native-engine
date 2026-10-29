import { expect, it } from "vitest";
import {
  PROGRAM_DIGEST,
  PROGRAM_MANIFEST,
  disabledProgramStore,
  programIntent,
  programKey,
  publicProgramReceipt,
} from "../../src/program-values.ts";

it("PROGRAM-02/03 validates exact structured enrollment input without accepting malformed versions or keys", () => {
  const value = {
    programVersion: "1",
    termVersion: 1,
    revision: "2",
    digest: PROGRAM_DIGEST,
  };
  expect(programIntent(value)).toEqual({
    ...value,
    programVersion: 1,
    revision: 2,
  });
  for (const invalid of [
    null,
    false,
    [],
    "version1",
    {},
    { ...value, programVersion: 0 },
    { ...value, termVersion: "01" },
    { ...value, revision: "2x" },
    { ...value, digest: "not-a-digest" },
    { ...value, digest: 123 },
  ])
    expect(programIntent(invalid)).toBeNull();
  expect(programKey("10aba371-5534-468f-9a8b-e6fa1ea406b1")).toBe(true);
  for (const invalid of [
    undefined,
    123,
    "",
    "10aba371-5534-068f-9a8b-e6fa1ea406b1",
    "10aba371-5534-468f-0a8b-e6fa1ea406b1",
  ])
    expect(programKey(invalid)).toBe(false);
});
it("PROGRAM-05 whitelists enrollment exports even if a future store adds internal metadata", () => {
  const receipt = {
    id: "10aba371-5534-468f-9a8b-e6fa1ea406b1",
    enrolledAt: "2026-10-29T09:00:00.000Z",
    digest: PROGRAM_DIGEST,
    manifest: { ...PROGRAM_MANIFEST, privateStaff: "not-public" },
    activity: [
      {
        id: "FND-001",
        version: 2,
        started: true,
        selfAssessed: false,
        privateNote: "not-public",
      },
    ],
    workspaceId: "not-public",
    idempotencyKey: "not-public",
  };
  const exported = publicProgramReceipt(receipt);
  expect(JSON.stringify(exported)).not.toContain("not-public");
  expect(exported.activity).toEqual([
    { id: "FND-001", version: 2, started: true, selfAssessed: false },
  ]);
  expect(exported.manifest.lessons).toHaveLength(6);
  expect(exported.manifest.lessons[0]).not.toHaveProperty("sourceDigest");
});
it("PROGRAM-01/03 offers no simulated inventory, enrollment or receipt when unconfigured", async () => {
  const disabled = disabledProgramStore();
  const intent = {
    programVersion: 1,
    termVersion: 1,
    revision: 2,
    digest: PROGRAM_DIGEST,
  };
  for (const result of await Promise.all([
    disabled.overview(),
    disabled.admin("member"),
    disabled.change("member", "open", 1, PROGRAM_DIGEST),
    disabled.enroll("member", "original-key", intent),
    disabled.mine("member"),
    disabled.inspect("member", "original-key"),
  ]))
    expect(result).toEqual({ kind: "unavailable" });
});
