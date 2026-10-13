import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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
