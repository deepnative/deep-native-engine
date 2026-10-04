import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { ObjectStorage } from "../../src/evidence.ts";
import {
  sampleFeedbackStore,
  type SampleFeedbackRecord,
} from "../../src/sample-feedback.ts";
const id = "11111111-1111-4111-8111-111111111111";
import {
  sampleDraftDigest,
  type SampleDraftInput,
} from "../../src/sample-feedback-values.ts";
const token = "a".repeat(64);
function fixture(staff = true) {
  const source = Buffer.from("Invented source");
  const expiry = new Date(Date.now() + 60000);
  const state = {
    identity: {
      id,
      kind: staff ? "staff" : "member",
      role: staff ? "reviewer" : null,
      expires: expiry,
    } as Record<string, unknown> | undefined,
    workspace: { id } as { id: string } | undefined,
    evidence: {
      owner: id,
      consent: true,
      state: "clean",
      name: "Sample",
      media: "text/plain",
      key: "private-source",
      bytes: source.length,
      digest: createHash("sha256").update(source).digest("hex"),
      revision: 1,
    },
    submission: { id, status: "queued" } as
      { id: string; status: string } | undefined,
    assignment: { id, expires: expiry } as
      { id: string; expires: Date } | undefined,
    grant: { id, expires: expiry } as { id: string; expires: Date } | undefined,
    records: [] as SampleFeedbackRecord[],
    replay: undefined as { digest: string; revision: number } | undefined,
    throwQuery: false,
  };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (state.throwQuery) throw Error("private database diagnostic");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [{ remaining: "60000", valid: true, observed: new Date() }];
    else if (sql.includes("FROM principals p"))
      rows = state.identity ? [state.identity] : [];
    else if (sql.includes("SELECT w.id FROM workspaces"))
      rows = state.workspace ? [state.workspace] : [];
    else if (sql.includes("original_name AS name")) rows = [state.evidence];
    else if (sql.includes("SELECT id,status FROM evidence_review_submissions"))
      rows = state.submission ? [state.submission] : [];
    else if (sql.includes("FROM assignment_grants a"))
      rows = state.assignment ? [state.assignment] : [];
    else if (
      sql.includes(
        "SELECT id,expires_at AS expires FROM reviewer_evidence_grants",
      )
    )
      rows = state.grant ? [state.grant] : [];
    else if (sql.includes("FROM private_sample_feedback_draft_operations"))
      rows = state.replay ? [state.replay] : [];
    else if (
      sql.includes("FROM private_sample_feedback\n") ||
      sql.includes("FROM private_sample_feedback WHERE")
    )
      rows = state.records;
    return { rows };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
  };
  const objects = { get: vi.fn(async () => source) };
  return {
    state,
    calls,
    pool,
    objects,
    release,
    store: sampleFeedbackStore(
      pool as unknown as Pool,
      objects as unknown as ObjectStorage,
    ),
  };
}
function record(f: ReturnType<typeof fixture>): SampleFeedbackRecord {
  return {
    id,
    submissionId: id,
    authorId: id,
    sourceSha256: f.state.evidence.digest,
    sourceRevision: 1,
    criteria: [
      {
        label: "Clarity",
        comment: "Explain the example",
        quote: "Invented",
        start: 0,
        end: 8,
      },
    ],
    preparationMinutes: null,
    reviewMinutes: null,
    revision: 1,
    draftOperationId: id,
    publicationOperationId: null,
    publishedAt: null,
    clarification: null,
    clarificationOperationId: null,
    clarifiedAt: null,
    answer: null,
    answerOperationId: null,
    answeredAt: null,
  };
}
it("rejects malformed identities and cursors without opening a connection", async () => {
  const f = fixture();
  expect(await f.store.reviewer("bad", id)).toEqual({ kind: "denied" });
  expect(await f.store.owner(token, "bad")).toEqual({ kind: "denied" });
  expect(await f.store.owner(token, id, "bad")).toEqual({ kind: "denied" });
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it.each([
  "missing identity",
  "member reviewer",
  "wrong staff role",
  "missing workspace",
  "missing submission",
  "withdrawn submission",
  "missing assignment",
  "missing exact grant",
  "withdrawn consent",
  "unclean source",
  "wrong media",
])("denies %s before reading private source bytes", async (reason) => {
  const f = fixture();
  switch (reason) {
    case "missing identity":
      f.state.identity = undefined;
      break;
    case "member reviewer":
      f.state.identity!.kind = "member";
      break;
    case "wrong staff role":
      f.state.identity!.role = "operator";
      break;
    case "missing workspace":
      f.state.workspace = undefined;
      break;
    case "missing submission":
      f.state.submission = undefined;
      break;
    case "withdrawn submission":
      f.state.submission!.status = "withdrawn";
      break;
    case "missing assignment":
      f.state.assignment = undefined;
      break;
    case "missing exact grant":
      f.state.grant = undefined;
      break;
    case "withdrawn consent":
      f.state.evidence.consent = false;
      break;
    case "unclean source":
      f.state.evidence.state = "pending";
      break;
    case "wrong media":
      f.state.evidence.media = "application/pdf";
      break;
  }
  expect(await f.store.reviewer(token, id)).toEqual({ kind: "denied" });
  expect(f.objects.get).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  expect(f.release).toHaveBeenCalledOnce();
});
it.each(["wrong owner", "staff owner"])(
  "denies %s access to member feedback",
  async (reason) => {
    const f = fixture(false);
    if (reason === "wrong owner") f.state.evidence.owner = "another-member";
    else f.state.identity!.kind = "staff";
    expect(await f.store.owner(token, id)).toEqual({ kind: "denied" });
    expect(f.objects.get).not.toHaveBeenCalled();
  },
);
it.each([0, -1, 1048577, 1.5])(
  "rejects unsafe source size %s before storage access",
  async (bytes) => {
    const f = fixture();
    f.state.evidence.bytes = bytes;
    expect(await f.store.reviewer(token, id)).toEqual({ kind: "unavailable" });
    expect(f.objects.get).not.toHaveBeenCalled();
  },
);
it.each(["size", "digest", "encoding", "storage failure"])(
  "withholds source with %s failure",
  async (reason) => {
    const f = fixture();
    if (reason === "size")
      f.objects.get.mockResolvedValue(Buffer.from("short"));
    if (reason === "digest") f.state.evidence.digest = "b".repeat(64);
    if (reason === "encoding") {
      const bytes = Buffer.from([255]);
      f.objects.get.mockResolvedValue(bytes);
      f.state.evidence.bytes = 1;
      f.state.evidence.digest = createHash("sha256")
        .update(bytes)
        .digest("hex");
    }
    if (reason === "storage failure")
      f.objects.get.mockRejectedValue(Error("private storage path"));
    expect(await f.store.reviewer(token, id)).toEqual({ kind: "unavailable" });
    expect(f.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  },
);
it("returns the authorized reviewer's source and records with metadata-only audit", async () => {
  const f = fixture();
  f.state.records = [record(f)];
  const result = await f.store.reviewer(token, id);
  expect(result).toMatchObject({
    kind: "ready",
    source: "Invented source",
    records: f.state.records,
    next: null,
  });
  const audit = f.calls.find((c) =>
    c.sql.includes("INSERT INTO private_sample_feedback_audit"),
  );
  expect(audit?.values?.at(-1)).toBe("read");
  expect(JSON.stringify(audit?.values)).not.toContain("Invented source");
  expect(f.calls.at(-1)?.sql).toBe("COMMIT");
});
it("keeps owner history readable after withdrawal and returns bounded continuation", async () => {
  const f = fixture(false);
  f.state.evidence.consent = false;
  f.state.records = Array.from({ length: 21 }, (_, i) => ({
    ...record(f),
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    publishedAt: new Date(),
  }));
  const result = await f.store.owner(token, id);
  expect(result).toMatchObject({
    kind: "ready",
    consent: false,
    next: f.state.records[19]!.id,
  });
  if (result.kind !== "ready") throw Error("Expected owner view");
  expect(result.records).toHaveLength(20);
  expect(
    f.calls.some((c) => c.sql.includes("private_sample_feedback_audit")),
  ).toBe(false);
});
it("contains database failures without disclosing diagnostics", async () => {
  const f = fixture();
  f.state.throwQuery = true;
  expect(await f.store.reviewer(token, id)).toEqual({ kind: "unavailable" });
  expect(f.release).toHaveBeenCalledOnce();
});
it.each([0, NaN, 1.5])(
  "rejects invalid publication revision %s without database access",
  async (revision) => {
    const f = fixture();
    expect(await f.store.publish(token, id, revision, id)).toEqual({
      kind: "invalid",
    });
    expect(f.pool.connect).not.toHaveBeenCalled();
  },
);
it("publishes the exact saved draft and advances its submission atomically", async () => {
  const f = fixture();
  f.state.records = [record(f)];
  expect(await f.store.publish(token, id, 1, id)).toEqual({
    kind: "saved",
    id,
    revision: 1,
  });
  expect(
    f.calls.filter((c) =>
      c.sql.startsWith("UPDATE private_sample_feedback SET publication"),
    ),
  ).toHaveLength(1);
  expect(
    f.calls.filter((c) =>
      c.sql.startsWith(
        "UPDATE evidence_review_submissions SET status='reviewed'",
      ),
    ),
  ).toHaveLength(1);
  expect(f.calls.at(-1)?.sql).toBe("COMMIT");
});
it("acknowledges the same publication operation without updating it again", async () => {
  const f = fixture();
  f.state.records = [
    { ...record(f), publishedAt: new Date(), publicationOperationId: id },
  ];
  expect(await f.store.publish(token, id, 1, id)).toEqual({
    kind: "saved",
    id,
    revision: 1,
  });
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
it.each([
  "missing draft",
  "stale revision",
  "other publication",
  "source digest",
  "source revision",
])("rejects publication with %s", async (reason) => {
  const f = fixture();
  const row = record(f);
  f.state.records = [row];
  if (reason === "missing draft") f.state.records = [];
  if (reason === "stale revision") row.revision = 2;
  if (reason === "other publication") {
    row.publishedAt = new Date();
    row.publicationOperationId = "another-operation";
  }
  if (reason === "source digest") row.sourceSha256 = "b".repeat(64);
  if (reason === "source revision") row.sourceRevision = 2;
  expect(await f.store.publish(token, id, 1, id)).toEqual({
    kind: reason.startsWith("source") ? "unavailable" : "conflict",
  });
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
it.each([false, true])(
  "saves one new clarification/answer with reviewer=%s",
  async (staff) => {
    const f = fixture(staff);
    const row = { ...record(f), publishedAt: new Date() };
    if (staff) row.clarification = "Explain this";
    f.state.records = [row];
    const method = staff ? "answer" : "clarify";
    expect(
      await f.store[method](token, id, id, "A helpful response", id),
    ).toEqual({ kind: "saved", id, revision: 1 });
    expect(
      f.calls.filter((c) =>
        c.sql.startsWith(
          `UPDATE private_sample_feedback SET ${staff ? "answer" : "clarification"}=`,
        ),
      ),
    ).toHaveLength(1);
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
  },
);
it.each([false, true])(
  "accepts an exact exchange replay without a second update, reviewer=%s",
  async (staff) => {
    const f = fixture(staff);
    const row = {
      ...record(f),
      publishedAt: new Date(),
      clarification: "Explain this",
      clarificationOperationId: id,
    };
    if (staff) {
      row.answer = "Explain this";
      row.answerOperationId = id;
    }
    f.state.records = [row];
    expect(
      await f.store[staff ? "answer" : "clarify"](
        token,
        id,
        id,
        "Explain this",
        id,
      ),
    ).toEqual({ kind: "saved", id, revision: 1 });
    expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
  },
);
it.each(["invalid id", "invalid operation", "empty text", "oversize text"])(
  "rejects %s exchange input before reading records",
  async (reason) => {
    const f = fixture();
    expect(
      await f.store.answer(
        token,
        id,
        reason === "invalid id" ? "bad" : id,
        reason === "empty text"
          ? " "
          : reason === "oversize text"
            ? "a".repeat(2001)
            : "Question",
        reason === "invalid operation" ? "bad" : id,
      ),
    ).toEqual({ kind: "invalid" });
    expect(f.pool.connect).not.toHaveBeenCalled();
  },
);
it.each([
  "no question",
  "different author",
  "missing record",
  "different text",
  "different operation",
])("rejects an answer with %s", async (reason) => {
  const f = fixture();
  const row: SampleFeedbackRecord = {
    ...record(f),
    publishedAt: new Date(),
    clarification: "Question",
  };
  f.state.records = [row];
  if (reason === "no question") row.clarification = null;
  if (reason === "different author") row.authorId = "other-reviewer";
  if (reason === "missing record") f.state.records = [];
  if (reason === "different text") {
    row.answer = "Earlier answer";
    row.answerOperationId = id;
  }
  if (reason === "different operation") {
    row.answer = "Answer";
    row.answerOperationId = "other-operation";
  }
  expect(await f.store.answer(token, id, id, "Answer", id)).toEqual({
    kind: ["different author", "missing record"].includes(reason)
      ? "denied"
      : "conflict",
  });
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
it("withdrawal retains reading but denies a new owner clarification", async () => {
  const f = fixture(false);
  f.state.evidence.consent = false;
  f.state.records = [{ ...record(f), publishedAt: new Date() }];
  expect(await f.store.clarify(token, id, id, "Question", id)).toEqual({
    kind: "denied",
  });
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
function draft(revision = 0): SampleDraftInput {
  return {
    revision,
    operationId: id,
    criteria: [
      {
        label: "Clarity",
        comment: "Explain the example",
        quote: "Invented",
        start: 0,
        end: 8,
      },
    ],
    preparationMinutes: null,
    reviewMinutes: 3,
  };
}
it("creates a source-bound private draft with an operation receipt in one transaction", async () => {
  const f = fixture();
  const input = draft();
  const result = await f.store.save(token, id, input);
  expect(result).toMatchObject({ kind: "saved", revision: 1 });
  const insert = f.calls.find((c) =>
    c.sql.startsWith("INSERT INTO private_sample_feedback("),
  );
  expect(insert?.values).toEqual([
    expect.any(String),
    id,
    id,
    f.state.evidence.digest,
    1,
    JSON.stringify(input.criteria),
    null,
    3,
    1,
    id,
  ]);
  expect(
    f.calls.find((c) =>
      c.sql.startsWith("INSERT INTO private_sample_feedback_draft_operations"),
    )?.values,
  ).toEqual([expect.any(String), id, sampleDraftDigest(input), 1]);
  expect(f.calls.at(-1)?.sql).toBe("COMMIT");
  expect(f.calls.some((c) => c.sql.includes("SET status='reviewed'"))).toBe(
    false,
  );
});
it("updates only the matching saved revision and increments the draft version", async () => {
  const f = fixture();
  f.state.records = [record(f)];
  const input = draft(1);
  expect(await f.store.save(token, id, input)).toEqual({
    kind: "saved",
    id,
    revision: 2,
  });
  expect(
    f.calls.find((c) =>
      c.sql.startsWith("UPDATE private_sample_feedback SET criteria"),
    )?.values,
  ).toEqual([id, JSON.stringify(input.criteria), null, 3, 2, id]);
});
it("acknowledges an exact draft replay without another write or revision increment", async () => {
  const f = fixture();
  const input = draft();
  f.state.records = [record(f)];
  f.state.replay = { digest: sampleDraftDigest(input), revision: 1 };
  expect(await f.store.save(token, id, input)).toEqual({
    kind: "saved",
    id,
    revision: 1,
  });
  expect(f.calls.some((c) => /^(INSERT|UPDATE)/.test(c.sql))).toBe(false);
});
it.each([
  "stale draft",
  "changed replay",
  "old replay",
  "published draft",
  "absent expected draft",
])("does not overwrite %s", async (reason) => {
  const f = fixture();
  const input = draft(1);
  f.state.records = [record(f)];
  if (reason === "stale draft") input.revision = 0;
  if (reason === "changed replay")
    f.state.replay = { digest: "b".repeat(64), revision: 1 };
  if (reason === "old replay")
    f.state.replay = { digest: sampleDraftDigest(input), revision: 2 };
  if (reason === "published draft")
    f.state.records[0]!.publishedAt = new Date();
  if (reason === "absent expected draft") f.state.records = [];
  expect(await f.store.save(token, id, input)).toEqual({ kind: "conflict" });
  expect(f.calls.some((c) => /^(INSERT|UPDATE)/.test(c.sql))).toBe(false);
});
it("rejects a draft quote that does not match its immutable source", async () => {
  const f = fixture();
  const input = draft();
  input.criteria[0]!.quote = "Different";
  expect(await f.store.save(token, id, input)).toEqual({ kind: "invalid" });
  expect(f.calls.some((c) => /^(INSERT|UPDATE)/.test(c.sql))).toBe(false);
});
it("returns an empty owner page without a continuation or private draft", async () => {
  const f = fixture(false);
  expect(await f.store.owner(token, id)).toMatchObject({
    kind: "ready",
    records: [],
    next: null,
  });
});
