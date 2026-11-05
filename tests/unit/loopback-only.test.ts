import express from "express";
import { createServer, type Server } from "node:net";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(
    open
      .splice(0)
      .map((server) => new Promise((done) => server.close(() => done(null)))),
  );
});

it("LOOPBACK-ONLY-01 fails bare Supertest instead of binding the wildcard address", () => {
  expect(() => request(express()).get("/")).toThrow(
    "Test servers must bind 127.0.0.1",
  );
});

it.each([
  ["no host", [0]],
  ["a callback only", [0, () => undefined]],
  ["a numeric string port", ["0"]],
  ["IPv4 wildcard", [0, "0.0.0.0"]],
  ["IPv6 wildcard", [0, "::"]],
  ["options without host", [{ port: 0 }]],
  ["options with wildcard host", [{ port: 0, host: "::" }]],
] as [string, unknown[]][])(
  "LOOPBACK-ONLY-02 refuses a TCP listener with %s",
  (_name, args) => {
    const server = createServer();
    expect(() =>
      (server.listen as (...a: unknown[]) => Server).apply(server, args),
    ).toThrow("Test servers must bind 127.0.0.1");
    expect(server.listening).toBe(false);
  },
);

it.each([
  ["positional host", [0, "127.0.0.1"]],
  ["options host", [{ port: 0, host: "127.0.0.1" }]],
] as [string, unknown[]][])(
  "LOOPBACK-ONLY-03 allows a loopback listener with %s",
  async (_name, args) => {
    const server = createServer();
    open.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
      (server.listen as (...a: unknown[]) => Server).apply(server, args);
    });
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
  },
);

it("LOOPBACK-ONLY-04 keeps the owned Supertest path working", async () => {
  const application = express();
  application.get("/", (_req, res) => res.send("owned"));
  const server = await listenLoopback(application);
  try {
    await request(server).get("/").expect(200, "owned");
  } finally {
    await closeLoopback(server);
  }
});
