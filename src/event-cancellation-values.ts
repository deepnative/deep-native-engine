import type { EventPreview } from "./events.ts";
export interface EventCancellationScope {
  eventId: string;
  eventVersion: number;
}
export interface EventCancellationSnapshot {
  title: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
}
export interface EventCancellationAttempt
  extends EventCancellationScope, EventCancellationSnapshot {
  key: string;
}
export interface EventCancellationReceipt extends EventCancellationScope {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date;
}
export type EventCancellationResult<T> =
  | { kind: "ready"; value: T; observedAt: Date; deadline: number }
  | { kind: "denied" | "invalid" | "conflict" | "unavailable" };
export interface EventCancellationPreview {
  event: EventPreview;
  creationEnabled: boolean;
  receipt: EventCancellationReceipt | null;
}
export interface EventCancellationStore {
  admin(
    token: string,
  ): Promise<EventCancellationResult<{ creationEnabled: boolean }>>;
  preview(
    token: string,
    scope: EventCancellationScope,
  ): Promise<EventCancellationResult<EventCancellationPreview>>;
  cancel(
    token: string,
    scope: EventCancellationScope,
    key: string,
    snapshot?: EventCancellationSnapshot,
  ): Promise<
    EventCancellationResult<{
      receipt: EventCancellationReceipt;
      replayed: boolean;
    }>
  >;
  inspect(
    token: string,
    scope: EventCancellationScope,
  ): Promise<EventCancellationResult<EventCancellationReceipt | null>>;
  inspectOperation(
    token: string,
    scope: EventCancellationScope,
    key: string,
  ): Promise<EventCancellationResult<EventCancellationReceipt | null>>;
}
export const eventCancellationId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const eventCancellationScope = (
  scope: unknown,
): scope is EventCancellationScope =>
  !!scope &&
  typeof scope === "object" &&
  !Array.isArray(scope) &&
  typeof (scope as EventCancellationScope).eventId === "string" &&
  /^[a-z][a-z0-9-]{0,79}$/.test((scope as EventCancellationScope).eventId) &&
  Number.isInteger((scope as EventCancellationScope).eventVersion) &&
  (scope as EventCancellationScope).eventVersion >= 1 &&
  (scope as EventCancellationScope).eventVersion <= 1000000;
