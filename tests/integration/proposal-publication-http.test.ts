import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { start } from "../../src/runtime.ts";
import { store } from "../../src/store.ts";
import { proposalStore } from "../../src/proposals.ts";
import { COOKIE } from "../../src/session.ts";

const url = process.env.DNE_TEST_DATABASE_URL!;
if (!/^\/dne_test_[a-f0-9]{32}$/.test(new URL(url).pathname))
  throw Error("Dedicated generated test database required");
const pool = new pg.Pool({ connectionString: url });
let running: Awaited<ReturnType<typeof start>>, root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dne97-publication-"));
  running = await start({
    DNE_DATABASE_URL: url,
    DNE_APP_MODE: "test",
    DNE_PORT: "0",
    DNE_PRIVATE_STORAGE_ROOT: root,
    DNE_MEMBER_CONTRIBUTIONS: "enabled",
  });
});
afterAll(async () => {
  await running?.close();
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("CONPUB-01/03 provides an owner-only publication preview without sharing a submitted proposal", async () => {
  const token = randomBytes(32).toString("hex");
  await store(pool).create(token, { background: "explorer", goal: "everyday" });
  const proposals = proposalStore(pool);
  const id = await proposals.createDraft(
    token,
    {
      title: "Invented reading circle checklist",
      body: "Compare three invented activity ideas and check the source facts.",
      sources: "Original invented fixture text; no external reuse rights.",
    },
    true,
  );
  expect(await proposals.submit(token, id!, true, 1)).toBe("submitted");
  const response = await request(running.server)
    .get(`/contribute/${id}/publication`)
    .set("Host", new URL(running.origin).host)
    .set("Cookie", `${COOKIE}=${token}`);
  expect(
    response.status,
    "The owner cannot inspect editorial acceptance and deliberate sharing",
  ).toBe(200);
  expect(response.text).toContain(
    "Editorial acceptance is needed before sharing",
  );
  expect(response.text).toContain("Compare three invented activity ideas");
  expect(response.text).not.toContain(
    'action="/contribute/' + id + '/publish"',
  );
});
