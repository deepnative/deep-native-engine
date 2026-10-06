import { createHmac, timingSafeEqual } from "node:crypto";
import { SampleFeedbackFailure } from "./sample-feedback-lifetime.ts";
export const assignmentId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
export interface AssignmentCursor {
  at: string;
  id: string;
}
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const signature = (
  body: string,
  actor: string,
  request: string,
  secret: string,
) =>
  createHmac("sha256", secret)
    .update(`${actor}|${request}|${body}`)
    .digest("hex");
export function assignmentCursor(
  value: AssignmentCursor,
  actor: string,
  request: string,
  secret: string,
) {
  const body = `${value.at}|${value.id}|${Date.now() + 1200000}`;
  return `${body}|${signature(body, actor, request, secret)}`;
}
export function readAssignmentCursor(
  value: string | undefined,
  actor: string,
  request: string,
  secret: string,
): AssignmentCursor | null {
  if (value === undefined) return null;
  const parts = value.split("|");
  if (
    value.length > 200 ||
    parts.length !== 4 ||
    !stamp.test(parts[0]!) ||
    !Number.isFinite(+new Date(parts[0]!)) ||
    !assignmentId(parts[1]) ||
    !/^\d{13}$/.test(parts[2]!) ||
    Number(parts[2]) <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(parts[3]!)
  )
    throw new SampleFeedbackFailure("denied");
  if (new Date(parts[0]!).toISOString() !== `${parts[0]!.slice(0, 23)}Z`)
    throw new SampleFeedbackFailure("denied");
  const body = parts.slice(0, 3).join("|");
  if (
    !timingSafeEqual(
      Buffer.from(parts[3]!, "hex"),
      Buffer.from(signature(body, actor, request, secret), "hex"),
    )
  )
    throw new SampleFeedbackFailure("denied");
  return { at: parts[0]!, id: parts[1]! };
}
