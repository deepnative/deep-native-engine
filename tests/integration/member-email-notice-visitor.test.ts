import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import {
  memberEmailAccess,
  type MemberEmailAccess,
} from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-notice-visitor-secret";
const notices: string[] = [];
const email = memberEmailAccess(
  pool,
  {
    async send() {},
    async sendNoAccount(address) {
      notices.push(address);
    },
  },
  origin,
);
let finished = 0;
const access: MemberEmailAccess = {
  ...email,
  requestSignIn: (address, visitor) =>
    email.requestSignIn(address, visitor).finally(() => finished++),
};
const application = app(store(pool), { origin, secret, memberEmail: access });
let server: Server;
let requested = 0;

beforeAll(async () => {
  await migrate(pool);
  server = await listenLoopback(application);
});
beforeEach(async () => {
  notices.length = 0;
  requested = 0;
  finished = 0;
  await pool.query(
    "TRUNCATE member_email_notices, member_email_notice_visitors",
  );
});
afterAll(async () => {
  await closeLoopback(server);
  await pool.end();
});

/** One real sign-in request, as nginx hands it to the application. */
async function ask(forwardedFor: string) {
  const landing = await request(server)
    .get("/email/sign-in")
    .set("Host", "127.0.0.1:3000");
  const cookie = landing.headers["set-cookie"]?.[0]?.match(
    /dne_preview=([a-f0-9]{64})/,
  )?.[1];
  if (!cookie) throw new Error("Sign-in page did not set a browser cookie");
  const response = await request(server)
    .post("/email/sign-in")
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${cookie}`)
    .set("X-Forwarded-For", forwardedFor)
    .type("form")
    .send({
      email: `invented${++requested}@example.test`,
      csrf: csrf(cookie, secret),
    });
  // The work finishes after the page is sent, including for a refused request.
  await vi.waitFor(() => expect(finished).toBe(requested));
  return response;
}

it("NOTICE-VISITOR-01 sends a visitor three notices an hour with an unchanged page", async () => {
  const pages = [];
  for (let index = 0; index < 5; index++) pages.push(await ask("203.0.113.9"));
  expect(notices).toHaveLength(3);
  expect(new Set(pages.map((page) => page.status))).toEqual(new Set([200]));
  expect(new Set(pages.map((page) => page.text)).size).toBe(1);
});

it("NOTICE-VISITOR-02 leaves other visitors' notices unaffected", async () => {
  for (let index = 0; index < 4; index++) await ask("203.0.113.9");
  await ask("203.0.113.10");
  expect(notices).toHaveLength(4);
});

it("NOTICE-VISITOR-03 invented earlier entries neither buy an allowance nor spend someone else's", async () => {
  for (let index = 0; index < 5; index++)
    await ask(`198.51.100.${index}, 203.0.113.9`);
  expect(notices).toHaveLength(3);
  // The attacker named 198.51.100.1 above; its real owner still has all three.
  for (let index = 0; index < 3; index++) await ask("198.51.100.1");
  expect(notices).toHaveLength(6);
});

it("NOTICE-VISITOR-06 an address that can't be read shares one allowance", async () => {
  for (const unreadable of ["not-an-ip", "also-not", "", "203.0.113.9, x"])
    await ask(unreadable);
  expect(notices).toHaveLength(3);
});
