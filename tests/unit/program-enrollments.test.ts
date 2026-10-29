import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { programEnrollmentStore } from "../../src/program-enrollments.ts";
import { PROGRAM_DIGEST, PROGRAM_MANIFEST } from "../../src/program-values.ts";

const bearer = "a".repeat(64);
const key = "10aba371-5534-468f-9a8b-e6fa1ea406b1";
const intent = {
  programVersion: 1,
  termVersion: 1,
  revision: 2,
  digest: PROGRAM_DIGEST,
};
async function fixture(mode: "test" | "live" = "test") {
  const pack = await reviewedFoundation();
  const content = pack.map((item) => ({
    ...item,
    structured_prerequisites: item.structuredPrerequisites,
    minimum_experience: item.minimumExperience,
    rubric_version: item.rubricVersion,
    state: "published",
    current: true,
    rights_confirmed: true,
    requires_qualified_signoff: false,
    reviewed_at: "2026-10-29T09:00:00Z",
    published_at: "2026-10-29T09:01:00Z",
  }));
  const term = {
    snapshot: structuredClone(PROGRAM_MANIFEST),
    digest: PROGRAM_DIGEST,
    state: "open",
    revision: 2,
    enrolled: 0,
    content,
  };
  const state = {
    actor: true,
    workspace: true,
    role: "platform_admin",
    current: true,
    term: true,
    fail: "",
    releaseFail: false,
    missingInsert: false,
    receipt: null as null | {
      id: string;
      enrolled: Date;
      snapshot: unknown;
      digest: string;
      originalKey: string;
    },
    activity: [] as Array<{
      id: string;
      version: number;
      started: boolean;
      selfAssessed: boolean;
    }>,
    duplicateReceipt: false,
  };
  const calls: string[] = [];
  const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (
      state.fail &&
      (sql === state.fail ||
        (state.fail !== "COMMIT" && sql.includes(state.fail)))
    )
      throw Error("Private database detail");
    if (sql.includes("WITH instant AS MATERIALIZED"))
      return rows([
        { remaining: "60000", valid: state.current, observed: new Date() },
      ]);
    if (sql.includes("FROM principals"))
      return rows(
        state.actor
          ? [{ id: "own-principal", expires: new Date(Date.now() + 60000) }]
          : [],
      );
    if (sql.includes("FROM staff_profiles"))
      return rows([{ role: state.role }]);
    if (sql.includes("FROM workspaces"))
      return rows(state.workspace ? [{ id: "own-workspace" }] : []);
    if (sql.startsWith("SELECT t.snapshot"))
      return rows(state.term ? [term] : []);
    if (sql.startsWith("UPDATE local_program_terms")) {
      term.state = String(values[0]);
      term.revision++;
    }
    if (
      sql.startsWith("INSERT INTO local_program_enrollments") &&
      !state.missingInsert
    ) {
      state.receipt = {
        id: String(values[0]),
        enrolled: new Date(),
        snapshot: structuredClone(PROGRAM_MANIFEST),
        digest: PROGRAM_DIGEST,
        originalKey: String(values[2]),
      };
      term.enrolled++;
    }
    if (sql.startsWith("SELECT e.id")) {
      const receipt = state.receipt;
      return rows(
        receipt && (!values[1] || values[1] === receipt.originalKey)
          ? state.duplicateReceipt
            ? [receipt, receipt]
            : [receipt]
          : [],
      );
    }
    if (sql.includes("FROM lesson_activity")) return rows(state.activity);
    return rows([]);
  });
  const release = vi.fn(() => {
    if (state.releaseFail) throw Error("Private release detail");
  });
  const connect = vi.fn(
    async () => ({ query, release }) as unknown as PoolClient,
  );
  const db = programEnrollmentStore(
    { query, connect } as unknown as Pool,
    mode,
  );
  return { db, state, term, calls, query, connect, release };
}
it("PROGRAM-01/02 returns public source metadata and one own explicit receipt without copying private columns", async () => {
  const f = await fixture();
  expect(await f.db.overview()).toMatchObject({
    kind: "ready",
    value: { availability: "ready", remaining: 20 },
  });
  const first = await f.db.enroll(bearer, key, intent);
  expect(first).toMatchObject({
    kind: "ready",
    value: { digest: PROGRAM_DIGEST, activity: [] },
  });
  expect(await f.db.enroll(bearer, key, intent)).toEqual(first);
  expect(
    await f.db.enroll(bearer, "13a81b72-3651-4426-888b-c7c45a41d919", intent),
  ).toEqual(first);
  expect(await f.db.enroll(bearer, key, { ...intent, termVersion: 2 })).toEqual(
    { kind: "conflict" },
  );
  expect(
    f.calls.filter((sql) =>
      sql.startsWith("INSERT INTO local_program_enrollments"),
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(first)).not.toMatch(
    /own-workspace|own-principal|originalKey/,
  );
  expect(await f.db.mine(bearer)).toEqual(first);
  expect(await f.db.inspect(bearer, key)).toEqual(first);
  expect(
    await f.db.inspect(bearer, "13a81b72-3651-4426-888b-c7c45a41d919"),
  ).toEqual({ kind: "ready", value: null });
});
it("PROGRAM-01/03 permits only exact finite administration and terminal closure", async () => {
  const f = await fixture();
  f.term.state = "not_open";
  f.term.revision = 1;
  expect(await f.db.admin(bearer)).toMatchObject({
    kind: "ready",
    value: { state: "not_open" },
  });
  expect(await f.db.change(bearer, "open", 1, PROGRAM_DIGEST)).toMatchObject({
    kind: "ready",
    value: { state: "open", revision: 2 },
  });
  expect(await f.db.change(bearer, "open", 1, PROGRAM_DIGEST)).toEqual({
    kind: "stale",
  });
  expect(await f.db.change(bearer, "open", 2, PROGRAM_DIGEST)).toEqual({
    kind: "closed",
  });
  expect(await f.db.change(bearer, "close", 2, PROGRAM_DIGEST)).toMatchObject({
    kind: "ready",
    value: { state: "closed", revision: 3 },
  });
  expect(await f.db.change(bearer, "close", 3, PROGRAM_DIGEST)).toEqual({
    kind: "closed",
  });
  f.state.role = "editor";
  expect(await f.db.admin(bearer)).toEqual({ kind: "denied" });
  expect(await f.db.change(bearer, "open", 1, "bad")).toEqual({
    kind: "invalid",
  });
  expect(await f.db.change(bearer, "open", NaN, PROGRAM_DIGEST)).toEqual({
    kind: "invalid",
  });
  expect(
    await f.db.change(bearer, "other" as "open", 1, PROGRAM_DIGEST),
  ).toEqual({ kind: "invalid" });
});
it("PROGRAM-01/03 refuses changed source payload, unavailable versions and missing inventory without admitting", async () => {
  const f = await fixture();
  f.term.content[0]!.body += " Unreviewed alteration";
  expect(await f.db.overview()).toMatchObject({
    kind: "ready",
    value: { availability: "course_unavailable" },
  });
  expect(await f.db.enroll(bearer, key, intent)).toEqual({ kind: "stale" });
  f.term.state = "not_open";
  f.term.revision = 1;
  expect(await f.db.change(bearer, "open", 1, PROGRAM_DIGEST)).toEqual({
    kind: "stale",
  });
  f.state.term = false;
  expect(await f.db.overview()).toEqual({ kind: "unavailable" });
  expect(await f.db.enroll(bearer, key, intent)).toEqual({
    kind: "unavailable",
  });
  expect(f.state.receipt).toBeNull();
});
it("PROGRAM-03 distinguishes unavailable, full, closed and stale rather than inventing admission", async () => {
  const f = await fixture();
  f.term.enrolled = 20;
  expect(await f.db.overview()).toMatchObject({
    kind: "ready",
    value: { availability: "full" },
  });
  expect(await f.db.enroll(bearer, key, intent)).toEqual({ kind: "full" });
  f.term.enrolled = 0;
  f.term.state = "closed";
  f.term.revision = 3;
  expect(await f.db.enroll(bearer, key, { ...intent, revision: 3 })).toEqual({
    kind: "closed",
  });
  expect(await f.db.enroll(bearer, key, intent)).toEqual({ kind: "stale" });
  f.state.fail = "SELECT t.snapshot";
  expect(await f.db.overview()).toEqual({ kind: "unavailable" });
  expect(f.state.receipt).toBeNull();
});
it.each([
  "digest",
  "snapshot",
  "state",
  "revision",
  "enrolled",
  "content",
] as const)(
  "PROGRAM-01/03 fails closed for corrupt inventory %s",
  async (field) => {
    const f = await fixture();
    Object.assign(f.term, {
      [field]:
        field === "enrolled" ? -1 : field === "revision" ? 99 : "invalid",
    });
    expect(await f.db.overview()).toEqual({ kind: "unavailable" });
  },
);
it("PROGRAM-03 refuses missing/currently invalid authority and never uses a rotated bearer", async () => {
  const f = await fixture();
  expect(await f.db.mine("not-a-bearer")).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
  f.state.actor = false;
  expect(await f.db.mine(bearer)).toEqual({ kind: "denied" });
  f.state.actor = true;
  f.state.workspace = false;
  expect(await f.db.enroll(bearer, key, intent)).toEqual({ kind: "denied" });
  f.state.workspace = true;
  f.state.current = false;
  expect(await f.db.mine(bearer)).toEqual({ kind: "denied" });
  expect(await f.db.enroll(bearer, "bad-key", intent)).toEqual({
    kind: "invalid",
  });
  expect(await f.db.enroll(bearer, key, { ...intent, revision: 0 })).toEqual({
    kind: "invalid",
  });
  expect(await f.db.inspect(bearer, "bad-key")).toEqual({ kind: "invalid" });
  const live = await fixture("live");
  expect(await live.db.overview()).toEqual({ kind: "unavailable" });
  expect(await live.db.enroll(bearer, key, intent)).toEqual({ kind: "denied" });
  expect(live.connect).not.toHaveBeenCalled();
});
it.each(["COMMIT", "release"])(
  "PROGRAM-03/ENR-04 keeps an uncertain %s response separate from read-only original-key recovery",
  async (failure) => {
    const f = await fixture();
    if (failure === "release") f.state.releaseFail = true;
    else f.state.fail = failure;
    expect(await f.db.enroll(bearer, key, intent)).toEqual({
      kind: "unavailable",
    });
    f.state.fail = "";
    f.state.releaseFail = false;
    const saved = await f.db.inspect(bearer, key);
    expect(saved).toMatchObject({
      kind: "ready",
      value: { digest: PROGRAM_DIGEST },
    });
    expect(
      f.calls.filter((sql) =>
        sql.startsWith("INSERT INTO local_program_enrollments"),
      ),
    ).toHaveLength(1);
  },
);
it("PROGRAM-03/05 reports missing writes and invalid retained rows as unavailable, with current exact-version activity only", async () => {
  const f = await fixture();
  f.state.missingInsert = true;
  expect(await f.db.enroll(bearer, key, intent)).toEqual({
    kind: "unavailable",
  });
  f.state.missingInsert = false;
  expect((await f.db.enroll(bearer, key, intent)).kind).toBe("ready");
  f.state.activity = [
    { id: "FND-001", version: 2, started: true, selfAssessed: false },
  ];
  expect(await f.db.mine(bearer)).toMatchObject({
    kind: "ready",
    value: { activity: f.state.activity },
  });
  f.state.duplicateReceipt = true;
  expect(await f.db.mine(bearer)).toEqual({ kind: "unavailable" });
  f.state.duplicateReceipt = false;
  f.state.receipt!.enrolled = new Date(NaN);
  expect(await f.db.mine(bearer)).toEqual({ kind: "unavailable" });
  f.state.receipt!.enrolled = new Date();
  f.state.receipt!.snapshot = {};
  expect(await f.db.mine(bearer)).toEqual({ kind: "unavailable" });
});
