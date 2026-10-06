import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { staffEntryStore } from "../../src/staff-entry.ts";
import { testPool } from "../support/database.ts";
import { sampleAssignmentFixture } from "../support/sample-assignment.ts";
const pool = testPool();
let root = "",
  server: Server | undefined;
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  root = await mkdtemp(join(tmpdir(), "dne480-http-lifetime-"));
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});
afterAll(() => pool.end());
const nonce = (html: string) =>
  html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
const cookie = (response: request.Response, name: string) =>
  (response.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith(name + "="))!
    .split(";")[0]!;
it.each(["read", "write"] as const)(
  "REVADM-07 real PostgreSQL %s completion crossing HTTP acceptance withholds late metadata",
  async (operation) => {
    const f = await sampleAssignmentFixture(pool, root);
    if (operation === "read")
      expect(
        (await f.assignments.assign(f.administratorToken, f.input)).kind,
      ).toBe("applied");
    const delayed = {
      ...f.assignments,
      recover: async (...args: Parameters<typeof f.assignments.recover>) => {
        const result = await f.assignments.recover(...args);
        if (result.kind === "ready") await crossExpiry();
        return result;
      },
      assign: async (...args: Parameters<typeof f.assignments.assign>) => {
        const result = await f.assignments.assign(...args);
        if (result.kind === "applied") await crossExpiry();
        return result;
      },
    };
    async function crossExpiry() {
      await pool.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.075) FROM principals WHERE id=$1",
        [f.administratorId],
      );
    }
    const options = {
      origin: "http://127.0.0.1:0",
      secret: randomBytes(32).toString("hex"),
      mode: "test" as const,
      localStaffEntry: true,
      staffEntry: staffEntryStore(pool),
      sampleAssignmentAdministration: true,
      sampleAssignments: delayed,
    };
    server = app(store(pool), options).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned listener unavailable");
    options.origin = `http://127.0.0.1:${address.port}`;
    const host = new URL(options.origin).host;
    const login = await request(server)
      .get("/staff/sign-in")
      .set("Host", host)
      .expect(200);
    const signed = await request(server)
      .post("/staff/sign-in")
      .set("Host", host)
      .set("Origin", options.origin)
      .set("Cookie", cookie(login, "dne_staff_entry"))
      .type("form")
      .send({ csrf: nonce(login.text), credential: f.administratorToken })
      .expect(303);
    const selected = cookie(signed, "dne_staff"),
      form = await request(server)
        .get("/operator/sample-assignments")
        .set("Host", host)
        .set("Cookie", selected)
        .expect(200);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE id=$1",
      [f.administratorId],
    );
    const response = await request(server)
      .post(
        "/operator/sample-assignments/" +
          (operation === "read" ? "recover" : "assign"),
      )
      .set("Host", host)
      .set("Origin", options.origin)
      .set("Cookie", selected)
      .type("form")
      .send(
        operation === "read"
          ? { csrf: nonce(form.text), operationId: f.input.operationId }
          : {
              csrf: nonce(form.text),
              ...f.input,
              sourceRevision: "1",
              confirm: "yes",
            },
      )
      .expect(operation === "read" ? 403 : 503);
    expect(response.text).not.toContain("data-receipt");
    expect(response.text).not.toContain(
      "The exact paired assignment was recorded",
    );
    if (operation === "write") {
      expect(response.text).toContain(f.input.operationId);
      expect(response.text).toContain("may already have committed");
      expect(response.text).not.toMatch(/name="confirm"[^>]*checked/);
    } else expect(response.text).not.toContain(f.input.operationId);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM private_sample_assignment_operations",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM authorization_audit"))
        .rows[0].n,
    ).toBe(2);
  },
);
