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
  id: "synthetic",
  title: value.title,
  body: value.body,
  sources: value.sources,
  state: "draft",
  createdAt: new Date("2026-09-23"),
  submittedAt: null,
};
it("accepts only bounded nonblank sample fields", () => {
  expect(validProposal(value)).toBe(true);
  for (const invalid of [
    { title: " " },
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
  expect(await disabled.submit("member", draft.id, true)).toBe(false);
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
  expect(await store.submit("member", draft.id, false)).toBe(false);
  expect(await store.moderate("staff", draft.id, "approve" as "reject")).toBe(
    false,
  );
  expect(query).not.toHaveBeenCalled();
});
it("bounds member operations to their current owner", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ id: draft.id }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [draft] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [{ workflowId: null, workflowVersion: null }],
    })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 });
  const store = proposalStore({ query } as unknown as Pool);
  expect(await store.createDraft("member", value, true)).toBe(draft.id);
  expect(await store.createDraft("unknown", value, true)).toBeNull();
  expect(await store.owned("member")).toEqual([draft]);
  expect(await store.preview("member", draft.id)).toEqual(draft);
  expect(await store.preview("other", draft.id)).toBeNull();
  expect(await store.submit("member", draft.id, true)).toBe(true);
  expect(await store.submit("other", draft.id, true)).toBe(false);
  expect(await store.withdraw("member", draft.id)).toBe(true);
  expect(await store.withdraw("other", draft.id)).toBe(false);
});

it("rejects forged or stale workflow references and refuses stale draft submission", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ id: draft.id }] })
    .mockResolvedValueOnce({
      rows: [{ workflowId: "WF-001", workflowVersion: 1 }],
    })
    .mockResolvedValueOnce({
      rows: [{ workflowId: "WF-001", workflowVersion: 1 }],
    })
    .mockResolvedValueOnce({ rowCount: 1 });
  let current = 1;
  const resolve = vi.fn(async (id: string) =>
    id === "WF-001" ? ({ version: current } as never) : null,
  );
  const store = proposalStore({ query } as unknown as Pool, resolve);
  expect(
    await store.createDraft("member", value, true, {
      id: "WF-999",
      version: 1,
    }),
  ).toBeNull();
  expect(
    await store.createDraft("member", value, true, {
      id: "WF-001",
      version: 0,
    }),
  ).toBeNull();
  expect(
    await store.createDraft("member", value, true, {
      id: "WF-001",
      version: 2,
    }),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
  expect(
    await store.createDraft("member", value, true, {
      id: "WF-001",
      version: 1,
    }),
  ).toBe(draft.id);
  current = 2;
  expect(await store.submit("member", draft.id, true)).toBe(false);
  current = 1;
  expect(await store.submit("member", draft.id, true)).toBe(true);
  expect(query).toHaveBeenCalledTimes(4);
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
