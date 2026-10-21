import { expect, it, vi } from "vitest";
import { readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as preview from "../../scripts/private-preview.mjs";
import { controlConnection } from "../../scripts/private-preview.mjs";

// Explicitly simulated lifecycle faults. Native database acknowledgement and
// lock timing are proved separately by CLOSE-DDL-01/04 integration evidence.
const lifecycle = vi.hoisted(() => ({
  enabled: false,
  fault: "",
  databasePresent: false,
  connects: 0,
  drops: 0,
  ends: 0,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    spawnSync(executable, args, ...rest) {
      // These lifecycle cases simulate build/runtime metadata too. Gate probes
      // intentionally copy sources without .git; native tests cover real Git.
      if (lifecycle.enabled && executable === "git") {
        const metadata = {
          "rev-parse HEAD": "a".repeat(40),
          "rev-parse HEAD^{tree}": "b".repeat(40),
          "status --porcelain": "",
        };
        if (Object.hasOwn(metadata, args.join(" ")))
          return { status: 0, stdout: metadata[args.join(" ")] };
      }
      if (
        lifecycle.enabled &&
        ((executable === "npm" && args[0] === "run" && args[1] === "build") ||
          args[0] === "scripts/check-installed-deps.mjs")
      )
        return { status: 0, stdout: "" };
      return original.spawnSync(executable, args, ...rest);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    async cp(source, destination, options) {
      if (!lifecycle.enabled) return original.cp(source, destination, options);
      if (source.endsWith("/package.json")) {
        await original.writeFile(destination, '{"type":"module"}');
      } else if (source.endsWith("/package-lock.json")) {
        await original.writeFile(destination, "{}");
      } else {
        await original.mkdir(destination, { recursive: true });
        if (source.endsWith("/dist")) {
          await original.writeFile(
            destination + "/runtime.js",
            'export async function start() { return { origin: "http://127.0.0.1:1", close: async () => {} }; }',
          );
          await original.writeFile(
            destination + "/authorization.js",
            'export function authorizationStore() { return { provisionStaff: async () => "invented-staff-reference" }; }',
          );
          await original.writeFile(
            destination + "/catalog.js",
            "export function catalogStore() { return { createDraft: async () => true, submit: async () => true, approve: async () => true, publish: async () => true }; }",
          );
        }
      }
    },
  };
});
vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal();
  const fault = (code) =>
    Object.assign(new Error("invented-private-driver-payload"), { code });
  return {
    ...original,
    Pool: class extends original.Pool {
      async query(text, ...rest) {
        if (!lifecycle.enabled) return super.query(text, ...rest);
        if (text.startsWith('CREATE DATABASE "dne_test_')) {
          lifecycle.databasePresent = true;
          return { rows: [] };
        }
        if (
          text ===
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1"
        )
          return { rows: [{ n: 0 }] };
        throw new Error("Unexpected simulated control query");
      }
      async end() {
        if (!lifecycle.enabled) return super.end();
      }
    },
    Client: class extends original.Client {
      async connect(...args) {
        if (!lifecycle.enabled) return super.connect(...args);
        lifecycle.connects++;
        if (lifecycle.fault === "connect") throw fault("08006");
        if (lifecycle.fault === "event-before")
          await new Promise((resolve) =>
            setTimeout(() => {
              this.emit("error", fault("57P01"));
              resolve();
            }, 0),
          );
      }
      async query(text, ...rest) {
        if (!lifecycle.enabled) return super.query(text, ...rest);
        if (!/^DROP DATABASE "dne_test_[a-f0-9]{32}"$/.test(text))
          throw new Error("Unexpected simulated removal target");
        lifecycle.drops++;
        if (["query-end", "event-before"].includes(lifecycle.fault))
          throw fault("57014");
        lifecycle.databasePresent = false;
        if (lifecycle.fault === "ack-lost") throw fault("08006");
        return { rows: [] };
      }
      async end(...args) {
        if (!lifecycle.enabled) return super.end(...args);
        lifecycle.ends++;
        // This event occurs after the launcher received successful DROP and
        // cleared its acknowledged ownership flag, while it awaits end().
        if (lifecycle.fault === "event-after")
          await new Promise((resolve) =>
            setTimeout(() => {
              this.emit("error", fault("57P01"));
              resolve();
            }, 0),
          );
        if (
          ["query-end", "event-before", "event-after", "end"].includes(
            lifecycle.fault,
          )
        )
          throw fault("58000");
      }
    },
  };
});

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
  "DNE_LOCAL_SUPPORT_ASSIGNMENT",
  "DNE_WORKFLOW_REVIEW_REQUESTS",
])(
  "PREVIEW-03 SUPPREVIEW-01 WFPREVIEW-01 rejects inherited application setting %s",
  (key) => {
    expect(() =>
      controlConnection({ [key]: "synthetic-private-secret" }),
    ).toThrow("failed at configuration");
  },
);

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

it.each([
  ["connect", "owned-drop", "08006", true, 0],
  ["query-end", "owned-drop", "57014", true, 1],
  ["event-before", "owned-drop", "57P01", true, 1],
  ["event-after", "owned-drop", "57P01", false, 1],
  ["ack-lost", "owned-drop", "08006", false, 1],
  ["end", "drop-client-close", "58000", false, 1],
])(
  "CLOSE-DDL-03 simulated %s retains first cause, responsibility and one cleanup operation",
  async (mode, stage, code, present, drops) => {
    Object.assign(lifecycle, {
      enabled: true,
      fault: mode,
      databasePresent: false,
      connects: 0,
      drops: 0,
      ends: 0,
    });
    let running;
    try {
      running = await preview.launchPreview({});
      const outcomes = await Promise.all([running.close(), running.close()]);
      expect(outcomes).toEqual([false, false]);
      expect(await running.close()).toBe(false);
      expect(lifecycle.connects).toBe(1);
      expect(lifecycle.drops).toBe(drops);
      expect(lifecycle.ends).toBe(1);
      expect(lifecycle.databasePresent).toBe(present);
      expect(existsSync(running.privateRoot)).toBe(true);
      expect((await stat(running.metadataFile)).mode & 0o777).toBe(0o600);
      const retained = JSON.parse(await readFile(running.metadataFile, "utf8"));
      expect(retained.cleanup).toContain("Cleanup blocked");
      const safe = preview.cleanupDiagnostic(retained);
      expect(safe).toMatchObject({ stage, code, kind: "absent" });
      expect(running.cleanupDiagnostic()).toEqual(safe);
      expect(JSON.stringify(safe)).not.toContain(
        "invented-private-driver-payload",
      );
      expect(JSON.stringify(safe).includes(retained.database)).toBe(false);
      expect(JSON.stringify(safe).includes(running.privateRoot)).toBe(false);
    } finally {
      try {
        await running?.close();
        // Only the test-owned simulated snapshot is removed; no PostgreSQL
        // database exists for these explicitly simulated lifecycle scenarios.
        if (running)
          await rm(running.privateRoot, { recursive: true, force: true });
      } finally {
        lifecycle.enabled = false;
      }
    }
  },
);

it("CLOSE-DDL-03 simulated acknowledged removal closes once and removes its owned snapshot", async () => {
  Object.assign(lifecycle, {
    enabled: true,
    fault: "none",
    databasePresent: false,
    connects: 0,
    drops: 0,
    ends: 0,
  });
  let running;
  try {
    running = await preview.launchPreview({});
    expect(await Promise.all([running.close(), running.close()])).toEqual([
      true,
      true,
    ]);
    expect(lifecycle.databasePresent).toBe(false);
    expect(lifecycle.connects).toBe(1);
    expect(lifecycle.drops).toBe(1);
    expect(lifecycle.ends).toBe(1);
    expect(existsSync(running.privateRoot)).toBe(false);
  } finally {
    try {
      await running?.close();
      if (running)
        await rm(running.privateRoot, { recursive: true, force: true });
    } finally {
      lifecycle.enabled = false;
    }
  }
});
