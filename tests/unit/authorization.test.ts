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
const future = new Date("2099-01-01T00:00:00Z");

function database(...rows: unknown[]) {
  const query = vi.fn();
  for (const row of rows)
    query.mockResolvedValueOnce({
      rows: row ? (Array.isArray(row) ? row : [row]) : [],
    });
  return { query, access: authorizationStore({ query } as unknown as Pool) };
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
  const db = database({ id: grant }, undefined);
  await expect(db.access.revokeAssignment(admin, grant)).resolves.toBe(true);
  await expect(db.access.revokeSupport(admin, grant)).resolves.toBe(false);
  expect(db.query.mock.calls[0]![0]).toContain("assignment_grants");
  expect(db.query.mock.calls[1]![0]).toContain("support_access_grants");
  await expect(db.access.revokeAssignment("bad", grant)).resolves.toBe(false);
  await expect(db.access.revokeSupport(admin, "bad")).resolves.toBe(false);
  expect(db.query).toHaveBeenCalledTimes(2);
});

it("returns authorized private records with their server-derived access path", async () => {
  const db = database([
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
  ]);
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
  expect(db.query.mock.calls[0]![1]).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    workspace,
    "resolve ticket",
  ]);
});

it("allows an empty owned workspace and denies absent authorization", async () => {
  const allowed = database({
    via: "member",
    purpose: null,
    lesson_id: null,
    lesson_version: null,
    instruction: null,
    verification: null,
    completed_at: null,
  });
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
    database(undefined).access.readWorkspace(token, workspace),
  ).resolves.toEqual({ kind: "denied" });
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
