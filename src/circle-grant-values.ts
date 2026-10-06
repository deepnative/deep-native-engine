import { CIRCLES } from "./circles.ts";
export type CircleGrantRole = "moderator" | "platform_admin";
export interface CircleGrantReference {
  staffId: string;
  role: CircleGrantRole;
  expiresAt: Date;
}
export interface CircleGrantScope {
  staffId: string;
  circleId: string;
}
export interface CircleGrantInput extends CircleGrantScope {
  idempotencyKey: string;
  expiresAt: Date;
}
/** Browser recovery preserves these original strings, never a replacement key. */
export interface CircleGrantAttempt extends CircleGrantScope {
  idempotencyKey: string;
  expiresAt: string;
}
export interface CircleGrantAdmin {
  reference: CircleGrantReference;
  creationEnabled: boolean;
}
export interface CircleGrantCheck extends CircleGrantReference {
  circleId: string;
  creationEnabled: boolean;
}
export interface RetainedCircleGrant extends CircleGrantScope {
  source: "retained";
  grantId: string;
  role: CircleGrantRole;
  purpose: string;
  createdBy: string;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  state: "current" | "future" | "expired" | "revoked" | "ineffective";
}
export interface AbsentCircleGrant extends CircleGrantScope {
  source: "absent";
  grantId: string;
  state: "source-absent";
  audit: { action: "created" | "revoked"; actorId: string; at: Date }[];
}
export type CircleGrantRecord = RetainedCircleGrant | AbsentCircleGrant;
export interface CircleGrantPage extends CircleGrantScope {
  observedAt: Date;
  items: CircleGrantRecord[];
  nextCursor: string | null;
}
export type CircleGrantResult<T> =
  | { kind: "ready"; value: T; observedAt: Date; deadline: number }
  | { kind: "denied" | "invalid" | "conflict" | "unavailable" };
export type CircleGrantLookup =
  { kind: "key"; value: string } | { kind: "grant"; value: string };
export interface CircleGrantAdminStore {
  admin(token: string): Promise<CircleGrantResult<CircleGrantAdmin>>;
  reference(token: string): Promise<CircleGrantResult<CircleGrantReference>>;
  check(
    token: string,
    staffId: string,
    circleId: string,
  ): Promise<CircleGrantResult<CircleGrantCheck>>;
  create(
    token: string,
    input: CircleGrantInput,
  ): Promise<CircleGrantResult<RetainedCircleGrant>>;
  inspect(
    token: string,
    scope: CircleGrantScope,
    lookup: CircleGrantLookup,
  ): Promise<CircleGrantResult<CircleGrantRecord | null>>;
  history(
    token: string,
    scope: CircleGrantScope,
    after?: string,
  ): Promise<CircleGrantResult<CircleGrantPage>>;
  revoke(
    token: string,
    scope: CircleGrantScope,
    grantId: string,
  ): Promise<CircleGrantResult<RetainedCircleGrant>>;
}
export const circleGrantId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
export const circleGrantCircle = (value: unknown): value is string =>
  typeof value === "string" && CIRCLES.some((circle) => circle.id === value);
export const circleGrantRole = (value: unknown): value is CircleGrantRole =>
  value === "moderator" || value === "platform_admin";
export function circleGrantUtc(value: unknown): Date | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString() === value ? date : null;
}
