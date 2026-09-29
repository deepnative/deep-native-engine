import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  authorizationStore,
  disabledAuthorizationStore,
  STAFF_ROLES,
  type StaffRole,
} from "../../src/authorization.ts";

const token = "a".repeat(64);
const admin = "00000000-0000-4000-8000-000000000001";
const staff = "00000000-0000-4000-8000-000000000002";
const workspace = "00000000-0000-4000-8000-000000000003";
const grant = "00000000-0000-4000-8000-000000000004";
const submission = "00000000-0000-4000-8000-000000000005";
const future = new Date("2099-01-01T00:00:00Z");

function database(...rows: unknown[]) {
  const query = vi.fn();
  for (const row of rows)
    query.mockResolvedValueOnce({
      rows: row ? (Array.isArray(row) ? row : [row]) : [],
    });
  return { query, access: authorizationStore({ query } as unknown as Pool) };
}

function workspaceDatabase(
  records: unknown[],
  options: {
    denied?: boolean;
    missingWorkspace?: boolean;
    current?: boolean | null;
    via?: "member" | "assignment" | "support";
    failAt?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const via = options.via ?? "member";
  const release = vi.fn();
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (options.failAt && sql.includes(options.failAt))
      throw Error("Synthetic read failure");
    if (options.rollbackFails && sql === "ROLLBACK")
      throw Error("Synthetic rollback failure");
    if (sql.includes("WITH identity AS"))
      return {
        rows: options.denied
          ? []
          : [
              {
                via,
                purpose: via === "support" ? "resolve ticket" : null,
                actor_id: staff,
                grant_id: via === "member" ? null : grant,
                grant_expires_at: future,
              },
            ],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: options.missingWorkspace ? [] : [{ id: workspace }] };
    if (sql.includes("FROM exercises")) return { rows: records };
    if (sql.includes("AS valid"))
      return {
        rows:
          options.current === null ? [] : [{ valid: options.current ?? true }],
      };
    return { rows: [] };
  });
  return {
    query,
    release,
    access: authorizationStore({
      connect: async () => ({ query, release }),
    } as unknown as Pool),
  };
}

it("uses a fail-closed authorization store when privileged access is unconfigured", async () => {
  const disabled = disabledAuthorizationStore();
  await expect(disabled.readWorkspace(token, workspace)).resolves.toEqual({
    kind: "denied",
  });
  await expect(disabled.readCohort(token, "group", "guide")).resolves.toEqual({
    kind: "denied",
  });
  await expect(disabled.provisionStaff(token, "coach", future)).rejects.toThrow(
    "not configured",
  );
  await expect(
    disabled.grantAssignment(
      admin,
      staff,
      workspace,
      "coach",
      "review",
      future,
    ),
  ).rejects.toThrow("not configured");
  await expect(
    disabled.grantSupport(
      admin,
      staff,
      workspace,
      "operator",
      "support",
      future,
    ),
  ).rejects.toThrow("not configured");
  await expect(disabled.revokeAssignment(admin, grant)).resolves.toBe(false);
  await expect(
    disabled.grantEvidenceReview(
      admin,
      staff,
      grant,
      submission,
      "review",
      future,
    ),
  ).rejects.toThrow("not configured");
  await expect(disabled.revokeEvidenceReview(admin, grant)).resolves.toBe(
    false,
  );
  await expect(disabled.revokeSupport(admin, grant)).resolves.toBe(false);
});

it.each(STAFF_ROLES)(
  "provisions a bounded %s identity without storing its token",
  async (role) => {
    const db = database({ id: staff });
    await expect(db.access.provisionStaff(token, role, future)).resolves.toBe(
      staff,
    );
    expect(db.query.mock.calls[0]![1]).toEqual([
      expect.any(String),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      future,
      role,
    ]);
    expect(JSON.stringify(db.query.mock.calls[0])).not.toContain(token);
  },
);

it.each([
  ["short", "coach", future],
  [token, "owner", future],
  [token, "coach", new Date("invalid")],
])("rejects malformed staff identity input", async (value, role, expiry) => {
  await expect(
    authorizationStore({} as Pool).provisionStaff(
      value as string,
      role as StaffRole,
      expiry as Date,
    ),
  ).rejects.toThrow("could not be provisioned");
});

it("rejects expired or duplicate staff provisioning", async () => {
  const db = database(undefined);
  await expect(
    db.access.provisionStaff(token, "coach", future),
  ).rejects.toThrow("could not be provisioned");
});

it("creates assignment and support grants only through an active administrator", async () => {
  const db = database({ id: grant }, { id: grant });
  await expect(
    db.access.grantAssignment(
      admin,
      staff,
      workspace,
      "reviewer",
      " assess lesson ",
      future,
    ),
  ).resolves.toBe(grant);
  expect(db.query.mock.calls[0]![0]).toContain("assignment_grants");
  expect(db.query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    staff,
    "reviewer",
    workspace,
    "assess lesson",
    future,
    admin,
  ]);
  await expect(
    db.access.grantSupport(
      admin,
      staff,
      workspace,
      "operator",
      "resolve ticket",
      future,
    ),
  ).resolves.toBe(grant);
  expect(db.query.mock.calls[1]![0]).toContain("support_access_grants");
});

it("creates an exact reviewer evidence grant for a submitted object", async () => {
  const db = database({ id: grant });
  await expect(
    db.access.grantEvidenceReview(
      admin,
      staff,
      grant,
      submission,
      " private review ",
      future,
    ),
  ).resolves.toBe(grant);
  expect(db.query.mock.calls[0]![0]).toContain("reviewer_evidence_grants");
  expect(db.query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    staff,
    grant,
    submission,
    "private review",
    future,
    admin,
  ]);
  await expect(
    database(undefined).access.grantEvidenceReview(
      admin,
      staff,
      grant,
      submission,
      "review",
      future,
    ),
  ).rejects.toThrow("denied");
});

it.each([
  ["bad", staff, grant, submission, future],
  [admin, "bad", grant, submission, future],
  [admin, staff, "bad", submission, future],
  [admin, staff, grant, "bad", future],
  [admin, staff, grant, submission, new Date("invalid")],
])(
  "rejects malformed exact reviewer grants",
  async (actor, reviewer, assignment, item, expiry) => {
    await expect(
      authorizationStore({} as Pool).grantEvidenceReview(
        actor as string,
        reviewer as string,
        assignment as string,
        item as string,
        "review",
        expiry as Date,
      ),
    ).rejects.toThrow("denied");
  },
);

it("rejects unsafe exact reviewer grant purpose", async () => {
  await expect(
    authorizationStore({} as Pool).grantEvidenceReview(
      admin,
      staff,
      grant,
      submission,
      " ",
      future,
    ),
  ).rejects.toThrow("Access purpose");
});

it.each([
  ["bad", staff, workspace, future],
  [admin, "bad", workspace, future],
  [admin, staff, "bad", future],
  [admin, staff, workspace, new Date("invalid")],
])(
  "rejects malformed privileged grants",
  async (actor, target, space, expiry) => {
    await expect(
      authorizationStore({} as Pool).grantAssignment(
        actor as string,
        target as string,
        space as string,
        "coach",
        "review",
        expiry as Date,
      ),
    ).rejects.toThrow("denied");
  },
);

it.each(["", "x".repeat(201)])(
  "rejects unsafe grant purpose %j",
  async (purpose) => {
    await expect(
      authorizationStore({ query: vi.fn() } as unknown as Pool).grantAssignment(
        admin,
        staff,
        workspace,
        "coach",
        purpose,
        future,
      ),
    ).rejects.toThrow("Access purpose");
  },
);

it("fails closed when the administrator, target, workspace or expiry is not eligible", async () => {
  await expect(
    database(undefined).access.grantSupport(
      admin,
      staff,
      workspace,
      "platform_admin",
      "incident",
      future,
    ),
  ).rejects.toThrow("denied");
});

it("revokes each grant type only for valid identifiers and an active administrator", async () => {
  const db = database({ id: grant }, undefined, { id: grant });
  await expect(db.access.revokeAssignment(admin, grant)).resolves.toBe(true);
  await expect(db.access.revokeSupport(admin, grant)).resolves.toBe(false);
  await expect(db.access.revokeEvidenceReview(admin, grant)).resolves.toBe(
    true,
  );
  expect(db.query.mock.calls[0]![0]).toContain("assignment_grants");
  expect(db.query.mock.calls[1]![0]).toContain("support_access_grants");
  expect(db.query.mock.calls[2]![0]).toContain("reviewer_evidence_grants");
  await expect(db.access.revokeAssignment("bad", grant)).resolves.toBe(false);
  await expect(db.access.revokeSupport(admin, "bad")).resolves.toBe(false);
  await expect(db.access.revokeEvidenceReview("bad", grant)).resolves.toBe(
    false,
  );
  expect(db.query).toHaveBeenCalledTimes(3);
});

it("returns authorized private records with their server-derived access path", async () => {
  const db = workspaceDatabase(
    [
      {
        via: "support",
        purpose: "resolve ticket",
        lesson_id: "lesson-a",
        lesson_version: 1,
        instruction: "private",
        verification: "check",
        completed_at: null,
      },
      {
        via: "support",
        purpose: "resolve ticket",
        lesson_id: "lesson-b",
        lesson_version: 2,
        instruction: "private two",
        verification: "check two",
        completed_at: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    { via: "support" },
  );
  await expect(
    db.access.readWorkspace(token, workspace, " resolve ticket "),
  ).resolves.toMatchObject({
    kind: "allowed",
    via: "support",
    workspaceId: workspace,
    purpose: "resolve ticket",
    records: [
      { lessonId: "lesson-a", lessonVersion: 1, instruction: "private" },
      { lessonId: "lesson-b", lessonVersion: 2, instruction: "private two" },
    ],
  });
  expect(
    db.query.mock.calls.find(([sql]) => sql.includes("WITH identity AS"))![1],
  ).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    workspace,
    "resolve ticket",
  ]);
});

it("allows an empty owned workspace and denies absent authorization", async () => {
  const allowed = workspaceDatabase([]);
  await expect(allowed.access.readWorkspace(token, workspace)).resolves.toEqual(
    {
      kind: "allowed",
      via: "member",
      workspaceId: workspace,
      purpose: null,
      records: [],
    },
  );
  await expect(
    workspaceDatabase([], { denied: true }).access.readWorkspace(
      token,
      workspace,
    ),
  ).resolves.toEqual({ kind: "denied" });
});

it("fails closed on database audit failure without returning privileged success or content", async () => {
  const query = vi.fn().mockRejectedValue(new Error("Synthetic audit failure"));
  const access = authorizationStore({
    query,
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as Pool);
  const attempts = [
    () =>
      access.grantAssignment(
        admin,
        staff,
        workspace,
        "coach",
        "review",
        future,
      ),
    () =>
      access.grantSupport(
        admin,
        staff,
        workspace,
        "operator",
        "support",
        future,
      ),
    () =>
      access.grantEvidenceReview(
        admin,
        staff,
        grant,
        submission,
        "review",
        future,
      ),
    () => access.revokeAssignment(admin, grant),
    () => access.revokeSupport(admin, grant),
    () => access.revokeEvidenceReview(admin, grant),
    () => access.readWorkspace(token, workspace),
    () => access.readWorkspace(token, workspace, "support"),
  ];
  for (const attempt of attempts)
    await expect(attempt()).rejects.toThrow("Synthetic audit failure");
  expect(query).toHaveBeenCalledTimes(attempts.length + 2);
});

it.each([
  ["short", workspace, undefined],
  [token, "bad", undefined],
  [token, workspace, ""],
  [token, workspace, "x".repeat(201)],
])("denies malformed workspace requests", async (value, space, purpose) => {
  await expect(
    authorizationStore({} as Pool).readWorkspace(
      value as string,
      space as string,
      purpose,
    ),
  ).resolves.toEqual({ kind: "denied" });
});

it("returns only explicitly permitted cohort content", async () => {
  const db = database({ body: "Shared guide" }, undefined);
  await expect(
    db.access.readCohort(token, "learning-group", "guide"),
  ).resolves.toEqual({
    kind: "allowed",
    cohortId: "learning-group",
    contentId: "guide",
    body: "Shared guide",
  });
  await expect(
    db.access.readCohort(token, "learning-group", "other"),
  ).resolves.toEqual({
    kind: "denied",
  });
});

it.each([
  ["short", "group", "guide"],
  [token, "Bad group", "guide"],
  [token, "group", "../guide"],
])("denies malformed cohort requests", async (value, cohort, content) => {
  await expect(
    authorizationStore({} as Pool).readCohort(value, cohort, content),
  ).resolves.toEqual({ kind: "denied" });
});

it("represents withdrawn exercise text as null with its retained timestamp", async () => {
  const withdrawnAt = new Date("2026-09-29T00:00:00Z");
  const db = workspaceDatabase([
    {
      via: "member",
      purpose: null,
      lesson_id: "lesson-a",
      lesson_version: 1,
      instruction: null,
      verification: null,
      completed_at: new Date("2026-09-28T00:00:00Z"),
      withdrawn_at: withdrawnAt,
    },
  ]);
  await expect(
    db.access.readWorkspace(token, workspace),
  ).resolves.toMatchObject({
    kind: "allowed",
    records: [{ instruction: null, verification: null, withdrawnAt }],
  });
});

it.each([{ missingWorkspace: true }, { current: false }, { current: null }])(
  "denies unavailable workspaces or authorization expiring while waiting",
  async (options) => {
    const db = workspaceDatabase([], options);
    expect(await db.access.readWorkspace(token, workspace)).toEqual({
      kind: "denied",
    });
    expect(db.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it.each(["FROM exercises", "INSERT INTO authorization_audit", "COMMIT"])(
  "fails closed and releases the transaction after %s fails",
  async (failAt) => {
    const db = workspaceDatabase([], { via: "assignment", failAt });
    await expect(db.access.readWorkspace(token, workspace)).rejects.toThrow(
      "Synthetic read failure",
    );
    expect(db.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards the connection if failed read rollback cannot release privacy locks", async () => {
  const db = workspaceDatabase([], {
    failAt: "FROM exercises",
    rollbackFails: true,
  });
  await expect(db.access.readWorkspace(token, workspace)).rejects.toThrow(
    "Synthetic read failure",
  );
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});
