import { BlockList, isIP } from "node:net";

export type VisitorScope = "public" | "private" | "unknown";
/** Who a request counts against. `key` is private: never log or store it raw. */
export interface VisitorAddress {
  key: string;
  scope: VisitorScope;
}
/** NOTICE-VISITOR-06: anyone we can't identify shares one allowance. */
export const UNKNOWN_VISITOR: VisitorAddress = {
  key: "unknown",
  scope: "unknown",
};

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;

function ipv4(address: string): VisitorAddress {
  return {
    key: address,
    scope: PRIVATE.check(address, "ipv4") ? "private" : "public",
  };
}

function ipv6Groups(address: string) {
  const text = address.replace(/\d+\.\d+\.\d+\.\d+$/, (dotted) => {
    const [a, b, c, d] = dotted.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  });
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(gap).fill("0"), ...right].map((group) =>
    parseInt(group, 16),
  );
}

function parsed(value: string): VisitorAddress | null {
  const address = value
    .trim()
    .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1")
    .replace(/%.*$/, "");
  const family = isIP(address);
  if (family === 0) return null;
  if (family === 4) return ipv4(address);
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return ipv4(
      [
        groups[6]! >> 8,
        groups[6]! & 0xff,
        groups[7]! >> 8,
        groups[7]! & 0xff,
      ].join("."),
    );
  // NOTICE-VISITOR-08: one customer usually holds a whole /64.
  return {
    key: `${groups
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(":")}::/64`,
    scope: PRIVATE.check(address, "ipv6") ? "private" : "public",
  };
}

/**
 * The hosted app is reached only through nginx on loopback, and nginx passes on
 * the X-Forwarded-For from Azure's ingress. Azure appends the address it saw and
 * documents that only the rightmost entry is its own, so every earlier entry is
 * whatever the client typed. A client that reached this process directly has no
 * proxy to vouch for the header, so its socket address is used instead.
 *
 * This deliberately isn't Express `trust proxy`, which would also change
 * req.protocol and req.hostname across the application.
 */
export function visitorAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
): VisitorAddress {
  const direct = peer ?? "";
  const address = LOOPBACK.test(direct)
    ? (forwardedFor?.split(",").at(-1) ?? "")
    : direct;
  return parsed(address) ?? UNKNOWN_VISITOR;
}
