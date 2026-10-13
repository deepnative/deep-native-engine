import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import ts from "typescript";
import { test } from "vitest";
const require = createRequire(import.meta.url);
const root = process.cwd();
test("DRAIN-01 an earlier timed-out fixture teardown cannot close or delete a later fixture", async () => {
  const fixtures = new Map();
  const pools = [];
  let releaseFirst;
  let firstClosing;
  const closing = new Promise((resolve) => {
    firstClosing = resolve;
  });
  const pending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  class ControlledPool {
    constructor(options) {
      this.name = new URL(options.connectionString).pathname.slice(1);
      this.endCalls = 0;
      this.ordinal = pools.length;
      pools.push(this);
      if (this.name !== "postgres") fixtures.get(this.name).active = 1;
    }
    async query(input, params) {
      const text = typeof input === "string" ? input : input.text;
      const values = params || input.values;
      if (text.startsWith("CREATE DATABASE")) {
        const name = text.match(/"([^"]+)"/)[1];
        fixtures.set(name, { active: 0, present: true });
        return { rows: [] };
      }
      if (text.includes("pg_backend_pid"))
        return { rows: [{ pg_backend_pid: 1 }] };
      if (text.includes("COUNT(*)"))
        return { rows: [{ count: fixtures.get(values[0]).active }] };
      if (text.startsWith("DROP DATABASE")) {
        const name = text.match(/"([^"]+)"/)[1];
        assert.equal(fixtures.get(name).active, 0);
        fixtures.get(name).present = false;
        return { rows: [] };
      }
      if (text.includes("FROM pg_database"))
        return {
          rows: fixtures.get(values[0]).present ? [{ datname: values[0] }] : [],
        };
      throw Error("Unexpected fixture query");
    }
    async end() {
      this.endCalls++;
      if (this.ordinal === 1) {
        firstClosing();
        await pending;
      }
      if (this.name !== "postgres") fixtures.get(this.name).active = 0;
    }
  }
  let before, after;
  const api = {
    beforeEach(callback) {
      before = callback;
    },
    afterEach(callback) {
      after = callback;
    },
    it() {},
    expect(value) {
      return {
        toBe(expected) {
          assert.equal(value, expected);
        },
        toHaveLength(expected) {
          assert.equal(value.length, expected);
        },
      };
    },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const sandbox = {
      module: mod,
      exports: mod.exports,
      URL,
      performance,
      setTimeout,
      clearTimeout,
      process: {
        env: {
          DNE_TEST_DATABASE_URL:
            "postgresql://127.0.0.1/dne_test_" + "a".repeat(32),
        },
      },
      require(id) {
        if (id === "node:crypto") return require(id);
        if (id === "pg") return { Pool: ControlledPool };
        if (id === "vitest") return api;
        if (id.startsWith("."))
          return load(path.resolve(path.dirname(file), id));
        throw Error("Unexpected fixture import");
      },
    };
    vm.runInNewContext(source, sandbox, { filename: path.basename(file) });
    return mod.exports;
  }
  load(
    path.join(root, "tests/integration/attendance-browser-database.test.ts"),
  );
  const first = { task: {} },
    second = { task: {} };
  const cleanup = await before(first);
  const older = (cleanup ? cleanup() : after(first)).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, message: e.message }),
  );
  await closing;
  // Model the observed Vitest deadline boundary: an earlier cleanup remains
  // pending while the runner starts a later test. No actual database is used.
  await before(second);
  releaseFirst();
  const result = await older;

  assert.equal(
    pools[2].endCalls,
    0,
    "An earlier fixture teardown must not close the later fixture control pool",
  );
  assert.equal(
    result.ok,
    true,
    "The earlier fixture must finish only its own cleanup",
  );
  assert.equal(pools[0].endCalls, 1);
  assert.equal(fixtures.get(pools[1].name).present, false);
  assert.equal(fixtures.get(pools[3].name).present, true);
});
