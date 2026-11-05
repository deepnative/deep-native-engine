import { expect, it } from "vitest";
import { UNKNOWN_VISITOR, visitorAddress } from "../../src/visitor-address.ts";

const proxy = "127.0.0.1";

it("NOTICE-VISITOR-03 behind the proxy uses only the entry Azure's ingress added", () => {
  expect(visitorAddress(proxy, "203.0.113.9")).toEqual({
    key: "203.0.113.9",
    scope: "public",
  });
  expect(
    visitorAddress(proxy, "198.51.100.7, 192.0.2.1,not-an-ip, 203.0.113.9"),
  ).toEqual({ key: "203.0.113.9", scope: "public" });
  for (const loopback of ["::1", "::ffff:127.0.0.1", "127.0.0.2"])
    expect(visitorAddress(loopback, "203.0.113.9").key).toBe("203.0.113.9");
});

it("NOTICE-VISITOR-03 ignores the header when the client reached the app directly", () => {
  expect(visitorAddress("192.0.2.44", "203.0.113.9")).toEqual({
    key: "192.0.2.44",
    scope: "public",
  });
  expect(visitorAddress("::ffff:192.0.2.44", "203.0.113.9").key).toBe(
    "192.0.2.44",
  );
});

it("NOTICE-VISITOR-06 treats a missing or unreadable address as one unknown visitor", () => {
  for (const [peer, forwarded] of [
    [undefined, undefined],
    [undefined, "203.0.113.9"],
    ["not-an-ip", "203.0.113.9"],
    [proxy, undefined],
    [proxy, ""],
    [proxy, "203.0.113.9,"],
    [proxy, "203.0.113.9, not-an-ip"],
    [proxy, "999.1.1.1"],
    [proxy, "01.2.3.4"],
  ] as const)
    expect(visitorAddress(peer, forwarded)).toEqual(UNKNOWN_VISITOR);
});

it("NOTICE-VISITOR-08 counts one IPv6 /64 as one visitor", () => {
  const first = visitorAddress(proxy, "2001:DB8:1:2:aaaa:bbbb:cccc:dddd");
  expect(first).toEqual({ key: "2001:db8:1:2::/64", scope: "public" });
  for (const same of [
    "2001:db8:1:2::1",
    "2001:0db8:0001:0002:ffff::",
    "[2001:db8:1:2::1]:4431",
    "[2001:db8:1:2::1]",
  ])
    expect(visitorAddress(proxy, same).key).toBe(first.key);
  expect(visitorAddress(proxy, "2001:db8:1:3::1").key).not.toBe(first.key);
  expect(visitorAddress(proxy, "2001:db8::1").key).toBe("2001:db8:0:0::/64");
  expect(visitorAddress(proxy, "::").key).toBe("0:0:0:0::/64");
  expect(visitorAddress(proxy, "fe80::1%eth0")).toEqual({
    key: "fe80:0:0:0::/64",
    scope: "private",
  });
});

it("NOTICE-VISITOR-08 counts an IPv4-mapped address as its IPv4 address", () => {
  for (const mapped of [
    "::ffff:203.0.113.9",
    "::FFFF:cb00:7109",
    "0:0:0:0:0:ffff:203.0.113.9",
    "203.0.113.9:51234",
  ])
    expect(visitorAddress(proxy, mapped)).toEqual({
      key: "203.0.113.9",
      scope: "public",
    });
});

it.each([
  "10.0.0.4",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.1",
  "192.168.1.1",
  "::1",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
])("NOTICE-VISITOR-10 labels %s as private", (address) => {
  expect(visitorAddress(proxy, address).scope).toBe("private");
});

it.each(["8.8.8.8", "172.32.0.1", "2606:4700::1"])(
  "NOTICE-VISITOR-10 labels %s as public",
  (address) => {
    expect(visitorAddress(proxy, address).scope).toBe("public");
  },
);
