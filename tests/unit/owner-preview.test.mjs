import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as preview from "../../scripts/private-preview.mjs";
import { controlConnection } from "../../scripts/private-preview.mjs";

it("PREVIEW-01 exposes one repository command for the owner-run rehearsal", () => {
  const result = spawnSync("make", ["--dry-run", "preview"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("npm run preview");
});

it.each([
  "https://127.0.0.1/postgres",
  "postgresql://remote.example.invalid/postgres",
  "postgresql://127.0.0.1/postgres?options=secret",
  "postgresql://127.0.0.1/postgres#private",
  "not a database URL",
])(
  "PREVIEW-03 rejects an unsafe control destination without exposing input",
  (value) => {
    let message = "";
    try {
      controlConnection({ DNE_PREVIEW_CONTROL_URL: value });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("failed at configuration");
    expect(message.includes(value)).toBe(false);
  },
);

it.each([
  "DNE_DATABASE_URL",
  "DNE_PORT",
  "DNE_PRIVATE_STORAGE_ROOT",
  "DNE_APP_MODE",
  "DNE_AI_PROVIDER",
  "DNE_LOCAL_STAFF_ENTRY",
  "DNE_CIRCLE_DISCUSSION",
])("PREVIEW-03 rejects inherited application setting %s", (key) => {
  expect(() =>
    controlConnection({ [key]: "synthetic-private-secret" }),
  ).toThrow("failed at configuration");
});

it.each(["127.0.0.1", "localhost", "[::1]"])(
  "PREVIEW-03 permits loopback control at %s but never its selected database",
  (host) => {
    const control = controlConnection({
      DNE_PREVIEW_CONTROL_URL: `postgresql://dne:synthetic-private-secret@${host}:54329/do_not_migrate_this`,
    });
    expect(control.hostname).toBe(host);
    expect(control.pathname).toBe("/postgres");
    expect(control.search).toBe("");
    expect(control.hash).toBe("");
  },
);
it("PREVIEW-03 uses the documented loopback development connection when absent", () => {
  const control = controlConnection({});
  expect(control.hostname).toBe("127.0.0.1");
  expect(control.port).toBe("54329");
  expect(control.pathname).toBe("/postgres");
});

it("CLOSE-DIAG-02 projects only fixed diagnostics from a private cleanup record", () => {
  expect(typeof preview.cleanupDiagnostic).toBe("function");
  const diagnostic = preview.cleanupDiagnostic({
    cleanupStage: "owned-drop",
    cleanupCode: "57014",
    cleanupElapsedMs: 5012.8,
    database: "postgresql://private-user:private-password@localhost/private-db",
    privateRoot: "/private/credential-file",
    cleanup: "private thrown text",
  });
  expect(diagnostic).toEqual({
    record: "present",
    stage: "owned-drop",
    kind: "absent",
    code: "57014",
    elapsedMs: 5012,
  });
  expect(JSON.stringify(diagnostic)).not.toContain("private");
  expect(
    preview.cleanupDiagnostic({
      cleanupStage: "private-stage",
      cleanupKind: "private-kind",
      cleanupCode: "private-secret",
      cleanupElapsedMs: Infinity,
    }),
  ).toEqual({
    record: "present",
    stage: "unknown",
    kind: "unknown",
    code: "unknown",
    elapsedMs: "unknown",
  });
  expect(preview.cleanupDiagnostic(undefined)).toEqual({
    record: "missing",
    stage: "unknown",
    kind: "absent",
    code: "absent",
    elapsedMs: "unknown",
  });
});

it("CLOSE-DIAG-01 preserves the first cleanup cause when later steps also fail", () => {
  expect(typeof preview.recordCleanupFailure).toBe("function");
  const record = {};
  preview.recordCleanupFailure(
    record,
    "runtime-close",
    new Error("private runtime error"),
    3.2,
  );
  preview.recordCleanupFailure(
    record,
    "control-pool-close",
    { code: "57014", message: "private driver text" },
    9,
  );
  expect(preview.cleanupDiagnostic(record)).toEqual({
    record: "present",
    stage: "runtime-close",
    kind: "absent",
    code: "unknown",
    elapsedMs: 3,
  });
  const held = { cleanupKind: "owned-session-present" };
  preview.recordCleanupFailure(held, "session-refusal", undefined, 20001);
  expect(preview.cleanupDiagnostic(held)).toEqual({
    record: "present",
    stage: "session-refusal",
    kind: "owned-session-present",
    code: "absent",
    elapsedMs: 20001,
  });
  expect(held.cleanupCode).toBeUndefined();
});

it.each([57014, { code: "private-secret" }, ["57014"], false])(
  "CLOSE-DIAG-02 never treats a non-string driver code as SQLSTATE",
  (code) => {
    const record = {};
    preview.recordCleanupFailure(record, "owned-drop", { code }, 1);
    expect(preview.cleanupDiagnostic(record).code).toBe("unknown");
    expect(preview.cleanupDiagnostic({ cleanupCode: code }).code).toBe(
      "unknown",
    );
  },
);

it("CLOSE-DIAG-02 never invokes private record or thrown-error accessors", () => {
  let reads = 0;
  const unsafe = Object.defineProperties(
    {},
    {
      cleanupStage: {
        get() {
          reads++;
          return "owned-drop";
        },
      },
      cleanupCode: {
        get() {
          reads++;
          throw new Error("private accessor");
        },
      },
    },
  );
  expect(preview.cleanupDiagnostic(unsafe)).toMatchObject({
    stage: "unknown",
    code: "unknown",
  });
  const record = {};
  expect(() =>
    preview.recordCleanupFailure(
      record,
      "owned-drop",
      Object.defineProperty({}, "code", {
        get() {
          reads++;
          throw new Error("private driver accessor");
        },
      }),
      1,
    ),
  ).not.toThrow();
  expect(preview.cleanupDiagnostic(record).code).toBe("unknown");
  expect(reads).toBe(0);
});

it("CLOSE-DIAG-02 contains failed descriptor inspection without interrupting cleanup", () => {
  const inaccessible = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("private inspection");
      },
    },
  );
  expect(preview.cleanupDiagnostic(inaccessible)).toEqual({
    record: "present",
    stage: "unknown",
    kind: "unknown",
    code: "unknown",
    elapsedMs: "unknown",
  });
  expect(() =>
    preview.recordCleanupFailure(
      inaccessible,
      "owned-drop",
      { code: "57014" },
      1,
    ),
  ).not.toThrow();
  const record = {};
  preview.recordCleanupFailure(record, "owned-drop", inaccessible, 1);
  expect(preview.cleanupDiagnostic(record).code).toBe("unknown");
});
