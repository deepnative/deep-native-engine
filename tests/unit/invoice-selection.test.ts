import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import type { Store } from "../../src/store.ts";
import { csrf } from "../../src/session.ts";
import {
  invoiceSelection,
  invoiceResumeTarget,
  mountInvoiceSelection,
  INVOICE_SELECTION_COOKIE as name,
} from "../../src/invoice-selection.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "11111111-1111-4111-8111-111111111111",
  secret = "selection-test",
  now = 1800000000000;
const cookie = (value: string) => `${name}=${value}`;
it("BILLPROFILE01 remembers only a signed, current exact proposal with no arbitrary redirect", () => {
  const value = invoiceSelection(id, secret, now);
  expect(invoiceResumeTarget(cookie(value), secret, now)).toBe(
    `/account/purchases#plan-${id}`,
  );
  const defaultValue = invoiceSelection(id, secret);
  expect(invoiceResumeTarget(cookie(defaultValue), secret)).toBe(
    `/account/purchases#plan-${id}`,
  );
  for (const raw of [
    undefined,
    "",
    cookie(value) + ";" + cookie(value),
    cookie("a"),
    cookie(value + ".extra"),
    cookie(value.replace(id, "other")),
    cookie(value.replace(String(now + 900000), "bad")),
    cookie(value.replace(String(now + 900000), String(now))),
    cookie(value.replace(String(now + 900000), String(now + 900001))),
    cookie(value.slice(0, -1) + "X"),
  ])
    expect(invoiceResumeTarget(raw, secret, now)).toBeNull();
  const payload = `${id}.${now + 900001}`;
  expect(
    invoiceResumeTarget(
      cookie(`${payload}.${csrf(payload, secret)}`),
      secret,
      now,
    ),
  ).toBeNull();
  expect(invoiceResumeTarget(cookie(value), "other", now)).toBeNull();
});
it("BILLPROFILE01 gates proposal details on the original account and retains selection across recovery", async () => {
  const session = vi.fn().mockResolvedValue({ kind: "active" }),
    app = express();
  app.use((_req, res, next) => {
    res.locals.token = "a".repeat(64);
    next();
  });
  mountInvoiceSelection(app, { session } as unknown as Store, {
    origin: "https://example.invalid",
    secret,
  });
  const get = (path: string) => withLoopback(app, (s) => request(s).get(path));
  const r = await get(`/courses/proposals/${id}`);
  expect(r.status).toBe(303);
  expect(r.headers.location).toBe(`/account/purchases#plan-${id}`);
  expect(r.headers["set-cookie"]![0]).toContain("HttpOnly");
  expect(r.headers["set-cookie"]![0]).toContain("Secure");
  expect(r.headers["cache-control"]).toBe("no-store");
  session.mockResolvedValueOnce({ kind: "expired" });
  const expired = await get(`/courses/proposals/${id}`);
  expect(expired.status).toBe(401);
  expect(expired.text).toContain("never transfers a proposal");
  session.mockRejectedValueOnce(Error());
  expect((await get(`/courses/proposals/${id}`)).status).toBe(503);
  for (const path of [
    "/courses/proposals/bad",
    `/courses/proposals/${id}?next=https://evil.invalid`,
  ])
    expect((await get(path)).status).toBe(404);
  const local = express();
  mountInvoiceSelection(local, { session } as unknown as Store, {
    origin: "http://localhost:3000",
    secret,
  });
  expect(
    (
      await withLoopback(local, (s) =>
        request(s).get(`/courses/proposals/${id}`),
      )
    ).headers["set-cookie"]![0],
  ).not.toContain("Secure");
});
