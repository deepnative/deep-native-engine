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
  expect(await disabled.editDraft("member", draft.id, value, 1)).toBe("denied");
  expect(await disabled.submit("member", draft.id, true, 1)).toBe("denied");
  expect(await disabled.withdraw("member", draft.id)).toBe(false);
  expect(await disabled.moderationQueue("moderator")).toBeNull();
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
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ id: draft.id }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [] });
  const store = proposalStore({ query } as unknown as Pool);
  expect(await store.createDraft("member", value, true)).toBe(draft.id);
  expect(await store.createDraft("unknown", value, true)).toBeNull();
  expect(await store.owned("member")).toEqual([draft]);
  expect(await store.preview("member", draft.id)).toEqual(draft);
  expect(await store.preview("other", draft.id)).toBeNull();
});
it("rejects forged or stale workflow references at creation", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: draft.id }] });
  const resolve = vi.fn(async (id: string) =>
    id === "WF-001" ? ({ version: 1 } as never) : null,
  );
  const store = proposalStore({ query } as unknown as Pool, resolve);
  for (const ref of [
    { id: "WF-999", version: 1 },
    { id: "WF-001", version: 0 },
    { id: "WF-001", version: 2 },
  ])
    expect(await store.createDraft("member", value, true, ref)).toBeNull();
  expect(query).not.toHaveBeenCalled();
  expect(
    await store.createDraft("member", value, true, {
      id: "WF-001",
      version: 1,
    }),
  ).toBe(draft.id);
});

function ownerFixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    row?: Proposal | null;
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
    if (sql.startsWith("SELECT mp.id"))
      return { rows: options.row === null ? [] : [options.row ?? draft] };
    if (sql.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: !options.expired }] };
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
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(undefined);
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
  "rolls back failed %s without reporting success",
  async (failure) => {
    const f = ownerFixture({ failure });
    await expect(
      f.store.editDraft("member", draft.id, value, 1),
    ).rejects.toThrow("Synthetic mutation failure");
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(undefined);
  },
);
it("discards a mutation connection when rollback fails", async () => {
  const f = ownerFixture({ failure: "write", rollbackFails: true });
  await expect(f.store.submit("member", draft.id, true, 1)).rejects.toThrow(
    "Synthetic mutation failure",
  );
  expect(f.release).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Proposal mutation rollback failed" }),
  );
});

function moderationFixture(
  options: {
    principal?: boolean;
    profile?: boolean;
    expired?: boolean;
    rows?: Proposal[];
    failure?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const release = vi.fn();
  const history: unknown[][] = [];
  const query = vi.fn(async (statement: string, values?: unknown[]) => {
    if (
      statement === options.failure ||
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
            : [{ id: "actor", expires_at: new Date("2099-01-01") }],
      };
    if (statement.startsWith("SELECT role FROM staff_profiles"))
      return { rows: options.profile === false ? [] : [{ role: "moderator" }] };
    if (statement.startsWith("SELECT mp.id,mp.member_id"))
      return { rows: [{ id: "proposal", member_id: "member" }] };
    if (statement.startsWith("SELECT id FROM workspaces"))
      return { rows: [{ id: "workspace" }] };
    if (statement.startsWith("WITH locked"))
      return {
        rows: (options.rows ?? [{ ...draft, state: "submitted" }]).map(
          (row) => ({ ...row, workspace_id: "workspace", member_id: "member" }),
        ),
      };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: !options.expired }] };
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
    ],
  ]);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledWith(undefined);
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
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
      expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
      expect(f.release).toHaveBeenCalledWith(undefined);
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
  "returns no private text and releases the connection on %s failure",
  async (failure) => {
    const f = moderationFixture({ failure });
    await expect(f.store.moderationQueue("staff")).rejects.toThrow(
      "Synthetic transaction failure",
    );
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(undefined);
  },
);
it("discards a connection when audit and rollback both fail", async () => {
  const f = moderationFixture({ failure: "audit", rollbackFails: true });
  await expect(f.store.moderate("staff", draft.id, "reject")).rejects.toThrow(
    "Synthetic transaction failure",
  );
  expect(f.release).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Proposal audit rollback failed" }),
  );
});

it("denies malformed proposal IDs without a database query", async () => {
  const f = ownerFixture();
  expect(await f.store.editDraft("member", "invalid", value, 1)).toBe("denied");
  expect(await f.store.submit("member", "invalid", true, 1)).toBe("denied");
  expect(await f.store.withdraw("member", "invalid")).toBe(false);
  expect(f.connect).not.toHaveBeenCalled();
});
