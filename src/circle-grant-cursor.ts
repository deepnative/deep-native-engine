import { createHmac, timingSafeEqual } from "node:crypto";
import { CIRCLE_DISCUSSION_POLICY } from "./circle-discussion.ts";
import { CircleGrantFailure } from "./circle-grant-lifetime.ts";
import { circleGrantId, type CircleGrantScope } from "./circle-grant-values.ts";
function signature(
  body: string,
  actor: string,
  scope: CircleGrantScope,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "circle-grant-history",
        CIRCLE_DISCUSSION_POLICY,
        actor,
        scope.staffId,
        scope.circleId,
        body,
      ]),
    )
    .digest("hex");
}
export function circleGrantCursor(
  id: string,
  actor: string,
  scope: CircleGrantScope,
  secret: string,
) {
  const body = `${id}|${Date.now() + 1200000}`;
  return `${body}|${signature(body, actor, scope, secret)}`;
}
export function readCircleGrantCursor(
  value: string | undefined,
  actor: string,
  scope: CircleGrantScope,
  secret: string,
): string | null {
  if (value === undefined) return null;
  const parts = value.split("|");
  if (
    value.length > 200 ||
    parts.length !== 3 ||
    !circleGrantId(parts[0]) ||
    !/^\d{13}$/.test(parts[1]!) ||
    Number(parts[1]) <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(parts[2]!)
  )
    throw new CircleGrantFailure("invalid");
  const body = parts.slice(0, 2).join("|");
  if (
    !timingSafeEqual(
      Buffer.from(parts[2]!, "hex"),
      Buffer.from(signature(body, actor, scope, secret), "hex"),
    )
  )
    throw new CircleGrantFailure("invalid");
  return parts[0]!;
}
