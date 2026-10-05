import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  config: vi.fn(),
  mkdir: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
  migrate: vi.fn(),
  provision: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  timeGrant: vi.fn(),
  timeRevoke: vi.fn(),
  holdFactory: vi.fn(),
  holdGrant: vi.fn(),
  holdRevoke: vi.fn(),
  circleFactory: vi.fn(),
  circleGrant: vi.fn(),
  circleRevoke: vi.fn(),
}));
vi.mock("../../src/config.ts", () => ({ config: f.config }));
vi.mock("node:fs/promises", () => ({
  mkdir: f.mkdir,
  lstat: f.lstat,
  realpath: f.realpath,
  readFile: f.read,
  writeFile: f.write,
}));
vi.mock("pg", () => ({
  Pool: class {
    constructor(value: unknown) {
      f.create(value);
    }
    on = f.on;
    end = f.end;
  },
}));
vi.mock("../../src/store.ts", () => ({ migrate: f.migrate }));
vi.mock("../../src/authorization.ts", () => ({
  authorizationStore: () => ({ provisionStaff: f.provision }),
}));
vi.mock("../../src/support-requests.ts", () => ({
  supportRequestStore: () => ({
    grant: f.grant,
    revoke: f.revoke,
    time: { grant: f.timeGrant, revoke: f.timeRevoke },
  }),
}));
vi.mock("../../src/circle-discussion.ts", () => ({
  circleDiscussionStore: (...args: unknown[]) => {
    f.circleFactory(...args);
    return { grantModerator: f.circleGrant, revokeModerator: f.circleRevoke };
  },
}));
vi.mock("../../src/local-ai-hold-inspection.ts", () => ({
  localAiHoldInspectionStore: (...args: unknown[]) => {
    f.holdFactory(...args);
    return { grant: f.holdGrant, revoke: f.holdRevoke };
  },
}));
const directory = {
  isDirectory: () => true,
  isSymbolicLink: () => false,
  mode: 0o40700,
  uid: process.getuid!(),
};
const token = "a".repeat(64),
  uid = process.getuid!();
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = 0;
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "script",
    "grant",
    "instruction.json",
  ]);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  f.config.mockReturnValue({
    privateStorageRoot: "/private/test",
    databaseUrl: "private-local-url",
  });
  f.create.mockImplementation(() => {});
  f.mkdir.mockResolvedValue(undefined);
  f.lstat.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith("/support-admin")
        ? directory
        : { isFile: () => true, mode: 0o100600, uid },
    ),
  );
  f.realpath.mockImplementation((path: string) => Promise.resolve(path));
  f.write.mockResolvedValue(undefined);
  f.on.mockImplementation(() => {});
  f.end.mockResolvedValue(undefined);
  f.migrate.mockResolvedValue(undefined);
  f.read.mockImplementation((path: string) =>
    Promise.resolve(
      JSON.stringify(
        path.endsWith("admin.json")
          ? { token }
          : path.endsWith("operator.json")
            ? { id: "staff" }
            : {
                requestId: "request",
                idempotencyKey: "key",
                startsAt: "2026-10-02T01:00:00Z",
                expiresAt: "2026-10-02T02:00:00Z",
              },
      ),
    ),
  );
  f.provision.mockResolvedValue("staff");
  f.grant.mockResolvedValue({ kind: "created", grantId: "grant" });
  f.revoke.mockResolvedValue({ kind: "revoked" });
  f.timeGrant.mockResolvedValue({ kind: "created", grantId: "time-grant" });
  f.timeRevoke.mockResolvedValue({ kind: "revoked" });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
async function run(args?: string[]) {
  if (args)
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "script",
      ...args,
    ]);
  await import("../../src/support-admin-main.ts");
  return {
    out: vi.mocked(console.info).mock.calls,
    err: vi.mocked(console.error).mock.calls,
  };
}
function failed(result: Awaited<ReturnType<typeof run>>) {
  expect(result).toEqual({
    out: [],
    err: [[JSON.stringify({ status: "failed" })]],
  });
  expect(process.exitCode).toBe(1);
}
it.each(["created", "replayed"])(
  "uses a separate time grant boundary for %s without printing credentials",
  async (kind) => {
    f.read.mockImplementation((path: string) =>
      Promise.resolve(
        JSON.stringify(
          path.endsWith("admin.json")
            ? { token }
            : path.endsWith("operator.json")
              ? { id: "staff" }
              : {
                  requestId: "request",
                  allocationId: "allocation",
                  idempotencyKey: "key",
                  startsAt: "2026-10-02T01:00:00Z",
                  expiresAt: "2026-10-02T02:00:00Z",
                },
        ),
      ),
    );
    f.timeGrant.mockResolvedValue({ kind, grantId: "time-grant" });
    expect((await run(["time-grant", "instruction.json"])).out).toEqual([
      [
        JSON.stringify({
          status: "complete",
          action: "time-grant",
          grantId: "time-grant",
        }),
      ],
    ]);
    expect(f.timeGrant).toHaveBeenCalledWith(token, {
      requestId: "request",
      allocationId: "allocation",
      idempotencyKey: "key",
      staffId: "staff",
      role: "operator",
      startsAt: new Date("2026-10-02T01:00:00Z"),
      expiresAt: new Date("2026-10-02T02:00:00Z"),
    });
    expect(f.grant).not.toHaveBeenCalled();
  },
);
it("rejects a time grant instruction without an exact allocation", async () => {
  failed(await run(["time-grant", "instruction.json"]));
  expect(f.timeGrant).not.toHaveBeenCalled();
});
it.each(["revoked", "already-revoked"])(
  "uses separate time revocation for %s without note grant privileges",
  async (kind) => {
    f.read.mockResolvedValueOnce(JSON.stringify({ grantId: "time-grant" }));
    f.timeRevoke.mockResolvedValue({ kind });
    expect((await run(["time-revoke", "instruction.json"])).out).toEqual([
      [JSON.stringify({ status: "complete", action: "time-revoke" })],
    ]);
    expect(f.timeRevoke).toHaveBeenCalledWith(token, "time-grant");
    expect(f.revoke).not.toHaveBeenCalled();
  },
);
it("uses an actual private administrator credential and fixed operator role for grant/replay", async () => {
  for (const kind of ["created", "replayed"]) {
    vi.resetModules();
    f.grant.mockResolvedValueOnce({ kind, grantId: "grant" });
    expect((await run()).out.slice(-1)).toEqual([
      [
        JSON.stringify({
          status: "complete",
          action: "grant",
          grantId: "grant",
        }),
      ],
    ]);
  }
  expect(f.grant).toHaveBeenCalledWith(token, {
    requestId: "request",
    idempotencyKey: "key",
    staffId: "staff",
    role: "operator",
    startsAt: new Date("2026-10-02T01:00:00Z"),
    expiresAt: new Date("2026-10-02T02:00:00Z"),
  });
  expect(f.end).toHaveBeenCalledTimes(2);
});
it("bootstraps expiring random credentials only into new private files without printing them", async () => {
  f.lstat.mockImplementation((path: string) =>
    path.endsWith("/support-admin")
      ? Promise.resolve(directory)
      : Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" })),
  );
  const result = await run(["bootstrap"]);
  expect(result.err).toEqual([]);
  expect(f.provision).toHaveBeenCalledTimes(2);
  expect(f.write).toHaveBeenCalledTimes(2);
  for (const [, contents, options] of f.write.mock.calls) {
    const credential = JSON.parse(contents);
    expect(credential.token).toMatch(/^[a-f0-9]{64}$/);
    expect(options).toEqual({ flag: "wx", mode: 0o600 });
    expect(JSON.stringify(result)).not.toContain(credential.token);
  }
  expect(f.provision.mock.calls.map((row) => row[1])).toEqual([
    "platform_admin",
    "operator",
  ]);
});
it.each(["revoked", "already-revoked"])(
  "revokes through current admin authority: %s",
  async (kind) => {
    f.read.mockImplementation((path: string) =>
      Promise.resolve(
        JSON.stringify(
          path.endsWith("admin.json") ? { token } : { grantId: "grant" },
        ),
      ),
    );
    f.revoke.mockResolvedValue({ kind });
    expect((await run(["revoke", "instruction.json"])).out).toEqual([
      [JSON.stringify({ status: "complete", action: "revoke" })],
    ]);
    expect(f.revoke).toHaveBeenCalledWith(token, "grant");
  },
);
it.each([
  [],
  ["unknown"],
  ["grant"],
  ["grant", "../instruction.json"],
  ["grant", "secret-token", "extra"],
])("denies malformed arguments before connecting %j", async (...args) => {
  failed(await run(args));
  expect(f.create).not.toHaveBeenCalled();
});
it.each(["existing", "stat-failure"])(
  "preserves credentials before provisioning: %s",
  async (kind) => {
    if (kind === "stat-failure")
      f.lstat.mockRejectedValue(new Error("private error"));
    failed(await run(["bootstrap"]));
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each([
  "directory",
  "mode",
  "owner",
  "oversize",
  "json",
  "null",
  "array",
  "credential",
  "request",
  "key",
  "start",
  "end",
  "staff",
  "extra",
  "revoke-extra",
  "revoke-id",
])("suppresses invalid private input: %s", async (kind) => {
  if (kind === "directory")
    f.lstat.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/support-admin")
          ? directory
          : { isFile: () => false, mode: 0o600, uid },
      ),
    );
  if (kind === "mode")
    f.lstat.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/support-admin")
          ? directory
          : { isFile: () => true, mode: 0o644, uid },
      ),
    );
  if (kind === "owner")
    f.lstat.mockResolvedValue({
      isFile: () => true,
      mode: 0o600,
      uid: uid + 1,
    });
  const read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (path: string) => {
    if (path.endsWith("admin.json") && kind === "credential")
      return JSON.stringify({ token: "private-invalid" });
    if (path.endsWith("operator.json") && kind === "staff")
      return JSON.stringify({ id: null });
    if (!path.endsWith("instruction.json")) return read(path);
    if (kind === "oversize") return "x".repeat(8193);
    if (kind === "json") return "{";
    if (kind === "null") return "null";
    if (kind === "array") return "[]";
    const v = JSON.parse(await read(path));
    const fields: Record<string, string> = {
      request: "requestId",
      key: "idempotencyKey",
      start: "startsAt",
      end: "expiresAt",
    };
    if (fields[kind]) delete v[fields[kind]!];
    if (kind === "extra") v.adminId = "forged";
    if (kind === "revoke-extra")
      return JSON.stringify({ grantId: "grant", extra: "forged" });
    if (kind === "revoke-id") return JSON.stringify({ grantId: null });
    return JSON.stringify(v);
  });
  failed(
    await run(
      kind.startsWith("revoke") ? ["revoke", "instruction.json"] : undefined,
    ),
  );
  expect(f.grant).not.toHaveBeenCalled();
  expect(f.revoke).not.toHaveBeenCalled();
});
it.each(["denied", "withdrawn", "conflict", "unavailable"])(
  "does not announce a denied grant: %s",
  async (kind) => {
    f.grant.mockResolvedValue({ kind });
    failed(await run());
  },
);
it.each(["denied", "unavailable"])(
  "does not announce a denied revoke: %s",
  async (kind) => {
    f.read.mockImplementation((path: string) =>
      Promise.resolve(
        JSON.stringify(
          path.endsWith("admin.json") ? { token } : { grantId: "grant" },
        ),
      ),
    );
    f.revoke.mockResolvedValue({ kind });
    failed(await run(["revoke", "instruction.json"]));
  },
);
it.each([
  "config",
  "mkdir",
  "create",
  "migrate",
  "read",
  "grant",
  "write",
  "provision",
  "shutdown",
  "idle",
])("suppresses private failures at %s", async (stage) => {
  const error = new Error("private-token-or-member-text");
  if (stage === "config")
    f.config.mockImplementation(() => {
      throw error;
    });
  if (stage === "mkdir") f.mkdir.mockRejectedValue(error);
  if (stage === "create")
    f.create.mockImplementation(() => {
      throw error;
    });
  if (stage === "migrate") f.migrate.mockRejectedValue(error);
  if (stage === "read") f.read.mockRejectedValue(error);
  if (stage === "grant") f.grant.mockRejectedValue(error);
  if (stage === "write") f.write.mockRejectedValue(error);
  if (stage === "provision") f.provision.mockRejectedValue(error);
  if (stage === "shutdown") f.end.mockRejectedValue(error);
  if (stage === "idle")
    f.on.mockImplementation((_event, callback) => callback(error));
  if (["write", "provision"].includes(stage))
    f.lstat.mockImplementation((path: string) =>
      path.endsWith("/support-admin")
        ? Promise.resolve(directory)
        : Promise.reject(Object.assign(error, { code: "ENOENT" })),
    );
  failed(
    await run(
      ["write", "provision"].includes(stage) ? ["bootstrap"] : undefined,
    ),
  );
});

it.each(["symlink", "not-directory", "permissions", "owner", "escaped-path"])(
  "rejects unsafe private directory before provisioning: %s",
  async (kind) => {
    f.lstat.mockResolvedValue({
      ...directory,
      isDirectory: () => kind !== "not-directory",
      isSymbolicLink: () => kind === "symlink",
      mode: kind === "permissions" ? 0o40755 : 0o40700,
      uid: kind === "owner" ? uid + 1 : uid,
    });
    if (kind === "escaped-path")
      f.realpath.mockResolvedValue("/public/escaped");
    failed(await run(["bootstrap"]));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  },
);
it("denies bootstrap if checking an existing credential file fails without assuming absence", async () => {
  f.lstat.mockImplementation((path: string) =>
    path.endsWith("/support-admin")
      ? Promise.resolve(directory)
      : Promise.reject(
          Object.assign(new Error("private stat detail"), { code: "EACCES" }),
        ),
  );
  failed(await run(["bootstrap"]));
  expect(f.create).not.toHaveBeenCalled();
  expect(f.provision).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});

function circleInput(
  input: Record<string, unknown>,
  staff: unknown = "moderator",
) {
  f.config.mockReturnValue({
    privateStorageRoot: "/private/test",
    databaseUrl: "private-local-url",
    secret: "private-secret",
    circleDiscussion: true,
  });
  f.read.mockImplementation((path: string) =>
    Promise.resolve(
      JSON.stringify(
        path.endsWith("admin.json")
          ? { token }
          : path.endsWith("moderator.json")
            ? { id: staff }
            : input,
      ),
    ),
  );
}
it("bootstraps separate administrator and moderator credentials without creating a grant", async () => {
  circleInput({});
  f.lstat.mockImplementation((path: string) =>
    path.endsWith("/support-admin")
      ? Promise.resolve(directory)
      : Promise.reject(Object.assign(Error("absent"), { code: "ENOENT" })),
  );
  const result = await run(["circle-bootstrap"]);
  expect(result.err).toEqual([]);
  expect(f.provision.mock.calls.map((row) => row[1])).toEqual([
    "platform_admin",
    "moderator",
  ]);
  expect(f.write.mock.calls.map((row) => row[0])).toEqual([
    "/private/test/support-admin/admin.json",
    "/private/test/support-admin/moderator.json",
  ]);
  expect(f.circleGrant).not.toHaveBeenCalled();
  expect(f.circleFactory).not.toHaveBeenCalled();
  for (const [, text, options] of f.write.mock.calls) {
    const credential = JSON.parse(text);
    expect(options).toEqual({ flag: "wx", mode: 0o600 });
    expect(JSON.stringify(result)).not.toContain(credential.token);
  }
});
it("creates an explicitly instructed circle grant and outputs only its safe receipt", async () => {
  circleInput({
    circleId: "everyday-ai",
    idempotencyKey: "original",
    expiresAt: "2026-10-04T12:00:00Z",
  });
  f.circleGrant.mockResolvedValue({
    kind: "ready",
    value: { id: "safe-grant" },
  });
  const result = await run(["circle-grant", "instruction.json"]);
  expect(result).toEqual({
    out: [
      [
        JSON.stringify({
          status: "complete",
          action: "circle-grant",
          grantId: "safe-grant",
        }),
      ],
    ],
    err: [],
  });
  expect(f.circleGrant).toHaveBeenCalledWith(
    token,
    "moderator",
    "everyday-ai",
    "original",
    new Date("2026-10-04T12:00:00Z"),
  );
  expect(JSON.stringify(result)).not.toContain(token);
});
it("preserves grant revocation while discussion sharing is paused", async () => {
  circleInput({ circleId: "everyday-ai", grantId: "safe-grant" });
  f.config.mockReturnValue({
    privateStorageRoot: "/private/test",
    databaseUrl: "private-local-url",
    secret: "private-secret",
    circleDiscussion: false,
  });
  f.circleRevoke.mockResolvedValue({
    kind: "ready",
    value: { id: "safe-grant" },
  });
  const result = await run(["circle-revoke", "instruction.json"]);
  expect(result.err).toEqual([]);
  expect(f.circleFactory.mock.calls[0]!.slice(1)).toEqual([
    "private-secret",
    false,
  ]);
  expect(f.circleRevoke).toHaveBeenCalledWith(
    token,
    "everyday-ai",
    "safe-grant",
  );
});
it.each(["circle-bootstrap", "circle-grant"])(
  "denies %s during pause before creating files or a connection",
  async (command) => {
    circleInput({});
    f.config.mockReturnValue({ circleDiscussion: false });
    failed(
      await run(
        command === "circle-bootstrap"
          ? [command]
          : [command, "instruction.json"],
      ),
    );
    expect(f.mkdir).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each([
  [
    "circle-grant",
    { circleId: 1, idempotencyKey: "key", expiresAt: "2026-10-04T12:00:00Z" },
    "moderator",
  ],
  [
    "circle-grant",
    { circleId: "everyday-ai", expiresAt: "2026-10-04T12:00:00Z" },
    "moderator",
  ],
  [
    "circle-grant",
    { circleId: "everyday-ai", idempotencyKey: "key" },
    "moderator",
  ],
  [
    "circle-grant",
    {
      circleId: "everyday-ai",
      idempotencyKey: "key",
      expiresAt: "2026-10-04T12:00:00Z",
      extra: "forged",
    },
    "moderator",
  ],
  [
    "circle-grant",
    {
      circleId: "everyday-ai",
      idempotencyKey: "key",
      expiresAt: "2026-10-04T12:00:00Z",
    },
    null,
  ],
  ["circle-revoke", { circleId: "everyday-ai" }, "moderator"],
  ["circle-revoke", { circleId: "everyday-ai", grantId: 1 }, "moderator"],
  [
    "circle-revoke",
    { circleId: "everyday-ai", grantId: "grant", extra: "forged" },
    "moderator",
  ],
] as const)(
  "rejects malformed %s instructions without inventing success",
  async (command, input, staff) => {
    circleInput(input, staff);
    failed(await run([command, "instruction.json"]));
    expect(f.circleGrant).not.toHaveBeenCalled();
    expect(f.circleRevoke).not.toHaveBeenCalled();
  },
);
it.each(["circle-grant", "circle-revoke"])(
  "withholds %s completion when authorization does not confirm",
  async (command) => {
    circleInput(
      command === "circle-grant"
        ? {
            circleId: "everyday-ai",
            idempotencyKey: "key",
            expiresAt: "2026-10-04T12:00:00Z",
          }
        : { circleId: "everyday-ai", grantId: "grant" },
    );
    f.circleGrant.mockResolvedValue({ kind: "denied" });
    f.circleRevoke.mockResolvedValue({ kind: "denied" });
    failed(await run([command, "instruction.json"]));
  },
);

function holdInput(
  input: Record<string, unknown>,
  operator: unknown = "staff",
) {
  f.config.mockReturnValue({
    privateStorageRoot: "/private/test",
    databaseUrl: "private-local-url",
    mode: "test",
    localHoldInspectionReads: true,
  });
  f.read.mockImplementation((path: string) =>
    Promise.resolve(
      JSON.stringify(
        path.endsWith("admin.json")
          ? { token }
          : path.endsWith("operator.json")
            ? { id: operator }
            : input,
      ),
    ),
  );
}
const holdInstruction = {
  jobId: "job",
  idempotencyKey: "key",
  startsAt: "2026-10-05T12:00:00Z",
  expiresAt: "2026-10-05T13:00:00Z",
};
it.each(["applied", "replayed"])(
  "confirms %s exact hold inspection grant through private admin/operator credentials",
  async (kind) => {
    holdInput(holdInstruction);
    f.holdGrant.mockResolvedValue({ kind, grantId: "grant" });
    const result = await run(["hold-grant", "instruction.json"]);
    expect(result).toEqual({
      out: [
        [
          JSON.stringify({
            status: "complete",
            action: "hold-grant",
            grantId: "grant",
          }),
        ],
      ],
      err: [],
    });
    expect(f.holdGrant).toHaveBeenCalledWith(
      token,
      "job",
      "staff",
      new Date(holdInstruction.startsAt),
      new Date(holdInstruction.expiresAt),
      "key",
    );
    expect(f.holdFactory.mock.calls[0]?.[1]).toEqual({
      mode: "test",
      enabled: true,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.grant).not.toHaveBeenCalled();
  },
);
it.each(["applied", "replayed"])(
  "preserves exact hold revocation during pause: %s",
  async (kind) => {
    holdInput({ grantId: "grant" });
    f.config.mockReturnValue({
      privateStorageRoot: "/private/test",
      databaseUrl: "private-local-url",
      mode: "test",
      localHoldInspectionReads: false,
    });
    f.holdRevoke.mockResolvedValue({ kind, grantId: "grant" });
    expect(await run(["hold-revoke", "instruction.json"])).toEqual({
      out: [[JSON.stringify({ status: "complete", action: "hold-revoke" })]],
      err: [],
    });
    expect(f.holdFactory.mock.calls[0]?.[1]).toEqual({
      mode: "test",
      enabled: false,
    });
    expect(f.holdRevoke).toHaveBeenCalledWith(token, "grant");
    expect(f.revoke).not.toHaveBeenCalled();
  },
);
it.each([
  "jobId",
  "idempotencyKey",
  "startsAt",
  "expiresAt",
  "operator",
  "extra",
  "missing",
])("rejects malformed hold grant %s", async (field) => {
  const input: Record<string, unknown> = { ...holdInstruction };
  if (field === "extra") input.forbidden = "invented";
  else if (field === "missing") delete input.jobId;
  else if (field !== "operator") input[field] = null;
  holdInput(input, field === "operator" ? null : "staff");
  failed(await run(["hold-grant", "instruction.json"]));
  expect(f.holdGrant).not.toHaveBeenCalled();
});
it.each([{ grantId: null }, { grantId: "grant", extra: "invented" }])(
  "rejects malformed hold revocation %j",
  async (input) => {
    holdInput(input);
    failed(await run(["hold-revoke", "instruction.json"]));
    expect(f.holdRevoke).not.toHaveBeenCalled();
  },
);
it.each(["hold-grant", "hold-revoke"])(
  "withholds unconfirmed %s and suppresses private errors",
  async (command) => {
    holdInput(
      command === "hold-grant" ? holdInstruction : { grantId: "grant" },
    );
    f.holdGrant.mockResolvedValue({ kind: "denied" });
    f.holdRevoke.mockResolvedValue({ kind: "unavailable" });
    failed(await run([command, "instruction.json"]));
  },
);
