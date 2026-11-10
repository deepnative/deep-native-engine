import { afterEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  accountHash,
  cookieHash,
  forget,
  openBrowserSession,
  remember,
  replaced,
  separateSessions,
} from "../../src/member-sessions.ts";

// #695 MULTISESSION: the per-process memory of which account a browser opens.
const value = (character: string) => character.repeat(64);
afterEach(() => vi.useRealTimers());

it("MULTISESSION-08 remembers a browser's account only for a while", () => {
  vi.useFakeTimers();
  const browser = value("a");
  expect(accountHash(browser)).toBe(browser);
  remember([[browser, value("b")]]);
  expect(accountHash(browser)).toBe(value("b"));
  vi.advanceTimersByTime(10 * 60_000 + 1);
  expect(accountHash(browser)).toBe(browser);
});

it("MULTISESSION-08 keeps a bounded number of browsers, dropping the oldest", () => {
  const first = cookieHash("first browser");
  remember([[first, value("c")]]);
  remember(
    Array.from(
      { length: 50_000 },
      (_, index) =>
        [cookieHash(`browser ${index}`), value("d")] as [string, string],
    ),
  );
  expect(accountHash(first)).toBe(first);
  expect(accountHash(cookieHash("browser 49999"))).toBe(value("d"));
  for (let index = 0; index < 50_000; index++)
    forget(cookieHash(`browser ${index}`));
});

it("MULTISESSION-08 moves or drops the browsers of a replaced account value", () => {
  const [one, two, other] = ["one", "two", "other"].map(cookieHash) as [
    string,
    string,
    string,
  ];
  remember([
    [one, value("e")],
    [two, value("e")],
    [other, value("f")],
  ]);
  replaced(value("e"), value("1"));
  expect(accountHash(one)).toBe(value("1"));
  expect(accountHash(two)).toBe(value("1"));
  expect(accountHash(other)).toBe(value("f"));
  replaced(value("1"));
  expect(accountHash(one)).toBe(one);
  expect(accountHash(two)).toBe(two);
  expect(accountHash(other)).toBe(value("f"));
  forget(other);
});

it("MULTISESSION-08 forgets a browser whose session lookup fails", async () => {
  const token = value("9");
  const browser = cookieHash(token);
  remember([[browser, value("e")]]);
  const failing = {
    query: async () => {
      throw Error("synthetic database failure");
    },
  } as unknown as Pool;
  await openBrowserSession(failing, token);
  expect(accountHash(browser)).toBe(browser);
});

it("MULTISESSION-08 leaves an account that already has separate sessions alone", async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  expect(await separateSessions(client, "member")).toEqual([]);
  expect(queries).toHaveLength(1);
});
