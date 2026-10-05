import { it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledProposalStore,
  proposalStore,
  validProposal,
  type Proposal,
} from "../../src/proposals.ts";

const value = {
  title: "Original sample",
  body: "Invented community event plan",
  sources: "Original invented details",
};
const draft: Proposal = {
  id: "11111111-1111-1111-1111-111111111111",
  title: value.title,
  body: value.body,
  sources: value.sources,
  state: "draft",
  revision: 1,
  createdAt: new Date("2026-09-23"),
  submittedAt: null,
};
it("accepts only bounded nonblank sample fields", () => {
  expect(validProposal(value)).toBe(true);
  for (const invalid of [null, undefined, "text"])
    expect(validProposal(invalid)).toBe(false);
  for (const invalid of [
    { title: " " },
    { title: "NUL\0text" },
    { body: 42 },
    { sources: ["duplicate", "fields"] },
    { title: "x".repeat(161) },
    { body: " " },
    { body: "x".repeat(4001) },
    { sources: " " },
    { sources: "x".repeat(1001) },
  ])
    expect(validProposal({ ...value, ...invalid })).toBe(false);
});
it("fails closed when proposal storage is unavailable", async () => {
  const disabled = disabledProposalStore();
  expect(await disabled.createDraft("member", value, true)).toBeNull();
  expect(await disabled.owned("member")).toEqual([]);
  expect(await disabled.preview("member", draft.id)).toBeNull();
  expect(
    await disabled.requestChanges("staff", draft.id, {
      expectedRevision: 1,
      feedback: "Sample correction",
    }),
  ).toBe("denied");
  expect(await disabled.editDraft("member", draft.id, value, 1)).toBe("denied");
  expect(await disabled.submit("member", draft.id, true, 1)).toBe("denied");
  expect(await disabled.withdraw("member", draft.id)).toBe(false);
  expect(await disabled.moderationQueue("moderator")).toBeNull();
  expect(await disabled.moderationPage("moderator")).toBeNull();
  expect(await disabled.moderate("moderator", draft.id, "reject")).toBe(false);
});
it("keeps invalid consent and rights submissions out of storage", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const store = proposalStore({ query } as unknown as Pool);
  expect(await store.createDraft("member", value, false)).toBeNull();
  expect(
    await store.createDraft("member", { ...value, title: " " }, true),
  ).toBeNull();
  expect(await store.submit("member", draft.id, false, 1)).toBe("denied");
  expect(await store.moderate("staff", draft.id, "approve" as "reject")).toBe(
    false,
  );
  expect(query).not.toHaveBeenCalled();
});
it("bounds member reads and creation to their current owner", async () => {
  const f = ownerFixture();
  expect(await f.store.createDraft("member", value, true)).toBe(draft.id);
  expect(
    await ownerFixture({ principal: false }).store.createDraft(
      "unknown",
      value,
      true,
    ),
  ).toBeNull();
  expect(await f.store.owned("member")).toEqual([draft]);
  expect(
    await ownerFixture({ principal: false }).store.owned("unknown"),
  ).toBeNull();
});
it("rejects forged or stale workflow references at creation", async () => {
  for (const options of [{ workflow: null }, { workflow: 2 }]) {
    const f = ownerFixture(options);
    expect(
      await f.store.createDraft("member", value, true, {
        id: "WF-001",
        version: 1,
      }),
    ).toBeNull();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  }
  const f = ownerFixture();
  expect(
    await f.store.createDraft("member", value, true, {
      id: "WF-001",
      version: 0,
    }),
  ).toBeNull();
  expect(f.connect).not.toHaveBeenCalled();
  expect(
    await f.store.createDraft("member", value, true, {
      id: "WF-001",
      version: 1,
    }),
  ).toBe(draft.id);
});

function ownerFixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    row?:
      | (Proposal & {
          feedbackText?: string | null;
          feedbackRevision?: number | null;
          feedbackRequestedAt?: Date | null;
          rightsAttestedRevision?: number | null;
          rightsAttestedAt?: Date | null;
        })
      | null;
    expired?: boolean;
    failure?: string;
    rollbackFails?: boolean;
    workflow?: number | null;
  } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (
      sql === options.failure ||
      (options.failure === "BEGIN" && sql.startsWith("BEGIN ")) ||
      (options.failure === "write" && sql.startsWith("UPDATE member_proposals"))
    )
      throw Error("Synthetic mutation failure");
    if (sql === "ROLLBACK" && options.rollbackFails)
      throw Error("Synthetic rollback failure");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "owner", expires_at: new Date("2099-01-01") }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (sql.startsWith("SELECT mp.id") || sql.startsWith("WITH owned"))
      return {
        rows:
          options.row === null
            ? []
            : [
                {
                  feedbackText: null,
                  feedbackRevision: null,
                  feedbackRequestedAt: null,
                  rightsAttestedRevision: null,
                  rightsAttestedAt: null,
                  ...(options.row ?? draft),
                },
              ],
      };
    if (sql.startsWith("WITH instant"))
      return {
        rows: [
          {
            valid: !options.expired,
            remaining: options.expired ? "-1" : "60000",
            observed: new Date(),
          },
        ],
      };
    if (sql.startsWith("INSERT INTO member_proposals"))
      return { rows: [{ id: draft.id }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const store = proposalStore({ connect } as unknown as Pool, async () =>
    options.workflow === null
      ? null
      : ({ version: options.workflow ?? 1 } as never),
  );
  return { store, query, release, connect };
}
it("saves valid maximum-size text, submits exact revision, and withdraws without a revision", async () => {
  const f = ownerFixture();
  expect(
    await f.store.editDraft(
      "member",
      draft.id,
      {
        title: "x".repeat(160),
        body: "x".repeat(4000),
        sources: "x".repeat(1000),
      },
      1,
    ),
  ).toBe("saved");
  expect(await f.store.submit("member", draft.id, true, 1)).toBe("submitted");
  expect(await f.store.withdraw("member", draft.id)).toBe(true);
  expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(
    3,
  );
});
it.each([0, -1, 1.5, NaN, Infinity, 2147483648, undefined])(
  "rejects invalid revision %s before connection acquisition",
  async (revision) => {
    const f = ownerFixture();
    expect(
      await f.store.editDraft("member", draft.id, value, revision as number),
    ).toBe("invalid");
    expect(
      await f.store.submit("member", draft.id, true, revision as number),
    ).toBe("denied");
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it("rejects invalid text without starting a write transaction", async () => {
  const f = ownerFixture();
  expect(
    await f.store.editDraft("member", draft.id, { ...value, body: " " }, 1),
  ).toBe("invalid");
  expect(f.connect).not.toHaveBeenCalled();
});
it.each([
  { principal: false },
  { workspace: false },
  { row: null },
  { expired: true },
])("denies unauthorized or expired owner mutation %o", async (options) => {
  for (const action of ["edit", "submit", "withdraw"] as const) {
    const f = ownerFixture(options);
    expect(
      await (action === "edit"
        ? f.store.editDraft("member", draft.id, value, 1)
        : action === "submit"
          ? f.store.submit("member", draft.id, true, 1)
          : f.store.withdraw("member", draft.id)),
    ).toBe(action === "withdraw" ? false : "denied");
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    if (!options.expired)
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  }
});
it.each(["submitted", "quarantined", "rejected", "withdrawn"] as const)(
  "never edits or resubmits a %s proposal",
  async (state) => {
    const f = ownerFixture({ row: { ...draft, state } });
    expect(await f.store.editDraft("member", draft.id, value, 1)).toBe(
      "denied",
    );
    expect(await f.store.submit("member", draft.id, true, 1)).toBe("denied");
    expect(await f.store.withdraw("member", draft.id)).toBe(
      state === "submitted" || state === "quarantined",
    );
  },
);
it("reports stale edit/submit conflict and prevents integer overflow without losing current text", async () => {
  const stale = ownerFixture({ row: { ...draft, revision: 2 } });
  expect(await stale.store.editDraft("member", draft.id, value, 1)).toBe(
    "conflict",
  );
  expect(await stale.store.submit("member", draft.id, true, 1)).toBe(
    "conflict",
  );
  expect(stale.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
    false,
  );
  const limit = ownerFixture({ row: { ...draft, revision: 2147483647 } });
  expect(
    await limit.store.editDraft("member", draft.id, value, 2147483647),
  ).toBe("conflict");
  expect(await limit.store.submit("member", draft.id, true, 2147483647)).toBe(
    "submitted",
  );
});
it.each([1, 2, null])(
  "allows only the pinned current workflow version %s",
  async (workflow) => {
    const f = ownerFixture({
      row: { ...draft, workflowId: "WF-001", workflowVersion: 1 },
      workflow,
    });
    expect(await f.store.editDraft("member", draft.id, value, 1)).toBe(
      workflow === 1 ? "saved" : "denied",
    );
    expect(await f.store.submit("member", draft.id, true, 1)).toBe(
      workflow === 1 ? "submitted" : "denied",
    );
    expect(await f.store.withdraw("member", draft.id)).toBe(true);
  },
);
it.each(["BEGIN", "write", "COMMIT"])(
  "withholds success and discards the connection after %s failure",
  async (failure) => {
    const f = ownerFixture({ failure });
    await expect(
      f.store.editDraft("member", draft.id, value, 1),
    ).rejects.toThrow("Proposal operation unconfirmed");
    expect(f.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(
      failure === "write",
    );
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  },
);
it("discards a mutation connection when rollback fails", async () => {
  const f = ownerFixture({ failure: "write", rollbackFails: true });
  await expect(f.store.submit("member", draft.id, true, 1)).rejects.toThrow(
    "Proposal operation unconfirmed",
  );
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});

function moderationFixture(
  options: {
    actorId?: string;
    candidates?: { id: string; member_id: string; submitted_at: string }[];
    principal?: boolean;
    profile?: boolean;
    expired?: boolean;
    rows?: (Proposal & {
      feedback_matches?: boolean;
      feedback_revision?: number | null;
      decision_actor_id?: string | null;
    })[];
    failure?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const release = vi.fn();
  const history: unknown[][] = [];
  const query = vi.fn(async (statement: string, values?: unknown[]) => {
    if (
      statement === options.failure ||
      (options.failure === "BEGIN" && statement.startsWith("BEGIN ")) ||
      (options.failure === "audit" &&
        statement.includes("INSERT INTO proposal_audit"))
    )
      throw new Error("Synthetic transaction failure");
    if (statement === "ROLLBACK" && options.rollbackFails)
      throw new Error("Synthetic rollback failure");
    if (statement.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [
                {
                  id: options.actorId ?? "actor",
                  expires_at: new Date("2099-01-01"),
                },
              ],
      };
    if (statement.startsWith("SELECT role FROM staff_profiles"))
      return { rows: options.profile === false ? [] : [{ role: "moderator" }] };
    if (statement.startsWith("SELECT mp.id,mp.member_id"))
      return {
        rows: options.candidates ?? [{ id: "proposal", member_id: "member" }],
      };
    if (statement.startsWith("SELECT id FROM workspaces"))
      return { rows: [{ id: "workspace" }] };
    if (statement.startsWith("WITH locked"))
      return {
        rows: (options.rows ?? [{ ...draft, state: "submitted" }]).map(
          (row) => ({ ...row, workspace_id: "workspace", member_id: "member" }),
        ),
      };
    if (statement.startsWith("WITH instant"))
      return {
        rows: [
          {
            valid: !options.expired,
            remaining: options.expired ? "-1" : "60000",
            observed: new Date(),
          },
        ],
      };
    if (statement.includes("INSERT INTO proposal_audit")) history.push(values!);
    return { rows: [], rowCount: 1 };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return {
    store: proposalStore({ connect } as unknown as Pool),
    query,
    release,
    history,
  };
}

it("returns a submitted revision to its owner with a content-free changes decision", async () => {
  const f = moderationFixture();
  expect(
    await f.store.requestChanges("staff", draft.id, {
      expectedRevision: 1,
      feedback: "Clarify the invented example.",
    }),
  ).toBe("requested");
  expect(f.history.map((row) => row[5])).toEqual([
    "proposal_changes_requested",
  ]);
});

it("commits one content-free event for each returned private proposal without exposing ownership metadata", async () => {
  const f = moderationFixture();
  expect(await f.store.moderationQueue("staff")).toEqual([
    { ...draft, state: "submitted" },
  ]);
  expect(f.history).toEqual([
    [
      "actor",
      "moderator",
      "workspace",
      "member",
      draft.id,
      "proposal_read",
      "submitted",
      "submitted",
      1,
    ],
  ]);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  const empty = moderationFixture({ rows: [] });
  expect(await empty.store.moderationQueue("staff")).toEqual([]);
  expect(empty.history).toEqual([]);
});
it.each([{ principal: false }, { profile: false }, { expired: true }])(
  "withholds queue text and moderation success on denied identity %o",
  async (options) => {
    for (const action of ["read", "reject"] as const) {
      const f = moderationFixture(options);
      expect(
        await (action === "read"
          ? f.store.moderationQueue("staff")
          : f.store.moderate("staff", draft.id, "reject")),
      ).toEqual(action === "read" ? null : false);
      if (!options.expired)
        expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
      expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
      expect(f.release).toHaveBeenCalledWith(expect.any(Error));
    }
  },
);
it.each([
  ["submitted", "quarantine", true, "proposal_quarantined"],
  ["submitted", "reject", true, "proposal_rejected"],
  ["quarantined", "reject", true, "proposal_rejected"],
  ["quarantined", "quarantine", false, null],
] as const)(
  "audits only an accepted %s to %s decision",
  async (state, action, accepted, event) => {
    const f = moderationFixture({ rows: [{ ...draft, state }] });
    expect(await f.store.moderate("staff", draft.id, action)).toBe(accepted);
    expect(f.history.map((row) => row[5])).toEqual(event ? [event] : []);
    const missing = moderationFixture({ rows: [] });
    expect(await missing.store.moderate("staff", draft.id, action)).toBe(false);
    expect(missing.history).toEqual([]);
  },
);
it.each(["BEGIN", "audit", "COMMIT"])(
  "withholds private text and discards the connection after %s failure",
  async (failure) => {
    const f = moderationFixture({ failure });
    expect(await f.store.moderationQueue("staff")).toBeNull();
    expect(f.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(
      failure === "audit",
    );
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  },
);
it("discards a connection when audit and rollback both fail", async () => {
  const f = moderationFixture({ failure: "audit", rollbackFails: true });
  await expect(f.store.moderate("staff", draft.id, "reject")).rejects.toThrow(
    "Proposal operation unconfirmed",
  );
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});

it("denies malformed proposal IDs without a database query", async () => {
  const f = ownerFixture();
  expect(await f.store.editDraft("member", "invalid", value, 1)).toBe("denied");
  expect(await f.store.submit("member", "invalid", true, 1)).toBe("denied");
  expect(await f.store.withdraw("member", "invalid")).toBe(false);
  expect(f.connect).not.toHaveBeenCalled();
});

it("returns a bounded continuation even when a full candidate window was withdrawn before it was locked", async () => {
  const options = {
    candidates: Array.from({ length: 100 }, (_, index) => ({
      id: `11111111-1111-1111-1111-${String(index).padStart(12, "0")}`,
      member_id: "member",
      submitted_at: "2026-09-01 00:00:00.123456+00",
    })),
    rows: [] as Proposal[],
  };
  const f = moderationFixture(options);
  const first = await f.store.moderationPage("staff");
  expect(first?.items).toEqual([]);
  expect(first?.nextCursor).toEqual(expect.any(String));
  expect(first!.nextCursor!.length).toBeLessThanOrEqual(512);
  expect(f.history).toEqual([]);
  options.candidates = [];
  expect(await f.store.moderationPage("staff", first!.nextCursor)).toEqual({
    items: [],
    nextCursor: null,
  });
});

it("accepts only the issuing actor and session's intact continuation in the same store instance", async () => {
  const options = {
    actorId: "actor",
    candidates: Array.from({ length: 100 }, () => ({
      id: draft.id,
      member_id: "member",
      submitted_at: "2026-09-01 00:00:00.123456+00",
    })),
  };
  const f = moderationFixture(options);
  const first = await f.store.moderationPage("staff");
  const cursor = first!.nextCursor!;
  const history = [...f.history];
  for (const invalid of [
    null,
    42,
    [],
    {},
    "",
    "x".repeat(513),
    "bad",
    cursor.replace("v1.", "v2."),
    cursor.replace(draft.id, "-".repeat(36)),
    cursor.slice(0, -43) + "x".repeat(43),
    cursor + "=",
  ]) {
    expect(await f.store.moderationPage("staff", invalid)).toBeNull();
    expect(f.history).toEqual(history);
  }
  expect(await f.store.moderationPage("other-session", cursor)).toBeNull();
  options.actorId = "other-actor";
  expect(await f.store.moderationPage("staff", cursor)).toBeNull();
  options.actorId = "actor";
  expect(
    await moderationFixture(options).store.moderationPage("staff", cursor),
  ).toBeNull();
  expect(await f.store.moderationPage("staff", cursor)).toMatchObject({
    items: [{ ...draft, state: "submitted" }],
  });
  expect(f.history).toHaveLength(2);
});

it("returns only owner feedback and consent fields after the locked preview commits", async () => {
  const requestedAt = new Date("2026-10-02T12:00:00Z");
  const f = ownerFixture({
    row: {
      ...draft,
      state: "changes_requested",
      feedbackText: "Private feedback",
      feedbackRevision: 1,
      feedbackRequestedAt: requestedAt,
    },
  });
  expect(await f.store.preview("member", draft.id)).toEqual({
    ...draft,
    feedback: { text: "Private feedback", reviewedRevision: 1, requestedAt },
    state: "changes_requested",
    rightsAttestedRevision: null,
    rightsAttestedAt: null,
  });
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(await ownerFixture().store.preview("member", draft.id)).toEqual({
    ...draft,
    feedback: null,
    rightsAttestedRevision: null,
    rightsAttestedAt: null,
  });
  for (const options of [
    { principal: false },
    { workspace: false },
    { row: null },
    { expired: true },
  ])
    expect(
      await ownerFixture(options).store.preview("member", draft.id),
    ).toBeNull();
  const invalid = ownerFixture();
  expect(await invalid.store.preview("member", "invalid")).toBeNull();
  expect(invalid.connect).not.toHaveBeenCalled();
});

it.each([
  "",
  " \n\t",
  "x".repeat(1001),
  "\0",
  "\ud800",
  "\udc00",
  ["one", "two"],
  undefined,
])(
  "rejects invalid member-visible feedback without a transaction: %j",
  async (feedback) => {
    const f = moderationFixture();
    expect(
      await f.store.requestChanges("staff", draft.id, {
        expectedRevision: 1,
        feedback: feedback as string,
      }),
    ).toBe("invalid");
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("accepts full UTF-16 feedback and preserves exact input bytes", async () => {
  for (const feedback of [
    "汉".repeat(1000),
    "😀".repeat(500),
    "  Original sample feedback\n",
  ]) {
    const f = moderationFixture();
    expect(
      await f.store.requestChanges("staff", draft.id, {
        expectedRevision: 1,
        feedback,
      }),
    ).toBe("requested");
    const update = f.query.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE member_proposals"),
    );
    expect(update?.[1]?.[1]).toBe(feedback);
    expect(JSON.stringify(f.history)).not.toContain(feedback.trim());
  }
});
it("denies malformed IDs and revisions without database access", async () => {
  const f = moderationFixture();
  expect(
    await f.store.requestChanges("staff", "bad", {
      expectedRevision: 1,
      feedback: "Sample",
    }),
  ).toBe("denied");
  expect(
    await f.store.requestChanges("staff", draft.id, {
      expectedRevision: 0,
      feedback: "Sample",
    }),
  ).toBe("invalid");
  expect(f.query).not.toHaveBeenCalled();
});
it.each([{ principal: false }, { profile: false }, { expired: true }])(
  "requires current staff authorization even for changes: %o",
  async (options) => {
    const f = moderationFixture(options);
    expect(
      await f.store.requestChanges("staff", draft.id, {
        expectedRevision: 1,
        feedback: "Sample",
      }),
    ).toBe("denied");
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    if (!options.expired)
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  },
);
it.each([
  { rows: [], result: "conflict" },
  {
    rows: [{ ...draft, state: "submitted" as const, revision: 2 }],
    result: "conflict",
  },
  { rows: [{ ...draft, state: "quarantined" as const }], result: "conflict" },
  {
    rows: [
      {
        ...draft,
        state: "changes_requested" as const,
        feedback_matches: true,
        feedback_revision: 1,
        decision_actor_id: "actor",
      },
    ],
    result: "replayed",
  },
  {
    rows: [
      {
        ...draft,
        state: "changes_requested" as const,
        feedback_matches: false,
        feedback_revision: 1,
        decision_actor_id: "actor",
      },
    ],
    result: "conflict",
  },
  {
    rows: [
      {
        ...draft,
        state: "changes_requested" as const,
        feedback_matches: true,
        feedback_revision: 2,
        decision_actor_id: "actor",
      },
    ],
    result: "conflict",
  },
  {
    rows: [
      {
        ...draft,
        state: "changes_requested" as const,
        feedback_matches: true,
        feedback_revision: 1,
        decision_actor_id: "other",
      },
    ],
    result: "conflict",
  },
])(
  "distinguishes exact authorized request replay from conflicting decisions: %o",
  async ({ rows, result }) => {
    const f = moderationFixture({ rows });
    expect(
      await f.store.requestChanges("staff", draft.id, {
        expectedRevision: 1,
        feedback: "Sample",
      }),
    ).toBe(result);
    expect(f.history).toEqual([]);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  },
);
it("requires an edited returned revision and exact fresh rights for resubmission/replay", async () => {
  const returned = {
    ...draft,
    state: "changes_requested" as const,
    feedbackText: "Change",
    feedbackRevision: 1,
  };
  for (const row of [returned, { ...returned, feedbackRevision: null }])
    expect(
      await ownerFixture({ row }).store.submit("member", draft.id, true, 1),
    ).toBe("conflict");
  const edit = ownerFixture({ row: returned });
  expect(await edit.store.editDraft("member", draft.id, value, 1)).toBe(
    "saved",
  );
  const revised = ownerFixture({ row: { ...returned, revision: 2 } });
  expect(await revised.store.submit("member", draft.id, true, 2)).toBe(
    "submitted",
  );
  const submitted = ownerFixture({
    row: {
      ...draft,
      state: "submitted",
      revision: 2,
      rightsAttestedRevision: 2,
      rightsAttestedAt: new Date(),
    },
  });
  expect(await submitted.store.submit("member", draft.id, true, 2)).toBe(
    "replayed",
  );
  expect(await submitted.store.submit("member", draft.id, true, 1)).toBe(
    "conflict",
  );
  expect(
    submitted.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE")),
  ).toBe(false);
});
it("never returns owner feedback or extra database columns through a moderation projection", async () => {
  const privateRow = {
    ...draft,
    state: "submitted" as const,
    feedback: "Private text",
    rightsAttestedAt: new Date(),
    feedback_matches: true,
    feedback_revision: 1,
    decision_actor_id: "actor",
  };
  const page = await moderationFixture({
    rows: [privateRow],
  }).store.moderationPage("staff");
  expect(page?.items).toEqual([{ ...draft, state: "submitted" }]);
  expect(JSON.stringify(page)).not.toContain("Private text");
});
